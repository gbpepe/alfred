"""Pydantic v2 DTOs and FastAPI CRUD routes for `core-kanban`."""

from __future__ import annotations

import json
import re
import sqlite3
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Final, Literal

from fastapi import Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator
from starlette.responses import JSONResponse, Response

from alfred.core.db import SqlitePool
from alfred.kernel.errors import ModuleError
from alfred.kernel.types import ModuleContext, ModuleRouteDefinition

MODULE_ID: Final[str] = "core-kanban"
KanbanColumn = Literal["backlog", "todo", "in_progress", "review", "done"]
KanbanPriority = Literal["low", "medium", "high", "urgent"]

VALID_COLUMNS: Final[frozenset[str]] = frozenset(
    {"backlog", "todo", "in_progress", "review", "done"}
)
VALID_PRIORITIES: Final[frozenset[str]] = frozenset({"low", "medium", "high", "urgent"})
_HEX_COLOR_RE: Final[re.Pattern[str]] = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def _strip_required_text(value: str, field_label: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError(f"{field_label} must not be blank")
    return cleaned


def _normalize_optional_text(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned if cleaned else None


def _normalize_labels(labels: list[str]) -> list[str]:
    deduped: list[str] = []
    seen: set[str] = set()
    for raw in labels:
        item = raw.strip()
        if not item:
            raise ValueError("labels must not contain blank entries")
        if item not in seen:
            seen.add(item)
            deduped.append(item)
    return deduped


class ProjectCreateRequest(BaseModel):
    """Input DTO for `POST /api/kanban/projects`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=4000)

    @field_validator("name")
    @classmethod
    def _validate_name(cls, value: str) -> str:
        return _strip_required_text(value, "name")


class ProjectPatchRequest(BaseModel):
    """Input DTO for `PATCH /api/kanban/projects/{project_id}`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    name: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=4000)

    @field_validator("name")
    @classmethod
    def _validate_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _strip_required_text(value, "name")

    @model_validator(mode="after")
    def _reject_explicit_nulls(self) -> ProjectPatchRequest:
        for field_name in ("name", "description"):
            if field_name in self.model_fields_set and getattr(self, field_name) is None:
                raise ValueError(f"{field_name} cannot be null")
        return self


class ProjectDTO(BaseModel):
    """Serialized Kanban project DTO."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str
    name: str
    description: str
    created_at: str
    updated_at: str


class ProjectListResponse(BaseModel):
    """List wrapper DTO for `GET /api/kanban/projects`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    projects: list[ProjectDTO]


class LabelCreateRequest(BaseModel):
    """Input DTO for `POST /api/kanban/projects/{project_id}/labels`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    name: str = Field(min_length=1, max_length=80)
    color: str = Field(default="#64748b")

    @field_validator("name")
    @classmethod
    def _validate_name(cls, value: str) -> str:
        return _strip_required_text(value, "name")

    @field_validator("color")
    @classmethod
    def _validate_color(cls, value: str) -> str:
        cleaned = value.strip()
        if not _HEX_COLOR_RE.match(cleaned):
            raise ValueError("color must be a valid hex color like '#64748b'")
        return cleaned.lower()


class LabelDTO(BaseModel):
    """Serialized Kanban label DTO."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str
    project_id: str
    name: str
    color: str


class LabelListResponse(BaseModel):
    """List wrapper DTO for `GET /api/kanban/projects/{project_id}/labels`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    labels: list[LabelDTO]


class CardCreateRequest(BaseModel):
    """Input DTO for `POST /api/kanban/projects/{project_id}/cards`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    title: str = Field(min_length=1, max_length=300)
    description: str = Field(default="", max_length=20000)
    column_name: KanbanColumn = "backlog"
    priority: KanbanPriority = "medium"
    position: int | None = Field(default=None, ge=0)
    assignee: str | None = Field(default=None, max_length=120)
    labels: list[str] = Field(default_factory=list, max_length=50)

    @field_validator("title")
    @classmethod
    def _validate_title(cls, value: str) -> str:
        return _strip_required_text(value, "title")

    @field_validator("assignee")
    @classmethod
    def _validate_assignee(cls, value: str | None) -> str | None:
        return _normalize_optional_text(value)

    @field_validator("labels")
    @classmethod
    def _validate_labels(cls, value: list[str]) -> list[str]:
        return _normalize_labels(value)


class CardPatchRequest(BaseModel):
    """Input DTO for `PATCH /api/kanban/cards/{card_id}`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    title: str | None = Field(default=None, min_length=1, max_length=300)
    description: str | None = Field(default=None, max_length=20000)
    column_name: KanbanColumn | None = None
    priority: KanbanPriority | None = None
    position: int | None = Field(default=None, ge=0)
    assignee: str | None = Field(default=None, max_length=120)
    labels: list[str] | None = Field(default=None, max_length=50)

    @field_validator("title")
    @classmethod
    def _validate_title(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _strip_required_text(value, "title")

    @field_validator("assignee")
    @classmethod
    def _validate_assignee(cls, value: str | None) -> str | None:
        return _normalize_optional_text(value)

    @field_validator("labels")
    @classmethod
    def _validate_labels(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        return _normalize_labels(value)

    @model_validator(mode="after")
    def _reject_explicit_nulls(self) -> CardPatchRequest:
        for field_name in (
            "title",
            "description",
            "column_name",
            "priority",
            "position",
            "labels",
        ):
            if field_name in self.model_fields_set and getattr(self, field_name) is None:
                raise ValueError(f"{field_name} cannot be null")
        return self


class CardDTO(BaseModel):
    """Serialized Kanban card DTO."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str
    project_id: str
    title: str
    description: str
    column_name: KanbanColumn
    priority: KanbanPriority
    position: int
    assignee: str | None = None
    labels: list[str] = Field(default_factory=list)
    created_at: str
    updated_at: str


class CardListResponse(BaseModel):
    """List wrapper DTO for `GET /api/kanban/projects/{project_id}/cards`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    cards: list[CardDTO]


class CommentCreateRequest(BaseModel):
    """Input DTO for `POST /api/kanban/cards/{card_id}/comments`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    author: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=20000)

    @field_validator("author")
    @classmethod
    def _validate_author(cls, value: str) -> str:
        return _strip_required_text(value, "author")

    @field_validator("body")
    @classmethod
    def _validate_body(cls, value: str) -> str:
        return _strip_required_text(value, "body")


class CommentDTO(BaseModel):
    """Serialized Kanban comment DTO."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str
    card_id: str
    author: str
    body: str
    created_at: str


class CommentListResponse(BaseModel):
    """List wrapper DTO for `GET /api/kanban/cards/{card_id}/comments`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    comments: list[CommentDTO]


class DeleteResponse(BaseModel):
    """Standard deletion confirmation DTO."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    ok: bool
    deleted: bool
    id: str


def _now_iso() -> str:
    return datetime.now(tz=UTC).isoformat()


def _error_json(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"error": code, "message": message, "moduleId": MODULE_ID},
    )


def _json_dto(dto: BaseModel, *, status_code: int = 200) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=dto.model_dump(mode="json", by_alias=True),
    )


def _format_validation_errors(exc: ValidationError) -> tuple[str, list[dict[str, str]]]:
    details: list[dict[str, str]] = []
    parts: list[str] = []
    for err in exc.errors(include_url=False, include_input=False):
        loc = ".".join(str(part) for part in err.get("loc", ())) or "<root>"
        msg = str(err.get("msg", "Invalid value"))
        err_type = str(err.get("type", "value_error"))
        details.append({"field": loc, "message": msg, "type": err_type})
        parts.append(f"{loc}: {msg}")
    summary = "; ".join(parts) if parts else "Validation failed"
    return summary, details


async def _parse_json_model[TModel: BaseModel](
    request: Request,
    model_cls: type[TModel],
) -> tuple[TModel | None, JSONResponse | None]:
    try:
        raw_bytes = await request.body()
        if not raw_bytes:
            return None, _error_json(400, "INVALID_JSON", "Request body must not be empty")
        payload = json.loads(raw_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, _error_json(400, "INVALID_JSON", "Malformed JSON request body")

    try:
        return model_cls.model_validate(payload), None
    except ValidationError as exc:
        summary, details = _format_validation_errors(exc)
        return None, JSONResponse(
            status_code=400,
            content={
                "error": "VALIDATION_ERROR",
                "message": f"Invalid request payload: {summary}",
                "errors": details,
                "moduleId": MODULE_ID,
            },
        )


def _decode_labels(raw: str | None) -> list[str]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except ValueError:
        return []
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, str) and item.strip()]


def _as_column(raw: object) -> KanbanColumn:
    val = str(raw)
    if val == "todo":
        return "todo"
    if val == "in_progress":
        return "in_progress"
    if val == "review":
        return "review"
    if val == "done":
        return "done"
    return "backlog"


def _as_priority(raw: object) -> KanbanPriority:
    val = str(raw)
    if val == "low":
        return "low"
    if val == "high":
        return "high"
    if val == "urgent":
        return "urgent"
    return "medium"


def _row_to_project(row: sqlite3.Row) -> ProjectDTO:
    return ProjectDTO(
        id=str(row["id"]),
        name=str(row["name"]),
        description=str(row["description"]),
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


def _row_to_label(row: sqlite3.Row) -> LabelDTO:
    return LabelDTO(
        id=str(row["id"]),
        project_id=str(row["project_id"]),
        name=str(row["name"]),
        color=str(row["color"]),
    )


def _row_to_card(row: sqlite3.Row) -> CardDTO:
    assignee_raw = row["assignee"]
    return CardDTO(
        id=str(row["id"]),
        project_id=str(row["project_id"]),
        title=str(row["title"]),
        description=str(row["description"]),
        column_name=_as_column(row["column_name"]),
        priority=_as_priority(row["priority"]),
        position=int(row["position"]),
        assignee=str(assignee_raw) if assignee_raw is not None else None,
        labels=_decode_labels(str(row["labels_json"])),
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


def _row_to_comment(row: sqlite3.Row) -> CommentDTO:
    return CommentDTO(
        id=str(row["id"]),
        card_id=str(row["card_id"]),
        author=str(row["author"]),
        body=str(row["body"]),
        created_at=str(row["created_at"]),
    )


def _require_db(get_ctx: Callable[[], ModuleContext | None]) -> SqlitePool:
    ctx = get_ctx()
    if ctx is None:
        raise ModuleError(
            "Module 'core-kanban' is not initialized",
            code="MODULE_DISABLED",
            module_id=MODULE_ID,
            status_code=503,
        )
    return ctx.db


def _path_param(request: Request, name: str) -> str:
    return str(request.path_params[name])


def build_kanban_routes(
    get_ctx: Callable[[], ModuleContext | None],
) -> list[ModuleRouteDefinition]:
    """Create all 15 HTTP CRUD routes for `core-kanban`."""

    async def list_projects(request: Request) -> Response:
        del request
        db = _require_db(get_ctx)

        def _query(conn: sqlite3.Connection) -> list[ProjectDTO]:
            rows = conn.execute(
                "SELECT id, name, description, created_at, updated_at "
                "FROM kanban_projects ORDER BY created_at ASC, name ASC"
            ).fetchall()
            return [_row_to_project(row) for row in rows]

        return _json_dto(ProjectListResponse(projects=await db.read(_query)))

    async def create_project(request: Request) -> Response:
        db = _require_db(get_ctx)
        body, err = await _parse_json_model(request, ProjectCreateRequest)
        if err is not None or body is None:
            return err or _error_json(400, "INVALID_JSON", "Invalid project payload")

        project_id = str(uuid.uuid4())
        now_iso = _now_iso()

        def _insert(conn: sqlite3.Connection) -> ProjectDTO:
            conn.execute(
                "INSERT INTO kanban_projects (id, name, description, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (project_id, body.name, body.description, now_iso, now_iso),
            )
            return ProjectDTO(
                id=project_id,
                name=body.name,
                description=body.description,
                created_at=now_iso,
                updated_at=now_iso,
            )

        created = await db.write(_insert)
        return _json_dto(created, status_code=201)

    async def patch_project(request: Request) -> Response:
        db = _require_db(get_ctx)
        project_id = _path_param(request, "project_id")
        patch, err = await _parse_json_model(request, ProjectPatchRequest)
        if err is not None or patch is None:
            return err or _error_json(400, "INVALID_JSON", "Invalid project patch")

        now_iso = _now_iso()

        def _update(conn: sqlite3.Connection) -> ProjectDTO | None:
            existing = conn.execute(
                "SELECT id, name, description, created_at, updated_at "
                "FROM kanban_projects WHERE id = ?",
                (project_id,),
            ).fetchone()
            if existing is None:
                return None

            next_name = patch.name if patch.name is not None else str(existing["name"])
            next_desc = (
                patch.description
                if patch.description is not None
                else str(existing["description"])
            )
            conn.execute(
                "UPDATE kanban_projects SET name = ?, description = ?, updated_at = ? WHERE id = ?",
                (next_name, next_desc, now_iso, project_id),
            )
            return ProjectDTO(
                id=project_id,
                name=next_name,
                description=next_desc,
                created_at=str(existing["created_at"]),
                updated_at=now_iso,
            )

        updated = await db.write(_update)
        if updated is None:
            return _error_json(404, "PROJECT_NOT_FOUND", f"Project '{project_id}' not found")
        return _json_dto(updated)

    async def delete_project(request: Request) -> Response:
        db = _require_db(get_ctx)
        project_id = _path_param(request, "project_id")

        def _delete(conn: sqlite3.Connection) -> bool:
            cursor = conn.execute("DELETE FROM kanban_projects WHERE id = ?", (project_id,))
            return cursor.rowcount > 0

        if not await db.write(_delete):
            return _error_json(404, "PROJECT_NOT_FOUND", f"Project '{project_id}' not found")
        return _json_dto(DeleteResponse(ok=True, deleted=True, id=project_id))

    async def list_labels(request: Request) -> Response:
        db = _require_db(get_ctx)
        project_id = _path_param(request, "project_id")

        def _query(conn: sqlite3.Connection) -> list[LabelDTO] | None:
            proj = conn.execute(
                "SELECT 1 FROM kanban_projects WHERE id = ?",
                (project_id,),
            ).fetchone()
            if proj is None:
                return None
            rows = conn.execute(
                "SELECT id, project_id, name, color FROM labels "
                "WHERE project_id = ? ORDER BY name ASC",
                (project_id,),
            ).fetchall()
            return [_row_to_label(row) for row in rows]

        labels = await db.read(_query)
        if labels is None:
            return _error_json(404, "PROJECT_NOT_FOUND", f"Project '{project_id}' not found")
        return _json_dto(LabelListResponse(labels=labels))

    async def create_label(request: Request) -> Response:
        db = _require_db(get_ctx)
        project_id = _path_param(request, "project_id")
        body, err = await _parse_json_model(request, LabelCreateRequest)
        if err is not None or body is None:
            return err or _error_json(400, "INVALID_JSON", "Invalid label payload")

        label_id = str(uuid.uuid4())

        def _insert(conn: sqlite3.Connection) -> tuple[str, LabelDTO | None]:
            proj = conn.execute(
                "SELECT 1 FROM kanban_projects WHERE id = ?",
                (project_id,),
            ).fetchone()
            if proj is None:
                return "missing_project", None
            dup = conn.execute(
                "SELECT 1 FROM labels WHERE project_id = ? AND name = ?",
                (project_id, body.name),
            ).fetchone()
            if dup is not None:
                return "duplicate", None
            try:
                conn.execute(
                    "INSERT INTO labels (id, project_id, name, color) VALUES (?, ?, ?, ?)",
                    (label_id, project_id, body.name, body.color),
                )
            except sqlite3.IntegrityError:
                return "duplicate", None
            return "ok", LabelDTO(
                id=label_id,
                project_id=project_id,
                name=body.name,
                color=body.color,
            )

        status, label = await db.write(_insert)
        if status == "missing_project":
            return _error_json(404, "PROJECT_NOT_FOUND", f"Project '{project_id}' not found")
        if status == "duplicate" or label is None:
            return _error_json(
                400,
                "DUPLICATE_LABEL",
                f"Label '{body.name}' already exists in project '{project_id}'",
            )
        return _json_dto(label, status_code=201)

    async def delete_label(request: Request) -> Response:
        db = _require_db(get_ctx)
        label_id = _path_param(request, "label_id")

        def _delete(conn: sqlite3.Connection) -> bool:
            row = conn.execute(
                "SELECT id, project_id FROM labels WHERE id = ?",
                (label_id,),
            ).fetchone()
            if row is None:
                return False
            project_id = str(row["project_id"])
            conn.execute("DELETE FROM labels WHERE id = ?", (label_id,))
            cards = conn.execute(
                "SELECT id, labels_json FROM kanban_cards WHERE project_id = ?",
                (project_id,),
            ).fetchall()
            for card_row in cards:
                labels = _decode_labels(str(card_row["labels_json"]))
                if label_id in labels:
                    updated_labels = [lbl for lbl in labels if lbl != label_id]
                    conn.execute(
                        "UPDATE kanban_cards SET labels_json = ? WHERE id = ?",
                        (json.dumps(updated_labels), str(card_row["id"])),
                    )
            return True

        if not await db.write(_delete):
            return _error_json(404, "LABEL_NOT_FOUND", f"Label '{label_id}' not found")
        return _json_dto(DeleteResponse(ok=True, deleted=True, id=label_id))

    async def list_cards(request: Request) -> Response:
        db = _require_db(get_ctx)
        project_id = _path_param(request, "project_id")
        col_filter = request.query_params.get("column_name")
        prio_filter = request.query_params.get("priority")
        assignee_filter = request.query_params.get("assignee")
        label_filter = request.query_params.get("label")

        if col_filter is not None and col_filter not in VALID_COLUMNS:
            return _error_json(400, "INVALID_FILTER", f"Invalid column_name '{col_filter}'")
        if prio_filter is not None and prio_filter not in VALID_PRIORITIES:
            return _error_json(400, "INVALID_FILTER", f"Invalid priority '{prio_filter}'")

        def _query(conn: sqlite3.Connection) -> list[CardDTO] | None:
            proj = conn.execute(
                "SELECT 1 FROM kanban_projects WHERE id = ?",
                (project_id,),
            ).fetchone()
            if proj is None:
                return None
            rows = conn.execute(
                "SELECT id, project_id, title, description, column_name, priority, "
                "position, assignee, labels_json, created_at, updated_at "
                "FROM kanban_cards WHERE project_id = ? "
                "ORDER BY column_name ASC, position ASC, created_at ASC",
                (project_id,),
            ).fetchall()
            cards = [_row_to_card(row) for row in rows]
            if col_filter is not None:
                cards = [c for c in cards if c.column_name == col_filter]
            if prio_filter is not None:
                cards = [c for c in cards if c.priority == prio_filter]
            if assignee_filter is not None:
                cards = [c for c in cards if c.assignee == assignee_filter]
            if label_filter is not None:
                cards = [c for c in cards if label_filter in c.labels]
            return cards

        cards = await db.read(_query)
        if cards is None:
            return _error_json(404, "PROJECT_NOT_FOUND", f"Project '{project_id}' not found")
        return _json_dto(CardListResponse(cards=cards))

    async def create_card(request: Request) -> Response:
        db = _require_db(get_ctx)
        project_id = _path_param(request, "project_id")
        body, err = await _parse_json_model(request, CardCreateRequest)
        if err is not None or body is None:
            return err or _error_json(400, "INVALID_JSON", "Invalid card payload")

        card_id = str(uuid.uuid4())
        now_iso = _now_iso()
        labels_json = json.dumps(body.labels, ensure_ascii=False)

        def _insert(conn: sqlite3.Connection) -> CardDTO | None:
            proj = conn.execute(
                "SELECT 1 FROM kanban_projects WHERE id = ?",
                (project_id,),
            ).fetchone()
            if proj is None:
                return None

            position = body.position
            if position is None:
                max_row = conn.execute(
                    "SELECT COALESCE(MAX(position), -1) FROM kanban_cards "
                    "WHERE project_id = ? AND column_name = ?",
                    (project_id, body.column_name),
                ).fetchone()
                position = (int(max_row[0]) if max_row is not None else -1) + 1

            conn.execute(
                "INSERT INTO kanban_cards "
                "(id, project_id, title, description, column_name, priority, position, "
                "assignee, labels_json, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    card_id,
                    project_id,
                    body.title,
                    body.description,
                    body.column_name,
                    body.priority,
                    position,
                    body.assignee,
                    labels_json,
                    now_iso,
                    now_iso,
                ),
            )
            return CardDTO(
                id=card_id,
                project_id=project_id,
                title=body.title,
                description=body.description,
                column_name=body.column_name,
                priority=body.priority,
                position=position,
                assignee=body.assignee,
                labels=list(body.labels),
                created_at=now_iso,
                updated_at=now_iso,
            )

        created = await db.write(_insert)
        if created is None:
            return _error_json(404, "PROJECT_NOT_FOUND", f"Project '{project_id}' not found")
        return _json_dto(created, status_code=201)

    async def get_card(request: Request) -> Response:
        db = _require_db(get_ctx)
        card_id = _path_param(request, "card_id")

        def _query(conn: sqlite3.Connection) -> CardDTO | None:
            row = conn.execute(
                "SELECT id, project_id, title, description, column_name, priority, "
                "position, assignee, labels_json, created_at, updated_at "
                "FROM kanban_cards WHERE id = ?",
                (card_id,),
            ).fetchone()
            return _row_to_card(row) if row is not None else None

        card = await db.read(_query)
        if card is None:
            return _error_json(404, "CARD_NOT_FOUND", f"Card '{card_id}' not found")
        return _json_dto(card)

    async def patch_card(request: Request) -> Response:
        db = _require_db(get_ctx)
        card_id = _path_param(request, "card_id")
        patch, err = await _parse_json_model(request, CardPatchRequest)
        if err is not None or patch is None:
            return err or _error_json(400, "INVALID_JSON", "Invalid card patch")

        now_iso = _now_iso()

        def _update(conn: sqlite3.Connection) -> CardDTO | None:
            existing = conn.execute(
                "SELECT id, project_id, title, description, column_name, priority, "
                "position, assignee, labels_json, created_at, updated_at "
                "FROM kanban_cards WHERE id = ?",
                (card_id,),
            ).fetchone()
            if existing is None:
                return None

            current = _row_to_card(existing)
            next_title = patch.title if patch.title is not None else current.title
            next_desc = (
                patch.description if patch.description is not None else current.description
            )
            next_col = patch.column_name if patch.column_name is not None else current.column_name
            next_prio = patch.priority if patch.priority is not None else current.priority
            if "position" in patch.model_fields_set and patch.position is not None:
                next_pos = patch.position
            elif next_col != current.column_name:
                max_row = conn.execute(
                    "SELECT COALESCE(MAX(position), -1) FROM kanban_cards "
                    "WHERE project_id = ? AND column_name = ?",
                    (current.project_id, next_col),
                ).fetchone()
                next_pos = (int(max_row[0]) if max_row is not None else -1) + 1
            else:
                next_pos = current.position

            next_assignee = (
                patch.assignee if "assignee" in patch.model_fields_set else current.assignee
            )
            next_labels = patch.labels if patch.labels is not None else current.labels

            conn.execute(
                "UPDATE kanban_cards "
                "SET title = ?, description = ?, column_name = ?, priority = ?, "
                "position = ?, assignee = ?, labels_json = ?, updated_at = ? "
                "WHERE id = ?",
                (
                    next_title,
                    next_desc,
                    next_col,
                    next_prio,
                    next_pos,
                    next_assignee,
                    json.dumps(next_labels, ensure_ascii=False),
                    now_iso,
                    card_id,
                ),
            )
            return CardDTO(
                id=card_id,
                project_id=current.project_id,
                title=next_title,
                description=next_desc,
                column_name=next_col,
                priority=next_prio,
                position=next_pos,
                assignee=next_assignee,
                labels=list(next_labels),
                created_at=current.created_at,
                updated_at=now_iso,
            )

        updated = await db.write(_update)
        if updated is None:
            return _error_json(404, "CARD_NOT_FOUND", f"Card '{card_id}' not found")
        return _json_dto(updated)

    async def delete_card(request: Request) -> Response:
        db = _require_db(get_ctx)
        card_id = _path_param(request, "card_id")

        def _delete(conn: sqlite3.Connection) -> bool:
            cursor = conn.execute("DELETE FROM kanban_cards WHERE id = ?", (card_id,))
            return cursor.rowcount > 0

        if not await db.write(_delete):
            return _error_json(404, "CARD_NOT_FOUND", f"Card '{card_id}' not found")
        return _json_dto(DeleteResponse(ok=True, deleted=True, id=card_id))

    async def list_comments(request: Request) -> Response:
        db = _require_db(get_ctx)
        card_id = _path_param(request, "card_id")

        def _query(conn: sqlite3.Connection) -> list[CommentDTO] | None:
            card = conn.execute(
                "SELECT 1 FROM kanban_cards WHERE id = ?",
                (card_id,),
            ).fetchone()
            if card is None:
                return None
            rows = conn.execute(
                "SELECT id, card_id, author, body, created_at FROM kanban_comments "
                "WHERE card_id = ? ORDER BY created_at ASC, rowid ASC",
                (card_id,),
            ).fetchall()
            return [_row_to_comment(row) for row in rows]

        comments = await db.read(_query)
        if comments is None:
            return _error_json(404, "CARD_NOT_FOUND", f"Card '{card_id}' not found")
        return _json_dto(CommentListResponse(comments=comments))

    async def create_comment(request: Request) -> Response:
        db = _require_db(get_ctx)
        card_id = _path_param(request, "card_id")
        body, err = await _parse_json_model(request, CommentCreateRequest)
        if err is not None or body is None:
            return err or _error_json(400, "INVALID_JSON", "Invalid comment payload")

        comment_id = str(uuid.uuid4())
        now_iso = _now_iso()

        def _insert(conn: sqlite3.Connection) -> CommentDTO | None:
            card = conn.execute(
                "SELECT 1 FROM kanban_cards WHERE id = ?",
                (card_id,),
            ).fetchone()
            if card is None:
                return None
            conn.execute(
                "INSERT INTO kanban_comments (id, card_id, author, body, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (comment_id, card_id, body.author, body.body, now_iso),
            )
            return CommentDTO(
                id=comment_id,
                card_id=card_id,
                author=body.author,
                body=body.body,
                created_at=now_iso,
            )

        created = await db.write(_insert)
        if created is None:
            return _error_json(404, "CARD_NOT_FOUND", f"Card '{card_id}' not found")
        return _json_dto(created, status_code=201)

    async def delete_comment(request: Request) -> Response:
        db = _require_db(get_ctx)
        comment_id = _path_param(request, "comment_id")

        def _delete(conn: sqlite3.Connection) -> bool:
            cursor = conn.execute("DELETE FROM kanban_comments WHERE id = ?", (comment_id,))
            return cursor.rowcount > 0

        if not await db.write(_delete):
            return _error_json(404, "COMMENT_NOT_FOUND", f"Comment '{comment_id}' not found")
        return _json_dto(DeleteResponse(ok=True, deleted=True, id=comment_id))

    return [
        ModuleRouteDefinition(
            path="/api/kanban/projects",
            methods=("GET",),
            handler=list_projects,
            auth="dashboard",
            summary="List Kanban projects",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/kanban/projects",
            methods=("POST",),
            handler=create_project,
            auth="admin",
            summary="Create Kanban project",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/kanban/projects/{project_id}",
            methods=("PATCH",),
            handler=patch_project,
            auth="admin",
            summary="Update Kanban project",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/kanban/projects/{project_id}",
            methods=("DELETE",),
            handler=delete_project,
            auth="admin",
            summary="Delete Kanban project",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/kanban/projects/{project_id}/labels",
            methods=("GET",),
            handler=list_labels,
            auth="dashboard",
            summary="List project labels",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/kanban/projects/{project_id}/labels",
            methods=("POST",),
            handler=create_label,
            auth="admin",
            summary="Create project label",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/kanban/labels/{label_id}",
            methods=("DELETE",),
            handler=delete_label,
            auth="admin",
            summary="Delete label",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/kanban/projects/{project_id}/cards",
            methods=("GET",),
            handler=list_cards,
            auth="dashboard",
            summary="List project Kanban cards",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/kanban/projects/{project_id}/cards",
            methods=("POST",),
            handler=create_card,
            auth="admin",
            summary="Create Kanban card",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/kanban/cards/{card_id}",
            methods=("GET",),
            handler=get_card,
            auth="dashboard",
            summary="Get Kanban card",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/kanban/cards/{card_id}",
            methods=("PATCH",),
            handler=patch_card,
            auth="admin",
            summary="Update or move Kanban card",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/kanban/cards/{card_id}",
            methods=("DELETE",),
            handler=delete_card,
            auth="admin",
            summary="Delete Kanban card",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/kanban/cards/{card_id}/comments",
            methods=("GET",),
            handler=list_comments,
            auth="dashboard",
            summary="List Kanban card comments",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/kanban/cards/{card_id}/comments",
            methods=("POST",),
            handler=create_comment,
            auth="admin",
            summary="Create Kanban card comment",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/kanban/comments/{comment_id}",
            methods=("DELETE",),
            handler=delete_comment,
            auth="admin",
            summary="Delete Kanban comment",
            module_id=MODULE_ID,
        ),
    ]
