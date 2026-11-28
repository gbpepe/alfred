"""2 GB VPS telemetry collector: `/proc/meminfo`, Linux PSI, disk usage & storage sizes."""

from __future__ import annotations

import asyncio
import contextlib
import ctypes
import os
import re
import shutil
import socket
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Final, Literal

from pydantic import BaseModel, ConfigDict, Field

from alfred.kernel.types import ModuleContext

_MEMINFO_LINE_RE: Final[re.Pattern[str]] = re.compile(
    r"^([A-Za-z0-9_()]+):\s+(\d+)(?:\s+kB)?$",
    re.IGNORECASE,
)
_VMRSS_LINE_RE: Final[re.Pattern[str]] = re.compile(
    r"^VmRSS:\s+(\d+)\s+kB$",
    re.IGNORECASE,
)


class _MemoryStatusEx(ctypes.Structure):
    _fields_ = [
        ("dwLength", ctypes.c_ulong),
        ("dwMemoryLoad", ctypes.c_ulong),
        ("ullTotalPhys", ctypes.c_uint64),
        ("ullAvailPhys", ctypes.c_uint64),
        ("ullTotalPageFile", ctypes.c_uint64),
        ("ullAvailPageFile", ctypes.c_uint64),
        ("ullTotalVirtual", ctypes.c_uint64),
        ("ullAvailVirtual", ctypes.c_uint64),
        ("ullAvailExtendedVirtual", ctypes.c_uint64),
    ]


class _ProcessMemoryCounters(ctypes.Structure):
    _fields_ = [
        ("cb", ctypes.c_ulong),
        ("PageFaultCount", ctypes.c_ulong),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]


class ParsedProcMeminfo(BaseModel):
    """Parsed values from Linux `/proc/meminfo` in bytes."""

    model_config = ConfigDict(extra="forbid")

    total_bytes: int = Field(ge=0)
    available_bytes: int = Field(ge=0)
    free_bytes: int = Field(ge=0)
    buffers_bytes: int = Field(ge=0)
    cached_bytes: int = Field(ge=0)
    swap_total_bytes: int = Field(ge=0)
    swap_free_bytes: int = Field(ge=0)


class MemoryTelemetry(BaseModel):
    """System and current-process memory utilization."""

    model_config = ConfigDict(extra="forbid")

    source: Literal["proc_meminfo", "windows_global_memory", "posix_sysconf", "fallback"]
    total_bytes: int = Field(ge=0)
    available_bytes: int = Field(ge=0)
    used_bytes: int = Field(ge=0)
    used_pct: float = Field(ge=0.0, le=100.0)
    total_mb: float = Field(ge=0.0)
    available_mb: float = Field(ge=0.0)
    used_mb: float = Field(ge=0.0)
    swap_total_bytes: int = Field(default=0, ge=0)
    swap_free_bytes: int = Field(default=0, ge=0)
    swap_used_bytes: int = Field(default=0, ge=0)
    swap_used_pct: float = Field(default=0.0, ge=0.0, le=100.0)
    process_rss_bytes: int = Field(default=0, ge=0)
    process_rss_mb: float = Field(default=0.0, ge=0.0)


class PsiMetric(BaseModel):
    """Linux Pressure Stall Information (PSI) metric for a single resource."""

    model_config = ConfigDict(extra="forbid")

    available: bool = False
    some_avg10: float = Field(default=0.0, ge=0.0)
    some_avg60: float = Field(default=0.0, ge=0.0)
    some_avg300: float = Field(default=0.0, ge=0.0)
    some_total_us: int = Field(default=0, ge=0)
    full_avg10: float | None = Field(default=None, ge=0.0)
    full_avg60: float | None = Field(default=None, ge=0.0)
    full_avg300: float | None = Field(default=None, ge=0.0)
    full_total_us: int | None = Field(default=None, ge=0)


class PsiTelemetry(BaseModel):
    """Combined Linux `/proc/pressure/{cpu,memory,io}` metrics."""

    model_config = ConfigDict(extra="forbid")

    cpu: PsiMetric = Field(default_factory=PsiMetric)
    memory: PsiMetric = Field(default_factory=PsiMetric)
    io: PsiMetric = Field(default_factory=PsiMetric)


class DiskTelemetry(BaseModel):
    """Filesystem disk usage snapshot via `shutil.disk_usage`."""

    model_config = ConfigDict(extra="forbid")

    path: str
    total_bytes: int = Field(ge=0)
    used_bytes: int = Field(ge=0)
    free_bytes: int = Field(ge=0)
    used_pct: float = Field(ge=0.0, le=100.0)


class StorageEntry(BaseModel):
    """Measured size and file count for a tracked Alfred directory/artifact."""

    model_config = ConfigDict(extra="forbid")

    key: Literal["workspace", "store", "db", "logs"]
    path: str
    exists: bool
    bytes: int = Field(ge=0)
    mb: float = Field(ge=0.0)
    file_count: int = Field(default=0, ge=0)


class StorageBreakdown(BaseModel):
    """Breakdown of workspace, store, SQLite DB/WAL, and logs disk footprint."""

    model_config = ConfigDict(extra="forbid")

    workspace_bytes: int = Field(default=0, ge=0)
    store_bytes: int = Field(default=0, ge=0)
    db_bytes: int = Field(default=0, ge=0)
    db_wal_bytes: int = Field(default=0, ge=0)
    db_shm_bytes: int = Field(default=0, ge=0)
    logs_bytes: int = Field(default=0, ge=0)
    total_tracked_bytes: int = Field(default=0, ge=0)
    entries: list[StorageEntry] = Field(default_factory=list)


class VpsTelemetryReport(BaseModel):
    """Complete 2 GB VPS telemetry report combining RAM, PSI, SSD, storage & holds."""

    model_config = ConfigDict(extra="forbid")

    captured_at: str
    hostname: str
    platform: str
    memory: MemoryTelemetry
    psi: PsiTelemetry
    disk: DiskTelemetry
    storage: StorageBreakdown
    active_heavy_holds: int = Field(default=0, ge=0)
    heavy_hold_labels: list[str] = Field(default_factory=list)
    health_level: Literal["ok", "warn", "crit"] = "ok"
    warnings: list[str] = Field(default_factory=list)


def _to_mb(num_bytes: int) -> float:
    return round(num_bytes / 1_048_576, 2)


def _to_pct(used: int, total: int) -> float:
    if total <= 0:
        return 0.0
    raw = (used / total) * 100.0
    return round(max(0.0, min(100.0, raw)), 2)


def _clamp_threshold_pct(env_name: str, default: float) -> float:
    raw = os.environ.get(env_name, "").strip()
    if not raw:
        return default
    try:
        val = float(raw)
    except ValueError:
        return default
    return max(1.0, min(100.0, val))


def parse_proc_meminfo(raw: str) -> ParsedProcMeminfo | None:
    """Parse Linux `/proc/meminfo` text cleanly into byte counters."""
    values_kb: dict[str, int] = {}
    for line in raw.splitlines():
        match = _MEMINFO_LINE_RE.match(line.strip())
        if match is None:
            continue
        values_kb[match.group(1)] = int(match.group(2))

    mem_total_kb = values_kb.get("MemTotal")
    if mem_total_kb is None or mem_total_kb <= 0:
        return None

    mem_free_kb = values_kb.get("MemFree", 0)
    buffers_kb = values_kb.get("Buffers", 0)
    cached_kb = values_kb.get("Cached", 0)
    mem_avail_kb = values_kb.get(
        "MemAvailable",
        min(mem_total_kb, mem_free_kb + buffers_kb + cached_kb),
    )
    swap_total_kb = values_kb.get("SwapTotal", 0)
    swap_free_kb = values_kb.get("SwapFree", 0)

    total_bytes = mem_total_kb * 1024
    avail_bytes = max(0, min(total_bytes, mem_avail_kb * 1024))
    swap_total_bytes = max(0, swap_total_kb * 1024)
    swap_free_bytes = max(0, min(swap_total_bytes, swap_free_kb * 1024))

    return ParsedProcMeminfo(
        total_bytes=total_bytes,
        available_bytes=avail_bytes,
        free_bytes=max(0, mem_free_kb * 1024),
        buffers_bytes=max(0, buffers_kb * 1024),
        cached_bytes=max(0, cached_kb * 1024),
        swap_total_bytes=swap_total_bytes,
        swap_free_bytes=swap_free_bytes,
    )


def parse_proc_pressure(raw: str) -> PsiMetric:
    """Parse Linux `/proc/pressure/{cpu,memory,io}` contents into `PsiMetric`."""
    some_vals: dict[str, float] = {}
    full_vals: dict[str, float] = {}
    parsed_any = False

    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        parts = stripped.split()
        kind = parts[0]
        if kind not in ("some", "full"):
            continue
        target = some_vals if kind == "some" else full_vals
        for token in parts[1:]:
            if "=" not in token:
                continue
            key, val_str = token.split("=", 1)
            try:
                target[key] = float(val_str)
                parsed_any = True
            except ValueError:
                continue

    if not parsed_any:
        return PsiMetric(available=False)

    has_full = bool(full_vals)
    return PsiMetric(
        available=True,
        some_avg10=max(0.0, some_vals.get("avg10", 0.0)),
        some_avg60=max(0.0, some_vals.get("avg60", 0.0)),
        some_avg300=max(0.0, some_vals.get("avg300", 0.0)),
        some_total_us=max(0, int(some_vals.get("total", 0.0))),
        full_avg10=max(0.0, full_vals.get("avg10", 0.0)) if has_full else None,
        full_avg60=max(0.0, full_vals.get("avg60", 0.0)) if has_full else None,
        full_avg300=max(0.0, full_vals.get("avg300", 0.0)) if has_full else None,
        full_total_us=max(0, int(full_vals.get("total", 0.0))) if has_full else None,
    )


def _read_windows_physical_memory() -> tuple[int, int] | None:
    if os.name != "nt":
        return None
    windll = getattr(ctypes, "windll", None)
    if windll is None:
        return None
    status = _MemoryStatusEx()
    status.dwLength = ctypes.sizeof(_MemoryStatusEx)
    try:
        ok = windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
    except OSError:
        return None
    if not ok:
        return None
    return int(status.ullTotalPhys), int(status.ullAvailPhys)


def _read_posix_sysconf_memory() -> tuple[int, int] | None:
    sysconf = getattr(os, "sysconf", None)
    if not callable(sysconf):
        return None
    try:
        page_size = int(sysconf("SC_PAGE_SIZE"))
        phys_pages = int(sysconf("SC_PHYS_PAGES"))
    except (ValueError, OSError, TypeError):
        return None
    total = max(0, page_size * phys_pages)
    if total <= 0:
        return None
    avail = total
    with contextlib.suppress(ValueError, OSError, TypeError):
        avail_pages = int(sysconf("SC_AVPHYS_PAGES"))
        avail = max(0, min(total, page_size * avail_pages))
    return total, avail


def _read_process_rss_bytes(proc_root: Path) -> int:
    status_path = proc_root / "self" / "status"
    if status_path.is_file():
        try:
            for line in status_path.read_text(encoding="utf-8", errors="ignore").splitlines():
                match = _VMRSS_LINE_RE.match(line.strip())
                if match is not None:
                    return int(match.group(1)) * 1024
        except OSError:
            pass

    if os.name == "nt":
        windll = getattr(ctypes, "windll", None)
        if windll is not None:
            counters = _ProcessMemoryCounters()
            counters.cb = ctypes.sizeof(_ProcessMemoryCounters)
            try:
                handle = windll.kernel32.GetCurrentProcess()
                ok = windll.kernel32.K32GetProcessMemoryInfo(
                    handle,
                    ctypes.byref(counters),
                    counters.cb,
                )
                if ok:
                    return int(counters.WorkingSetSize)
            except (AttributeError, OSError):
                return 0
    return 0


def read_memory_telemetry(*, proc_root: Path = Path("/proc")) -> MemoryTelemetry:
    """Read memory telemetry from `/proc/meminfo` with clean stdlib non-Linux fallbacks."""
    rss_bytes = _read_process_rss_bytes(proc_root)
    meminfo_path = proc_root / "meminfo"
    parsed: ParsedProcMeminfo | None = None
    if meminfo_path.is_file():
        try:
            parsed = parse_proc_meminfo(meminfo_path.read_text(encoding="utf-8", errors="ignore"))
        except OSError:
            parsed = None

    if parsed is not None:
        used = max(0, parsed.total_bytes - parsed.available_bytes)
        swap_used = max(0, parsed.swap_total_bytes - parsed.swap_free_bytes)
        return MemoryTelemetry(
            source="proc_meminfo",
            total_bytes=parsed.total_bytes,
            available_bytes=parsed.available_bytes,
            used_bytes=used,
            used_pct=_to_pct(used, parsed.total_bytes),
            total_mb=_to_mb(parsed.total_bytes),
            available_mb=_to_mb(parsed.available_bytes),
            used_mb=_to_mb(used),
            swap_total_bytes=parsed.swap_total_bytes,
            swap_free_bytes=parsed.swap_free_bytes,
            swap_used_bytes=swap_used,
            swap_used_pct=_to_pct(swap_used, parsed.swap_total_bytes),
            process_rss_bytes=rss_bytes,
            process_rss_mb=_to_mb(rss_bytes),
        )

    win_mem = _read_windows_physical_memory()
    if win_mem is not None:
        total, avail = win_mem
        used = max(0, total - avail)
        return MemoryTelemetry(
            source="windows_global_memory",
            total_bytes=total,
            available_bytes=avail,
            used_bytes=used,
            used_pct=_to_pct(used, total),
            total_mb=_to_mb(total),
            available_mb=_to_mb(avail),
            used_mb=_to_mb(used),
            process_rss_bytes=rss_bytes,
            process_rss_mb=_to_mb(rss_bytes),
        )

    posix_mem = _read_posix_sysconf_memory()
    if posix_mem is not None:
        total, avail = posix_mem
        used = max(0, total - avail)
        return MemoryTelemetry(
            source="posix_sysconf",
            total_bytes=total,
            available_bytes=avail,
            used_bytes=used,
            used_pct=_to_pct(used, total),
            total_mb=_to_mb(total),
            available_mb=_to_mb(avail),
            used_mb=_to_mb(used),
            process_rss_bytes=rss_bytes,
            process_rss_mb=_to_mb(rss_bytes),
        )

    return MemoryTelemetry(
        source="fallback",
        total_bytes=0,
        available_bytes=0,
        used_bytes=0,
        used_pct=0.0,
        total_mb=0.0,
        available_mb=0.0,
        used_mb=0.0,
        process_rss_bytes=rss_bytes,
        process_rss_mb=_to_mb(rss_bytes),
    )


def read_psi_telemetry(*, proc_root: Path = Path("/proc")) -> PsiTelemetry:
    """Read Linux `/proc/pressure/{cpu,memory,io}`, returning unavailable metrics elsewhere."""
    pressure_dir = proc_root / "pressure"

    def _read_one(name: str) -> PsiMetric:
        target = pressure_dir / name
        if not target.is_file():
            return PsiMetric(available=False)
        try:
            return parse_proc_pressure(target.read_text(encoding="utf-8", errors="ignore"))
        except OSError:
            return PsiMetric(available=False)

    return PsiTelemetry(
        cpu=_read_one("cpu"),
        memory=_read_one("memory"),
        io=_read_one("io"),
    )


def measure_disk_usage(target_path: Path) -> DiskTelemetry:
    """Measure filesystem space using `shutil.disk_usage`, walking up if needed."""
    probe = target_path.resolve()
    while not probe.exists() and probe.parent != probe:
        probe = probe.parent
    try:
        usage = shutil.disk_usage(probe)
    except OSError:
        return DiskTelemetry(
            path=str(probe),
            total_bytes=0,
            used_bytes=0,
            free_bytes=0,
            used_pct=0.0,
        )
    total = int(usage.total)
    used = int(usage.used)
    free = int(usage.free)
    return DiskTelemetry(
        path=str(probe),
        total_bytes=total,
        used_bytes=used,
        free_bytes=free,
        used_pct=_to_pct(used, total),
    )


def _scan_dir_sync(root: Path) -> tuple[bool, int, int]:
    if not root.exists() or not root.is_dir():
        return False, 0, 0
    total_bytes = 0
    file_count = 0
    stack: list[Path] = [root]
    while stack:
        current = stack.pop()
        try:
            with os.scandir(current) as it:
                for entry in it:
                    try:
                        if entry.is_symlink():
                            continue
                        if entry.is_file(follow_symlinks=False):
                            total_bytes += int(entry.stat(follow_symlinks=False).st_size)
                            file_count += 1
                        elif entry.is_dir(follow_symlinks=False):
                            stack.append(Path(entry.path))
                    except OSError:
                        continue
        except OSError:
            continue
    return True, total_bytes, file_count


def _stat_file_size_sync(path: Path) -> int:
    try:
        if path.is_file() and not path.is_symlink():
            return int(path.stat().st_size)
    except OSError:
        return 0
    return 0


def collect_storage_breakdown_sync(
    *,
    project_root: Path,
    db_path: Path,
    workspace_dir: Path | None = None,
) -> StorageBreakdown:
    """Measure workspace, store, SQLite DB/WAL/SHM, and logs sizes on disk."""
    resolved_root = project_root.resolve()
    resolved_db = db_path.resolve()
    store_dir = resolved_db.parent
    logs_dir = resolved_root / "logs"

    if workspace_dir is not None and workspace_dir.resolve() != resolved_root:
        target_workspace = workspace_dir.resolve()
    else:
        target_workspace = resolved_root / "workspaces"

    ws_exists, ws_bytes, ws_files = _scan_dir_sync(target_workspace)
    store_exists, store_bytes, store_files = _scan_dir_sync(store_dir)
    logs_exists, logs_bytes, logs_files = _scan_dir_sync(logs_dir)

    db_main_bytes = _stat_file_size_sync(resolved_db)
    db_wal_bytes = _stat_file_size_sync(Path(f"{resolved_db}-wal"))
    db_shm_bytes = _stat_file_size_sync(Path(f"{resolved_db}-shm"))
    db_total_bytes = db_main_bytes + db_wal_bytes + db_shm_bytes
    db_exists = resolved_db.is_file()
    db_file_count = sum(
        1
        for candidate in (resolved_db, Path(f"{resolved_db}-wal"), Path(f"{resolved_db}-shm"))
        if candidate.is_file()
    )

    db_inside_store = resolved_db.is_relative_to(store_dir)
    total_tracked = ws_bytes + store_bytes + logs_bytes + (0 if db_inside_store else db_total_bytes)

    entries = [
        StorageEntry(
            key="workspace",
            path=str(target_workspace),
            exists=ws_exists,
            bytes=ws_bytes,
            mb=_to_mb(ws_bytes),
            file_count=ws_files,
        ),
        StorageEntry(
            key="store",
            path=str(store_dir),
            exists=store_exists,
            bytes=store_bytes,
            mb=_to_mb(store_bytes),
            file_count=store_files,
        ),
        StorageEntry(
            key="db",
            path=str(resolved_db),
            exists=db_exists,
            bytes=db_total_bytes,
            mb=_to_mb(db_total_bytes),
            file_count=db_file_count,
        ),
        StorageEntry(
            key="logs",
            path=str(logs_dir),
            exists=logs_exists,
            bytes=logs_bytes,
            mb=_to_mb(logs_bytes),
            file_count=logs_files,
        ),
    ]

    return StorageBreakdown(
        workspace_bytes=ws_bytes,
        store_bytes=store_bytes,
        db_bytes=db_main_bytes,
        db_wal_bytes=db_wal_bytes,
        db_shm_bytes=db_shm_bytes,
        logs_bytes=logs_bytes,
        total_tracked_bytes=total_tracked,
        entries=entries,
    )


async def collect_storage_breakdown(
    ctx: ModuleContext,
    *,
    workspace_dir: Path | None = None,
) -> StorageBreakdown:
    """Asynchronously collect `StorageBreakdown` without blocking the event loop."""
    return await asyncio.to_thread(
        collect_storage_breakdown_sync,
        project_root=ctx.project_root,
        db_path=ctx.db.db_path,
        workspace_dir=workspace_dir,
    )


def _evaluate_health(
    memory: MemoryTelemetry,
    disk: DiskTelemetry,
) -> tuple[Literal["ok", "warn", "crit"], list[str]]:
    mem_warn_pct = _clamp_threshold_pct("ALFRED_MEM_WARN_PCT", 85.0)
    disk_warn_pct = _clamp_threshold_pct("ALFRED_DISK_WARN_PCT", 80.0)
    disk_crit_pct = max(disk_warn_pct, _clamp_threshold_pct("ALFRED_DISK_CRIT_PCT", 90.0))

    warnings: list[str] = []
    level: Literal["ok", "warn", "crit"] = "ok"

    if memory.total_bytes > 0:
        if memory.used_pct >= 95.0:
            level = "crit"
            warnings.append(f"RAM usage critical: {memory.used_pct:.1f}% >= 95.0%")
        elif memory.used_pct >= mem_warn_pct:
            level = "warn"
            warnings.append(f"RAM usage high: {memory.used_pct:.1f}% >= {mem_warn_pct:.1f}%")

    if disk.total_bytes > 0:
        if disk.used_pct >= disk_crit_pct:
            level = "crit"
            warnings.append(f"Disk usage critical: {disk.used_pct:.1f}% >= {disk_crit_pct:.1f}%")
        elif disk.used_pct >= disk_warn_pct:
            if level != "crit":
                level = "warn"
            warnings.append(f"Disk usage high: {disk.used_pct:.1f}% >= {disk_warn_pct:.1f}%")

    return level, warnings


async def collect_telemetry(
    ctx: ModuleContext,
    *,
    proc_root: Path = Path("/proc"),
    workspace_dir: Path | None = None,
) -> VpsTelemetryReport:
    """Collect full 2 GB VPS telemetry report including active heavy job holds."""
    holds = await ctx.heavy_job.active_holds()

    def _collect_sync() -> tuple[
        MemoryTelemetry,
        PsiTelemetry,
        DiskTelemetry,
        StorageBreakdown,
    ]:
        memory = read_memory_telemetry(proc_root=proc_root)
        psi = read_psi_telemetry(proc_root=proc_root)
        disk = measure_disk_usage(ctx.project_root)
        storage = collect_storage_breakdown_sync(
            project_root=ctx.project_root,
            db_path=ctx.db.db_path,
            workspace_dir=workspace_dir,
        )
        return memory, psi, disk, storage

    memory, psi, disk, storage = await asyncio.to_thread(_collect_sync)
    health_level, warnings = _evaluate_health(memory, disk)

    return VpsTelemetryReport(
        captured_at=datetime.now(tz=UTC).isoformat(),
        hostname=socket.gethostname(),
        platform=sys.platform,
        memory=memory,
        psi=psi,
        disk=disk,
        storage=storage,
        active_heavy_holds=len(holds),
        heavy_hold_labels=[hold.label for hold in holds],
        health_level=health_level,
        warnings=warnings,
    )
