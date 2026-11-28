"""Heavy-job-aware SQLite WAL housekeeping, retention pruning & module cleanup aggregation."""

from __future__ import annotations

import asyncio
import os
import sqlite3
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

from pydantic import BaseModel, ConfigDict, Field

from alfred.kernel.types import HousekeepingStats, ModuleContext

from .system_monitor import measure_disk_usage

_PROTECTED_FILENAMES: Final[frozenset[str]] = frozenset(
    {
        "vault.json",
        ".vault-key",
        ".heavy-job.lock",
        ".modules-generation",
        ".dashboard-token",
        ".env",
        ".env.test",
        ".env.example",
    }
)
_PROTECTED_SUFFIXES: Final[tuple[str, ...]] = (".db", ".db-wal", ".db-shm")
_PRUNABLE_LOG_SUFFIXES: Final[tuple[str, ...]] = (".log", ".gz", ".jsonl", ".txt")
_TEMP_MAX_AGE_SECONDS: Final[int] = 86_400


class WalCheckpointStats(BaseModel):
    """Result of SQLite WAL checkpoint (or skip when heavy-job holds are active)."""

    model_config = ConfigDict(extra="forbid")

    executed: bool = False
    mode: str = "skipped"
    busy: int = Field(default=0, ge=0)
    log_frames: int = Field(default=0, ge=0)
    checkpointed_frames: int = Field(default=0, ge=0)
    wal_bytes_before: int = Field(default=0, ge=0)
    wal_bytes_after: int = Field(default=0, ge=0)
    reclaimed_bytes: int = Field(default=0, ge=0)
    vacuumed: bool = False


class HousekeepingReport(BaseModel):
    """Structured report produced by `Housekeeper.run()`."""

    model_config = ConfigDict(extra="forbid")

    executed_at: str
    retention_days: int = Field(ge=1)
    disk_used_pct: float = Field(ge=0.0, le=100.0)
    gentle_mode: bool = False
    active_hold_count: int = Field(default=0, ge=0)
    active_hold_labels: list[str] = Field(default_factory=list)
    wal_checkpoint: WalCheckpointStats
    pruned_db_rows: int = Field(default=0, ge=0)
    pruned_log_files: list[str] = Field(default_factory=list)
    pruned_temp_files: list[str] = Field(default_factory=list)
    freed_bytes: int = Field(default=0, ge=0)
    module_results: list[HousekeepingStats] = Field(default_factory=list)
    notes: str = ""


def _stat_size_sync(path: Path) -> int:
    try:
        if path.is_file() and not path.is_symlink():
            return int(path.stat().st_size)
    except OSError:
        return 0
    return 0


def _is_protected_path(path: Path) -> bool:
    name = path.name
    if name in _PROTECTED_FILENAMES:
        return True
    return name.endswith(_PROTECTED_SUFFIXES)


def _prune_old_files_sync(
    *,
    logs_dir: Path,
    store_dir: Path,
    retention_days: int,
    now_sec: float,
) -> tuple[list[str], list[str], int]:
    deleted_logs: list[str] = []
    deleted_temps: list[str] = []
    freed_bytes = 0
    log_cutoff = now_sec - (retention_days * 86_400)
    tmp_cutoff = now_sec - _TEMP_MAX_AGE_SECONDS

    if logs_dir.is_dir():
        try:
            with os.scandir(logs_dir) as it:
                for entry in it:
                    try:
                        if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                            continue
                        target = Path(entry.path)
                        if _is_protected_path(target):
                            continue
                        st = entry.stat(follow_symlinks=False)
                        is_tmp = target.name.endswith(".tmp")
                        if is_tmp and st.st_mtime < tmp_cutoff:
                            target.unlink()
                            deleted_temps.append(target.name)
                            freed_bytes += int(st.st_size)
                        elif (
                            target.name.endswith(_PRUNABLE_LOG_SUFFIXES)
                            and st.st_mtime < log_cutoff
                        ):
                            target.unlink()
                            deleted_logs.append(target.name)
                            freed_bytes += int(st.st_size)
                    except OSError:
                        continue
        except OSError:
            pass

    if store_dir.is_dir():
        try:
            with os.scandir(store_dir) as it:
                for entry in it:
                    try:
                        if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                            continue
                        target = Path(entry.path)
                        if _is_protected_path(target) or not target.name.endswith(".tmp"):
                            continue
                        st = entry.stat(follow_symlinks=False)
                        if st.st_mtime < tmp_cutoff:
                            target.unlink()
                            deleted_temps.append(target.name)
                            freed_bytes += int(st.st_size)
                    except OSError:
                        continue
        except OSError:
            pass

    return sorted(deleted_logs), sorted(deleted_temps), freed_bytes


def _prune_db_rows_sync(conn: sqlite3.Connection, cutoff_ts: int) -> int:
    total_deleted = 0
    for table_name in ("conversation_log", "compute_usage", "token_usage"):
        exists = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table_name,),
        ).fetchone()
        if exists is None:
            continue
        cursor = conn.execute(
            f"DELETE FROM {table_name} WHERE timestamp < ?",  # noqa: S608
            (cutoff_ts,),
        )
        total_deleted += max(0, int(cursor.rowcount))
    return total_deleted


class Housekeeper:
    """Heavy-job-aware SQLite WAL, retention & cross-module housekeeping orchestrator."""

    async def run(
        self,
        ctx: ModuleContext,
        *,
        retention_days: int = 30,
        disk_used_pct: float | None = None,
        aggregate_modules: bool = True,
    ) -> HousekeepingReport:
        """Execute housekeeping sweep; enter gentle mode if heavy-job holds are active."""
        safe_retention = max(1, int(retention_days))
        resolved_disk_pct = (
            float(disk_used_pct)
            if disk_used_pct is not None
            else await asyncio.to_thread(lambda: measure_disk_usage(ctx.project_root).used_pct)
        )
        resolved_disk_pct = max(0.0, min(100.0, resolved_disk_pct))
        executed_at = datetime.now(tz=UTC).isoformat()

        holds = await ctx.heavy_job.active_holds()
        if holds:
            hold_labels = [hold.label for hold in holds]
            module_results: list[HousekeepingStats] = []
            if aggregate_modules:
                module_results = await ctx.modules.run_all_housekeeping(
                    retention_days=safe_retention,
                    disk_used_pct=resolved_disk_pct,
                    exclude_module_ids=frozenset({"core-ops"}),
                )
            return HousekeepingReport(
                executed_at=executed_at,
                retention_days=safe_retention,
                disk_used_pct=resolved_disk_pct,
                gentle_mode=True,
                active_hold_count=len(holds),
                active_hold_labels=hold_labels,
                wal_checkpoint=WalCheckpointStats(executed=False, mode="skipped"),
                pruned_db_rows=0,
                pruned_log_files=[],
                pruned_temp_files=[],
                freed_bytes=0,
                module_results=module_results,
                notes=(
                    f"Gentle mode active ({len(holds)} heavy-job hold(s)); "
                    "skipped TRUNCATE WAL checkpoint and destructive pruning"
                ),
            )

        wal_path = Path(f"{ctx.db.db_path}-wal")
        wal_before = await asyncio.to_thread(_stat_size_sync, wal_path)
        busy, log_frames, checkpointed_frames = await ctx.db.wal_checkpoint("TRUNCATE")
        wal_after = await asyncio.to_thread(_stat_size_sync, wal_path)
        wal_reclaimed = max(0, wal_before - wal_after)

        now_sec = time.time()
        cutoff_ts = int(now_sec) - (safe_retention * 86_400)
        pruned_db_rows = await ctx.db.write(lambda conn: _prune_db_rows_sync(conn, cutoff_ts))

        pruned_logs, pruned_temps, file_freed = await asyncio.to_thread(
            _prune_old_files_sync,
            logs_dir=ctx.project_root / "logs",
            store_dir=ctx.db.db_path.parent,
            retention_days=safe_retention,
            now_sec=now_sec,
        )

        module_results = []
        if aggregate_modules:
            module_results = await ctx.modules.run_all_housekeeping(
                retention_days=safe_retention,
                disk_used_pct=resolved_disk_pct,
                exclude_module_ids=frozenset({"core-ops"}),
            )

        total_freed = wal_reclaimed + file_freed
        wal_stats = WalCheckpointStats(
            executed=True,
            mode="TRUNCATE",
            busy=max(0, int(busy)),
            log_frames=max(0, int(log_frames)),
            checkpointed_frames=max(0, int(checkpointed_frames)),
            wal_bytes_before=wal_before,
            wal_bytes_after=wal_after,
            reclaimed_bytes=wal_reclaimed,
            vacuumed=False,
        )
        return HousekeepingReport(
            executed_at=executed_at,
            retention_days=safe_retention,
            disk_used_pct=resolved_disk_pct,
            gentle_mode=False,
            active_hold_count=0,
            active_hold_labels=[],
            wal_checkpoint=wal_stats,
            pruned_db_rows=pruned_db_rows,
            pruned_log_files=pruned_logs,
            pruned_temp_files=pruned_temps,
            freed_bytes=total_freed,
            module_results=module_results,
            notes="Full housekeeping completed",
        )
