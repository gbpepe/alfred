"""HTTP routes for `batch-api` mounted via the microkernel HTTP bridge."""

from __future__ import annotations

import json
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Final

from fastapi import Request
from pydantic import ValidationError
from starlette.responses import JSONResponse

from alfred.kernel.errors import ModuleError
from alfred.kernel.types import ModuleRouteDefinition, RouteReturn

from .adapters import BATCH_PROVIDERS, BatchJobStatus, BatchProviderName
from .runner import BatchRunner, BatchSubmitInput

_VALID_STATUSES: Final[frozenset[str]] = frozenset(
    {"queued", "submitted", "running", "downloading", "completed", "failed", "cancelled"}
)


def format_validation_error(exc: ValidationError) -> tuple[str, list[dict[str, Any]]]:
    """Format Pydantic `ValidationError` safely without leaking URLs or raw input values."""
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


async def _parse_json_object(
    request: Request,
    *,
    allow_empty: bool = False,
) -> tuple[dict[str, Any] | None, JSONResponse | None]:
    raw_bytes = await request.body()
    if not raw_bytes.strip():
        if allow_empty:
            return {}, None
        return None, _error_json(400, "INVALID_JSON", "Request body is required")
    try:
        parsed = json.loads(raw_bytes)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        return None, _error_json(400, "INVALID_JSON", "Malformed JSON request body")
    if not isinstance(parsed, dict):
        return None, _error_json(400, "INVALID_REQUEST", "Request JSON body must be an object")
    return parsed, None


def _coerce_status(raw: str | None) -> BatchJobStatus | None:
    if raw is None:
        return None
    cleaned = raw.strip()
    if not cleaned:
        return None
    if cleaned == "queued":
        return "queued"
    if cleaned == "submitted":
        return "submitted"
    if cleaned == "running":
        return "running"
    if cleaned == "downloading":
        return "downloading"
    if cleaned == "completed":
        return "completed"
    if cleaned == "failed":
        return "failed"
    if cleaned == "cancelled":
        return "cancelled"
    return None


def _coerce_provider(raw: str | None) -> BatchProviderName | None:
    if raw is None:
        return None
    cleaned = raw.strip()
    if not cleaned:
        return None
    if cleaned == "anthropic":
        return "anthropic"
    if cleaned == "gemini":
        return "gemini"
    if cleaned == "vertex-eu":
        return "vertex-eu"
    if cleaned == "openai":
        return "openai"
    return None


def build_batch_routes(
    require_runner: Callable[[], BatchRunner],
) -> Sequence[ModuleRouteDefinition]:
    """Build the 4 Auth/CSRF-gated HTTP routes for `batch-api`."""

    async def list_jobs_handler(request: Request) -> RouteReturn:
        runner = require_runner()
        qp = request.query_params

        raw_status = qp.get("status")
        status_filter: BatchJobStatus | None = None
        if raw_status is not None and raw_status.strip():
            status_filter = _coerce_status(raw_status)
            if status_filter is None:
                return _error_json(
                    400,
                    "INVALID_REQUEST",
                    f"Invalid status filter; expected one of {sorted(_VALID_STATUSES)}",
                )

        raw_provider = qp.get("provider")
        provider_filter: BatchProviderName | None = None
        if raw_provider is not None and raw_provider.strip():
            provider_filter = _coerce_provider(raw_provider)
            if provider_filter is None:
                return _error_json(
                    400,
                    "INVALID_REQUEST",
                    f"Invalid provider filter; expected one of {list(BATCH_PROVIDERS)}",
                )

        raw_limit = qp.get("limit")
        limit = 20
        if raw_limit is not None:
            try:
                limit = int(raw_limit)
            except ValueError:
                return _error_json(
                    400,
                    "INVALID_REQUEST",
                    "Query parameter 'limit' must be an integer",
                )
            if limit < 1 or limit > 100:
                return _error_json(
                    400,
                    "INVALID_REQUEST",
                    "Query parameter 'limit' must be between 1 and 100",
                )

        return await runner.get_overview(
            status=status_filter,
            provider=provider_filter,
            limit=limit,
        )

    async def create_job_handler(request: Request) -> RouteReturn:
        raw, err = await _parse_json_object(request, allow_empty=False)
        if err is not None or raw is None:
            return err or _error_json(400, "INVALID_JSON", "Invalid request body")
        try:
            payload = BatchSubmitInput.model_validate(raw)
        except ValidationError as exc:
            return _validation_error_response(exc)

        runner = require_runner()
        try:
            job = await runner.submit_job(payload)
        except ModuleError as exc:
            return JSONResponse(status_code=exc.status_code, content=exc.to_payload())
        return JSONResponse(status_code=201, content=job.model_dump(mode="json"))

    async def get_job_handler(request: Request) -> RouteReturn:
        job_id = _get_path_param(request, "job_id")
        if not job_id:
            return _error_json(400, "INVALID_REQUEST", "Missing path parameter 'job_id'")
        poll_flag = (request.query_params.get("poll") or "").strip().lower() in (
            "1",
            "true",
            "yes",
        )
        runner = require_runner()
        try:
            return await runner.get_job(job_id, poll=poll_flag)
        except ModuleError as exc:
            return JSONResponse(status_code=exc.status_code, content=exc.to_payload())

    async def cancel_job_handler(request: Request) -> RouteReturn:
        job_id = _get_path_param(request, "job_id")
        if not job_id:
            return _error_json(400, "INVALID_REQUEST", "Missing path parameter 'job_id'")
        _, err = await _parse_json_object(request, allow_empty=True)
        if err is not None:
            return err
        runner = require_runner()
        try:
            return await runner.cancel_job(job_id)
        except ModuleError as exc:
            return JSONResponse(status_code=exc.status_code, content=exc.to_payload())

    return (
        ModuleRouteDefinition(
            path="/api/batch/jobs",
            methods=("GET",),
            handler=list_jobs_handler,
            auth="dashboard",
            summary="List batch jobs and 4-provider CostOps savings summary",
            module_id="batch-api",
        ),
        ModuleRouteDefinition(
            path="/api/batch/jobs",
            methods=("POST",),
            handler=create_job_handler,
            auth="admin",
            summary="Submit a new multi-provider Batch API job",
            module_id="batch-api",
        ),
        ModuleRouteDefinition(
            path="/api/batch/jobs/{job_id}",
            methods=("GET",),
            handler=get_job_handler,
            auth="dashboard",
            summary="Get batch job status and optional live poll",
            module_id="batch-api",
        ),
        ModuleRouteDefinition(
            path="/api/batch/jobs/{job_id}/cancel",
            methods=("POST",),
            handler=cancel_job_handler,
            auth="admin",
            summary="Cancel an in-flight batch job",
            module_id="batch-api",
        ),
    )
