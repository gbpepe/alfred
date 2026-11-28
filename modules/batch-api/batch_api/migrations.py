"""Idempotent SQLite schema migrations for `batch-api`."""

from __future__ import annotations

from alfred.kernel.types import ModuleMigration

BATCH_API_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS batch_jobs (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK(provider IN ('anthropic', 'gemini', 'vertex-eu', 'openai')),
    model TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK(status IN (
            'queued',
            'submitted',
            'running',
            'downloading',
            'completed',
            'failed',
            'cancelled'
        )),
    agent_id TEXT NOT NULL DEFAULT 'alfred-batch',
    session_id TEXT NOT NULL DEFAULT '',
    external_job_id TEXT,
    input_ref TEXT NOT NULL,
    output_ref TEXT,
    request_count INTEGER NOT NULL DEFAULT 0,
    completed_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0.0,
    qa_sampled INTEGER NOT NULL DEFAULT 0,
    qa_status TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_batch_jobs_status
    ON batch_jobs(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_batch_jobs_provider
    ON batch_jobs(provider, created_at DESC);
"""

BATCH_API_MIGRATIONS: tuple[ModuleMigration, ...] = (
    ModuleMigration(
        version=1,
        name="batch_api_schema",
        sql=BATCH_API_SCHEMA_SQL,
    ),
)
