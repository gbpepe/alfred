"""Headless subscription CLI `ModuleModelProvider` adapters (`claude`, `agy`, `codex`, `gemini`)."""

from __future__ import annotations

import asyncio
import json
import os
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, cast
from weakref import WeakKeyDictionary

from alfred.core.logging_setup import mask_secrets
from alfred.kernel.errors import ModuleError
from alfred.kernel.types import (
    ModelProviderRequest,
    ModelProviderResponse,
    ModuleContext,
)

from .profiles import (
    CLI_PROVIDER_SPECS,
    CliProviderId,
    CliRuntimeTracker,
    ProfileManager,
    build_sanitized_env,
    resolve_cli_binary,
)

DEFAULT_CLI_TIMEOUT_SEC: Final[float] = 300.0
DEFAULT_KILL_GRACE_SEC: Final[float] = 2.0
DEFAULT_MAX_PROMPT_CHARS: Final[int] = 32_000
MAX_RAW_OUTPUT_CHARS: Final[int] = 65_536

_WRITE_TOOL_NAMES: Final[frozenset[str]] = frozenset({"fs_write", "bash", "git"})
_RATE_LIMIT_RE: Final[re.Pattern[str]] = re.compile(
    r"rate[\s_-]?limit|\b429\b|quota\s+(?:exceeded|exhausted)|"
    r"too\s+many\s+requests|credit\s+balance|insufficient_quota|usage\s+limit",
    re.IGNORECASE,
)
_AUTH_ERROR_RE: Final[re.Pattern[str]] = re.compile(
    r"not\s+logged\s+in|login\s+required|please\s+log\s+in|unauthorized|\b401\b|"
    r"authentication\s+(?:failed|required|error)|invalid\s+api\s+key|"
    r"expired\s+token|credentials?\s+(?:not\s+found|missing|expired)",
    re.IGNORECASE,
)


@dataclass(frozen=True, slots=True)
class CliSubprocessRequest:
    """Invocation payload supplied to `CliSubprocessRunner`."""

    provider_id: CliProviderId
    command: str
    args: tuple[str, ...]
    cwd: Path
    env: dict[str, str]
    timeout_sec: float


@dataclass(frozen=True, slots=True)
class CliSubprocessResult:
    """Result returned by `CliSubprocessRunner`."""

    stdout: str
    stderr: str
    returncode: int | None
    timed_out: bool = False
    spawn_error: str | None = None


CliSubprocessRunner = Callable[[CliSubprocessRequest], Awaitable[CliSubprocessResult]]


class CliExecutionError(ModuleError):
    """Structured error raised when a headless CLI provider invocation fails."""

    def __init__(
        self,
        *,
        provider_id: CliProviderId,
        kind: str,
        message: str,
        returncode: int | None = None,
        status_code: int = 502,
    ) -> None:
        super().__init__(
            mask_secrets(message),
            code=f"CLI_{kind}",
            module_id="core-cli",
            status_code=status_code,
        )
        self.provider_id = provider_id
        self.kind = kind
        self.returncode = returncode


async def default_subprocess_runner(req: CliSubprocessRequest) -> CliSubprocessResult:
    """Execute a CLI subprocess without shell, enforcing timeout + terminate/kill."""
    try:
        proc = await asyncio.create_subprocess_exec(
            req.command,
            *req.args,
            cwd=str(req.cwd),
            env=req.env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        return CliSubprocessResult(
            stdout="",
            stderr=f"CLI binary '{req.command}' not found",
            returncode=None,
            spawn_error="ENOENT",
        )
    except OSError as exc:
        return CliSubprocessResult(
            stdout="",
            stderr=str(exc),
            returncode=None,
            spawn_error=type(exc).__name__,
        )

    timed_out = False
    try:
        stdout_b, stderr_b = await asyncio.wait_for(
            proc.communicate(),
            timeout=req.timeout_sec,
        )
    except TimeoutError:
        timed_out = True
        try:
            proc.terminate()
        except ProcessLookupError:
            pass
        try:
            stdout_b, stderr_b = await asyncio.wait_for(
                proc.communicate(),
                timeout=DEFAULT_KILL_GRACE_SEC,
            )
        except TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            stdout_b, stderr_b = await proc.communicate()

    return CliSubprocessResult(
        stdout=stdout_b.decode("utf-8", errors="replace"),
        stderr=stderr_b.decode("utf-8", errors="replace"),
        returncode=proc.returncode,
        timed_out=timed_out,
    )


def _format_prompts_with_budget(
    request: ModelProviderRequest,
    *,
    max_chars: int = DEFAULT_MAX_PROMPT_CHARS,
) -> tuple[str, str]:
    clean_sys = request.system_prompt.strip()
    turns: list[str] = []
    last_user = ""
    for msg in request.messages:
        content = msg.content.strip()
        if not content:
            continue
        if msg.role == "user":
            last_user = content
            turns.append(f"User: {content}")
        elif msg.role == "assistant":
            turns.append(f"Assistant: {content}")
        elif msg.role == "tool":
            label = msg.name or "tool"
            turns.append(f"Tool({label}): {content}")
        elif msg.role == "system" and not clean_sys:
            clean_sys = content

    if turns and request.messages and request.messages[-1].role == "user":
        history_turns = turns[:-1]
    else:
        history_turns = turns

    def _build(active_turns: list[str]) -> tuple[str, str]:
        if active_turns and last_user:
            user_prompt = (
                "## Previous conversation\n"
                + "\n".join(active_turns)
                + f"\n\n## Current request\n{last_user}"
            )
        elif active_turns:
            user_prompt = "\n".join(active_turns)
        else:
            user_prompt = last_user
        combined = f"## System\n{clean_sys}\n\n{user_prompt}" if clean_sys else user_prompt
        return user_prompt, combined

    user_prompt, combined = _build(history_turns)
    while history_turns and len(combined) > max_chars:
        history_turns.pop(0)
        user_prompt, combined = _build(history_turns)
    return user_prompt, combined


def _strip_provider_prefix(provider_id: CliProviderId, model: str) -> str:
    clean = model.strip()
    prefix = f"{provider_id}:"
    if clean.startswith(prefix):
        clean = clean[len(prefix) :]
    return clean


def _build_cli_args(
    provider_id: CliProviderId,
    request: ModelProviderRequest,
    *,
    user_prompt: str,
    combined_prompt: str,
) -> tuple[str, ...]:
    model_name = _strip_provider_prefix(provider_id, request.model)
    has_explicit_model = bool(model_name and model_name != "default")
    has_write_tools = any(t.name in _WRITE_TOOL_NAMES for t in request.tools)

    if provider_id == "claude-cli":
        args = ["-p", user_prompt, "--output-format", "json"]
        if request.system_prompt.strip():
            args.extend(["--append-system-prompt", request.system_prompt.strip()])
        if has_explicit_model:
            args.extend(["--model", model_name])
        return tuple(args)

    if provider_id == "codex-cli":
        sandbox_mode = "workspace-write" if has_write_tools else "read-only"
        args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", sandbox_mode]
        if has_explicit_model:
            args.extend(["-m", model_name])
        args.append(combined_prompt)
        return tuple(args)

    if provider_id == "agy-cli":
        args = ["-p", combined_prompt, "--output-format", "json", "--disable-slash-commands"]
        if has_explicit_model:
            args.extend(["--model", model_name])
        args.extend(["--mode", "accept-edits" if has_write_tools else "plan"])
        return tuple(args)

    # gemini-cli
    args = ["-p", combined_prompt, "--output-format", "json"]
    if has_explicit_model:
        args.extend(["-m", model_name])
    if has_write_tools:
        args.extend(["--approval-mode", "auto_edit"])
    return tuple(args)


def _extract_json_object(raw: str) -> dict[str, Any] | None:
    trimmed = raw.strip()
    if not trimmed:
        return None
    try:
        parsed = json.loads(trimmed)
        if isinstance(parsed, dict):
            return parsed
    except ValueError:
        pass

    for line in reversed(trimmed.splitlines()):
        cand = line.strip()
        if not cand.startswith("{"):
            continue
        try:
            parsed = json.loads(cand)
            if isinstance(parsed, dict):
                return parsed
        except ValueError:
            continue
    return None


def _safe_int(val: Any) -> int:
    if isinstance(val, bool):
        return 0
    if isinstance(val, (int, float)):
        return max(0, int(val))
    return 0


def _estimate_tokens(text: str) -> int:
    return (len(text) + 3) // 4 if text else 0


def _parse_claude_output(
    stdout: str,
    prompt_text: str,
    configured_model: str,
) -> ModelProviderResponse:
    obj = _extract_json_object(stdout)
    if obj is None:
        raise CliExecutionError(
            provider_id="claude-cli",
            kind="PARSE_ERROR",
            message="Failed to parse Claude CLI JSON output",
        )
    if obj.get("is_error") is True:
        err_text = str(obj.get("result") or "Claude CLI reported an error")
        kind, status_code = _classify_error_text(err_text, 1, timed_out=False, spawn_error=None)
        raise CliExecutionError(
            provider_id="claude-cli",
            kind=kind,
            message=err_text,
            returncode=1,
            status_code=status_code,
        )
    content = (
        obj["result"]
        if isinstance(obj.get("result"), str)
        else (obj["text"] if isinstance(obj.get("text"), str) else "")
    )
    in_tok = 0
    out_tok = 0
    cache_read = 0
    cache_create = 0
    reported_model = obj.get("model") if isinstance(obj.get("model"), str) else configured_model
    usage = obj.get("usage")
    if isinstance(usage, Mapping):
        in_tok = _safe_int(usage.get("input_tokens") or usage.get("inputTokens"))
        out_tok = _safe_int(usage.get("output_tokens") or usage.get("outputTokens"))
        cache_read = _safe_int(
            usage.get("cache_read_input_tokens") or usage.get("cacheReadInputTokens")
        )
        cache_create = _safe_int(
            usage.get("cache_creation_input_tokens") or usage.get("cacheCreationInputTokens")
        )
    if in_tok + out_tok + cache_read + cache_create == 0:
        in_tok = _estimate_tokens(prompt_text)
        out_tok = _estimate_tokens(content)
    return ModelProviderResponse(
        content=content,
        input_tokens=in_tok,
        output_tokens=out_tok,
        cache_read_tokens=cache_read,
        cache_creation_tokens=cache_create,
        cost_usd=0.0,
        metadata={"provider": "claude-cli", "model": reported_model},
    )


def _parse_codex_output(
    stdout: str,
    prompt_text: str,
    configured_model: str,
) -> ModelProviderResponse:
    parsed_count = 0
    last_message = ""
    last_error = ""
    reported_model = configured_model
    in_tok = 0
    out_tok = 0
    cache_read = 0

    for raw_line in stdout.splitlines():
        line = raw_line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if not isinstance(ev, dict):
            continue
        parsed_count += 1
        if isinstance(ev.get("model"), str) and ev["model"].strip():
            reported_model = ev["model"].strip()
        ev_type = ev.get("type")
        if ev_type == "item.completed" and isinstance(ev.get("item"), Mapping):
            item = ev["item"]
            if item.get("type") == "agent_message" or item.get("role") == "assistant":
                if isinstance(item.get("text"), str) and item["text"]:
                    last_message = item["text"]
        elif ev.get("role") == "assistant" and isinstance(ev.get("text"), str):
            last_message = ev["text"]
        elif ev_type == "response.output_text.done" and isinstance(ev.get("text"), str):
            last_message = ev["text"]
        elif ev_type == "turn.completed" and isinstance(ev.get("usage"), Mapping):
            u = ev["usage"]
            raw_in = _safe_int(u.get("input_tokens"))
            cached = _safe_int(u.get("cached_input_tokens"))
            in_tok += max(0, raw_in - cached)
            cache_read += cached
            out_tok += _safe_int(u.get("output_tokens"))
        elif ev_type == "error" and isinstance(ev.get("message"), str):
            last_error = ev["message"]

    if parsed_count == 0:
        raise CliExecutionError(
            provider_id="codex-cli",
            kind="PARSE_ERROR",
            message="Failed to parse Codex CLI JSONL output",
        )
    if not last_message and last_error:
        kind, status_code = _classify_error_text(last_error, 1, timed_out=False, spawn_error=None)
        raise CliExecutionError(
            provider_id="codex-cli",
            kind=kind,
            message=last_error,
            returncode=1,
            status_code=status_code,
        )
    if in_tok + out_tok + cache_read == 0:
        in_tok = _estimate_tokens(prompt_text)
        out_tok = _estimate_tokens(last_message)
    return ModelProviderResponse(
        content=last_message,
        input_tokens=in_tok,
        output_tokens=out_tok,
        cache_read_tokens=cache_read,
        cost_usd=0.0,
        metadata={"provider": "codex-cli", "model": reported_model},
    )


def _parse_gemini_output(
    stdout: str,
    prompt_text: str,
    configured_model: str,
) -> ModelProviderResponse:
    obj = _extract_json_object(stdout)
    if obj is None:
        raise CliExecutionError(
            provider_id="gemini-cli",
            kind="PARSE_ERROR",
            message="Failed to parse Gemini CLI JSON output",
        )
    content = (
        obj["response"]
        if isinstance(obj.get("response"), str)
        else (obj["text"] if isinstance(obj.get("text"), str) else "")
    )
    in_tok = 0
    out_tok = 0
    cache_read = 0
    thinking = 0
    reported_model = configured_model

    stats = obj.get("stats")
    models = stats.get("models") if isinstance(stats, Mapping) else None
    if isinstance(models, Mapping):
        for m_name, entry in models.items():
            if isinstance(m_name, str) and reported_model == configured_model:
                reported_model = m_name
            if not isinstance(entry, Mapping):
                continue
            tokens = entry.get("tokens")
            if not isinstance(tokens, Mapping):
                continue
            prompt = _safe_int(tokens.get("prompt") or tokens.get("input"))
            cached = _safe_int(tokens.get("cached"))
            thoughts = _safe_int(tokens.get("thoughts"))
            candidates = _safe_int(tokens.get("candidates") or tokens.get("output"))
            in_tok += max(0, prompt - cached)
            cache_read += cached
            thinking += thoughts
            out_tok += candidates + thoughts

    if in_tok + out_tok + cache_read == 0:
        in_tok = _estimate_tokens(prompt_text)
        out_tok = _estimate_tokens(content)
    return ModelProviderResponse(
        content=content,
        input_tokens=in_tok,
        output_tokens=out_tok,
        cache_read_tokens=cache_read,
        thinking_tokens=thinking,
        cost_usd=0.0,
        metadata={"provider": "gemini-cli", "model": reported_model},
    )


def _parse_agy_output(
    stdout: str,
    prompt_text: str,
    configured_model: str,
) -> ModelProviderResponse:
    obj = _extract_json_object(stdout)
    if obj is None:
        plain = mask_secrets(stdout).strip()
        return ModelProviderResponse(
            content=plain,
            input_tokens=_estimate_tokens(prompt_text),
            output_tokens=_estimate_tokens(plain),
            cost_usd=0.0,
            metadata={"provider": "agy-cli", "model": configured_model},
        )
    content = ""
    for key in ("result", "response", "text", "content"):
        if isinstance(obj.get(key), str):
            content = obj[key]
            break
    reported_model = obj.get("model") if isinstance(obj.get("model"), str) else configured_model
    usage = obj.get("usage")
    in_tok = 0
    out_tok = 0
    cache_read = 0
    cache_create = 0
    thinking = 0
    if isinstance(usage, Mapping):
        in_tok = _safe_int(
            usage.get("input_tokens") or usage.get("inputTokens") or usage.get("prompt_tokens")
        )
        out_tok = _safe_int(
            usage.get("output_tokens")
            or usage.get("outputTokens")
            or usage.get("completion_tokens")
        )
        cache_read = _safe_int(
            usage.get("cache_read_input_tokens") or usage.get("cacheReadTokens")
        )
        cache_create = _safe_int(
            usage.get("cache_creation_input_tokens") or usage.get("cacheCreationTokens")
        )
        thinking = _safe_int(usage.get("thinking_tokens") or usage.get("thinkingTokens"))
    if in_tok + out_tok + cache_read + cache_create == 0:
        in_tok = _estimate_tokens(prompt_text)
        out_tok = _estimate_tokens(content)
    return ModelProviderResponse(
        content=content,
        input_tokens=in_tok,
        output_tokens=out_tok,
        cache_read_tokens=cache_read,
        cache_creation_tokens=cache_create,
        thinking_tokens=thinking,
        cost_usd=0.0,
        metadata={"provider": "agy-cli", "model": reported_model},
    )


def _classify_error_text(
    text: str,
    returncode: int | None,
    *,
    timed_out: bool,
    spawn_error: str | None,
) -> tuple[str, int]:
    if spawn_error == "ENOENT":
        return "BINARY_NOT_FOUND", 502
    if timed_out:
        return "TIMEOUT", 504
    if _RATE_LIMIT_RE.search(text):
        return "RATE_LIMITED", 429
    if _AUTH_ERROR_RE.search(text):
        return "AUTH_REQUIRED", 401
    return "NON_ZERO_EXIT", 502 if returncode != 0 else 500


def parse_cli_response(
    provider_id: CliProviderId,
    stdout: str,
    prompt_text: str,
    configured_model: str,
) -> ModelProviderResponse:
    """Parse provider-specific JSON or JSONL output into `ModelProviderResponse`."""
    if provider_id == "claude-cli":
        return _parse_claude_output(stdout, prompt_text, configured_model)
    if provider_id == "codex-cli":
        return _parse_codex_output(stdout, prompt_text, configured_model)
    if provider_id == "agy-cli":
        return _parse_agy_output(stdout, prompt_text, configured_model)
    return _parse_gemini_output(stdout, prompt_text, configured_model)


class BaseCliModelProvider:
    """Base `ModuleModelProvider` adapter with FIFO `asyncio.Semaphore(1)` & env isolation."""

    _provider_id: CliProviderId

    def __init__(
        self,
        *,
        ctx_getter: Callable[[], ModuleContext | None] | None = None,
        tracker: CliRuntimeTracker | None = None,
        subprocess_runner: CliSubprocessRunner | None = None,
        semaphore: asyncio.Semaphore | None = None,
        loop_semaphores: WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore]
        | None = None,
        timeout_sec: float = DEFAULT_CLI_TIMEOUT_SEC,
        env_source: Mapping[str, str] | None = None,
    ) -> None:
        self._ctx_getter = ctx_getter
        self._tracker = tracker or CliRuntimeTracker()
        self._subprocess_runner = subprocess_runner
        self._explicit_semaphore = semaphore
        self._loop_semaphores: WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = (
            loop_semaphores if loop_semaphores is not None else WeakKeyDictionary()
        )
        self._timeout_sec = timeout_sec
        self._env_source = env_source

    @property
    def provider_id(self) -> str:
        """Canonical CLI provider identifier."""
        return self._provider_id

    @property
    def zero_cost_model_prefixes(self) -> Sequence[str]:
        """Subscription CLI model regex prefixes ($0.00 cost)."""
        return (CLI_PROVIDER_SPECS[self._provider_id].zero_cost_prefix,)

    @property
    def eu_only_compliant(self) -> bool:
        """Headless external CLIs are not EU-residency guaranteed."""
        return False

    def supports_model(self, model: str) -> bool:
        """Return True if `model` targets this CLI provider (`<provider_id>:*`)."""
        return model == self._provider_id or model.startswith(f"{self._provider_id}:")

    def _get_semaphore(self) -> asyncio.Semaphore:
        if self._explicit_semaphore is not None:
            return self._explicit_semaphore
        loop = asyncio.get_running_loop()
        sem = self._loop_semaphores.get(loop)
        if sem is None:
            sem = asyncio.Semaphore(1)
            self._loop_semaphores[loop] = sem
        return sem

    def _resolve_runner(self, ctx: ModuleContext | None) -> CliSubprocessRunner:
        if self._subprocess_runner is not None:
            return self._subprocess_runner
        if ctx is not None:
            hook = ctx.extra.get("cli_subprocess_runner")
            if callable(hook):
                return cast(CliSubprocessRunner, hook)
        return default_subprocess_runner

    async def generate(self, request: ModelProviderRequest) -> ModelProviderResponse:
        """Run CLI inference under FIFO `Semaphore(1)` with sanitized env & timeout control."""
        sem = self._get_semaphore()
        async with sem:
            ctx = self._ctx_getter() if self._ctx_getter is not None else None
            self._tracker.record_invocation()

            raw_env: Mapping[str, str]
            if self._env_source is not None:
                raw_env = self._env_source
            elif ctx is not None and isinstance(ctx.extra.get("cli_env"), Mapping):
                raw_env = {str(k): str(v) for k, v in ctx.extra["cli_env"].items()}
            else:
                raw_env = os.environ

            sanitize_keys: tuple[str, ...] = ()
            profile_dir: Path | None = None
            if ctx is not None:
                sanitize_keys = ctx.modules.list_cli_env_sanitize_keys()
                pm = ProfileManager(ctx)
                active_pid = await pm.get_active_profile_id(self._provider_id)
                profile_dir = pm.resolve_profile_dir(self._provider_id, active_pid)
                await asyncio.to_thread(profile_dir.mkdir, parents=True, exist_ok=True)

            sanitized_env = build_sanitized_env(
                source_env=raw_env,
                module_sanitize_keys=sanitize_keys,
                provider_id=self._provider_id,
                profile_dir=profile_dir,
            )

            command = resolve_cli_binary(self._provider_id, raw_env)
            user_prompt, combined_prompt = _format_prompts_with_budget(request)
            cli_args = _build_cli_args(
                self._provider_id,
                request,
                user_prompt=user_prompt,
                combined_prompt=combined_prompt,
            )

            ws_dir = request.workspace_dir.resolve()
            await asyncio.to_thread(ws_dir.mkdir, parents=True, exist_ok=True)

            runner = self._resolve_runner(ctx)
            req_timeout = request.metadata.get("timeout_sec")
            timeout_sec = (
                float(req_timeout)
                if isinstance(req_timeout, (int, float)) and req_timeout > 0
                else self._timeout_sec
            )
            sub_req = CliSubprocessRequest(
                provider_id=self._provider_id,
                command=command,
                args=cli_args,
                cwd=ws_dir,
                env=sanitized_env,
                timeout_sec=timeout_sec,
            )
            sub_res = await runner(sub_req)

            if sub_res.spawn_error or sub_res.timed_out or sub_res.returncode != 0:
                detail = (sub_res.stderr or sub_res.stdout or "").strip()
                kind, status_code = _classify_error_text(
                    detail,
                    sub_res.returncode,
                    timed_out=sub_res.timed_out,
                    spawn_error=sub_res.spawn_error,
                )
                safe_detail = mask_secrets(detail[:300])
                if kind == "RATE_LIMITED":
                    self._tracker.record_quota_limit(
                        self._provider_id,
                        detail=safe_detail or "Rate limited",
                    )
                else:
                    self._tracker.record_error_detail(
                        self._provider_id,
                        safe_detail or f"{kind}",
                    )
                raise CliExecutionError(
                    provider_id=self._provider_id,
                    kind=kind,
                    message=safe_detail or f"{self._provider_id} failed ({kind})",
                    returncode=sub_res.returncode,
                    status_code=status_code,
                )

            response = parse_cli_response(
                self._provider_id,
                sub_res.stdout,
                combined_prompt,
                request.model,
            )
            self._tracker.clear_quota_limit(self._provider_id)
            return response


class ClaudeCliProvider(BaseCliModelProvider):
    """`ModuleModelProvider` adapter for `claude-cli`."""

    _provider_id: CliProviderId = "claude-cli"


class AgyCliProvider(BaseCliModelProvider):
    """`ModuleModelProvider` adapter for `agy-cli`."""

    _provider_id: CliProviderId = "agy-cli"


class CodexCliProvider(BaseCliModelProvider):
    """`ModuleModelProvider` adapter for `codex-cli`."""

    _provider_id: CliProviderId = "codex-cli"


class GeminiCliProvider(BaseCliModelProvider):
    """`ModuleModelProvider` adapter for `gemini-cli`."""

    _provider_id: CliProviderId = "gemini-cli"


def create_cli_providers(
    *,
    ctx_getter: Callable[[], ModuleContext | None] | None = None,
    tracker: CliRuntimeTracker | None = None,
    subprocess_runner: CliSubprocessRunner | None = None,
    semaphore: asyncio.Semaphore | None = None,
    timeout_sec: float = DEFAULT_CLI_TIMEOUT_SEC,
) -> tuple[BaseCliModelProvider, ...]:
    """Create the 4 CLI `ModuleModelProvider` instances sharing one runtime tracker & FIFO gate."""
    shared_tracker = tracker or CliRuntimeTracker()
    shared_sems: WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = (
        WeakKeyDictionary()
    )
    return (
        ClaudeCliProvider(
            ctx_getter=ctx_getter,
            tracker=shared_tracker,
            subprocess_runner=subprocess_runner,
            semaphore=semaphore,
            loop_semaphores=shared_sems,
            timeout_sec=timeout_sec,
        ),
        AgyCliProvider(
            ctx_getter=ctx_getter,
            tracker=shared_tracker,
            subprocess_runner=subprocess_runner,
            semaphore=semaphore,
            loop_semaphores=shared_sems,
            timeout_sec=timeout_sec,
        ),
        CodexCliProvider(
            ctx_getter=ctx_getter,
            tracker=shared_tracker,
            subprocess_runner=subprocess_runner,
            semaphore=semaphore,
            loop_semaphores=shared_sems,
            timeout_sec=timeout_sec,
        ),
        GeminiCliProvider(
            ctx_getter=ctx_getter,
            tracker=shared_tracker,
            subprocess_runner=subprocess_runner,
            semaphore=semaphore,
            loop_semaphores=shared_sems,
            timeout_sec=timeout_sec,
        ),
    )
