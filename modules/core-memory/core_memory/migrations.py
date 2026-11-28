"""SQLite schema and FTS5 triggers for the `core-memory` module."""

from __future__ import annotations

from alfred.kernel.types import ModuleMigration

CORE_MEMORY_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'general',
    importance INTEGER NOT NULL DEFAULT 5,
    version INTEGER NOT NULL DEFAULT 1,
    use_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memories_ns_archived_updated
    ON memories(namespace, archived, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_ns_category
    ON memories(namespace, category);

CREATE INDEX IF NOT EXISTS idx_memories_ns_importance
    ON memories(namespace, importance DESC, updated_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    keywords,
    content='memories',
    content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS trg_memories_fts_ai
AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, keywords)
    VALUES (new.rowid, new.content, new.keywords);
END;

CREATE TRIGGER IF NOT EXISTS trg_memories_fts_ad
AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, keywords)
    VALUES ('delete', old.rowid, old.content, old.keywords);
END;

CREATE TRIGGER IF NOT EXISTS trg_memories_fts_au
AFTER UPDATE OF content, keywords ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, keywords)
    VALUES ('delete', old.rowid, old.content, old.keywords);
    INSERT INTO memories_fts(rowid, content, keywords)
    VALUES (new.rowid, new.content, new.keywords);
END;

CREATE TABLE IF NOT EXISTS memory_versions (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    namespace TEXT NOT NULL,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE(memory_id, version)
);

CREATE INDEX IF NOT EXISTS idx_memory_versions_mem_ver
    ON memory_versions(memory_id, version DESC);

CREATE INDEX IF NOT EXISTS idx_memory_versions_ns
    ON memory_versions(namespace, memory_id);

CREATE TABLE IF NOT EXISTS memory_uses (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    namespace TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    used_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_uses_mem_at
    ON memory_uses(memory_id, used_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_uses_ns_agent
    ON memory_uses(namespace, agent_id, used_at DESC);
"""

CORE_MEMORY_MIGRATIONS: tuple[ModuleMigration, ...] = (
    ModuleMigration(
        version=1,
        name="core_memory_schema",
        sql=CORE_MEMORY_SCHEMA_SQL,
    ),
)
