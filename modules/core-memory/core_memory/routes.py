"""HTTP CRUD routes for `core-memory` mounted via the microkernel HTTP bridge."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from fastapi import Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator
from starlette.responses import JSONResponse

from alfred.kernel.types import ModuleRouteDefinition

from .engine import (
    MemoryDeleteResponse,
    MemoryEngine,
    MemorySaveInput,
    MemoryUpdateInput,
    MemoryVersionsResponse,
)


class MemoryPatchRequest(BaseModel):
    """HTTP PATCH body schema for `/api/memories/{memory_id}`."""

    model_config = ConfigDict(extra="forbid")

    namespace: str | None = Field(default=None, min_length=1, max_length=128)
    title: str | None = Field(default=None, min_length=1, max_length=300)
    content: str | None = Field(default=None, min_length=1, max_length=100_000)
    keywords: str | None = Field(default=None, max_length=1000)
    category: str | None = Field(default=None, min_length=1, max_length=64)
    importance: int | None = Field(default=None, ge=1, le=10)
    archived: bool | None = None

    @field_validator("namespace", "title", "content", "category")
    @classmethod
    def _strip_non_empty(cls, value: str | None) -> str | None:
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
    def _require_any_change(self) -> MemoryPatchRequest:
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


def format_validation_error(exc: ValidationError) -> tuple[str, list[dict[str, Any]]]:
    """Format Pydantic `ValidationError` safely without leaking raw input values."""
    details: list[dict[str, Any]] = []
    parts: list[str] = []
    for err in exc.errors(include_url=False, include_input=False):
        loc = ".".join(str(part) for part in err.get("loc", ())) or "<root>"
        msg = str(err.get("msg", "Invalid value"))
        err_type = str(err.get("type", "value_error"))
        details.append({"field": loc, "message": msg, "type": err_type})
        parts.append(f"{loc}: {msg}")
    summary = "; ".join(parts) if parts else "Validation failed"
    return summary, details


def _error_json(
    status_code: int,
    code: str,
    message: str,
    *,
    details: list[dict[str, Any]] | None = None,
) -> JSONResponse:
    content: dict[str, Any] = {"error": code, "message": message}
    if details is not None:
        content["details"] = details
    return JSONResponse(status_code=status_code, content=content)


def _validation_error_response(exc: ValidationError) -> JSONResponse:
    summary, details = format_validation_error(exc)
    return _error_json(400, "VALIDATION_ERROR", summary, details=details)


def _get_path_param(request: Request, name: str) -> str:
    val = request.path_params.get(name)
    if isinstance(val, str) and val:
        return val
    state_params = getattr(request.state, "path_params", None)
    if isinstance(state_params, Mapping):
        raw = state_params.get(name)
        if isinstance(raw, str):
            return raw
    return ""


def _principal_subject(request: Request) -> str:
    principal = getattr(request.state, "auth_principal", None)
    subject = getattr(principal, "subject", None)
    if isinstance(subject, str) and subject:
        return subject
    return "dashboard"


def _resolve_engine(
    request: Request,
    fallback_getter: Callable[[], MemoryEngine | None],
) -> MemoryEngine:
    container = getattr(request.app.state, "container", None)
    if container is not None:
        registry = getattr(container, "registry", None)
        if registry is not None:
            svc = registry.get_service("core-memory")
            if isinstance(svc, MemoryEngine):
                return svc
            ctx = registry.get_context("core-memory")
            if ctx is not None:
                return MemoryEngine(ctx.db)
        db = getattr(container, "db", None)
        if db is not None:
            return MemoryEngine(db)
    fallback = fallback_getter()
    if fallback is not None:
        return fallback
    raise RuntimeError("core-memory engine is not initialized")


async def _parse_json_object(request: Request) -> tuple[dict[str, Any] | None, JSONResponse | None]:
    try:
        raw = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        return None, _error_json(400, "INVALID_JSON", "Malformed JSON request body")
    if not isinstance(raw, dict):
        return None, _error_json(400, "INVALID_REQUEST", "Request JSON body must be an object")
    return raw, None


def build_memory_routes(
    fallback_engine_getter: Callable[[], MemoryEngine | None],
) -> Sequence[ModuleRouteDefinition]:
    """Build HTTP CRUD route definitions for `core-memory`."""

    async def list_or_search_memories(request: Request) -> Any:
        engine = _resolve_engine(request, fallback_engine_getter)
        qp = request.query_params
        if "namespace" in qp:
            namespace = qp["namespace"].strip()
            if not namespace:
                return _error_json(
                    400,
                    "INVALID_REQUEST",
                    "Query parameter 'namespace' must not be empty",
                )
        else:
            namespace = "default"

        raw_limit = qp.get("limit")
        if raw_limit is not None:
            try:
                limit = int(raw_limit)
            except ValueError:
                return _error_json(
                    400,
                    "INVALID_REQUEST",
                    "Query parameter 'limit' must be an integer",
                )
            if limit < 1 or limit > 200:
                return _error_json(
                    400,
                    "INVALID_REQUEST",
                    "Query parameter 'limit' must be between 1 and 200",
                )
        else:
            limit = 50

        category = (qp.get("category") or "").strip() or None
        query = (qp.get("q") or "").strip()
        include_archived = (qp.get("include_archived") or "").strip().lower() in (
            "1",
            "true",
            "yes",
        )

        if query:
            return await engine.search_memories(
                namespace=namespace,
                query=query,
                category=category,
                limit=limit,
                include_archived=include_archived,
                track_use=True,
                agent_id=_principal_subject(request),
            )
        return await engine.list_memories(
            namespace=namespace,
            category=category,
            limit=limit,
            include_archived=include_archived,
        )

    async def create_or_update_memory(request: Request) -> Any:
        raw, err = await _parse_json_object(request)
        if err is not None or raw is None:
            return err
        try:
            payload = MemorySaveInput.model_validate(raw)
        except ValidationError as exc:
            return _validation_error_response(exc)
        engine = _resolve_engine(request, fallback_engine_getter)
        return await engine.save_memory(payload)

    async def get_single_memory(request: Request) -> Any:
        memory_id = _get_path_param(request, "memory_id")
        namespace = (request.query_params.get("namespace") or "").strip()
        if not namespace:
            return _error_json(400, "MISSING_NAMESPACE", "Query parameter 'namespace' is required")
        engine = _resolve_engine(request, fallback_engine_getter)
        return await engine.get_memory(
            memory_id,
            namespace=namespace,
            track_use=True,
            agent_id=_principal_subject(request),
        )

    async def patch_single_memory(request: Request) -> Any:
        memory_id = _get_path_param(request, "memory_id")
        raw, err = await _parse_json_object(request)
        if err is not None or raw is None:
            return err
        try:
            body = MemoryPatchRequest.model_validate(raw)
        except ValidationError as exc:
            return _validation_error_response(exc)

        query_ns = (request.query_params.get("namespace") or "").strip()
        body_ns = (body.namespace or "").strip()
        if query_ns and body_ns and query_ns != body_ns:
            return _error_json(
                400,
                "NAMESPACE_MISMATCH",
                "Query 'namespace' does not match body 'namespace'",
            )
        namespace = query_ns or body_ns
        if not namespace:
            return _error_json(
                400,
                "MISSING_NAMESPACE",
                "Parameter 'namespace' is required in query string or body",
            )

        patch = MemoryUpdateInput(
            title=body.title,
            content=body.content,
            keywords=body.keywords,
            category=body.category,
            importance=body.importance,
            archived=body.archived,
        )
        engine = _resolve_engine(request, fallback_engine_getter)
        return await engine.update_memory(memory_id, namespace=namespace, patch=patch)

    async def delete_single_memory(request: Request) -> Any:
        memory_id = _get_path_param(request, "memory_id")
        namespace = (request.query_params.get("namespace") or "").strip()
        if not namespace:
            return _error_json(400, "MISSING_NAMESPACE", "Query parameter 'namespace' is required")
        engine = _resolve_engine(request, fallback_engine_getter)
        deleted = await engine.delete_memory(memory_id, namespace=namespace)
        if not deleted:
            return _error_json(
                404,
                "MEMORY_NOT_FOUND",
                f"Memory '{memory_id}' not found in namespace '{namespace}'",
            )
        return MemoryDeleteResponse(
            ok=True,
            deleted=True,
            id=memory_id,
            namespace=namespace,
        )

    async def get_memory_versions(request: Request) -> Any:
        memory_id = _get_path_param(request, "memory_id")
        namespace = (request.query_params.get("namespace") or "").strip()
        if not namespace:
            return _error_json(400, "MISSING_NAMESPACE", "Query parameter 'namespace' is required")
        engine = _resolve_engine(request, fallback_engine_getter)
        versions = await engine.list_versions(memory_id, namespace=namespace)
        return MemoryVersionsResponse(
            memory_id=memory_id,
            namespace=namespace,
            versions=versions,
        )

    return (
        ModuleRouteDefinition(
            path="/api/memories",
            methods=("GET",),
            handler=list_or_search_memories,
            auth="dashboard",
            summary="List or search memories in an isolated namespace",
            module_id="core-memory",
        ),
        ModuleRouteDefinition(
            path="/api/memories",
            methods=("POST",),
            handler=create_or_update_memory,
            auth="admin",
            summary="Create or update a memory in an isolated namespace",
            module_id="core-memory",
        ),
        ModuleRouteDefinition(
            path="/api/memories/{memory_id}",
            methods=("GET",),
            handler=get_single_memory,
            auth="dashboard",
            summary="Read a single memory in a matching namespace",
            module_id="core-memory",
        ),
        ModuleRouteDefinition(
            path="/api/memories/{memory_id}",
            methods=("PATCH",),
            handler=patch_single_memory,
            auth="admin",
            summary="Update a memory and append a version snapshot",
            module_id="core-memory",
        ),
        ModuleRouteDefinition(
            path="/api/memories/{memory_id}",
            methods=("DELETE",),
            handler=delete_single_memory,
            auth="admin",
            summary="Delete a memory from an isolated namespace",
            module_id="core-memory",
        ),
        ModuleRouteDefinition(
            path="/api/memories/{memory_id}/versions",
            methods=("GET",),
            handler=get_memory_versions,
            auth="dashboard",
            summary="Read version history for a memory in a matching namespace",
            module_id="core-memory",
        ),
    )
