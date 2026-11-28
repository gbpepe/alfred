"""EVIDGUARD818 fail-closed 3-detector scanner (path, content, transcript)."""

from __future__ import annotations

import re
from collections.abc import Sequence
from pathlib import Path
from typing import Final, Literal

from pydantic import BaseModel, ConfigDict


class SecretFinding(BaseModel):
    """Single security finding produced by `secret_gate` (never exposes matched secret)."""

    model_config = ConfigDict(extra="forbid")

    file: str
    detector: Literal["path", "content", "transcript", "unscannable"]
    severity: Literal["blocked", "unscannable"]
    line: int | None = None
    reason: str


class SecretScanInput(BaseModel):
    """Input descriptor passed to `scan_inputs()`."""

    model_config = ConfigDict(extra="forbid")

    path: str
    content: str | None = None
    unreadable_reason: str | None = None


class SecretGateResult(BaseModel):
    """Aggregated fail-closed scan outcome."""

    model_config = ConfigDict(extra="forbid")

    ok: bool
    findings: list[SecretFinding]
    scanned_count: int


DENIED_PATH_PATTERNS: Final[tuple[tuple[re.Pattern[str], str], ...]] = (
    (re.compile(r"(^|/)\.pre-ship-evidence(/|$)"), "pre-ship evidence directory"),
    (re.compile(r"(^|/)evidence(/|$)"), "evidence directory"),
    (re.compile(r"(^|/)\.evidence(/|$)"), "hidden evidence directory"),
    (re.compile(r"(^|/)transcripts?(/|$)"), "transcript directory"),
    (re.compile(r"(^|/)\.session-capture(/|$)"), "session capture directory"),
    (re.compile(r"\.pre-ship-evidence[^/]*$"), "pre-ship evidence file"),
)

SECRET_PATTERNS: Final[tuple[tuple[str, re.Pattern[str]], ...]] = (
    ("private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("Stripe secret/restricted key", re.compile(r"\b(sk|rk)_(live|test)_[A-Za-z0-9]{16,}")),
    ("ElevenLabs key header", re.compile(r"xi-api-key[\"'\s:=]+[A-Za-z0-9_-]{16,}", re.I)),
    ("ElevenLabs key literal", re.compile(r"\bsk_[a-f0-9]{32,}")),
    ("bearer token literal", re.compile(r"\bBearer\s+[A-Za-z0-9_-]{24,}\.?[A-Za-z0-9_.-]*")),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}")),
    ("Workspace bot token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}")),
    ("OpenAI project key", re.compile(r"\bsk-proj-[A-Za-z0-9_-]{20,}")),
    ("generic vendor secret key (sk_ or sk-)", re.compile(r"\bsk[-_][A-Za-z0-9_-]{24,}")),
    ("AWS access key id", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    (
        "Colon-prefixed bot token",
        re.compile(r"(?<![0-9])[0-9]{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])"),
    ),
    (
        "Bot token secret half",
        re.compile(
            r"(?:BOT_[A-Z_]*TOKEN|bot_token|botToken)[\"'\s:=]+[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])",
            re.I,
        ),
    ),
    ("Supabase service_role JWT hint", re.compile(r"service_role[\"'\s:=]+eyJ")),
    ("Supabase personal access token", re.compile(r"\bsbp_[0-9a-f]{40}\b")),
)

TRANSCRIPT_PATTERNS: Final[tuple[tuple[str, re.Pattern[str]], ...]] = (
    ("quoted channel message", re.compile(r"\bmessage_id\s*[:=]?\s*\d{2,}\s*[:\-]")),
    ("channel update dump", re.compile(r"\"(update_id|from_user|chat_id)\"\s*:\s*\d+")),
    (
        "quoted agent transcript header",
        re.compile(r"^\s*\[Uzenet \\?@[a-z0-9_-]+-tol", re.I | re.M),
    ),
)

WRAPPER_TAG: Final[re.Pattern[str]] = re.compile(
    r"<\s*(channel|trusted-peer)\b[^>]*\bsource\s*=\s*[\"'][^\"']+[\"'][^>]*>",
    re.I,
)
WRAPPED_PAYLOAD: Final[re.Pattern[str]] = re.compile(
    r"\bmessage_id\s*[:=]?\s*\d{2,}|\"(update_id|chat_id|from_user)\"\s*:\s*\d+"
)


def _line_number_at(content: str, offset: int) -> int:
    return content[:offset].count("\n") + 1


def scan_inputs(inputs: Sequence[SecretScanInput]) -> SecretGateResult:
    """Scan inputs using path, content, and transcript detectors (fail-closed)."""
    if not inputs:
        return SecretGateResult(
            ok=False,
            scanned_count=0,
            findings=[
                SecretFinding(
                    file="<empty>",
                    detector="unscannable",
                    severity="unscannable",
                    reason="empty input set (fail-closed)",
                )
            ],
        )

    findings: list[SecretFinding] = []
    for item in inputs:
        norm_path = item.path.replace("\\", "/")
        for pat, reason in DENIED_PATH_PATTERNS:
            if pat.search(norm_path):
                findings.append(
                    SecretFinding(
                        file=item.path,
                        detector="path",
                        severity="blocked",
                        reason=f"denied path category: {reason}",
                    )
                )

        if item.unreadable_reason is not None or item.content is None:
            findings.append(
                SecretFinding(
                    file=item.path,
                    detector="unscannable",
                    severity="unscannable",
                    reason=item.unreadable_reason or "content missing or unreadable (fail-closed)",
                )
            )
            continue

        content = item.content
        for rule_name, rx in SECRET_PATTERNS:
            for m in rx.finditer(content):
                findings.append(
                    SecretFinding(
                        file=item.path,
                        detector="content",
                        severity="blocked",
                        line=_line_number_at(content, m.start()),
                        reason=f"matched secret pattern: {rule_name}",
                    )
                )

        for rule_name, rx in TRANSCRIPT_PATTERNS:
            for m in rx.finditer(content):
                findings.append(
                    SecretFinding(
                        file=item.path,
                        detector="transcript",
                        severity="blocked",
                        line=_line_number_at(content, m.start()),
                        reason=f"matched transcript marker: {rule_name}",
                    )
                )

        if WRAPPER_TAG.search(content) and WRAPPED_PAYLOAD.search(content):
            match_tag = WRAPPER_TAG.search(content)
            findings.append(
                SecretFinding(
                    file=item.path,
                    detector="transcript",
                    severity="blocked",
                    line=_line_number_at(content, match_tag.start()) if match_tag else None,
                    reason="wrapped channel/trusted-peer transcript payload",
                )
            )

    return SecretGateResult(
        ok=len(findings) == 0,
        findings=findings,
        scanned_count=len(inputs),
    )


def scan_file(
    path: Path,
    *,
    display_path: str | None = None,
    max_bytes: int = 2 * 1024 * 1024,
) -> SecretGateResult:
    """Scan a single local file fail-closed before upload or commit."""
    shown = display_path or path.as_posix()
    if not path.exists() or not path.is_file():
        return scan_inputs(
            [SecretScanInput(path=shown, unreadable_reason="file missing or not a regular file")]
        )
    try:
        size = path.stat().st_size
        if size > max_bytes:
            return scan_inputs(
                [
                    SecretScanInput(
                        path=shown,
                        unreadable_reason=f"file exceeds scan limit ({size} > {max_bytes} bytes)",
                    )
                ]
            )
        raw_bytes = path.read_bytes()
    except OSError as exc:
        return scan_inputs(
            [SecretScanInput(path=shown, unreadable_reason=f"os read error: {exc}")]
        )

    if b"\x00" in raw_bytes:
        # Still verify path rules even for binary files, then report unscannable only if needed
        return scan_inputs(
            [
                SecretScanInput(
                    path=shown,
                    unreadable_reason="binary NUL bytes present (unscannable text)",
                )
            ]
        )

    try:
        text = raw_bytes.decode("utf-8")
    except UnicodeDecodeError:
        return scan_inputs(
            [SecretScanInput(path=shown, unreadable_reason="non-UTF-8 content (fail-closed)")]
        )
    return scan_inputs([SecretScanInput(path=shown, content=text)])
