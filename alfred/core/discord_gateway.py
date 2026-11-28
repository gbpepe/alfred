"""SDK-free `websockets` Discord Gateway v10 client with RESUME, locks & deduplication."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import random
import time
import weakref
from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from typing import Any, Final, Protocol, runtime_checkable

import websockets
from pydantic import BaseModel, ConfigDict
from websockets.exceptions import ConnectionClosed

from alfred.core.db import SqlitePool

DISCORD_GATEWAY_URL: Final[str] = "wss://gateway.discord.gg/?v=10&encoding=json"
DEFAULT_INTENTS: Final[int] = (1 << 9) | (1 << 12) | (1 << 15)  # GUILD_MESSAGES | DM | CONTENT
FATAL_DISCORD_CLOSE_CODES: Final[frozenset[int]] = frozenset(
    {4004, 4010, 4011, 4012, 4013, 4014}
)


class DiscordFatalCloseError(Exception):
    """Raised on non-recoverable Discord Gateway close codes (e.g. 4004, 4014)."""

    def __init__(self, code: int, reason: str = "") -> None:
        self.code = code
        self.reason = reason
        super().__init__(f"Fatal Discord Gateway close code {code}: {reason}")


class DiscordInboundMessage(BaseModel):
    """Validated inbound user message forwarded to Alfred core routing."""

    model_config = ConfigDict(extra="forbid")

    message_id: str
    channel_id: str
    author_id: str
    author_name: str
    content: str
    guild_id: str | None = None
    timestamp_sec: int


@runtime_checkable
class WebSocketConnection(Protocol):
    """Minimal structural protocol satisfied by `websockets` connections and mocks."""

    async def send(self, message: str) -> Any: ...

    async def recv(self) -> str | bytes: ...

    async def close(self, code: int = 1000, reason: str = "") -> None: ...


ConnectFactory = Callable[[str], AbstractAsyncContextManager[WebSocketConnection]]
InboundHandler = Callable[[DiscordInboundMessage], Awaitable[None]]


class DiscordGatewayClient:
    """Resilient Discord Gateway v10 loop with `RESUME`, jittered heartbeat & deduplication."""

    def __init__(
        self,
        *,
        bot_token: str,
        db: SqlitePool,
        on_message: InboundHandler,
        allowed_user_ids: frozenset[str] = frozenset(),
        allow_all_users: bool = False,
        intents: int = DEFAULT_INTENTS,
        gateway_url: str = DISCORD_GATEWAY_URL,
        connect_fn: ConnectFactory | None = None,
        sleep_fn: Callable[[float], Awaitable[None]] | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        self._bot_token = bot_token
        self._db = db
        self._on_message = on_message
        self.allowed_user_ids = allowed_user_ids
        self.allow_all_users = allow_all_users
        self._intents = intents
        self._gateway_url = gateway_url
        self._connect_fn: ConnectFactory = connect_fn or _default_connect
        self._sleep = sleep_fn or asyncio.sleep
        self._logger = logger or logging.getLogger("alfred.discord_gateway")

        self.session_id: str | None = None
        self.resume_gateway_url: str | None = None
        self.seq: int | None = None
        self._stop_event = asyncio.Event()
        self._channel_locks: weakref.WeakValueDictionary[str, asyncio.Lock] = (
            weakref.WeakValueDictionary()
        )
        self._inflight_tasks: set[asyncio.Task[None]] = set()
        self._heartbeat_ack_received: bool = True

    def stop(self) -> None:
        """Signal the Gateway loop to terminate cleanly."""
        self._stop_event.set()

    def _get_channel_lock(self, channel_id: str) -> asyncio.Lock:
        lock = self._channel_locks.get(channel_id)
        if lock is None:
            lock = asyncio.Lock()
            self._channel_locks[channel_id] = lock
        return lock

    def _on_task_done(self, task: asyncio.Task[None]) -> None:
        self._inflight_tasks.discard(task)
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            self._logger.exception(
                "Unhandled exception in Discord inbound message handler",
                exc_info=exc,
            )

    async def _run_inbound_task(
        self,
        lock: asyncio.Lock,
        inbound: DiscordInboundMessage,
    ) -> None:
        async with lock:
            await self._on_message(inbound)

    async def drain_inflight(self, *, cancel: bool = False) -> None:
        """Wait for (or cancel) all background inbound message tasks."""
        tasks = list(self._inflight_tasks)
        if not tasks:
            return
        if cancel:
            for task in tasks:
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _send_identify_or_resume(self, ws: WebSocketConnection) -> None:
        if self.session_id and self.seq is not None:
            payload: dict[str, Any] = {
                "op": 6,
                "d": {
                    "token": self._bot_token,
                    "session_id": self.session_id,
                    "seq": self.seq,
                },
            }
        else:
            payload = {
                "op": 2,
                "d": {
                    "token": self._bot_token,
                    "intents": self._intents,
                    "properties": {
                        "os": "linux",
                        "browser": "alfred-v2",
                        "device": "alfred-v2",
                    },
                },
            }
        await ws.send(json.dumps(payload))

    async def _send_heartbeat(self, ws: WebSocketConnection) -> None:
        await ws.send(json.dumps({"op": 1, "d": self.seq}))

    async def _heartbeat_loop(self, ws: WebSocketConnection, interval_ms: int) -> None:
        interval_sec = max(1.0, interval_ms / 1000.0)
        # Discord recommends jitter in (0, 1) before first heartbeat
        jitter = 0.1 + 0.8 * (random.SystemRandom().random())
        try:
            await self._sleep(interval_sec * jitter)
            while not self._stop_event.is_set():
                if not self._heartbeat_ack_received:
                    self._logger.warning(
                        "Discord Gateway zombie heartbeat timeout (no op=11 ACK); closing socket"
                    )
                    with contextlib.suppress(Exception):
                        await ws.close(code=4000, reason="Zombie heartbeat timeout")
                    return
                self._heartbeat_ack_received = False
                await self._send_heartbeat(ws)
                await self._sleep(interval_sec)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._logger.exception("Discord Gateway heartbeat loop failed: %s", exc)
            with contextlib.suppress(Exception):
                await ws.close(code=4000, reason="Heartbeat loop error")

    async def handle_payload(self, ws: WebSocketConnection, data: dict[str, Any]) -> str | None:
        """Process one decoded Gateway JSON frame; returns lifecycle signal if any."""
        op = data.get("op")
        if data.get("s") is not None:
            self.seq = int(data["s"])

        if op == 10:  # HELLO
            self._heartbeat_ack_received = True
            interval_ms = int((data.get("d") or {}).get("heartbeat_interval", 41250))
            await self._send_identify_or_resume(ws)
            return f"hello:{interval_ms}"

        if op == 11:  # HEARTBEAT_ACK
            self._heartbeat_ack_received = True
            return None

        if op == 1:  # HEARTBEAT request
            await self._send_heartbeat(ws)
            return None

        if op == 7:  # RECONNECT
            return "reconnect"

        if op == 9:  # INVALID_SESSION
            resumable = bool(data.get("d"))
            if not resumable:
                self.session_id = None
                self.seq = None
                self.resume_gateway_url = None
            return "reconnect"

        if op == 0:  # DISPATCH
            event_type = data.get("t")
            event_data = data.get("d") or {}
            if event_type == "READY" and isinstance(event_data, dict):
                self.session_id = str(event_data.get("session_id") or "") or None
                resume_url = event_data.get("resume_gateway_url")
                if isinstance(resume_url, str) and resume_url:
                    self.resume_gateway_url = f"{resume_url}?v=10&encoding=json"
            elif event_type == "MESSAGE_CREATE" and isinstance(event_data, dict):
                await self._handle_message_create(event_data)
        return None

    async def _handle_message_create(self, event_data: dict[str, Any]) -> None:
        author = event_data.get("author") or {}
        if not isinstance(author, dict) or author.get("bot"):
            return
        author_id = str(author.get("id") or "")
        author_name = str(author.get("username") or "unknown")
        channel_id = str(event_data.get("channel_id") or "")
        message_id = str(event_data.get("id") or "")
        content = str(event_data.get("content") or "")
        guild_id_raw = event_data.get("guild_id")
        guild_id = str(guild_id_raw) if guild_id_raw is not None else None

        if not author_id or not channel_id or not message_id:
            return
        if not self.allow_all_users:
            if not self.allowed_user_ids:
                self._logger.warning(
                    "Dropping Discord message %s from user %s: allowed_user_ids is empty "
                    "(fail-closed)",
                    message_id,
                    author_id,
                )
                return
            if author_id not in self.allowed_user_ids:
                return

        now_sec = int(time.time())
        inserted = await self._db.log_conversation_message(
            agent_id=f"discord:{channel_id}",
            chat_id=channel_id,
            direction="inbound",
            message_id=message_id,
            author_id=author_id,
            author_name=author_name,
            content=content,
            timestamp_sec=now_sec,
        )
        if not inserted:
            return

        inbound = DiscordInboundMessage(
            message_id=message_id,
            channel_id=channel_id,
            author_id=author_id,
            author_name=author_name,
            content=content,
            guild_id=guild_id,
            timestamp_sec=now_sec,
        )

        lock = self._get_channel_lock(channel_id)
        task = asyncio.create_task(self._run_inbound_task(lock, inbound))
        self._inflight_tasks.add(task)
        task.add_done_callback(self._on_task_done)

    async def run_once(self, ws: WebSocketConnection) -> str:
        """Drive a single connected Gateway session until close or reconnect signal."""
        hb_task: asyncio.Task[None] | None = None
        self._heartbeat_ack_received = True
        try:
            while not self._stop_event.is_set():
                try:
                    raw = await ws.recv()
                except ConnectionClosed as exc:
                    rcvd = getattr(exc, "rcvd", None)
                    code = int(getattr(rcvd, "code", 1000)) if rcvd is not None else 1006
                    reason = str(getattr(rcvd, "reason", "")) if rcvd is not None else ""
                    if code in FATAL_DISCORD_CLOSE_CODES:
                        raise DiscordFatalCloseError(code, reason) from exc
                    return "reconnect"

                text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
                payload = json.loads(text)
                if not isinstance(payload, dict):
                    continue
                signal = await self.handle_payload(ws, payload)
                if signal and signal.startswith("hello:"):
                    interval_ms = int(signal.split(":", 1)[1])
                    if hb_task is not None:
                        hb_task.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await hb_task
                    hb_task = asyncio.create_task(self._heartbeat_loop(ws, interval_ms))
                elif signal == "reconnect":
                    return "reconnect"
        finally:
            if hb_task is not None:
                hb_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await hb_task
            await self.drain_inflight(cancel=self._stop_event.is_set())
        return "stopped"

    async def run_forever(self) -> None:
        """Connect to Discord Gateway continuously with exponential backoff until stopped."""
        attempt = 0
        while not self._stop_event.is_set():
            target_url = self.resume_gateway_url or self._gateway_url
            try:
                async with self._connect_fn(target_url) as ws:
                    attempt = 0
                    outcome = await self.run_once(ws)
                    if outcome == "stopped":
                        return
            except DiscordFatalCloseError:
                raise
            except (OSError, TimeoutError, ConnectionClosed):
                pass

            backoff = min(60.0, float(2 ** min(attempt, 5)))
            attempt += 1
            await self._sleep(backoff)


def _default_connect(url: str) -> AbstractAsyncContextManager[WebSocketConnection]:
    return websockets.connect(url, max_size=4 * 1024 * 1024)
