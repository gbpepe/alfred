"""Indirect prompt-injection wrappers and peer trust-delimiting helpers."""

from __future__ import annotations

import re
import secrets
from typing import Final

_SECURITY_TAG_NAMES: Final[tuple[str, ...]] = ("untrusted", "trusted-peer", "scheduled-task")
_SECURITY_TAG_RX: Final[re.Pattern[str]] = re.compile(
    r"<\s*/?\s*(?:" + "|".join(_SECURITY_TAG_NAMES) + r")\b[^>]*>",
    re.IGNORECASE,
)
_STRIPPED_SENTINEL: Final[str] = f"[[SECURITY_TAG_REMOVED_{secrets.token_hex(4)}]]"
_CAPABILITY_TAG_RE: Final[re.Pattern[str]] = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
CAPABILITY_TAG_MAX_PER_AGENT: Final[int] = 12


def scrub_security_tags(raw: str) -> str:
    """Replace embedded security wrapper tags with a per-process random sentinel."""
    return _SECURITY_TAG_RX.sub(_STRIPPED_SENTINEL, raw)


def sanitize_agent_ident(raw: str | None) -> str:
    """Keep strictly safe agent identifier characters (no colons or angle brackets)."""
    return re.sub(r"[^a-zA-Z0-9_-]", "", raw or "")


def sanitize_agent_source(raw: str | None) -> str:
    """Sanitize a `prefix:name` source attribute; defaults to `unknown`."""
    cleaned = re.sub(r"[^a-zA-Z0-9:_-]", "", raw or "")
    return cleaned or "unknown"


def sanitize_capability_tag(raw: str | None) -> str | None:
    """Validate lowercase alphanumeric-hyphen capability tags; drop non-matching input."""
    candidate = (raw or "").strip().lower()
    return candidate if _CAPABILITY_TAG_RE.match(candidate) else None


def sanitize_origin_note(raw: str | None) -> str | None:
    """Whitelist safe label characters for peer origin notes outside XML tags."""
    cleaned = re.sub(r"[^a-zA-Z0-9 _.\-/]", "", raw or "")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()[:60]
    return cleaned or None


def wrap_untrusted(source: str, content: str | None) -> str:
    """Wrap external content in `<untrusted source="...">` while scrubbing inner delimiter tags."""
    if not content:
        return ""
    scrubbed = scrub_security_tags(content)
    safe_source = sanitize_agent_source(source)
    return f'<untrusted source="{safe_source}">\n{scrubbed}\n</untrusted>'


def wrap_trusted_peer(source: str, content: str | None) -> str:
    """Wrap verified teammate content in `<trusted-peer source="...">` with delimiter scrubbing."""
    if not content:
        return ""
    scrubbed = scrub_security_tags(content)
    safe_source = sanitize_agent_source(source)
    return f'<trusted-peer source="{safe_source}">\n{scrubbed}\n</trusted-peer>'
