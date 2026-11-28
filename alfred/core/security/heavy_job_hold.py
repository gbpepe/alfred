"""PID-verified `store/.heavy-job.lock` manager for heavy I/O / upload operations."""

from __future__ import annotations

import asyncio
import ctypes
import os
import time
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from alfred.core.env_file import atomic_write_text

_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_STILL_ACTIVE = 259


class HeavyJobEntry(BaseModel):
    """Single active heavy job lock record."""

    model_config = ConfigDict(extra="forbid")

    hold_id: str
    label: str
    pid: int
    acquired_at_ms: int


class HeavyJobLockStore(BaseModel):
    """Persisted `store/.heavy-job.lock` JSON payload."""

    model_config = ConfigDict(extra="forbid")

    holds: dict[str, HeavyJobEntry] = Field(default_factory=dict)


def default_is_pid_alive(pid: int) -> bool:
    """Cross-platform check whether a PID is currently alive (non-zombie)."""
    if pid <= 0:
        return False
    if os.name == "nt":
        windll = getattr(ctypes, "windll", None)
        if windll is None:
            return False
        kernel32 = windll.kernel32
        handle = kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong()
            ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))
            return bool(ok and exit_code.value == _STILL_ACTIVE)
        finally:
            kernel32.CloseHandle(handle)

    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True

    stat_path = Path(f"/proc/{pid}/stat")
    if stat_path.exists():
        try:
            stat_text = stat_path.read_text(encoding="utf-8", errors="ignore")
            rparen = stat_text.rfind(")")
            if rparen != -1 and len(stat_text) > rparen + 2 and stat_text[rparen + 2] == "Z":
                return False
        except OSError:
            pass
    return True


class HeavyJobHoldManager:
    """Coordinates active heavy-job holds with automatic stale-PID cleanup."""

    def __init__(
        self,
        lock_path: Path,
        *,
        is_pid_alive: Callable[[int], bool] | None = None,
    ) -> None:
        self.lock_path = lock_path
        self._is_pid_alive = is_pid_alive or default_is_pid_alive
        self._lock = asyncio.Lock()

    def _read_store_sync(self) -> HeavyJobLockStore:
        if not self.lock_path.exists():
            return HeavyJobLockStore()
        try:
            return HeavyJobLockStore.model_validate_json(self.lock_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, ValidationError):
            return HeavyJobLockStore()

    def _write_store_sync(self, store: HeavyJobLockStore) -> None:
        atomic_write_text(self.lock_path, store.model_dump_json(indent=2) + "\n", mode=0o600)

    def _prune_stale_sync(self, store: HeavyJobLockStore) -> int:
        dead_keys = [
            hold_id
            for hold_id, entry in store.holds.items()
            if not self._is_pid_alive(entry.pid)
        ]
        for hold_id in dead_keys:
            del store.holds[hold_id]
        return len(dead_keys)

    async def prune_stale_holds(self) -> int:
        """Remove entries belonging to dead PIDs from `.heavy-job.lock`."""
        async with self._lock:
            store = self._read_store_sync()
            removed = self._prune_stale_sync(store)
            if removed > 0:
                self._write_store_sync(store)
            return removed

    async def active_holds(self) -> list[HeavyJobEntry]:
        """Prune dead PIDs and return currently live heavy-job holds."""
        async with self._lock:
            store = self._read_store_sync()
            removed = self._prune_stale_sync(store)
            if removed > 0:
                self._write_store_sync(store)
            return list(store.holds.values())

    @asynccontextmanager
    async def hold(self, label: str) -> AsyncIterator[HeavyJobEntry]:
        """Acquire a heavy-job hold for the current process and guarantee release."""
        hold_id = uuid.uuid4().hex
        entry = HeavyJobEntry(
            hold_id=hold_id,
            label=label,
            pid=os.getpid(),
            acquired_at_ms=int(time.time() * 1000),
        )
        async with self._lock:
            store = self._read_store_sync()
            self._prune_stale_sync(store)
            store.holds[hold_id] = entry
            self._write_store_sync(store)
        try:
            yield entry
        finally:
            async with self._lock:
                store = self._read_store_sync()
                store.holds.pop(hold_id, None)
                self._prune_stale_sync(store)
                self._write_store_sync(store)
