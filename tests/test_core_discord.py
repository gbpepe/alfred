"""Phase 2 tests: Discord message splitter, REST 429 retries, Gateway RESUME, locks & dedup."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
import pytest
from websockets.exceptions import ConnectionClosed
from websockets.frames import Close

from alfred.core.db import SqlitePool
from alfred.core.discord_adapter import DiscordRestClient, split_discord_message
from alfred.core.discord_gateway import (
    DiscordFatalCloseError,
    DiscordGatewayClient,
    DiscordInboundMessage,
    WebSocketConnection,
)


def test_split_discord_message_preserves_code_fences_within_limit() -> None:
    lines = (
        ["```python"]
        + [f"val_{i} = 'line payload number {i:03d}'" for i in range(45)]
        + ["```"]
    )
    body = "Intro text:\n" + "\n".join(lines) + "\nDone."
    chunks = split_discord_message(body, max_len=240)
    assert len(chunks) > 2
    for idx, chunk in enumerate(chunks):
        assert len(chunk) <= 240, f"Chunk {idx} exceeded 240 chars ({len(chunk)})"
        fence_count = chunk.count("```")
        assert fence_count % 2 == 0, f"Unbalanced fence in chunk {idx}:\n{chunk}"
    assert chunks[1].startswith("```python\n")


async def test_discord_rest_client_handles_429_retry_after() -> None:
    attempts = 0
    sleeps: list[float] = []

    def _handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        assert request.headers["authorization"] == "Bot test-bot-token"
        if attempts == 1:
            return httpx.Response(429, json={"retry_after": 0.25})
        return httpx.Response(200, json={"id": f"msg-{attempts}"})

    async def _fake_sleep(sec: float) -> None:
        sleeps.append(sec)

    async with httpx.AsyncClient(transport=httpx.MockTransport(_handler)) as http_client:
        rest = DiscordRestClient(
            bot_token="test-bot-token",
            http_client=http_client,
            sleep_fn=_fake_sleep,
        )
        ids = await rest.send_message("chan-1", "Hello Alfred", reply_to_message_id="orig-1")
        assert ids == ["msg-2"]
        assert sleeps == [0.25]


class _FakeWebSocket:
    def __init__(self, frames: list[dict[str, Any] | Exception]) -> None:
        self._frames = list(frames)
        self.sent: list[dict[str, Any]] = []

    async def send(self, message: str) -> None:
        self.sent.append(json.loads(message))

    async def recv(self) -> str:
        if not self._frames:
            raise ConnectionClosed(Close(1000, "normal"), Close(1000, "normal"))
        nxt = self._frames.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return json.dumps(nxt)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        return None


async def test_discord_gateway_filter_dedup_channel_lock_resume_and_fatal_close(
    tmp_path: Path,
) -> None:
    handled: list[tuple[str, str]] = []
    active_in_channel = 0
    max_parallel_in_channel = 0

    async def _on_message(msg: DiscordInboundMessage) -> None:
        nonlocal active_in_channel, max_parallel_in_channel
        active_in_channel += 1
        max_parallel_in_channel = max(max_parallel_in_channel, active_in_channel)
        await asyncio.sleep(0.01)
        handled.append((msg.message_id, msg.content))
        active_in_channel -= 1

    async with SqlitePool(tmp_path / "store" / "alfred.db") as db:
        gateway = DiscordGatewayClient(
            bot_token="bot-secret",
            db=db,
            on_message=_on_message,
            allowed_user_ids=frozenset({"owner-1"}),
            sleep_fn=lambda _s: asyncio.sleep(0),
        )

        # Session 1: HELLO -> IDENTIFY, READY -> stores session_id, MESSAGE_CREATE filters/dedups
        ws1: WebSocketConnection = _FakeWebSocket(
            [
                {"op": 10, "d": {"heartbeat_interval": 30000}},
                {
                    "op": 0,
                    "s": 10,
                    "t": "READY",
                    "d": {"session_id": "sess-123", "resume_gateway_url": "wss://resume.discord"},
                },
                {
                    "op": 0,
                    "s": 11,
                    "t": "MESSAGE_CREATE",
                    "d": {
                        "id": "m-ignored",
                        "channel_id": "ch-1",
                        "author": {"id": "stranger-9", "username": "eve"},
                        "content": "hack",
                    },
                },
                {
                    "op": 0,
                    "s": 12,
                    "t": "MESSAGE_CREATE",
                    "d": {
                        "id": "m-bot",
                        "channel_id": "ch-1",
                        "author": {"id": "owner-1", "username": "bot", "bot": True},
                        "content": "loop",
                    },
                },
                {
                    "op": 0,
                    "s": 13,
                    "t": "MESSAGE_CREATE",
                    "d": {
                        "id": "m-ok-1",
                        "channel_id": "ch-1",
                        "author": {"id": "owner-1", "username": "peter"},
                        "content": "hello",
                    },
                },
                {
                    "op": 0,
                    "s": 14,
                    "t": "MESSAGE_CREATE",
                    "d": {
                        "id": "m-ok-1",
                        "channel_id": "ch-1",
                        "author": {"id": "owner-1", "username": "peter"},
                        "content": "duplicate delivery",
                    },
                },
                {"op": 7, "d": None},
            ]
        )
        assert await gateway.run_once(ws1) == "reconnect"
        assert isinstance(ws1, _FakeWebSocket)
        assert ws1.sent[0]["op"] == 2  # IDENTIFY
        assert gateway.session_id == "sess-123"
        assert gateway.seq == 14
        assert gateway.resume_gateway_url == "wss://resume.discord?v=10&encoding=json"
        assert handled == [("m-ok-1", "hello")]
        assert max_parallel_in_channel == 1

        # Second session: HELLO must emit RESUME (op=6) with saved session_id + seq
        ws2 = _FakeWebSocket(
            [
                {"op": 10, "d": {"heartbeat_interval": 30000}},
                ConnectionClosed(Close(4014, "Disallowed intents"), None),
            ]
        )

        @asynccontextmanager
        async def _connect_ws2(_url: str) -> AsyncIterator[WebSocketConnection]:
            yield ws2

        gateway._connect_fn = _connect_ws2
        with pytest.raises(DiscordFatalCloseError) as fatal_err:
            await gateway.run_forever()
        assert fatal_err.value.code == 4014
        assert ws2.sent[0]["op"] == 6  # RESUME
        assert ws2.sent[0]["d"]["session_id"] == "sess-123"
        assert ws2.sent[0]["d"]["seq"] == 14
