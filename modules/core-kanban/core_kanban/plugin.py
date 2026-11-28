"""Microkernel plugin entrypoint for `core-kanban`."""

from __future__ import annotations

import sqlite3
from collections.abc import Sequence

from alfred.kernel.types import (
    BaseModulePlugin,
    ModuleContext,
    ModuleMigration,
    ModuleRouteDefinition,
    ModuleUiContribution,
    ProbeCheck,
    ProbeResult,
)

from .migrations import KANBAN_MIGRATIONS
from .routes import MODULE_ID, build_kanban_routes


class CoreKanbanPlugin(BaseModulePlugin):
    """Built-in SQLite-backed Kanban Board plugin."""

    id: str = MODULE_ID

    def __init__(self) -> None:
        self._ctx: ModuleContext | None = None

    def _get_ctx(self) -> ModuleContext | None:
        return self._ctx

    def create_service(self, ctx: ModuleContext) -> None:
        self._ctx = ctx
        return None

    def migrations(self) -> Sequence[ModuleMigration]:
        return KANBAN_MIGRATIONS

    def routes(self) -> Sequence[ModuleRouteDefinition]:
        return build_kanban_routes(self._get_ctx)

    def ui_contributions(self) -> Sequence[ModuleUiContribution]:
        return (
            ModuleUiContribution(
                id="kanban",
                module_id=self.id,
                slot="sidebar-page",
                title="Kanban",
                entry_file="kanban-page.js",
                route_hash="#kanban",
                order=40,
            ),
        )

    async def on_load(self, ctx: ModuleContext) -> None:
        self._ctx = ctx

    async def on_unload(self, ctx: ModuleContext) -> None:
        del ctx
        self._ctx = None

    async def wizard_probe(self, ctx: ModuleContext) -> ProbeResult:
        expected = {"kanban_projects", "labels", "kanban_cards", "kanban_comments"}

        def _check_tables(conn: sqlite3.Connection) -> set[str]:
            rows = conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' "
                "AND name IN ('kanban_projects', 'labels', 'kanban_cards', 'kanban_comments')"
            ).fetchall()
            return {str(row["name"]) for row in rows}

        present = await ctx.db.read(_check_tables)
        missing = sorted(expected - present)
        ok = not missing
        detail = (
            "All Kanban SQLite tables present"
            if ok
            else f"Missing tables: {', '.join(missing)}"
        )
        return ProbeResult(
            ok=ok,
            module_id=self.id,
            summary="Kanban schema ready" if ok else "Kanban schema incomplete",
            checks=[ProbeCheck(name="sqlite_schema", ok=ok, detail=detail)],
        )


plugin = CoreKanbanPlugin()
