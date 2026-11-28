"""SQLite WAL connection pool with single-writer serialization (`BEGIN IMMEDIATE`)."""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
from collections.abc import Callable, Mapping
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field

from alfred.core.env_file import ensure_secure_dir

T = TypeVar("T")

ModuleState = Literal["available", "installed_disabled", "active"]

_CORE_SCHEMA_STATEMENTS: tuple[str, ...] = (
    """
    CREATE TABLE IF NOT EXISTS installed_modules (
        module_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK(state IN ('available', 'installed_disabled', 'active')),
        installed_at TEXT,
        updated_at TEXT,
        config_json TEXT NOT NULL DEFAULT '{}'
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS module_migrations (
        module_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY (module_id, version)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        session_id TEXT,
        timestamp INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        thinking_tokens INTEGER NOT NULL DEFAULT 0,
        model TEXT NOT NULL,
        content_preview TEXT,
        tool_name TEXT,
        task_title TEXT,
        project TEXT
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_token_usage_agent_ts
        ON token_usage(agent, timestamp)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_token_usage_ts
        ON token_usage(timestamp)
    """,
    """
    CREATE TABLE IF NOT EXISTS compute_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        module_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        session_id TEXT NOT NULL,
        resource_label TEXT NOT NULL,
        duration_sec REAL NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        timestamp INTEGER NOT NULL
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_compute_usage_agent_ts
        ON compute_usage(agent, timestamp)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_compute_usage_ts
        ON compute_usage(timestamp)
    """,
    """
    CREATE TABLE IF NOT EXISTS sessions (
        chat_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS conversation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        message_id TEXT,
        author_id TEXT,
        author_name TEXT,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        UNIQUE(agent_id, chat_id, direction, message_id)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_conversation_log_agent_ts
        ON conversation_log(agent_id, timestamp)
    """,
)


class InstalledModuleRecord(BaseModel):
    """Typed row representation for `installed_modules`."""

    model_config = ConfigDict(extra="forbid")

    module_id: str
    state: ModuleState
    installed_at: str | None = None
    updated_at: str | None = None
    config_json: dict[str, Any] = Field(default_factory=dict)


class SqlitePool:
    """Thread-isolated SQLite WAL pool with `asyncio.Lock` write serialization."""

    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="alfred-sqlite")
        self._write_lock = asyncio.Lock()
        self._conn: sqlite3.Connection | None = None
        self._closed = False

    def _ensure_conn_sync(self) -> sqlite3.Connection:
        if self._closed:
            raise RuntimeError("SqlitePool is already closed")
        if self._conn is None:
            ensure_secure_dir(self.db_path.parent, mode=0o700)
            conn = sqlite3.connect(
                self.db_path,
                timeout=5.0,
                isolation_level=None,
                check_same_thread=False,
            )
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute("PRAGMA busy_timeout=5000;")
            conn.execute("PRAGMA synchronous=NORMAL;")
            conn.execute("PRAGMA cache_size=-16384;")
            conn.execute("PRAGMA foreign_keys=ON;")
            self._conn = conn
            self._tighten_file_permissions_sync()
        return self._conn

    def _tighten_file_permissions_sync(self) -> None:
        for suffix in ("", "-wal", "-shm"):
            target = Path(f"{self.db_path}{suffix}")
            if target.exists():
                try:
                    os.chmod(target, 0o600)
                except OSError:
                    pass

    def _read_sync(self, fn: Callable[[sqlite3.Connection], T]) -> T:
        conn = self._ensure_conn_sync()
        conn.execute("PRAGMA query_only = ON;")
        try:
            return fn(conn)
        finally:
            if conn.in_transaction:
                try:
                    conn.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
            try:
                conn.execute("PRAGMA query_only = OFF;")
            except sqlite3.Error:
                pass

    def _write_sync(self, fn: Callable[[sqlite3.Connection], T]) -> T:
        conn = self._ensure_conn_sync()
        conn.execute("BEGIN IMMEDIATE")
        try:
            result = fn(conn)
            if conn.in_transaction:
                conn.execute("COMMIT")
        except BaseException:
            if conn.in_transaction:
                try:
                    conn.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
            raise
        self._tighten_file_permissions_sync()
        return result

    async def initialize(self) -> None:
        """Open WAL connection, initialize the 6 core tables, and enforce `0o600` perms."""

        def _init_schema(conn: sqlite3.Connection) -> None:
            for stmt in _CORE_SCHEMA_STATEMENTS:
                conn.execute(stmt)

        await self.write(_init_schema)

    async def read(self, fn: Callable[[sqlite3.Connection], T]) -> T:
        """Execute a read-only closure on the dedicated SQLite thread."""
        if self._closed:
            raise RuntimeError("SqlitePool is already closed")
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, self._read_sync, fn)

    async def write(self, fn: Callable[[sqlite3.Connection], T]) -> T:
        """Serialize write transactions via `asyncio.Lock` + `BEGIN IMMEDIATE`."""
        async with self._write_lock:
            if self._closed:
                raise RuntimeError("SqlitePool is already closed")
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(self._executor, self._write_sync, fn)

    async def close(self) -> None:
        """Serialize shutdown under `_write_lock` before closing connection and executor."""
        async with self._write_lock:
            if self._closed:
                return
            self._closed = True

            def _close_sync() -> None:
                if self._conn is not None:
                    try:
                        self._conn.close()
                    finally:
                        self._conn = None

            loop = asyncio.get_running_loop()
            await loop.run_in_executor(self._executor, _close_sync)
            self._executor.shutdown(wait=True)

    async def __aenter__(self) -> SqlitePool:
        await self.initialize()
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    async def get_module_row(self, module_id: str) -> InstalledModuleRecord | None:
        """Fetch an `installed_modules` row by id."""

        def _query(conn: sqlite3.Connection) -> InstalledModuleRecord | None:
            row = conn.execute(
                "SELECT module_id, state, installed_at, updated_at, config_json "
                "FROM installed_modules WHERE module_id = ?",
                (module_id,),
            ).fetchone()
            if row is None:
                return None
            return _row_to_module_record(row)

        return await self.read(_query)

    async def list_module_rows(self) -> list[InstalledModuleRecord]:
        """Return all `installed_modules` rows ordered by `module_id`."""

        def _query(conn: sqlite3.Connection) -> list[InstalledModuleRecord]:
            rows = conn.execute(
                "SELECT module_id, state, installed_at, updated_at, config_json "
                "FROM installed_modules ORDER BY module_id"
            ).fetchall()
            return [_row_to_module_record(row) for row in rows]

        return await self.read(_query)

    async def set_module_state(
        self,
        module_id: str,
        state: ModuleState,
        timestamp_iso: str,
    ) -> InstalledModuleRecord:
        """Insert or update a module lifecycle state atomically."""

        def _mutate(conn: sqlite3.Connection) -> InstalledModuleRecord:
            existing = conn.execute(
                "SELECT installed_at, config_json FROM installed_modules WHERE module_id = ?",
                (module_id,),
            ).fetchone()
            if existing is None:
                installed_at = timestamp_iso if state != "available" else None
                conn.execute(
                    "INSERT INTO installed_modules "
                    "(module_id, state, installed_at, updated_at, config_json) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (module_id, state, installed_at, timestamp_iso, "{}"),
                )
            else:
                installed_at = existing["installed_at"]
                if installed_at is None and state != "available":
                    installed_at = timestamp_iso
                conn.execute(
                    "UPDATE installed_modules "
                    "SET state = ?, installed_at = ?, updated_at = ? "
                    "WHERE module_id = ?",
                    (state, installed_at, timestamp_iso, module_id),
                )
            updated = conn.execute(
                "SELECT module_id, state, installed_at, updated_at, config_json "
                "FROM installed_modules WHERE module_id = ?",
                (module_id,),
            ).fetchone()
            if updated is None:
                raise RuntimeError(f"Failed to reload installed_modules row for '{module_id}'")
            return _row_to_module_record(updated)

        return await self.write(_mutate)

    async def get_module_config(self, module_id: str) -> dict[str, Any]:
        """Read parsed `config_json` dictionary for a module (empty dict if unset)."""
        row = await self.get_module_row(module_id)
        return dict(row.config_json) if row is not None else {}

    async def update_module_config(
        self,
        module_id: str,
        patch: Mapping[str, Any],
        timestamp_iso: str,
    ) -> dict[str, Any]:
        """Atomically read-merge-write `config_json` inside one `BEGIN IMMEDIATE` transaction."""

        def _mutate(conn: sqlite3.Connection) -> dict[str, Any]:
            existing = conn.execute(
                "SELECT config_json FROM installed_modules WHERE module_id = ?",
                (module_id,),
            ).fetchone()
            current: dict[str, Any] = {}
            if existing is not None:
                parsed = json.loads(existing["config_json"] or "{}")
                if isinstance(parsed, dict):
                    current = parsed
            current.update(dict(patch))
            serialized = json.dumps(current, ensure_ascii=False)
            if existing is None:
                conn.execute(
                    "INSERT INTO installed_modules "
                    "(module_id, state, installed_at, updated_at, config_json) "
                    "VALUES (?, 'available', NULL, ?, ?)",
                    (module_id, timestamp_iso, serialized),
                )
            else:
                conn.execute(
                    "UPDATE installed_modules SET config_json = ?, updated_at = ? "
                    "WHERE module_id = ?",
                    (serialized, timestamp_iso, module_id),
                )
            return dict(current)

        return await self.write(_mutate)

    async def set_module_config(
        self,
        module_id: str,
        config: Mapping[str, Any],
        timestamp_iso: str,
    ) -> dict[str, Any]:
        """Persist `config_json` for a module without modifying its activation state."""
        serialized = json.dumps(dict(config), ensure_ascii=False)

        def _mutate(conn: sqlite3.Connection) -> dict[str, Any]:
            existing = conn.execute(
                "SELECT module_id FROM installed_modules WHERE module_id = ?",
                (module_id,),
            ).fetchone()
            if existing is None:
                conn.execute(
                    "INSERT INTO installed_modules "
                    "(module_id, state, installed_at, updated_at, config_json) "
                    "VALUES (?, 'available', NULL, ?, ?)",
                    (module_id, timestamp_iso, serialized),
                )
            else:
                conn.execute(
                    "UPDATE installed_modules SET config_json = ?, updated_at = ? "
                    "WHERE module_id = ?",
                    (serialized, timestamp_iso, module_id),
                )
            return dict(config)

        return await self.write(_mutate)

    async def record_compute_usage(
        self,
        *,
        module_id: str,
        agent: str,
        session_id: str,
        resource_label: str,
        duration_sec: float,
        cost_usd: float,
        timestamp_sec: int,
    ) -> None:
        """Insert a non-token CostOps record into `compute_usage`."""

        def _insert(conn: sqlite3.Connection) -> None:
            conn.execute(
                "INSERT INTO compute_usage "
                "(module_id, agent, session_id, resource_label, duration_sec, cost_usd, timestamp) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    module_id,
                    agent,
                    session_id,
                    resource_label,
                    duration_sec,
                    cost_usd,
                    timestamp_sec,
                ),
            )

        await self.write(_insert)


def _row_to_module_record(row: sqlite3.Row) -> InstalledModuleRecord:
    raw_cfg = row["config_json"] or "{}"
    parsed_cfg = json.loads(raw_cfg)
    if not isinstance(parsed_cfg, dict):
        parsed_cfg = {}
    return InstalledModuleRecord(
        module_id=str(row["module_id"]),
        state=row["state"],
        installed_at=row["installed_at"],
        updated_at=row["updated_at"],
        config_json=parsed_cfg,
    )
