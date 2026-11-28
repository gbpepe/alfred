"""Microkernel plugin entrypoint for `core-memory`."""

from __future__ import annotations

import sqlite3
from collections.abc import Sequence
from typing import Any

from alfred.kernel.types import (
    BaseModulePlugin,
    HousekeepingStats,
    ModuleContext,
    ModuleMigration,
    ModuleRouteDefinition,
    ModuleToolDefinition,
    ModuleUiContribution,
    ProbeCheck,
    ProbeResult,
)

from .engine import MemoryEngine
from .migrations import CORE_MEMORY_MIGRATIONS
from .routes import build_memory_routes
from .tools import build_memory_tools

_EXPECTED_TABLES: tuple[str, ...] = (
    "memories",
    "memories_fts",
    "memory_versions",
    "memory_uses",
)


class CoreMemoryPlugin(BaseModulePlugin):
    """Alfred v2 microkernel plugin providing namespace-isolated FTS5 memory."""

    id: str = "core-memory"

    def __init__(self) -> None:
        self._engine: MemoryEngine | None = None

    def create_service(self, ctx: ModuleContext) -> MemoryEngine:
        """Create and register the `MemoryEngine` service for `core-memory`."""
        engine = MemoryEngine(ctx.db)
        self._engine = engine
        return engine

    def migrations(self) -> Sequence[ModuleMigration]:
        """Return versioned SQLite schema & FTS5 trigger migrations."""
        return CORE_MEMORY_MIGRATIONS

    def tools(self) -> Sequence[ModuleToolDefinition[Any]]:
        """Return the `memory` LLM tool definition."""
        return build_memory_tools()

    def routes(self) -> Sequence[ModuleRouteDefinition]:
        """Return HTTP CRUD routes mounted under `/api/memories`."""
        return build_memory_routes(lambda: self._engine)

    def ui_contributions(self) -> Sequence[ModuleUiContribution]:
        """Contribute the `#memories` sidebar page to the Dashboard."""
        return (
            ModuleUiContribution(
                id="memories",
                module_id="core-memory",
                slot="sidebar-page",
                title="Memories",
                entry_file="memories-page.js",
                route_hash="#memories",
                order=30,
            ),
        )

    async def wizard_probe(self, ctx: ModuleContext) -> ProbeResult:
        """Verify SQLite schema & FTS5 tables are present and queryable."""

        def _check_schema(conn: sqlite3.Connection) -> tuple[bool, list[ProbeCheck]]:
            rows = conn.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
            ).fetchall()
            present = {str(r["name"]) for r in rows}
            checks: list[ProbeCheck] = []
            all_ok = True
            for tbl in _EXPECTED_TABLES:
                found = tbl in present
                if not found:
                    all_ok = False
                checks.append(
                    ProbeCheck(
                        name=f"table:{tbl}",
                        ok=found,
                        detail="ready" if found else "missing",
                    )
                )
            return all_ok, checks

        all_ok, checks = await ctx.db.read(_check_schema)
        return ProbeResult(
            ok=all_ok,
            module_id=self.id,
            summary="Core memory FTS5 schema ready" if all_ok else "Missing core memory tables",
            checks=checks,
        )

    async def on_load(self, ctx: ModuleContext) -> None:
        """Ensure engine handle is bound on load."""
        if self._engine is None:
            self._engine = MemoryEngine(ctx.db)

    async def on_unload(self, ctx: ModuleContext) -> None:
        """Release cached engine handle cleanly on module unload."""
        self._engine = None

    async def on_housekeeping(
        self,
        ctx: ModuleContext,
        retention_days: int,
        disk_used_pct: float,
    ) -> HousekeepingStats:
        """Prune old `memory_uses` audit records beyond retention window."""
        engine = self._engine or MemoryEngine(ctx.db)
        effective_days = max(retention_days, 30) if retention_days > 0 else 0
        deleted = await engine.purge_old_uses(retention_days=effective_days)
        return HousekeepingStats(
            module_id=self.id,
            deleted_rows=deleted,
            notes=f"pruned memory_uses older than {effective_days}d (disk={disk_used_pct:.1f}%)",
        )


plugin = CoreMemoryPlugin()
