"""Workspace-confined `fs_read`, `fs_write`, `bash`, and `git` LLM tools."""

from __future__ import annotations

import asyncio
import contextlib
import fnmatch
import hashlib
import os
import re
import shlex
import shutil
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final

from pydantic import BaseModel, ConfigDict, Field

from alfred.core.env_file import atomic_write_text
from alfred.core.logging_setup import mask_secrets
from alfred.core.security.secret_gate import SecretScanInput, scan_inputs
from alfred.kernel.types import (
    ModuleToolDefinition,
    ToolExecutionContext,
    ToolExecutionResult,
)

from .profiles import build_sanitized_env

DEFAULT_MAX_READ_BYTES: Final[int] = 65_536
HARD_MAX_READ_BYTES: Final[int] = 2 * 1024 * 1024
MAX_COMMAND_OUTPUT_CHARS: Final[int] = 32_000
MAX_SNAPSHOT_FILE_BYTES: Final[int] = 4 * 1024 * 1024

_SHELL_METACHAR_RE: Final[re.Pattern[str]] = re.compile(r"[;&|`$<>()\r\n\x00]")
_DANGEROUS_UNESCAPED_CHARS_RE: Final[re.Pattern[str]] = re.compile(r"[`$\r\n\x00]")
_SHELL_OPERATOR_TOKENS: Final[frozenset[str]] = frozenset(
    {";", ";;", "&", "&&", "|", "||", "<", "<<", ">", ">>", "(", ")"}
)
_SELF_DEV_BRANCH_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:feat|fix)/self-[a-z0-9][a-z0-9._/-]{0,79}$"
)
_SAFE_PLACEHOLDER_ARG_RE: Final[re.Pattern[str]] = re.compile(
    r"^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$"
)
_ENV_BASENAME_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:\.env(?:\.(?!example$).+|~)?|\.dashboard-token|\.vault-key(?:\.migrated)?|vault\.json)$",
    re.IGNORECASE,
)
_FORBIDDEN_GIT_BRANCH_RE: Final[re.Pattern[str]] = re.compile(r"^(?:main|master)$", re.IGNORECASE)
_GIT_GLOBAL_VALUE_FLAGS: Final[frozenset[str]] = frozenset(
    {
        "-c",
        "--git-dir",
        "--work-tree",
        "--namespace",
        "--super-prefix",
        "--exec-path",
        "--config-env",
    }
)
_TRANSIENT_SQLITE_SIDECAR_RE: Final[re.Pattern[str]] = re.compile(
    r"\.(?:db|sqlite|sqlite3)-(?:wal|shm|journal)$",
    re.IGNORECASE,
)
_BASH_MUTATING_HINT_RE: Final[re.Pattern[str]] = re.compile(
    r"(?:\b(?:rm|del|erase|mv|move|cp|copy|tee|touch|truncate|dd|chmod|chown|ln|install|patch)\b"
    r"|\bsed\s+[^\n]*-i\b|\bperl\s+[^\n]*-i\b|\bgit\s+(?:checkout\s+--|restore|apply|clean)\b)",
    re.IGNORECASE,
)


class FsReadArgs(BaseModel):
    """Validated input arguments for `fs_read`."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(
        default=".",
        description="Relative path inside the agent workspace (file or directory).",
    )
    max_bytes: int = Field(
        default=DEFAULT_MAX_READ_BYTES,
        ge=1,
        le=HARD_MAX_READ_BYTES,
        description="Maximum UTF-8 bytes to return when reading a file.",
    )


class FsWriteArgs(BaseModel):
    """Validated input arguments for `fs_write`."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(
        min_length=1,
        description="Relative file path inside the agent workspace.",
    )
    content: str = Field(
        description="Full UTF-8 text content to write to the file.",
    )


class BashArgs(BaseModel):
    """Validated input arguments for `bash`."""

    model_config = ConfigDict(extra="forbid")

    command: str = Field(
        min_length=1,
        description="Single command line without shell chaining or redirection operators.",
    )


class GitArgs(BaseModel):
    """Validated input arguments for `git`."""

    model_config = ConfigDict(extra="forbid")

    args: list[str] = Field(
        min_length=1,
        description="Git CLI arguments (e.g. ['status', '--short']).",
    )


def _normalize_rel_posix(raw: str) -> str:
    norm = raw.replace("\\", "/")
    while norm.startswith("./"):
        norm = norm[2:]
    return norm.strip("/")


def _normalize_case(value: str) -> str:
    return value.lower() if os.name == "nt" else value


def _resolve_in_workspace(
    workspace_dir: Path,
    requested_path: str,
) -> tuple[Path, Path, Path] | None:
    """Return `(ws_root, lexical_candidate, resolved_target)` or `None` on boundary escape."""
    if "\x00" in requested_path:
        return None
    ws_root = workspace_dir.resolve()
    req_path = Path(requested_path)
    lexical = req_path if req_path.is_absolute() else (ws_root / req_path)
    # Check unresolved normalized path as well as symlink-resolved path
    lexical_norm = Path(os.path.normpath(str(lexical)))
    if not lexical_norm.is_relative_to(ws_root):
        return None
    resolved = lexical.resolve()
    if not resolved.is_relative_to(ws_root):
        return None
    return ws_root, lexical_norm, resolved


def _matches_rule(rel_posix: str, clean_rule: str) -> bool:
    rel_cmp = _normalize_case(rel_posix)
    rule_cmp = _normalize_case(clean_rule)
    if not rel_cmp or rel_cmp == "." or not rule_cmp:
        return False
    if any(ch in rule_cmp for ch in "*?["):
        return fnmatch.fnmatch(rel_cmp, rule_cmp) or fnmatch.fnmatch(
            rel_cmp.split("/")[0],
            rule_cmp.rstrip("/"),
        )
    return rel_cmp == rule_cmp or rel_cmp.startswith(f"{rule_cmp}/")


def _match_protected_path(
    ws_root: Path,
    lexical_target: Path,
    resolved_target: Path,
    protected_paths: Sequence[str],
) -> str | None:
    if not protected_paths:
        return None
    candidates: list[str] = []
    for cand_path in (lexical_target, resolved_target):
        if cand_path.is_relative_to(ws_root):
            candidates.append(_normalize_rel_posix(cand_path.relative_to(ws_root).as_posix()))

    for rule in protected_paths:
        clean_rule = _normalize_rel_posix(rule)
        if not clean_rule:
            continue
        for rel_posix in candidates:
            if _matches_rule(rel_posix, clean_rule):
                return rule
    return None


def _is_sensitive_read_path(
    ws_root: Path,
    lexical_target: Path,
    resolved_target: Path,
    protected_paths: Sequence[str],
) -> str | None:
    protects_store = any(_normalize_rel_posix(r).lower() == "store" for r in protected_paths)
    for cand_path in (lexical_target, resolved_target):
        if not cand_path.is_relative_to(ws_root):
            continue
        rel = _normalize_rel_posix(cand_path.relative_to(ws_root).as_posix())
        if not rel or rel == ".":
            continue
        if _ENV_BASENAME_RE.match(cand_path.name):
            return ".env"
        rel_lower = rel.lower()
        if protects_store and (rel_lower == "store" or rel_lower.startswith("store/")):
            return "store/"
    return None


def _decode_utf8_prefix(raw: bytes, *, truncated: bool) -> str | None:
    """Decode UTF-8 bytes cleanly; trim partial trailing codepoint only when truncated."""
    if b"\x00" in raw:
        return None
    if not truncated:
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError:
            return None
    for trim in range(4):
        end = len(raw) - trim
        if end < 0:
            break
        try:
            return raw[:end].decode("utf-8")
        except UnicodeDecodeError as exc:
            if exc.start >= max(0, len(raw) - 4):
                continue
            return None
    return None


def _read_path_sync(
    target: Path,
    *,
    max_bytes: int,
) -> tuple[bool, str, str | None, dict[str, object]]:
    if not target.exists():
        return False, "", "NOT_FOUND", {}
    if target.is_dir():
        entries = sorted(
            f"{entry.name}/" if entry.is_dir() else entry.name for entry in target.iterdir()
        )
        return (
            True,
            "\n".join(entries) if entries else "(empty directory)",
            None,
            {"is_dir": True, "count": len(entries)},
        )
    if not target.is_file():
        return False, "", "UNREADABLE_FILE", {}

    size = target.stat().st_size
    if size > HARD_MAX_READ_BYTES:
        return False, "", "FILE_TOO_LARGE", {"size": size, "limit": HARD_MAX_READ_BYTES}

    with target.open("rb") as handle:
        chunk = handle.read(max_bytes + 1)

    truncated = len(chunk) > max_bytes
    raw_used = chunk[:max_bytes] if truncated else chunk
    text = _decode_utf8_prefix(raw_used, truncated=truncated)
    if text is None:
        return False, "", "UNREADABLE_FILE", {}
    return (
        True,
        text,
        None,
        {"is_dir": False, "bytes": len(raw_used), "truncated": truncated},
    )


def _write_file_sync(target: Path, content: str) -> int:
    target.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(target, content, mode=0o644)
    return len(content.encode("utf-8"))


async def execute_fs_read(args: FsReadArgs, ctx: ToolExecutionContext) -> ToolExecutionResult:
    """Read a UTF-8 text file or list a directory confined inside `ctx.workspace_dir`."""
    if ctx.workspace_dir.is_symlink():
        return ToolExecutionResult(
            ok=False,
            error_code="WORKSPACE_BOUNDARY_VIOLATION",
            error="Symlinked workspace directory is forbidden",
        )
    if not ctx.workspace_dir.exists():
        return ToolExecutionResult(
            ok=False,
            error_code="WORKSPACE_NOT_FOUND",
            error=f"Workspace directory does not exist: {ctx.workspace_dir}",
        )
    resolved_pair = _resolve_in_workspace(ctx.workspace_dir, args.path)
    if resolved_pair is None:
        return ToolExecutionResult(
            ok=False,
            error_code="WORKSPACE_BOUNDARY_VIOLATION",
            error=f"Path '{args.path}' escapes workspace '{ctx.workspace_dir}'",
        )
    ws_root, lexical, target = resolved_pair
    sensitive = _is_sensitive_read_path(ws_root, lexical, target, ctx.protected_paths)
    if sensitive is not None:
        return ToolExecutionResult(
            ok=False,
            error_code="PROTECTED_PATH_VIOLATION",
            error=f"Reading sensitive path '{args.path}' (matched '{sensitive}') is forbidden",
        )

    ok, output, err_code, meta = await asyncio.to_thread(
        _read_path_sync,
        target,
        max_bytes=args.max_bytes,
    )
    if not ok:
        if err_code == "NOT_FOUND":
            return ToolExecutionResult(
                ok=False,
                error_code="NOT_FOUND",
                error=f"File or directory not found: {args.path}",
            )
        if err_code == "FILE_TOO_LARGE":
            return ToolExecutionResult(
                ok=False,
                error_code="FILE_TOO_LARGE",
                error=f"File '{args.path}' exceeds read limit ({HARD_MAX_READ_BYTES} bytes)",
                metadata=meta,
            )
        return ToolExecutionResult(
            ok=False,
            error_code=err_code or "UNREADABLE_FILE",
            error=f"File '{args.path}' is binary or not valid UTF-8 text",
        )
    return ToolExecutionResult(ok=True, output=output, metadata=meta)


async def execute_fs_write(args: FsWriteArgs, ctx: ToolExecutionContext) -> ToolExecutionResult:
    """Write a UTF-8 file inside `ctx.workspace_dir` after protected-path & secret-gate checks."""
    if ctx.workspace_dir.is_symlink():
        return ToolExecutionResult(
            ok=False,
            error_code="WORKSPACE_BOUNDARY_VIOLATION",
            error="Symlinked workspace directory is forbidden",
        )
    ctx.workspace_dir.mkdir(parents=True, exist_ok=True)
    resolved_pair = _resolve_in_workspace(ctx.workspace_dir, args.path)
    if resolved_pair is None:
        return ToolExecutionResult(
            ok=False,
            error_code="WORKSPACE_BOUNDARY_VIOLATION",
            error=f"Path '{args.path}' escapes workspace '{ctx.workspace_dir}'",
        )
    ws_root, lexical, target = resolved_pair
    if target == ws_root:
        return ToolExecutionResult(
            ok=False,
            error_code="INVALID_PATH",
            error="Target path must reference a file inside the workspace, not workspace root",
        )

    matched_rule = _match_protected_path(ws_root, lexical, target, ctx.protected_paths)
    if matched_rule is not None:
        return ToolExecutionResult(
            ok=False,
            error_code="PROTECTED_PATH_VIOLATION",
            error=(
                f"Agent '{ctx.agent_id}' is not allowed to write protected path "
                f"'{args.path}' (matched '{matched_rule}')"
            ),
        )

    rel_posix = _normalize_rel_posix(target.relative_to(ws_root).as_posix())
    gate = scan_inputs([SecretScanInput(path=rel_posix, content=args.content)])
    if not gate.ok:
        reasons = "; ".join(f"{f.detector}: {f.reason}" for f in gate.findings)
        return ToolExecutionResult(
            ok=False,
            error_code="SECRET_GATE_BLOCKED",
            error=f"Write blocked by secret_gate ({reasons})",
            metadata={"findings": [f.model_dump(mode="json") for f in gate.findings]},
        )

    written_bytes = await asyncio.to_thread(_write_file_sync, target, args.content)
    return ToolExecutionResult(
        ok=True,
        output=f"OK: Wrote {written_bytes} bytes to {rel_posix}",
        metadata={"path": rel_posix, "bytes": written_bytes},
    )


def is_valid_self_dev_branch(branch: str) -> bool:
    """Validate `feat/self-*` or `fix/self-*` branch names."""
    clean = branch.strip()
    if not _SELF_DEV_BRANCH_RE.match(clean):
        return False
    if ".." in clean or "//" in clean:
        return False
    return not (
        clean.startswith("-")
        or clean.endswith(".")
        or clean.endswith("/")
        or clean.endswith(".lock")
    )


def _check_dangerous_exec_flags(argv: Sequence[str]) -> str | None:
    """Reject inline-code, find-exec, and git config-injection flags across bash commands."""
    if not argv:
        return None
    exe = Path(argv[0]).stem.lower()
    args_tail = argv[1:]

    if exe in {"python", "python3", "py"} or exe.startswith(("python2", "python3")):
        for arg in args_tail:
            if arg == "-c" or arg.startswith("-c") or re.match(r"^-[A-Za-z]*c", arg):
                return "Inline Python execution ('-c') is forbidden"
    elif exe in {"node", "nodejs"}:
        for arg in args_tail:
            if arg in {"-e", "--eval", "-p", "--print"} or arg.startswith(("--eval=", "--print=")):
                return "Inline Node.js execution ('-e'/'--eval') is forbidden"
    elif exe in {"perl", "ruby", "php"}:
        for arg in args_tail:
            if arg in {"-e", "-E", "-r"} or arg.startswith(("-e", "-r")):
                return f"Inline {exe} execution flag '{arg}' is forbidden"
    elif exe in {"bash", "sh", "zsh", "dash", "ash"}:
        for arg in args_tail:
            if arg == "-c" or arg.startswith("-c") or re.match(r"^-[A-Za-z]*c", arg):
                return f"Inline shell execution ('{arg}') is forbidden"
    elif exe == "find":
        for arg in args_tail:
            if arg.lower() in {"-exec", "-execdir", "-ok", "-okdir", "-delete"}:
                return f"Dangerous find action '{arg}' is forbidden"
    elif exe == "git":
        for arg in args_tail:
            if arg in {"-c", "--config-env", "--exec-path"} or arg.startswith(
                ("-c", "--config-env=", "--exec-path=")
            ):
                return f"Dangerous git flag '{arg}' is forbidden"
    return None


def _match_bash_whitelist(argv: list[str], allowed_commands: Sequence[str]) -> bool:
    for template in allowed_commands:
        try:
            tmpl_tokens = shlex.split(template)
        except ValueError:
            continue
        if not tmpl_tokens or len(tmpl_tokens) != len(argv):
            continue
        matched = True
        has_placeholder = False
        for tmpl_tok, arg_tok in zip(tmpl_tokens, argv, strict=True):
            if tmpl_tok.startswith("<") and tmpl_tok.endswith(">") and len(tmpl_tok) > 2:
                has_placeholder = True
                if tmpl_tok == "<self-branch>":
                    if not is_valid_self_dev_branch(arg_tok):
                        matched = False
                        break
                else:
                    if (
                        ".." in arg_tok
                        or "\\" in arg_tok
                        or not _SAFE_PLACEHOLDER_ARG_RE.match(arg_tok)
                    ):
                        matched = False
                        break
            elif arg_tok != tmpl_tok:
                matched = False
                break
        if matched:
            if has_placeholder and _check_dangerous_exec_flags(argv) is not None:
                return False
            return True
    return False


def _check_unwhitelisted_bash_policy(
    command: str,
    argv: list[str],
    ctx: ToolExecutionContext,
) -> ToolExecutionResult | None:
    if argv and Path(argv[0]).stem.lower() == "sudo":
        return ToolExecutionResult(
            ok=False,
            error_code="BASH_POLICY_VIOLATION",
            error="Privilege escalation via 'sudo' is forbidden",
        )
    flag_err = _check_dangerous_exec_flags(argv)
    if flag_err is not None:
        return ToolExecutionResult(
            ok=False,
            error_code="BASH_POLICY_VIOLATION",
            error=flag_err,
        )
    norm_cmd = command.replace("\\", "/")
    if re.search(
        r"(?:^|[\s\"'=/:])\.env(?:\.(?!example\b)[a-z0-9._-]+|~)?(?=$|[\s\"'])",
        norm_cmd,
        re.IGNORECASE,
    ):
        return ToolExecutionResult(
            ok=False,
            error_code="PROTECTED_PATH_VIOLATION",
            error="Accessing .env files via bash is forbidden",
        )
    protects_store = any(_normalize_rel_posix(r).lower() == "store" for r in ctx.protected_paths)
    if protects_store and re.search(r"(?:^|[\s\"'=/:])store(?:/|$|[\s\"'])", norm_cmd, re.I):
        return ToolExecutionResult(
            ok=False,
            error_code="PROTECTED_PATH_VIOLATION",
            error="Accessing protected 'store/' via bash is forbidden",
        )
    if ctx.protected_paths and _BASH_MUTATING_HINT_RE.search(norm_cmd):
        for rule in ctx.protected_paths:
            clean = _normalize_rel_posix(rule)
            if not clean:
                continue
            escaped = re.escape(clean)
            if re.search(rf"(?:^|[\s\"'=/:]){escaped}(?:/|$|[\s\"'])", norm_cmd, re.IGNORECASE):
                return ToolExecutionResult(
                    ok=False,
                    error_code="PROTECTED_PATH_VIOLATION",
                    error=f"Modifying protected path '{clean}' via bash is forbidden",
                )
    return None


def _resolve_executable(cmd: str) -> str:
    if os.name == "nt" and cmd == "bash":
        for candidate in (
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files\Git\usr\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ):
            if Path(candidate).is_file():
                return candidate
    return cmd


async def _run_exec_with_timeout(
    argv: Sequence[str],
    *,
    cwd: Path,
    env: dict[str, str],
    timeout_sec: float,
) -> tuple[bool, int | None, str, str]:
    """Run subprocess without shell, returning `(timed_out, returncode, stdout, stderr)`."""
    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=str(cwd),
        env=env,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    timed_out = False
    try:
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
    except TimeoutError:
        timed_out = True
        with contextlib.suppress(ProcessLookupError):
            proc.terminate()
        try:
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=0.5)
        except TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            stdout_b, stderr_b = await proc.communicate()
    except BaseException:
        if proc.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            with contextlib.suppress(OSError):
                await proc.wait()
        raise

    stdout = stdout_b.decode("utf-8", errors="replace")
    stderr = stderr_b.decode("utf-8", errors="replace")
    return timed_out, proc.returncode, stdout, stderr


def _cap_and_mask(text: str, limit: int = MAX_COMMAND_OUTPUT_CHARS) -> str:
    masked = mask_secrets(text)
    if len(masked) > limit:
        return masked[:limit] + "\n[TRUNCATED]"
    return masked


def _parse_safe_bash_argv(raw_cmd: str) -> tuple[list[str] | None, str | None, str | None]:
    """Parse `raw_cmd` via `shlex`, rejecting shell operators and expansion characters."""
    if _DANGEROUS_UNESCAPED_CHARS_RE.search(raw_cmd):
        return (
            None,
            "BASH_METACHARACTER_REJECTED",
            "Shell expansion characters (`$`, backtick) and newlines are forbidden",
        )
    try:
        lexer = shlex.shlex(raw_cmd, posix=True, punctuation_chars=";&|<>()")
        lexer.whitespace_split = True
        tokens = list(lexer)
        argv = shlex.split(raw_cmd)
    except ValueError as exc:
        return None, "BASH_PARSE_ERROR", f"Invalid command quoting: {exc}"

    if any(tok in _SHELL_OPERATOR_TOKENS for tok in tokens):
        return (
            None,
            "BASH_METACHARACTER_REJECTED",
            "Shell metacharacters (;|&<>()) are forbidden",
        )
    if not argv:
        return None, "BASH_PARSE_ERROR", "Command produced no executable tokens"
    return argv, None, None


async def execute_bash(args: BashArgs, ctx: ToolExecutionContext) -> ToolExecutionResult:
    """Execute a shell-less command parsed by `shlex.split` inside `ctx.workspace_dir`."""
    if ctx.workspace_dir.is_symlink():
        return ToolExecutionResult(
            ok=False,
            error_code="WORKSPACE_BOUNDARY_VIOLATION",
            error="Symlinked workspace directory is forbidden",
        )

    raw_cmd = args.command.strip()
    if not raw_cmd:
        return ToolExecutionResult(
            ok=False,
            error_code="BASH_PARSE_ERROR",
            error="Command must not be empty",
        )
    if ctx.allowed_bash_commands and _SHELL_METACHAR_RE.search(raw_cmd):
        return ToolExecutionResult(
            ok=False,
            error_code="BASH_METACHARACTER_REJECTED",
            error="Shell metacharacters (;|&$`<>() or newlines) are forbidden",
        )
    argv, parse_code, parse_err = _parse_safe_bash_argv(raw_cmd)
    if argv is None:
        return ToolExecutionResult(
            ok=False,
            error_code=parse_code or "BASH_PARSE_ERROR",
            error=parse_err or "Invalid command",
        )

    ws_root = ctx.workspace_dir.resolve()
    project_root = ctx.module_ctx.project_root.resolve()
    if not ctx.allowed_bash_commands and ws_root == project_root:
        return ToolExecutionResult(
            ok=False,
            error_code="BASH_POLICY_VIOLATION",
            error=(
                "Unwhitelisted bash execution is forbidden in project root workspace; "
                "configure allowed_bash_commands"
            ),
        )

    if ctx.allowed_bash_commands:
        if not _match_bash_whitelist(argv, ctx.allowed_bash_commands):
            return ToolExecutionResult(
                ok=False,
                error_code="BASH_WHITELIST_VIOLATION",
                error=f"Command '{raw_cmd}' is not permitted by allowed_bash_commands",
            )
    else:
        policy_err = _check_unwhitelisted_bash_policy(raw_cmd, argv, ctx)
        if policy_err is not None:
            return policy_err

    ws_root.mkdir(parents=True, exist_ok=True)
    exec_argv = [_resolve_executable(argv[0]), *argv[1:]]
    env = build_sanitized_env(
        module_sanitize_keys=ctx.module_ctx.modules.list_cli_env_sanitize_keys(),
    )
    timeout_sec = max(ctx.bash_timeout_ms, 10) / 1000.0
    snapshot = await asyncio.to_thread(
        _snapshot_protected_paths_sync,
        ws_root,
        ctx.protected_paths,
    )
    timed_out = False
    returncode: int | None = None
    stdout = ""
    stderr = ""
    exec_exc: Exception | None = None
    violations: list[dict[str, str]] = []

    try:
        timed_out, returncode, stdout, stderr = await _run_exec_with_timeout(
            exec_argv,
            cwd=ws_root,
            env=env,
            timeout_sec=timeout_sec,
        )
    except Exception as exc:
        exec_exc = exc
    finally:
        violations = await asyncio.to_thread(
            _verify_and_rollback_snapshot_sync,
            snapshot,
            ctx.protected_paths,
        )

    if violations:
        paths_repr = ", ".join(v["path"] for v in violations)
        return ToolExecutionResult(
            ok=False,
            error_code="PROTECTED_PATH_VIOLATION",
            error=(
                f"Command modified protected path(s) [{paths_repr}]; "
                "reverted automatically via SHA-256 snapshot"
            ),
            metadata={"violations": violations},
        )

    if isinstance(exec_exc, FileNotFoundError):
        return ToolExecutionResult(
            ok=False,
            error_code="BINARY_NOT_FOUND",
            error=f"Executable not found: {argv[0]}",
        )
    if exec_exc is not None:
        return ToolExecutionResult(
            ok=False,
            error_code="BASH_EXEC_ERROR",
            error=mask_secrets(str(exec_exc)),
        )

    safe_out = _cap_and_mask(stdout.strip())
    safe_err = _cap_and_mask(stderr.strip())
    if timed_out:
        return ToolExecutionResult(
            ok=False,
            error_code="BASH_TIMEOUT",
            output=safe_out or None,
            error=f"Command exceeded {ctx.bash_timeout_ms} ms timeout and was terminated",
            metadata={"timed_out": True},
        )
    if returncode != 0:
        return ToolExecutionResult(
            ok=False,
            error_code="BASH_NON_ZERO_EXIT",
            output=safe_out or None,
            error=safe_err or f"Command exited with status {returncode}",
            metadata={"exit_code": returncode},
        )
    return ToolExecutionResult(
        ok=True,
        output=safe_out or "(command exited 0)",
        metadata={"exit_code": 0},
    )


@dataclass(slots=True)
class _ProtectedFileSnap:
    rel_path: str
    abs_path: Path
    rule: str
    sha256: str
    backup_bytes: bytes | None


@dataclass(slots=True)
class _ProtectedSnapshot:
    ws_root: Path
    file_snaps: dict[str, _ProtectedFileSnap] = field(default_factory=dict)
    non_existent_targets: list[tuple[str, Path, str]] = field(default_factory=list)
    dir_files: dict[str, tuple[Path, str, set[str]]] = field(default_factory=dict)


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file_sync(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(65_536):
            digest.update(chunk)
    return digest.hexdigest()


def _collect_dir_files_sync(root_dir: Path, ws_root: Path) -> list[tuple[str, Path]]:
    out: list[tuple[str, Path]] = []
    for cur_root, dirnames, filenames in os.walk(root_dir):
        dirnames[:] = sorted(d for d in dirnames if d not in {".git", "node_modules"})
        for fname in sorted(filenames):
            fpath = Path(cur_root) / fname
            if fpath.is_file():
                rel = _normalize_rel_posix(fpath.relative_to(ws_root).as_posix())
                out.append((rel, fpath))
    return out


def _snapshot_protected_paths_sync(
    ws_root: Path,
    protected_paths: Sequence[str],
) -> _ProtectedSnapshot | None:
    if not protected_paths:
        return None
    snap = _ProtectedSnapshot(ws_root=ws_root)

    def _add_file(rel_path: str, abs_path: Path, rule: str) -> None:
        if rel_path in snap.file_snaps or _TRANSIENT_SQLITE_SIDECAR_RE.search(rel_path):
            return
        try:
            st = abs_path.stat()
            if not abs_path.is_file():
                return
            if st.st_size <= MAX_SNAPSHOT_FILE_BYTES:
                data = abs_path.read_bytes()
                digest = _sha256_bytes(data)
                backup_bytes: bytes | None = data
            else:
                digest = _sha256_file_sync(abs_path)
                backup_bytes = None
        except OSError:
            return
        snap.file_snaps[rel_path] = _ProtectedFileSnap(
            rel_path=rel_path,
            abs_path=abs_path,
            rule=rule,
            sha256=digest,
            backup_bytes=backup_bytes,
        )

    for rule in protected_paths:
        clean = _normalize_rel_posix(rule)
        if not clean:
            continue
        if any(ch in clean for ch in "*?["):
            for rel_p, abs_p in _collect_dir_files_sync(ws_root, ws_root):
                if _matches_rule(rel_p, clean):
                    _add_file(rel_p, abs_p, rule)
            continue

        resolved_pair = _resolve_in_workspace(ws_root, clean)
        if resolved_pair is None:
            continue
        _, _, target = resolved_pair
        if not target.exists():
            snap.non_existent_targets.append((clean, target, rule))
            continue
        if target.is_file():
            _add_file(clean, target, rule)
        elif target.is_dir():
            files = _collect_dir_files_sync(target, ws_root)
            rel_set: set[str] = set()
            for rel_p, abs_p in files:
                rel_set.add(rel_p)
                _add_file(rel_p, abs_p, rule)
            snap.dir_files[clean] = (target, rule, rel_set)
    return snap


def _verify_and_rollback_snapshot_sync(
    snap: _ProtectedSnapshot | None,
    protected_paths: Sequence[str],
) -> list[dict[str, str]]:
    if snap is None:
        return []
    violations: list[dict[str, str]] = []
    recorded_rels: set[str] = set()

    for rel_path, entry in snap.file_snaps.items():
        changed = False
        if not entry.abs_path.exists():
            changed = True
        else:
            try:
                cur_hash = _sha256_file_sync(entry.abs_path)
                if cur_hash != entry.sha256:
                    changed = True
            except OSError:
                changed = True
        if changed:
            action = "restored" if entry.backup_bytes is not None else "modified_large_file"
            if rel_path not in recorded_rels:
                violations.append({"path": rel_path, "rule": entry.rule, "action": action})
                recorded_rels.add(rel_path)
            if entry.backup_bytes is not None:
                entry.abs_path.parent.mkdir(parents=True, exist_ok=True)
                entry.abs_path.write_bytes(entry.backup_bytes)

    for rel_path, abs_path, rule in snap.non_existent_targets:
        if abs_path.exists():
            if rel_path not in recorded_rels:
                violations.append({"path": rel_path, "rule": rule, "action": "removed"})
                recorded_rels.add(rel_path)
            if abs_path.is_dir() and not abs_path.is_symlink():
                shutil.rmtree(abs_path, ignore_errors=True)
            else:
                abs_path.unlink(missing_ok=True)

    for dir_path, rule, before_files in snap.dir_files.values():
        if not dir_path.exists():
            continue
        for rel_p, abs_p in _collect_dir_files_sync(dir_path, snap.ws_root):
            if rel_p not in before_files and not _TRANSIENT_SQLITE_SIDECAR_RE.search(rel_p):
                if rel_p not in recorded_rels:
                    violations.append({"path": rel_p, "rule": rule, "action": "removed"})
                    recorded_rels.add(rel_p)
                abs_p.unlink(missing_ok=True)

    # Also catch newly created files matching glob protected_paths
    for rule in protected_paths:
        clean = _normalize_rel_posix(rule)
        if not any(ch in clean for ch in "*?["):
            continue
        for rel_p, abs_p in _collect_dir_files_sync(snap.ws_root, snap.ws_root):
            if rel_p not in snap.file_snaps and _matches_rule(rel_p, clean):
                if rel_p not in recorded_rels:
                    violations.append({"path": rel_p, "rule": rule, "action": "removed"})
                    recorded_rels.add(rel_p)
                abs_p.unlink(missing_ok=True)

    return violations


def _validate_git_args(args: Sequence[str]) -> str | None:
    normalized = [str(a).strip() for a in args]
    for tok in normalized:
        if (
            tok == "-C"
            or tok.startswith("-C")
            or tok == "-c"
            or tok.startswith("-c")
            or tok == "--config-env"
            or tok.startswith("--config-env=")
            or tok.startswith("--git-dir")
            or tok.startswith("--work-tree")
            or tok.startswith("--exec-path")
        ):
            return f"Flag '{tok}' is forbidden in isolated workspace"

    subcmd = ""
    subcmd_idx = -1
    skip_next = False
    for idx, tok in enumerate(normalized):
        if skip_next:
            skip_next = False
            continue
        if not tok:
            continue
        if tok in _GIT_GLOBAL_VALUE_FLAGS:
            skip_next = True
            continue
        if tok.startswith("-"):
            continue
        subcmd = tok.lower()
        subcmd_idx = idx
        break

    if not subcmd:
        return "git requires a valid subcommand"

    sub_args = normalized[subcmd_idx + 1 :]
    if subcmd == "reset" and any(t == "--hard" or t.startswith("--hard=") for t in sub_args):
        return "'git reset --hard' is strictly forbidden"

    if subcmd in {"checkout", "switch"}:
        dash_idx = sub_args.index("--") if "--" in sub_args else len(sub_args)
        branch_tokens = sub_args[:dash_idx]
        creating = False
        for i, tok in enumerate(branch_tokens):
            if tok in {"-b", "-B", "-c", "-C", "--create", "--force-create"}:
                creating = True
                if i + 1 < len(branch_tokens) and _FORBIDDEN_GIT_BRANCH_RE.match(
                    branch_tokens[i + 1]
                ):
                    return f"Creating protected branch '{branch_tokens[i + 1]}' is forbidden"
                continue
            if tok.startswith("-"):
                continue
            if not creating and _FORBIDDEN_GIT_BRANCH_RE.match(tok):
                return f"Switching to protected branch '{tok}' is forbidden"

    if subcmd == "branch":
        mutating = any(
            t in {"-f", "--force", "-d", "-D", "--delete", "-m", "-M"} for t in sub_args
        )
        if mutating:
            for tok in sub_args:
                if not tok.startswith("-") and _FORBIDDEN_GIT_BRANCH_RE.match(tok):
                    return f"Modifying protected branch '{tok}' is forbidden"

    if subcmd == "push":
        for tok in sub_args:
            if (
                tok in {"--force", "-f", "--all", "--mirror", "--force-if-includes"}
                or tok.startswith("--force-with-lease")
                or tok.startswith("+")
                or re.match(r"^-[a-zA-Z]*f[a-zA-Z]*$", tok)
            ):
                return f"Force or wildcard push ('{tok}') is forbidden"
            if not tok.startswith("-"):
                target = tok.split(":")[-1] if ":" in tok else tok
                clean_target = re.sub(r"^refs/heads/", "", target, flags=re.IGNORECASE)
                if ":" in tok and target == "":
                    return f"Deleting remote branch via '{tok}' is forbidden"
                if _FORBIDDEN_GIT_BRANCH_RE.match(clean_target):
                    return f"Pushing to protected branch '{clean_target}' is forbidden"
    return None


async def execute_git(args: GitArgs, ctx: ToolExecutionContext) -> ToolExecutionResult:
    """Execute git inside `ctx.workspace_dir` with protected-path SHA-256 snapshot & rollback."""
    if ctx.workspace_dir.is_symlink():
        return ToolExecutionResult(
            ok=False,
            error_code="WORKSPACE_BOUNDARY_VIOLATION",
            error="Symlinked workspace directory is forbidden",
        )
    policy_err = _validate_git_args(args.args)
    if policy_err is not None:
        return ToolExecutionResult(
            ok=False,
            error_code="GIT_POLICY_VIOLATION",
            error=policy_err,
        )

    ws_root = ctx.workspace_dir.resolve()
    ws_root.mkdir(parents=True, exist_ok=True)
    snapshot = await asyncio.to_thread(
        _snapshot_protected_paths_sync,
        ws_root,
        ctx.protected_paths,
    )

    env = build_sanitized_env(
        module_sanitize_keys=ctx.module_ctx.modules.list_cli_env_sanitize_keys(),
    )
    timeout_sec = max(ctx.bash_timeout_ms, 10) / 1000.0
    timed_out = False
    returncode: int | None = None
    stdout = ""
    stderr = ""
    exec_exc: Exception | None = None

    try:
        timed_out, returncode, stdout, stderr = await _run_exec_with_timeout(
            ["git", *args.args],
            cwd=ws_root,
            env=env,
            timeout_sec=timeout_sec,
        )
    except Exception as exc:
        exec_exc = exc
    finally:
        violations = await asyncio.to_thread(
            _verify_and_rollback_snapshot_sync,
            snapshot,
            ctx.protected_paths,
        )
        if violations:
            rel_list = [v["path"] for v in violations]
            try:
                await _run_exec_with_timeout(
                    ["git", "reset", "--quiet", "HEAD", "--", *rel_list],
                    cwd=ws_root,
                    env=env,
                    timeout_sec=5.0,
                )
            except OSError:
                pass

    if violations:
        paths_repr = ", ".join(v["path"] for v in violations)
        return ToolExecutionResult(
            ok=False,
            error_code="PROTECTED_PATH_VIOLATION",
            error=(
                f"Git modified protected path(s) [{paths_repr}]; "
                "reverted automatically via SHA-256 snapshot"
            ),
            metadata={"violations": violations},
        )

    if exec_exc is not None:
        return ToolExecutionResult(
            ok=False,
            error_code="GIT_EXEC_ERROR",
            error=mask_secrets(str(exec_exc)),
        )

    safe_out = _cap_and_mask(stdout.strip())
    safe_err = _cap_and_mask(stderr.strip())
    if timed_out:
        return ToolExecutionResult(
            ok=False,
            error_code="GIT_TIMEOUT",
            output=safe_out or None,
            error=f"Git command exceeded {ctx.bash_timeout_ms} ms timeout",
        )
    if returncode != 0:
        return ToolExecutionResult(
            ok=False,
            error_code="GIT_NON_ZERO_EXIT",
            output=safe_out or None,
            error=safe_err or f"git exited with code {returncode}",
            metadata={"exit_code": returncode},
        )
    return ToolExecutionResult(
        ok=True,
        output=safe_out or "(git command exited 0 with no output)",
        metadata={"exit_code": 0},
    )


def build_core_cli_tools() -> tuple[ModuleToolDefinition[Any], ...]:
    """Build the 4 `ModuleToolDefinition` tools owned by `core-cli`."""
    return (
        ModuleToolDefinition(
            name="fs_read",
            description="Read a UTF-8 file or list a directory inside the isolated workspace.",
            args_model=FsReadArgs,
            execute=execute_fs_read,
            module_id="core-cli",
        ),
        ModuleToolDefinition(
            name="fs_write",
            description="Create or overwrite a UTF-8 file inside the isolated workspace.",
            args_model=FsWriteArgs,
            execute=execute_fs_write,
            module_id="core-cli",
        ),
        ModuleToolDefinition(
            name="bash",
            description="Execute a shell-less command inside the isolated workspace.",
            args_model=BashArgs,
            execute=execute_bash,
            module_id="core-cli",
        ),
        ModuleToolDefinition(
            name="git",
            description="Run git inside the isolated workspace with protected-path rollback.",
            args_model=GitArgs,
            execute=execute_git,
            module_id="core-cli",
        ),
    )
