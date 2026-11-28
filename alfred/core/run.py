"""Alfred v2 main daemon entrypoint (`python -m alfred.core.run`)."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import signal
import time
from pathlib import Path
from typing import Any

from alfred.core.agents_config import ResolvedAgent
from alfred.core.config import CoreSettings
from alfred.core.discord_adapter import DiscordRestClient
from alfred.core.discord_gateway import DiscordGatewayClient, DiscordInboundMessage
from alfred.core.logging_setup import configure_logging
from alfred.core.security.prompt_safety import wrap_untrusted
from alfred.core.web_app import CoreAppContainer, build_core_container
from alfred.kernel.loader import resolve_load_order
from alfred.kernel.types import ModelProviderRequest, ProviderMessage


class AlfredDaemon:
    """Coordinates active module hooks, Discord Gateway, and heartbeat cycles."""

    def __init__(
        self,
        container: CoreAppContainer,
        *,
        gateway: DiscordGatewayClient | None = None,
        rest_client: DiscordRestClient | None = None,
        heartbeat_interval_sec: float = 30.0,
        logger: logging.Logger | None = None,
    ) -> None:
        self.container = container
        self.gateway = gateway
        self.rest_client = rest_client
        self.heartbeat_interval_sec = heartbeat_interval_sec
        self.logger = logger or logging.getLogger("alfred.daemon")
        self._stop_event = asyncio.Event()
        self._started = False

    async def start(self) -> None:
        """Initialize DB, fail-closed Vault, active modules, and `on_startup` hooks."""
        if self._started:
            return
        await self.container.db.initialize()
        await self.container.vault.initialize()
        loaded = await self.container.loader.load_active_modules()
        for mod_id in loaded:
            plugin = self.container.registry.get_plugin(mod_id)
            ctx = self.container.registry.get_context(mod_id)
            if plugin is not None and ctx is not None:
                await plugin.on_startup(ctx)
        self._started = True

    async def handle_inbound_message(self, inbound: DiscordInboundMessage) -> str | None:
        """Sync modules across processes, route Discord message through agent, and reply."""
        await self.container.module_manager.sync_with_database()
        resolved: ResolvedAgent | None = self.container.agents.resolve_by_channel_id(
            inbound.channel_id
        )
        if resolved is None:
            return None
        agent = resolved.config
        if agent.allowed_user_ids and inbound.author_id not in agent.allowed_user_ids:
            return None

        cfg = self.container.agents.load()
        workspace_dir = (self.container.settings.project_root / Path(agent.workspace)).resolve()
        tools = self.container.tool_executor.get_schemas_for_agent(agent)
        messages: list[ProviderMessage] = [
            ProviderMessage(
                role="user",
                content=wrap_untrusted(f"discord:{inbound.author_id}", inbound.content),
            )
        ]

        reply_text = ""
        max_iters = agent.max_tool_iterations or 8
        for _ in range(max_iters):
            req = ModelProviderRequest(
                agent_id=agent.id,
                session_id=f"discord:{inbound.channel_id}",
                model=resolved.effective_model,
                messages=messages,
                system_prompt=agent.system_prompt,
                tools=tools,
                workspace_dir=workspace_dir,
                protected_paths=list(agent.protected_paths),
            )
            resp = await self.container.router.generate(
                resolved_agent=resolved,
                global_budget_usd=cfg.global_config.daily_budget_usd,
                request=req,
            )
            reply_text = resp.content
            if not resp.tool_calls:
                break

            messages.append(ProviderMessage(role="assistant", content=resp.content or ""))
            for tc in resp.tool_calls:
                tool_res = await self.container.tool_executor.execute_tool(
                    agent=agent,
                    tool_name=tc.name,
                    raw_args=tc.arguments,
                    session_id=f"discord:{inbound.channel_id}",
                    workspace_dir=workspace_dir,
                )
                messages.append(
                    ProviderMessage(
                        role="tool",
                        tool_call_id=tc.id,
                        name=tc.name,
                        content=json.dumps(tool_res.model_dump(mode="json"), ensure_ascii=False),
                    )
                )

        if reply_text and self.rest_client is not None:
            await self.rest_client.send_message(
                inbound.channel_id,
                reply_text,
                reply_to_message_id=inbound.message_id,
            )
        return reply_text

    async def run_heartbeat_tick(self, now_ms: int | None = None) -> dict[str, Any]:
        """Execute one heartbeat sweep: hot-sync modules, prune holds, dispatch `on_heartbeat`."""
        ts_ms = now_ms if now_ms is not None else int(time.time() * 1000)
        await self.container.module_manager.sync_with_database()
        await self.container.heavy_job.prune_stale_holds()

        results: dict[str, Any] = {}
        for mod_id in self.container.registry.active_module_ids():
            plugin = self.container.registry.get_plugin(mod_id)
            ctx = self.container.registry.get_context(mod_id)
            if plugin is None or ctx is None:
                continue
            try:
                outcome = await plugin.on_heartbeat(ctx, ts_ms)
                if outcome is not None:
                    results[mod_id] = outcome
            except Exception as exc:
                self.logger.exception("Heartbeat hook failed for module '%s': %s", mod_id, exc)
        return results

    async def _heartbeat_loop(self) -> None:
        while not self._stop_event.is_set():
            await self.run_heartbeat_tick()
            try:
                await asyncio.wait_for(
                    self._stop_event.wait(),
                    timeout=self.heartbeat_interval_sec,
                )
            except TimeoutError:
                continue

    def stop(self) -> None:
        """Request clean shutdown on signal without awaiting inside signal handler."""
        self._stop_event.set()
        if self.gateway is not None:
            self.gateway.stop()

    async def shutdown(self) -> None:
        """Stop gateway, unload modules in reverse DAG order & close SQLite."""
        self.stop()
        active_ids = set(self.container.registry.active_module_ids())
        if active_ids:
            manifests = {
                mid: pair[1]
                for mid, pair in self.container.loader.discover().items()
                if mid in active_ids
            }
            order = resolve_load_order(manifests, active_ids)
            for mid in reversed(order):
                await self.container.registry.unregister_module(mid, force=True)
        await self.container.db.close()

    async def run_until_stopped(self) -> None:
        """Start daemon tasks and run until `stop()` / signal."""
        await self.start()
        tasks: list[asyncio.Task[None]] = [asyncio.create_task(self._heartbeat_loop())]
        if self.gateway is not None:
            tasks.append(asyncio.create_task(self.gateway.run_forever()))
        try:
            await self._stop_event.wait()
        finally:
            await self.shutdown()
            for task in tasks:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task


async def run_daemon(settings: CoreSettings | None = None) -> None:
    """Create container, configure Discord clients if token present, and serve until SIGTERM."""
    configure_logging(level=os.environ.get("ALFRED_LOG_LEVEL", "INFO"))
    container = build_core_container(settings)
    bot_token = (
        await container.vault.get_secret("DISCORD_BOT_TOKEN")
        or os.environ.get("DISCORD_BOT_TOKEN", "").strip()
    )
    rest_client = DiscordRestClient(bot_token=bot_token) if bot_token else None
    daemon = AlfredDaemon(container, rest_client=rest_client)
    if bot_token:
        allowed_raw = os.environ.get("ALLOWED_USER_IDS", "")
        allowed_ids = frozenset(uid.strip() for uid in allowed_raw.split(",") if uid.strip())

        async def _dispatch_inbound(msg: DiscordInboundMessage) -> None:
            await daemon.handle_inbound_message(msg)

        daemon.gateway = DiscordGatewayClient(
            bot_token=bot_token,
            db=container.db,
            on_message=_dispatch_inbound,
            allowed_user_ids=allowed_ids,
        )

    loop = asyncio.get_running_loop()
    for sig_name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, sig_name, None)
        if sig is not None:
            with contextlib.suppress(NotImplementedError):
                loop.add_signal_handler(sig, daemon.stop)

    await daemon.run_until_stopped()


def main() -> None:
    """CLI entrypoint for `python -m alfred.core.run`."""
    asyncio.run(run_daemon())


if __name__ == "__main__":
    main()
