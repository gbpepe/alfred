"""Native Python `mio-scan` deterministic SKILL.md prompt-injection & PII scanner."""

from __future__ import annotations

import re
from typing import Final, Literal

from pydantic import BaseModel, ConfigDict

SCANNER_NAME: Final[str] = "mio-scan"
SCANNER_VERSION: Final[str] = "1.0.0"
RULEPACK: Final[str] = "2026-08-24"


class SkillFinding(BaseModel):
    """Single injection or PII finding inside skill markdown text."""

    model_config = ConfigDict(extra="forbid")

    rule: str
    category: Literal["injection", "pii"]
    match: str
    line: int
    span: tuple[int, int]


class SkillScanResult(BaseModel):
    """Full scan result returned by `scan_skill_text()`."""

    model_config = ConfigDict(extra="forbid")

    scanner_name: str = SCANNER_NAME
    scanner_version: str = SCANNER_VERSION
    rulepack: str = RULEPACK
    ok: bool
    findings: list[SkillFinding]


_INJECTION_RULES: Final[tuple[tuple[str, re.Pattern[str]], ...]] = (
    (
        "ignore-previous-instructions",
        re.compile(
            r"(?i)\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|all)\b.{0,30}\b(instructions?|prompts?|rules?)\b"
        ),
    ),
    (
        "ignore-previous-instructions-hu",
        re.compile(
            r"(?i)\b(hagyd\s+figyelmen\s+k[ií]v[üu]l|felejtsd\s+el)\b.{0,60}\b(utas[ií]t[áa]s|szab[áa]ly|prompt)"
        ),
    ),
    (
        "role-reassignment",
        re.compile(
            r"(?i)\byou\s+are\s+(now|no\s+longer)\b|\bact\s+as\s+(if\s+you\s+are\s+)?(the\s+)?(system|admin|root|developer)\b"
        ),
    ),
    (
        "system-prompt-probe",
        re.compile(
            r"(?i)\b(reveal|print|show|repeat)\b.{0,30}\b(system\s+prompt|hidden\s+instructions?|initial\s+prompt)\b"
        ),
    ),
    (
        "fake-system-tag",
        re.compile(r"(?i)<\s*/?\s*(system|assistant_instructions|important_system)[^>]*>"),
    ),
    (
        "imperative-html-comment",
        re.compile(r"(?is)<!--.{0,200}\b(you\s+must|execute|run|send|curl|fetch|post)\b.{0,400}-->"),
    ),
    (
        "pipe-to-shell",
        re.compile(r"(?i)\b(curl|wget)\b[^\n|;]{0,200}\|\s*(ba)?sh\b"),
    ),
    (
        "exfiltrate-instruction",
        re.compile(
            r"(?i)\b(send|post|upload|exfiltrate|forward)\b.{0,40}"
            r"\b(credentials?|secrets?|tokens?|api[-_ ]?keys?|\.env|passwords?)\b"
        ),
    ),
    (
        "tool-invocation-bait",
        re.compile(r"(?i)\b(use|call|invoke)\b.{0,20}\b(the\s+)?(bash|shell|webfetch|browser)\s+tool\b"),
    ),
    (
        "long-base64-blob",
        re.compile(r"[A-Za-z0-9+/]{240,}={0,2}"),
    ),
)

_PII_RULES: Final[tuple[tuple[str, re.Pattern[str]], ...]] = (
    ("email-address", re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")),
    (
        "hu-phone-number",
        re.compile(r"(?<!\d)(\+36|0036|06)[ \-]?(\d{1,2})[ \-]?\d{3}[ \-]?\d{3,4}(?!\d)"),
    ),
    ("card-number-shaped", re.compile(r"(?<!\d)(\d[ \-]?){15,16}(?!\d)")),
    (
        "api-key-shaped",
        re.compile(r"\b(sk|pk|rk)[-_](live|test|ant|proj)?[-_]?[A-Za-z0-9_\-]{16,}\b"),
    ),
    ("bearer-token-literal", re.compile(r"(?i)\bauthorization:\s*bearer\s+[A-Za-z0-9._\-]{12,}")),
    ("hu-taj-shaped", re.compile(r"(?<!\d)\d{3}[ \-]\d{3}[ \-]\d{3}(?!\d)")),
    (
        "secret-assignment",
        re.compile(r"(?i)\b(password|jelsz[óo]|secret|api[-_]?key|token)\b\s*[:=]\s*['\"]?[^\s'\"]{8,}"),
    ),
)


def _truncate_codepoints(snippet: str, limit: int = 80) -> str:
    return f"{snippet[:limit]}..." if len(snippet) > limit else snippet


def scan_skill_text(text: str) -> SkillScanResult:
    """Scan SKILL.md markdown text for prompt-injection and PII patterns."""
    findings: list[SkillFinding] = []
    rule_groups: tuple[
        tuple[Literal["injection", "pii"], tuple[tuple[str, re.Pattern[str]], ...]],
        ...,
    ] = (
        ("injection", _INJECTION_RULES),
        ("pii", _PII_RULES),
    )
    for category, rules in rule_groups:
        for rule_name, rx in rules:
            for match in rx.finditer(text):
                start, end = match.span()
                snippet = match.group(0)
                findings.append(
                    SkillFinding(
                        rule=rule_name,
                        category=category,
                        match=_truncate_codepoints(snippet),
                        line=text[:start].count("\n") + 1,
                        span=(start, end),
                    )
                )
    findings.sort(key=lambda item: item.span[0])
    return SkillScanResult(ok=len(findings) == 0, findings=findings)
