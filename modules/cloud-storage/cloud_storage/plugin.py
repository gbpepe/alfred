"""Microkernel plugin entrypoint for `cloud-storage`."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import httpx

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

from .engine import CloudStorageEngine
from .migrations import CLOUD_STORAGE_MIGRATIONS
from .models import CLOUD_CLI_ENV_SANITIZE_KEYS, MODULE_ID
from .probe import probe as run_cloud_probe
from .routes import build_cloud_routes
from .tools import build_cloud_tools


class CloudStoragePlugin(BaseModulePlugin):
    """Alfred v2 optional plugin for SDK-free streaming multi-cloud storage."""

    id: str = MODULE_ID

    def __init__(self, *, http_client: httpx.AsyncClient | None = None) -> None:
        self._http_client = http_client
        self._engine: CloudStorageEngine | None = None

    def _get_engine(self) -> CloudStorageEngine | None:
        return self._engine

    @property
    def cli_env_sanitize_keys(self) -> Sequence[str]:
        """Cloud OAuth2 client secrets and refresh token keys stripped from CLI child envs."""
        return CLOUD_CLI_ENV_SANITIZE_KEYS

    def create_service(self, ctx: ModuleContext) -> CloudStorageEngine:
        """Instantiate and register `CloudStorageEngine` on the microkernel Service Bus."""
        engine = CloudStorageEngine(ctx, http_client=self._http_client)
        self._engine = engine
        return engine

    def migrations(self) -> Sequence[ModuleMigration]:
        """Return idempotent SQLite migrations for `cloud_activity_log`."""
        return CLOUD_STORAGE_MIGRATIONS

    def tools(self) -> Sequence[ModuleToolDefinition[Any]]:
        """Expose the 5 `cloud_*` LLM tools."""
        return build_cloud_tools(self._get_engine)

    def routes(self) -> Sequence[ModuleRouteDefinition]:
        """Expose Auth/CSRF-gated OAuth2 PKCE, status, activity, and cloud file routes."""
        return build_cloud_routes(self._get_engine)

    def ui_contributions(self) -> Sequence[ModuleUiContribution]:
        """Contribute `vpsCloudStorageCard` to the Dashboard `#vps` slot."""
        return (
            ModuleUiContribution(
                id="vpsCloudStorageCard",
                module_id=MODULE_ID,
                slot="vps-card",
                title="Cloud Storage",
                entry_file="cloud-card.js",
                order=60,
            ),
        )

    async def wizard_probe(self, ctx: ModuleContext) -> ProbeResult:
        """Run 0-token Vault & configuration readiness probe."""
        return await run_cloud_probe(ctx)

    async def on_load(self, ctx: ModuleContext) -> None:
        """Ensure engine handle is bound on load."""
        if self._engine is None:
            self._engine = CloudStorageEngine(ctx, http_client=self._http_client)

    async def on_unload(self, ctx: ModuleContext) -> None:
        """Close owned HTTP client and clear in-memory caches cleanly on unload."""
        del ctx
        if self._engine is not None:
            await self._engine.aclose()
            self._engine = None

    async def on_housekeeping(
        self,
        ctx: ModuleContext,
        retention_days: int,
        disk_used_pct: float,
    ) -> HousekeepingStats:
        """Prune stale `.part` temp files and expired `cloud_activity_log` rows."""
        engine = self._engine or CloudStorageEngine(ctx, http_client=self._http_client)
        return await engine.run_housekeeping(
            retention_days=retention_days,
            disk_used_pct=disk_used_pct,
        )


plugin = CloudStoragePlugin()
