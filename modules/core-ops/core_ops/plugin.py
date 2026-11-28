"""`core-ops` module plugin entrypoint implementing `AlfredModulePlugin`."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from alfred.kernel.errors import ModuleDisabledError
from alfred.kernel.types import (
    BaseModulePlugin,
    HousekeepingStats,
    ModuleContext,
    ModuleRouteDefinition,
    ModuleToolDefinition,
    ModuleUiContribution,
    ProbeCheck,
    ProbeResult,
)

from .housekeeper import Housekeeper
from .routes import build_ops_routes
from .system_monitor import collect_telemetry
from .tools import build_ops_tools


class CoreOpsPlugin(BaseModulePlugin):
    """Built-in VPS telemetry, heavy-job-aware housekeeping & ops orchestration plugin."""

    id: str = "core-ops"

    def __init__(self) -> None:
        self._ctx: ModuleContext | None = None

    def _require_ctx(self) -> ModuleContext:
        if self._ctx is None:
            raise ModuleDisabledError(self.id)
        return self._ctx

    def create_service(self, ctx: ModuleContext) -> Any:
        self._ctx = ctx
        return None

    def tools(self) -> Sequence[ModuleToolDefinition[Any]]:
        return build_ops_tools()

    def routes(self) -> Sequence[ModuleRouteDefinition]:
        return build_ops_routes(self._require_ctx)

    def ui_contributions(self) -> Sequence[ModuleUiContribution]:
        return (
            ModuleUiContribution(
                id="vpsStorageCard",
                module_id="core-ops",
                slot="vps-card",
                title="VPS Storage & Telemetry",
                entry_file="storage-card.js",
                order=20,
            ),
        )

    async def on_load(self, ctx: ModuleContext) -> None:
        self._ctx = ctx

    async def on_unload(self, ctx: ModuleContext) -> None:
        self._ctx = None

    async def wizard_probe(self, ctx: ModuleContext) -> ProbeResult:
        report = await collect_telemetry(ctx)
        cli_ok = ctx.modules.get_service("core-cli") is not None
        checks = [
            ProbeCheck(
                name="telemetry",
                ok=True,
                detail=(
                    f"RAM {report.memory.used_pct:.1f}%, "
                    f"Disk {report.disk.used_pct:.1f}%, "
                    f"Holds {report.active_heavy_holds}"
                ),
            ),
            ProbeCheck(
                name="core_cli_service",
                ok=cli_ok,
                detail="core-cli Service Bus available" if cli_ok else "core-cli service inactive",
            ),
        ]
        return ProbeResult(
            ok=True,
            module_id=self.id,
            summary=f"VPS health={report.health_level}, holds={report.active_heavy_holds}",
            checks=checks,
        )

    async def on_housekeeping(
        self,
        ctx: ModuleContext,
        retention_days: int,
        disk_used_pct: float,
    ) -> HousekeepingStats:
        report = await Housekeeper().run(
            ctx,
            retention_days=retention_days,
            disk_used_pct=disk_used_pct,
            aggregate_modules=False,
        )
        return HousekeepingStats(
            module_id=self.id,
            deleted_rows=report.pruned_db_rows,
            freed_bytes=report.freed_bytes,
            notes=report.notes,
        )


plugin = CoreOpsPlugin()
