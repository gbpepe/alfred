"""Async FTS5 memory engine with strict namespace isolation, versioning & usage tracking."""

from __future__ import annotations

import re
import sqlite3
import uuid
from datetime import UTC, datetime, timedelta
from typing import Final, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from alfred.core.db import SqlitePool
from alfred.kernel.errors import ModuleError

_FTS_TOKEN_RX: Final[re.Pattern[str]] = re.compile(r"[^\W_]+", re.UNICODE)
_MAX_FTS_TOKENS: Final[int] = 32
_MAX_TITLE_DERIVE_LEN: Final[int] = 80


class MemoryNotFoundError(ModuleError):
    """Raised when a memory is missing or belongs to a different namespace."""

    def __init__(self, memory_id: str, namespace: str) -> None:
        super().__init__(
            f"Memory '{memory_id}' not found in namespace '{namespace}'",
            code="MEMORY_NOT_FOUND",
            module_id="core-memory",
            status_code=404,
        )


class MemoryNamespaceError(ModuleError):
    """Raised on namespace ownership or cross-namespace access violations."""

    def __init__(self, message: str) -> None:
        super().__init__(
            message,
            code="MEMORY_NAMESPACE_FORBIDDEN",
            module_id="core-memory",
            status_code=403,
        )


class MemoryRecord(BaseModel):
    """Serialized memory record returned by engine, tools, and HTTP routes."""

    model_config = ConfigDict(extra="forbid")

    id: str
    namespace: str
    title: str
    content: str
    keywords: str = ""
    category: str = "general"
    importance: int = Field(default=5, ge=1, le=10)
    version: int = Field(default=1, ge=1)
    use_count: int = Field(default=0, ge=0)
    last_used_at: str | None = None
    created_at: str
    updated_at: str
    archived: bool = False


class MemoryVersionRecord(BaseModel):
    """Historical snapshot row from `memory_versions`."""

    model_config = ConfigDict(extra="forbid")

    id: str
    memory_id: str
    namespace: str
    version: int
    title: str
    content: str
    keywords: str = ""
    created_at: str


class MemoryUseRecord(BaseModel):
    """Usage audit row from `memory_uses`."""

    model_config = ConfigDict(extra="forbid")

    id: str
    memory_id: str
    namespace: str
    agent_id: str
    session_id: str = ""
    used_at: str


class MemorySaveInput(BaseModel):
    """Validated create or upsert input for `MemoryEngine.save_memory()`."""

    model_config = ConfigDict(extra="forbid")

    id: str | None = Field(default=None, min_length=1, max_length=128)
    namespace: str = Field(min_length=1, max_length=128)
    title: str = Field(default="", max_length=300)
    content: str = Field(min_length=1, max_length=100_000)
    keywords: str = Field(default="", max_length=1000)
    category: str = Field(default="general", min_length=1, max_length=64)
    importance: int = Field(default=5, ge=1, le=10)
    archived: bool = False

    @field_validator("namespace", "content", "category")
    @classmethod
    def _must_not_be_blank(cls, value: str) -> str:
        stripped = value.strip()
        if not stripped:
            raise ValueError("Field must not be blank")
        return stripped

    @field_validator("id")
    @classmethod
    def _validate_optional_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            raise ValueError("id must not be blank")
        return stripped

    @field_validator("title", "keywords")
    @classmethod
    def _strip_optional_text(cls, value: str) -> str:
        return value.strip()


class MemoryUpdateInput(BaseModel):
    """Validated partial patch input for `MemoryEngine.update_memory()`."""

    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(default=None, min_length=1, max_length=300)
    content: str | None = Field(default=None, min_length=1, max_length=100_000)
    keywords: str | None = Field(default=None, max_length=1000)
    category: str | None = Field(default=None, min_length=1, max_length=64)
    importance: int | None = Field(default=None, ge=1, le=10)
    archived: bool | None = None

    @field_validator("title", "content", "category")
    @classmethod
    def _strip_non_empty_optional(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            raise ValueError("Field must not be blank")
        return stripped

    @field_validator("keywords")
    @classmethod
    def _strip_keywords(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return value.strip()

    @model_validator(mode="after")
    def _require_any_field(self) -> MemoryUpdateInput:
        if (
            self.title is None
            and self.content is None
            and self.keywords is None
            and self.category is None
            and self.importance is None
            and self.archived is None
        ):
            raise ValueError("At least one updatable field must be provided")
        return self


class MemoryListResponse(BaseModel):
    """List or search response DTO."""

    model_config = ConfigDict(extra="forbid")

    memories: list[MemoryRecord]
    total: int
    namespace: str
    query: str | None = None
    search_mode: Literal["list", "fts5", "like_fallback"] = "list"


class MemoryVersionsResponse(BaseModel):
    """Version history response DTO."""

    model_config = ConfigDict(extra="forbid")

    memory_id: str
    namespace: str
    versions: list[MemoryVersionRecord]


class MemoryDeleteResponse(BaseModel):
    """Delete confirmation DTO."""

    model_config = ConfigDict(extra="forbid")

    ok: bool
    deleted: bool
    id: str
    namespace: str


def sanitize_fts5_query(raw: str) -> str:
    """Extract safe alphanumeric tokens and quote each one for SQLite FTS5 `MATCH`.

    Returns `""` when `raw` has no alphanumeric tokens so callers can fall back cleanly
    to LIKE or recent-row queries without ever raising `sqlite3.OperationalError`.
    """
    if not raw:
        return ""
    tokens: list[str] = []
    seen: set[str] = set()
    for match in _FTS_TOKEN_RX.finditer(raw):
        token = match.group(0)
        key = token.casefold()
        if key in seen:
            continue
        seen.add(key)
        escaped = token.replace('"', '""')
        tokens.append(f'"{escaped}"')
        if len(tokens) >= _MAX_FTS_TOKENS:
            break
    return " ".join(tokens)


def _derive_title(content: str) -> str:
    first_line = ""
    for line in content.splitlines():
        candidate = line.strip()
        if candidate:
            first_line = candidate
            break
    if not first_line:
        first_line = content.strip()
    if len(first_line) <= _MAX_TITLE_DERIVE_LEN:
        return first_line
    return first_line[: _MAX_TITLE_DERIVE_LEN - 1].rstrip() + "…"


def _validate_namespace(namespace: str) -> str:
    cleaned = namespace.strip()
    if not cleaned:
        raise ValueError("Namespace must not be empty")
    return cleaned


def _clamp_limit(limit: int) -> int:
    if limit < 1:
        return 1
    if limit > 200:
        return 200
    return limit


def _escape_like(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _row_to_memory(row: sqlite3.Row) -> MemoryRecord:
    return MemoryRecord(
        id=str(row["id"]),
        namespace=str(row["namespace"]),
        title=str(row["title"]),
        content=str(row["content"]),
        keywords=str(row["keywords"]),
        category=str(row["category"]),
        importance=int(row["importance"]),
        version=int(row["version"]),
        use_count=int(row["use_count"]),
        last_used_at=str(row["last_used_at"]) if row["last_used_at"] is not None else None,
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
        archived=bool(int(row["archived"])),
    )


def _row_to_version(row: sqlite3.Row) -> MemoryVersionRecord:
    return MemoryVersionRecord(
        id=str(row["id"]),
        memory_id=str(row["memory_id"]),
        namespace=str(row["namespace"]),
        version=int(row["version"]),
        title=str(row["title"]),
        content=str(row["content"]),
        keywords=str(row["keywords"]),
        created_at=str(row["created_at"]),
    )


def _row_to_use(row: sqlite3.Row) -> MemoryUseRecord:
    return MemoryUseRecord(
        id=str(row["id"]),
        memory_id=str(row["memory_id"]),
        namespace=str(row["namespace"]),
        agent_id=str(row["agent_id"]),
        session_id=str(row["session_id"]),
        used_at=str(row["used_at"]),
    )


class MemoryEngine:
    """Async SQLite FTS5 memory engine enforcing namespace isolation, versions, and usage."""

    def __init__(self, db: SqlitePool) -> None:
        self._db = db

    async def save_memory(self, payload: MemorySaveInput) -> MemoryRecord:
        """Create a new memory or update an existing memory in the same namespace."""
        ns = _validate_namespace(payload.namespace)
        memory_id = payload.id or uuid.uuid4().hex
        title = payload.title or _derive_title(payload.content)
        now_iso = datetime.now(tz=UTC).isoformat()
        archived_int = 1 if payload.archived else 0

        def _mutate(conn: sqlite3.Connection) -> MemoryRecord:
            existing = conn.execute(
                "SELECT id, namespace, version FROM memories WHERE id = ?",
                (memory_id,),
            ).fetchone()
            if existing is not None:
                if str(existing["namespace"]) != ns:
                    raise MemoryNamespaceError(
                        f"Memory '{memory_id}' belongs to another namespace"
                    )
                next_version = int(existing["version"]) + 1
                conn.execute(
                    "UPDATE memories "
                    "SET title = ?, content = ?, keywords = ?, category = ?, "
                    "importance = ?, version = ?, updated_at = ?, archived = ? "
                    "WHERE id = ? AND namespace = ?",
                    (
                        title,
                        payload.content,
                        payload.keywords,
                        payload.category,
                        payload.importance,
                        next_version,
                        now_iso,
                        archived_int,
                        memory_id,
                        ns,
                    ),
                )
            else:
                next_version = 1
                conn.execute(
                    "INSERT INTO memories "
                    "(id, namespace, title, content, keywords, category, importance, "
                    "version, use_count, last_used_at, created_at, updated_at, archived) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, ?, ?, ?)",
                    (
                        memory_id,
                        ns,
                        title,
                        payload.content,
                        payload.keywords,
                        payload.category,
                        payload.importance,
                        now_iso,
                        now_iso,
                        archived_int,
                    ),
                )

            conn.execute(
                "INSERT INTO memory_versions "
                "(id, memory_id, namespace, version, title, content, keywords, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    uuid.uuid4().hex,
                    memory_id,
                    ns,
                    next_version,
                    title,
                    payload.content,
                    payload.keywords,
                    now_iso,
                ),
            )
            saved = conn.execute(
                "SELECT * FROM memories WHERE id = ? AND namespace = ?",
                (memory_id, ns),
            ).fetchone()
            if saved is None:
                raise RuntimeError(f"Failed to reload saved memory '{memory_id}'")
            return _row_to_memory(saved)

        return await self._db.write(_mutate)

    async def update_memory(
        self,
        memory_id: str,
        *,
        namespace: str,
        patch: MemoryUpdateInput,
    ) -> MemoryRecord:
        """Partially update an existing memory within `namespace` and append a new version."""
        ns = _validate_namespace(namespace)
        now_iso = datetime.now(tz=UTC).isoformat()

        def _mutate(conn: sqlite3.Connection) -> MemoryRecord:
            row = conn.execute(
                "SELECT * FROM memories WHERE id = ? AND namespace = ?",
                (memory_id, ns),
            ).fetchone()
            if row is None:
                raise MemoryNotFoundError(memory_id, ns)

            new_title = patch.title if patch.title is not None else str(row["title"])
            new_content = patch.content if patch.content is not None else str(row["content"])
            new_keywords = patch.keywords if patch.keywords is not None else str(row["keywords"])
            new_category = patch.category if patch.category is not None else str(row["category"])
            new_importance = (
                patch.importance if patch.importance is not None else int(row["importance"])
            )
            new_archived = (
                (1 if patch.archived else 0)
                if patch.archived is not None
                else int(row["archived"])
            )
            next_version = int(row["version"]) + 1

            conn.execute(
                "UPDATE memories "
                "SET title = ?, content = ?, keywords = ?, category = ?, "
                "importance = ?, version = ?, updated_at = ?, archived = ? "
                "WHERE id = ? AND namespace = ?",
                (
                    new_title,
                    new_content,
                    new_keywords,
                    new_category,
                    new_importance,
                    next_version,
                    now_iso,
                    new_archived,
                    memory_id,
                    ns,
                ),
            )
            conn.execute(
                "INSERT INTO memory_versions "
                "(id, memory_id, namespace, version, title, content, keywords, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    uuid.uuid4().hex,
                    memory_id,
                    ns,
                    next_version,
                    new_title,
                    new_content,
                    new_keywords,
                    now_iso,
                ),
            )
            updated = conn.execute(
                "SELECT * FROM memories WHERE id = ? AND namespace = ?",
                (memory_id, ns),
            ).fetchone()
            if updated is None:
                raise MemoryNotFoundError(memory_id, ns)
            return _row_to_memory(updated)

        return await self._db.write(_mutate)

    async def get_memory(
        self,
        memory_id: str,
        *,
        namespace: str,
        track_use: bool = True,
        agent_id: str = "dashboard",
        session_id: str = "",
    ) -> MemoryRecord:
        """Read a single memory strictly scoped to `namespace`, tracking usage when enabled."""
        ns = _validate_namespace(namespace)

        if not track_use:

            def _read_only(conn: sqlite3.Connection) -> MemoryRecord:
                row = conn.execute(
                    "SELECT * FROM memories WHERE id = ? AND namespace = ?",
                    (memory_id, ns),
                ).fetchone()
                if row is None:
                    raise MemoryNotFoundError(memory_id, ns)
                return _row_to_memory(row)

            return await self._db.read(_read_only)

        now_iso = datetime.now(tz=UTC).isoformat()

        def _read_and_track(conn: sqlite3.Connection) -> MemoryRecord:
            row = conn.execute(
                "SELECT * FROM memories WHERE id = ? AND namespace = ?",
                (memory_id, ns),
            ).fetchone()
            if row is None:
                raise MemoryNotFoundError(memory_id, ns)

            conn.execute(
                "UPDATE memories SET use_count = use_count + 1, last_used_at = ? "
                "WHERE id = ? AND namespace = ?",
                (now_iso, memory_id, ns),
            )
            conn.execute(
                "INSERT INTO memory_uses "
                "(id, memory_id, namespace, agent_id, session_id, used_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (uuid.uuid4().hex, memory_id, ns, agent_id, session_id, now_iso),
            )
            updated = conn.execute(
                "SELECT * FROM memories WHERE id = ? AND namespace = ?",
                (memory_id, ns),
            ).fetchone()
            if updated is None:
                raise MemoryNotFoundError(memory_id, ns)
            return _row_to_memory(updated)

        return await self._db.write(_read_and_track)

    async def list_memories(
        self,
        *,
        namespace: str,
        category: str | None = None,
        limit: int = 50,
        include_archived: bool = False,
    ) -> MemoryListResponse:
        """List memories strictly within `namespace` without incrementing usage counters."""
        ns = _validate_namespace(namespace)
        clean_cat = category.strip() if category and category.strip() else None
        clamped_limit = _clamp_limit(limit)
        inc_arch = 1 if include_archived else 0

        def _query(conn: sqlite3.Connection) -> tuple[list[MemoryRecord], int]:
            count_row = conn.execute(
                "SELECT COUNT(*) FROM memories "
                "WHERE namespace = ? "
                "AND (? = 1 OR archived = 0) "
                "AND (? IS NULL OR category = ?)",
                (ns, inc_arch, clean_cat, clean_cat),
            ).fetchone()
            total = int(count_row[0]) if count_row is not None else 0

            rows = conn.execute(
                "SELECT * FROM memories "
                "WHERE namespace = ? "
                "AND (? = 1 OR archived = 0) "
                "AND (? IS NULL OR category = ?) "
                "ORDER BY importance DESC, updated_at DESC, created_at DESC "
                "LIMIT ?",
                (ns, inc_arch, clean_cat, clean_cat, clamped_limit),
            ).fetchall()
            return [_row_to_memory(row) for row in rows], total

        records, total = await self._db.read(_query)
        return MemoryListResponse(
            memories=records,
            total=total,
            namespace=ns,
            query=None,
            search_mode="list",
        )

    async def search_memories(
        self,
        *,
        namespace: str,
        query: str,
        category: str | None = None,
        limit: int = 20,
        include_archived: bool = False,
        track_use: bool = True,
        agent_id: str = "dashboard",
        session_id: str = "",
    ) -> MemoryListResponse:
        """Search memories via FTS5 with safe tokenization and LIKE fallback, tracking hits."""
        ns = _validate_namespace(namespace)
        raw_q = query.strip()
        if not raw_q:
            return await self.list_memories(
                namespace=ns,
                category=category,
                limit=limit,
                include_archived=include_archived,
            )

        clean_cat = category.strip() if category and category.strip() else None
        clamped_limit = _clamp_limit(limit)
        inc_arch = 1 if include_archived else 0
        fts_query = sanitize_fts5_query(raw_q)

        def _search_read(
            conn: sqlite3.Connection,
        ) -> tuple[list[MemoryRecord], Literal["fts5", "like_fallback"]]:
            if fts_query:
                rows = conn.execute(
                    "SELECT m.* FROM memories_fts f "
                    "JOIN memories m ON m.rowid = f.rowid "
                    "WHERE memories_fts MATCH ? "
                    "AND m.namespace = ? "
                    "AND (? = 1 OR m.archived = 0) "
                    "AND (? IS NULL OR m.category = ?) "
                    "ORDER BY bm25(memories_fts), m.importance DESC, m.updated_at DESC "
                    "LIMIT ?",
                    (fts_query, ns, inc_arch, clean_cat, clean_cat, clamped_limit),
                ).fetchall()
                if rows:
                    return [_row_to_memory(row) for row in rows], "fts5"

            like_pattern = f"%{_escape_like(raw_q)}%"
            like_rows = conn.execute(
                "SELECT * FROM memories "
                "WHERE namespace = ? "
                "AND (? = 1 OR archived = 0) "
                "AND (? IS NULL OR category = ?) "
                "AND (title LIKE ? ESCAPE '\\' "
                "OR content LIKE ? ESCAPE '\\' "
                "OR keywords LIKE ? ESCAPE '\\') "
                "ORDER BY importance DESC, updated_at DESC, created_at DESC "
                "LIMIT ?",
                (
                    ns,
                    inc_arch,
                    clean_cat,
                    clean_cat,
                    like_pattern,
                    like_pattern,
                    like_pattern,
                    clamped_limit,
                ),
            ).fetchall()
            return [_row_to_memory(row) for row in like_rows], "like_fallback"

        hits, mode = await self._db.read(_search_read)

        if hits and track_use:
            hit_ids = [item.id for item in hits]
            now_iso = datetime.now(tz=UTC).isoformat()

            def _record_hits(conn: sqlite3.Connection) -> list[MemoryRecord]:
                updated_records: list[MemoryRecord] = []
                for mem_id in hit_ids:
                    conn.execute(
                        "UPDATE memories SET use_count = use_count + 1, last_used_at = ? "
                        "WHERE id = ? AND namespace = ?",
                        (now_iso, mem_id, ns),
                    )
                    conn.execute(
                        "INSERT INTO memory_uses "
                        "(id, memory_id, namespace, agent_id, session_id, used_at) "
                        "VALUES (?, ?, ?, ?, ?, ?)",
                        (uuid.uuid4().hex, mem_id, ns, agent_id, session_id, now_iso),
                    )
                    row = conn.execute(
                        "SELECT * FROM memories WHERE id = ? AND namespace = ?",
                        (mem_id, ns),
                    ).fetchone()
                    if row is not None:
                        updated_records.append(_row_to_memory(row))
                return updated_records

            hits = await self._db.write(_record_hits)

        return MemoryListResponse(
            memories=hits,
            total=len(hits),
            namespace=ns,
            query=raw_q,
            search_mode=mode,
        )

    async def delete_memory(self, memory_id: str, *, namespace: str) -> bool:
        """Delete a memory strictly scoped to `namespace`; returns whether a row was deleted."""
        ns = _validate_namespace(namespace)

        def _mutate(conn: sqlite3.Connection) -> bool:
            cursor = conn.execute(
                "DELETE FROM memories WHERE id = ? AND namespace = ?",
                (memory_id, ns),
            )
            return cursor.rowcount > 0

        return await self._db.write(_mutate)

    async def list_versions(
        self,
        memory_id: str,
        *,
        namespace: str,
    ) -> list[MemoryVersionRecord]:
        """Return version history for `memory_id` inside `namespace`, newest first."""
        ns = _validate_namespace(namespace)

        def _query(conn: sqlite3.Connection) -> list[MemoryVersionRecord]:
            exists = conn.execute(
                "SELECT 1 FROM memories WHERE id = ? AND namespace = ?",
                (memory_id, ns),
            ).fetchone()
            if exists is None:
                raise MemoryNotFoundError(memory_id, ns)

            rows = conn.execute(
                "SELECT * FROM memory_versions "
                "WHERE memory_id = ? AND namespace = ? "
                "ORDER BY version DESC",
                (memory_id, ns),
            ).fetchall()
            return [_row_to_version(row) for row in rows]

        return await self._db.read(_query)

    async def list_uses(
        self,
        memory_id: str,
        *,
        namespace: str,
        limit: int = 50,
    ) -> list[MemoryUseRecord]:
        """Return usage audit rows for `memory_id` inside `namespace`, newest first."""
        ns = _validate_namespace(namespace)
        clamped_limit = _clamp_limit(limit)

        def _query(conn: sqlite3.Connection) -> list[MemoryUseRecord]:
            exists = conn.execute(
                "SELECT 1 FROM memories WHERE id = ? AND namespace = ?",
                (memory_id, ns),
            ).fetchone()
            if exists is None:
                raise MemoryNotFoundError(memory_id, ns)

            rows = conn.execute(
                "SELECT * FROM memory_uses "
                "WHERE memory_id = ? AND namespace = ? "
                "ORDER BY used_at DESC LIMIT ?",
                (memory_id, ns, clamped_limit),
            ).fetchall()
            return [_row_to_use(row) for row in rows]

        return await self._db.read(_query)

    async def purge_old_uses(self, *, retention_days: int) -> int:
        """Delete old `memory_uses` audit entries beyond `retention_days`."""
        if retention_days < 1:
            return 0
        cutoff_iso = (datetime.now(tz=UTC) - timedelta(days=retention_days)).isoformat()

        def _prune(conn: sqlite3.Connection) -> int:
            cursor = conn.execute(
                "DELETE FROM memory_uses WHERE used_at < ?",
                (cutoff_iso,),
            )
            return int(cursor.rowcount)

        return await self._db.write(_prune)
