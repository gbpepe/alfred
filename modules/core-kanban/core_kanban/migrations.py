"""Idempotent SQLite schema migrations for `core-kanban`."""

from __future__ import annotations

from alfred.kernel.types import ModuleMigration

CORE_KANBAN_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS kanban_projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS labels (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES kanban_projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#64748b',
    UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS kanban_cards (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES kanban_projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    column_name TEXT NOT NULL DEFAULT 'backlog'
        CHECK(column_name IN ('backlog', 'todo', 'in_progress', 'review', 'done')),
    priority TEXT NOT NULL DEFAULT 'medium'
        CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
    position INTEGER NOT NULL DEFAULT 0,
    assignee TEXT,
    labels_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kanban_comments (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES kanban_cards(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kanban_labels_proj
    ON labels(project_id, name);

CREATE INDEX IF NOT EXISTS idx_kanban_cards_proj_col
    ON kanban_cards(project_id, column_name, position, created_at);

CREATE INDEX IF NOT EXISTS idx_kanban_comments_card
    ON kanban_comments(card_id, created_at);
"""

KANBAN_MIGRATIONS: tuple[ModuleMigration, ...] = (
    ModuleMigration(
        version=1,
        name="core_kanban_schema",
        sql=CORE_KANBAN_SCHEMA_SQL,
    ),
)
