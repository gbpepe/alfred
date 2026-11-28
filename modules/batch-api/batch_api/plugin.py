"""Microkernel plugin entrypoint for `batch-api` (-50% CostOps multi-provider batch)."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import httpx

from alfred.core.gcp_auth import GcpTokenProvider
from alfred.kernel.errors import ModuleDisabledError
from alfred.kernel.types import (
    BaseModulePlugin,
    HousekeepingStats,
    ModuleContext,
    ModuleMigration,
    ModuleRouteDefinition,
    ModuleToolDefinition,
    ModuleUiContribution,
    ProbeResult,
)

from .migrations import BATCH_API_MIGRATIONS
from .probe import probe as run_probe
from .routes import build_batch_routes
from .runner import BatchRunner
from .tools import build_batch_tools


class BatchApiPlugin(BaseModulePlugin):
    """Optional Alfred v2 module plugin providing SDK-free async multi-provider Batch API."""

    id: str = "batch-api"

    def __init__(
        self,
        *,
        http_client: httpx.AsyncClient | None = None,
        gcp_token_provider: GcpTokenProvider | None = None,
    ) -> None:
        self._http_client = http_client
        self._gcp_token_provider = gcp_token_provider
        self._ctx: ModuleContext | None = None
        self._runner: BatchRunner | None = None

    def _ensure_runner(self, ctx: ModuleContext) -> BatchRunner:
        self._ctx = ctx
        if self._runner is None:
            self._runner = BatchRunner(
                ctx,
                http_client=self._http_client,
                gcp_token_provider=self._gcp_token_provider,
            )
        return self._runner

    def _require_runner(self) -> BatchRunner:
        if self._runner is None:
            raise ModuleDisabledError(self.id)
        return self._runner

    @property
    def cli_env_sanitize_keys(self) -> Sequence[str]:
        """Environment keys stripped when invoking CLI child processes."""
        return ("ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY")

    def create_service(self, ctx: ModuleContext) -> BatchRunner:
        """Instantiate and register `BatchRunner` on the microkernel Service Bus."""
        return self._ensure_runner(ctx)

    def migrations(self) -> Sequence[ModuleMigration]:
        """Return versioned SQLite schema migrations for `batch_jobs`."""
        return BATCH_API_MIGRATIONS

    def tools(self) -> Sequence[ModuleToolDefinition[Any]]:
        """Expose `batch_submit`, `batch_status`, `batch_list`, and `batch_cancel` tools."""
        return build_batch_tools()

    def routes(self) -> Sequence[ModuleRouteDefinition]:
        """Expose Auth/CSRF-gated Batch API HTTP endpoints."""
        return build_batch_routes(self._require_runner)

    def ui_contributions(self) -> Sequence[ModuleUiContribution]:
        """Register the `vpsBatchCard` Dashboard UI slot contribution."""
        return (
            ModuleUiContribution(
                id="vpsBatchCard",
                module_id="batch-api",
                slot="vps-card",
                title="Batch API (-50% CostOps)",
                entry_file="batch-card.js",
                order=50,
            ),
        )

    async def wizard_probe(self, ctx: ModuleContext) -> ProbeResult:
        """Run Setup Wizard readiness checks via `probe.py`."""
        return await run_probe(ctx)

    async def on_load(self, ctx: ModuleContext) -> None:
        """Bind context and runner on module activation."""
        self._ensure_runner(ctx)

    async def on_startup(self, ctx: ModuleContext) -> None:
        """Recover crashed or active batch jobs from SQLite on daemon startup."""
        await self._ensure_runner(ctx).recover_on_startup()

    async def on_heartbeat(self, ctx: ModuleContext, now_ms: int) -> dict[str, Any] | None:
        """Poll active batch jobs non-blockingly, finalize outputs, record usage & QA mark."""
        return await self._ensure_runner(ctx).poll_active_jobs(now_ms=now_ms)

    async def on_housekeeping(
        self,
        ctx: ModuleContext,
        retention_days: int,
        disk_used_pct: float,
    ) -> HousekeepingStats:
        """Prune expired batch work files under `ctx.security.data_dir`."""
        return await self._ensure_runner(ctx).housekeep(
            retention_days=retention_days,
            disk_used_pct=disk_used_pct,
        )

    async def on_unload(self, ctx: ModuleContext) -> None:
        """Release runtime references when `batch-api` is deactivated."""
        del ctx
        self._runner = None
        self._ctx = None


plugin = BatchApiPlugin()
