"""Alfred v2 `core-ops` module package (2 GB VPS telemetry, housekeeping, ops tools)."""

from __future__ import annotations

from .housekeeper import Housekeeper, HousekeepingReport, WalCheckpointStats
from .plugin import CoreOpsPlugin, plugin
from .system_monitor import (
    DiskTelemetry,
    MemoryTelemetry,
    PsiMetric,
    PsiTelemetry,
    StorageBreakdown,
    StorageEntry,
    VpsTelemetryReport,
    collect_storage_breakdown,
    collect_telemetry,
    parse_proc_meminfo,
    parse_proc_pressure,
)

__all__ = [
    "CoreOpsPlugin",
    "DiskTelemetry",
    "Housekeeper",
    "HousekeepingReport",
    "MemoryTelemetry",
    "PsiMetric",
    "PsiTelemetry",
    "StorageBreakdown",
    "StorageEntry",
    "VpsTelemetryReport",
    "WalCheckpointStats",
    "collect_storage_breakdown",
    "collect_telemetry",
    "parse_proc_meminfo",
    "parse_proc_pressure",
    "plugin",
]
