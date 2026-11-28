"""Discord 2000-char code-fence-preserving splitter & SDK-free `httpx` REST client."""

from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable
from typing import Any, Final

import httpx

DISCORD_API_BASE: Final[str] = "https://discord.com/api/v10"
_FENCE_RE: Final[re.Pattern[str]] = re.compile(r"^```([^\n`]*)$")


def split_discord_message(text: str, *, max_len: int = 2000) -> list[str]:
    """Split text into `<= max_len` chunks while preserving fenced code blocks."""
    if max_len < 20:
        raise ValueError("max_len must be at least 20 characters")
    if not text:
        return []
    if len(text) <= max_len:
        return [text]

    chunks: list[str] = []
    current_lines: list[str] = []
    current_len = 0
    open_fence: str | None = None

    def _close_reserve() -> int:
        return len("\n```") if open_fence is not None else 0

    def _flush_chunk() -> None:
        nonlocal current_lines, current_len
        if not current_lines:
            return
        body = "\n".join(current_lines)
        if open_fence is not None:
            body = f"{body}\n```"
        chunks.append(body)
        if open_fence is not None:
            current_lines = [open_fence]
            current_len = len(open_fence)
        else:
            current_lines = []
            current_len = 0

    for line in text.splitlines():
        fence_match = _FENCE_RE.match(line)
        added_len = len(line) + (1 if current_lines else 0)
        if current_lines and current_len + added_len + _close_reserve() > max_len:
            _flush_chunk()

        if len(line) > max_len - _close_reserve():
            # Split extra-long single line without breaking current fence invariants
            pos = 0
            while pos < len(line):
                sep = 1 if current_lines else 0
                avail = max(1, max_len - (current_len + sep) - _close_reserve())
                piece = line[pos : pos + avail]
                current_lines.append(piece)
                current_len += len(piece) + (1 if len(current_lines) > 1 else 0)
                pos += len(piece)
                if pos < len(line):
                    _flush_chunk()
        else:
            current_lines.append(line)
            current_len += len(line) + (1 if len(current_lines) > 1 else 0)

        if fence_match is not None:
            open_fence = None if open_fence is not None else line

    if current_lines:
        body = "\n".join(current_lines)
        if open_fence is not None and len(body) + 4 <= max_len:
            body = f"{body}\n```"
        elif open_fence is not None:
            chunks.append(body)
            chunks.append("```")
            return chunks
        chunks.append(body)

    return chunks


class DiscordRestError(Exception):
    """Raised when Discord REST delivery fails after retries."""


class DiscordRestClient:
    """Async `httpx` Discord REST v10 message sender with `429` retry_after backoff."""

    def __init__(
        self,
        *,
        bot_token: str,
        http_client: httpx.AsyncClient | None = None,
        sleep_fn: Callable[[float], Awaitable[None]] | None = None,
        max_retries: int = 3,
    ) -> None:
        self._bot_token = bot_token
        self._http_client = http_client
        self._sleep = sleep_fn or asyncio.sleep
        self._max_retries = max_retries

    async def send_message(
        self,
        channel_id: str,
        content: str,
        *,
        reply_to_message_id: str | None = None,
    ) -> list[str]:
        """Split long content cleanly and deliver chunks via Discord REST v10."""
        chunks = split_discord_message(content)
        if not chunks:
            return []

        owns_client = self._http_client is None
        client = self._http_client or httpx.AsyncClient(timeout=20.0)
        url = f"{DISCORD_API_BASE}/channels/{channel_id}/messages"
        headers = {
            "Authorization": f"Bot {self._bot_token}",
            "Content-Type": "application/json",
        }
        sent_ids: list[str] = []
        try:
            for idx, chunk in enumerate(chunks):
                payload: dict[str, Any] = {"content": chunk}
                if idx == 0 and reply_to_message_id:
                    payload["message_reference"] = {"message_id": reply_to_message_id}
                msg_id = await self._post_with_429_retry(client, url, headers, payload)
                if msg_id:
                    sent_ids.append(msg_id)
        finally:
            if owns_client:
                await client.aclose()
        return sent_ids

    async def _post_with_429_retry(
        self,
        client: httpx.AsyncClient,
        url: str,
        headers: dict[str, str],
        payload: dict[str, Any],
    ) -> str:
        for attempt in range(self._max_retries + 1):
            try:
                resp = await client.post(url, headers=headers, json=payload)
            except httpx.HTTPError as exc:
                raise DiscordRestError(f"Discord REST network failure: {exc}") from exc

            if resp.status_code == 429 and attempt < self._max_retries:
                data = resp.json() if resp.content else {}
                retry_after = float(data.get("retry_after", 1.0)) if isinstance(data, dict) else 1.0
                await self._sleep(max(0.0, min(retry_after, 30.0)))
                continue

            if resp.status_code >= 400:
                raise DiscordRestError(
                    f"Discord REST error HTTP {resp.status_code}: {resp.text[:250]}"
                )
            body = resp.json() if resp.content else {}
            if isinstance(body, dict) and isinstance(body.get("id"), str):
                return str(body["id"])
            return ""
        raise DiscordRestError("Discord REST rate-limit retries exhausted")
