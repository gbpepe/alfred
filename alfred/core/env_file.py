"""Atomic file writes and safe `.env` parsing/updating utilities."""

from __future__ import annotations

import os
import re
import tempfile
from collections.abc import Mapping
from pathlib import Path

_ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_ENV_LINE_RE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")
_DOUBLE_QUOTE_ESCAPE_RE = re.compile(r'\\(["\\nr])')


def ensure_secure_dir(directory: Path, *, mode: int = 0o700) -> Path:
    """Create a directory and tighten permissions on newly created stores (best-effort)."""
    created = not directory.exists()
    directory.mkdir(parents=True, exist_ok=True)
    if created:
        try:
            os.chmod(directory, mode)
        except OSError:
            pass
    return directory


def atomic_write_bytes(
    path: Path,
    data: bytes,
    *,
    mode: int = 0o600,
    dir_mode: int | None = None,
) -> None:
    """Atomically write bytes via temporary file in same directory, fsync, and os.replace."""
    if dir_mode is not None:
        ensure_secure_dir(path.parent, mode=dir_mode)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(tmp_path, mode)
        except OSError:
            pass
        os.replace(tmp_path, path)
        try:
            os.chmod(path, mode)
        except OSError:
            pass
        _fsync_parent_dir(path.parent)
    except BaseException:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def atomic_write_text(
    path: Path,
    content: str,
    *,
    mode: int = 0o600,
    encoding: str = "utf-8",
    dir_mode: int | None = None,
) -> None:
    """Atomically write UTF-8 text to disk with flush, fsync, and `0o600` permissions."""
    atomic_write_bytes(path, content.encode(encoding), mode=mode, dir_mode=dir_mode)


def _fsync_parent_dir(directory: Path) -> None:
    """Fsync parent directory on POSIX so rename metadata is durable."""
    if os.name == "nt":
        return
    flags = getattr(os, "O_RDONLY", 0) | getattr(os, "O_DIRECTORY", 0)
    try:
        dir_fd = os.open(directory, flags)
    except OSError:
        return
    try:
        os.fsync(dir_fd)
    except OSError:
        pass
    finally:
        os.close(dir_fd)


def _unescape_double_quoted(match: re.Match[str]) -> str:
    esc = match.group(1)
    if esc == "n":
        return "\n"
    if esc == "r":
        return "\r"
    return esc


def _unquote_env_value(raw: str) -> str:
    stripped = raw.strip()
    if len(stripped) >= 2 and stripped[0] == stripped[-1] and stripped[0] in ("'", '"'):
        inner = stripped[1:-1]
        if stripped[0] == '"':
            return _DOUBLE_QUOTE_ESCAPE_RE.sub(_unescape_double_quoted, inner)
        return inner
    comment_match = re.match(r"^(.*?)\s+#.*$", stripped)
    return comment_match.group(1).strip() if comment_match else stripped


def _format_env_value(value: str) -> str:
    if "\n" in value or "\r" in value or "\x00" in value:
        raise ValueError("Environment variable values must not contain newlines or NUL bytes")
    if value == "" or any(ch.isspace() or ch in ('#', '"', "'", "\\", "$") for ch in value):
        escaped = value.replace("\\", r"\\").replace('"', r"\"")
        return f'"{escaped}"'
    return value


def parse_env_file(path: Path) -> dict[str, str]:
    """Parse key=value pairs from a `.env` file without evaluating shell expressions."""
    if not path.exists():
        return {}
    result: dict[str, str] = {}
    text = path.read_text(encoding="utf-8")
    for line in text.splitlines():
        trimmed = line.strip()
        if not trimmed or trimmed.startswith("#"):
            continue
        match = _ENV_LINE_RE.match(line)
        if not match:
            continue
        key, raw_val = match.group(1), match.group(2)
        result[key] = _unquote_env_value(raw_val)
    return result


def update_env_file(
    path: Path,
    updates: Mapping[str, str | None],
    *,
    mode: int = 0o600,
) -> dict[str, str]:
    """Atomically update or delete keys in `.env` while preserving comments and key order."""
    for key in updates:
        if not _ENV_KEY_RE.match(key):
            raise ValueError(f"Invalid environment variable name: {key!r}")

    existing_lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    remaining = dict(updates)
    new_lines: list[str] = []

    for line in existing_lines:
        trimmed = line.strip()
        if not trimmed or trimmed.startswith("#"):
            new_lines.append(line)
            continue
        match = _ENV_LINE_RE.match(line)
        if not match:
            new_lines.append(line)
            continue
        key = match.group(1)
        if key not in remaining:
            new_lines.append(line)
            continue
        new_val = remaining.pop(key)
        if new_val is None:
            continue
        new_lines.append(f"{key}={_format_env_value(new_val)}")

    for key, val in remaining.items():
        if val is not None:
            new_lines.append(f"{key}={_format_env_value(val)}")

    rendered = "\n".join(new_lines) + ("\n" if new_lines else "")
    atomic_write_text(path, rendered, mode=mode)
    return parse_env_file(path)
