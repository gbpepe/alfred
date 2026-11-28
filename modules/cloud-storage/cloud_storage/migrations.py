"""Idempotent SQLite schema migrations for `cloud-storage`."""

from __future__ import annotations

from alfred.kernel.types import ModuleMigration

CLOUD_STORAGE_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS cloud_activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    provider TEXT NOT NULL,
    account TEXT NOT NULL,
    remote_ref TEXT NOT NULL DEFAULT '',
    byte_size INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('ok', 'error')),
    detail TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_activity_log_created_at
    ON cloud_activity_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cloud_activity_log_provider_account
    ON cloud_activity_log(provider, account, created_at DESC);
"""

CLOUD_STORAGE_MIGRATIONS: tuple[ModuleMigration, ...] = (
    ModuleMigration(
        version=1,
        name="cloud_activity_log_v1",
        sql=CLOUD_STORAGE_SCHEMA_SQL,
    ),
)
