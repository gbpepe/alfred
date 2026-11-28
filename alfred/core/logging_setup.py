"""Structured JSON logging with automatic secret, Bearer, and API-key masking."""

from __future__ import annotations

import json
import logging
import re
import sys
from datetime import UTC, datetime
from typing import Any, Final

_SECRET_SUB_PATTERNS: Final[tuple[tuple[re.Pattern[str], str], ...]] = (
    (
        re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
        "[REDACTED_PRIVATE_KEY]",
    ),
    (
        re.compile(r"(\bBearer\s+)[A-Za-z0-9._\-]{12,}"),
        r"\1[REDACTED_TOKEN]",
    ),
    (
        re.compile(r"(xi-api-key[\"'\s:=]+)[A-Za-z0-9_\-]{12,}", re.IGNORECASE),
        r"\1[REDACTED_KEY]",
    ),
    (
        re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"),
        "[REDACTED_JWT]",
    ),
    (
        re.compile(
            r"\b(?:sk-ant-|sk-proj-|sk_live_|sk_test_|rk_live_|rk_test_|"
            r"gh[pousr]_|xox[baprs]-|AIza|AKIA|sbp_)[A-Za-z0-9_\-]{10,}\b"
        ),
        "[REDACTED_SECRET]",
    ),
    (
        re.compile(r"\bsk[-_][A-Za-z0-9_\-]{16,}\b"),
        "[REDACTED_SECRET]",
    ),
    (
        re.compile(r"(?<![0-9])[0-9]{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])"),
        "[REDACTED_BOT_TOKEN]",
    ),
    (
        re.compile(
            r"(\b(?:password|passwd|jelsz[óo]|secret|client_secret|refresh_token|"
            r"access_token|api[-_]?key|bot[-_]?token|token)\b\s*[:=]\s*['\"]?)([^\s'\",;]{4,})",
            re.IGNORECASE,
        ),
        r"\1[REDACTED]",
    ),
)

_STANDARD_RECORD_ATTRS: Final[frozenset[str]] = frozenset(
    {
        "args",
        "asctime",
        "created",
        "exc_info",
        "exc_text",
        "filename",
        "funcName",
        "levelname",
        "levelno",
        "lineno",
        "module",
        "msecs",
        "message",
        "msg",
        "name",
        "pathname",
        "process",
        "processName",
        "relativeCreated",
        "stack_info",
        "taskName",
        "thread",
        "threadName",
    }
)


def mask_secrets(text: str) -> str:
    """Scrub Bearer tokens, private keys, JWTs, API keys, and credential assignments."""
    masked = text
    for pattern, replacement in _SECRET_SUB_PATTERNS:
        masked = pattern.sub(replacement, masked)
    return masked


def _mask_value(value: Any) -> Any:
    if isinstance(value, str):
        return mask_secrets(value)
    if isinstance(value, dict):
        return {str(k): _mask_value(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_mask_value(item) for item in value]
    if isinstance(value, tuple):
        return [_mask_value(item) for item in value]
    return value


class JsonLogFormatter(logging.Formatter):
    """Render log records as single-line JSON with secret redaction."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": mask_secrets(record.getMessage()),
        }
        if record.exc_info:
            payload["exc"] = mask_secrets(self.formatException(record.exc_info))
        if record.stack_info:
            payload["stack"] = mask_secrets(self.formatStack(record.stack_info))
        for key, value in record.__dict__.items():
            if key not in _STANDARD_RECORD_ATTRS and not key.startswith("_"):
                payload[key] = _mask_value(value)
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging(*, level: str = "INFO", stream: Any = None) -> logging.Logger:
    """Configure root Alfred logger with structured JSON secret-masking output."""
    target_stream = stream if stream is not None else sys.stderr
    handler = logging.StreamHandler(target_stream)
    handler.setFormatter(JsonLogFormatter())

    root_logger = logging.getLogger("alfred")
    root_logger.handlers.clear()
    root_logger.addHandler(handler)
    root_logger.setLevel(getattr(logging, level.upper(), logging.INFO))
    root_logger.propagate = False
    return root_logger
