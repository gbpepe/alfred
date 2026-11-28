"""HTTP routes for `core-ops` telemetry, storage, housekeeping & CLI Service Bus controls."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Literal

from fastapi import Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.responses import JSONResponse, Response

from alfred.kernel.types import ModuleContext, ModuleRouteDefinition, RouteReturn

from .housekeeper import Housekeeper
from .system_monitor import DiskTelemetry, StorageBreakdown, collect_telemetry
from .tools import require_core_cli_service, serialize_service_result


class StorageStatusResponse(BaseModel):
    """Structured storage & disk usage DTO for `GET /api/ops/storage`."""

    model_config = ConfigDict(extra="forbid")

    captured_at: str
    disk: DiskTelemetry
    storage: StorageBreakdown
    active_heavy_holds: int = Field(ge=0)
    health_level: Literal["ok", "warn", "crit"]


class HousekeepingRequest(BaseModel):
    """Validated payload for `POST /api/ops/housekeeping`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    retention_days: int = Field(default=30, alias="retentionDays", ge=1, le=3650)


class CliSwitchRequest(BaseModel):
    """Validated payload for `POST /api/ops/cli/switch`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    provider_id: str = Field(alias="providerId", min_length=1)
    profile_id: str = Field(alias="profileId", min_length=1)


def format_validation_error(exc: ValidationError) -> str:
    """Format Pydantic `ValidationError` safely without echoing raw `input_value`."""
    parts: list[str] = []
    for err in exc.errors(include_url=False, include_input=False):
        loc = ".".join(str(part) for part in err.get("loc", ())) or "<root>"
        msg = str(err.get("msg", "Invalid value"))
        parts.append(f"{loc}: {msg}")
    return "; ".join(parts) if parts else "Validation failed"


def _error_response(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": code, "message": message})


def build_ops_routes(get_ctx: Callable[[], ModuleContext]) -> tuple[ModuleRouteDefinition, ...]:
    """Create the five `core-ops` HTTP routes wired to the active `ModuleContext`."""

    async def get_telemetry(_request: Request) -> RouteReturn:
        ctx = get_ctx()
        return await collect_telemetry(ctx)

    async def get_storage(_request: Request) -> RouteReturn:
        ctx = get_ctx()
        report = await collect_telemetry(ctx)
        return StorageStatusResponse(
            captured_at=report.captured_at,
            disk=report.disk,
            storage=report.storage,
            active_heavy_holds=report.active_heavy_holds,
            health_level=report.health_level,
        )

    async def post_housekeeping(request: Request) -> Response:
        ctx = get_ctx()
        raw_body = await request.body()
        if raw_body.strip():
            try:
                parsed_json = json.loads(raw_body)
                req_dto = HousekeepingRequest.model_validate(parsed_json)
            except json.JSONDecodeError:
                return _error_response(400, "INVALID_REQUEST", "Malformed JSON request body")
            except ValidationError as exc:
                return _error_response(
                    400,
                    "VALIDATION_ERROR",
                    f"Invalid housekeeping payload: {format_validation_error(exc)}",
                )
        else:
            req_dto = HousekeepingRequest()

        report = await Housekeeper().run(ctx, retention_days=req_dto.retention_days)
        return JSONResponse(status_code=200, content=report.model_dump(mode="json"))

    async def get_cli_status(_request: Request) -> Response:
        ctx = get_ctx()
        svc = require_core_cli_service(ctx.modules)
        status = await svc.get_cli_status()
        return JSONResponse(status_code=200, content=serialize_service_result(status))

    async def post_cli_switch(request: Request) -> Response:
        ctx = get_ctx()
        raw_body = await request.body()
        if not raw_body.strip():
            return _error_response(400, "INVALID_REQUEST", "Request body is required")
        try:
            parsed_json = json.loads(raw_body)
            req_dto = CliSwitchRequest.model_validate(parsed_json)
        except json.JSONDecodeError:
            return _error_response(400, "INVALID_REQUEST", "Malformed JSON request body")
        except ValidationError as exc:
            return _error_response(
                400,
                "VALIDATION_ERROR",
                f"Invalid CLI switch payload: {format_validation_error(exc)}",
            )

        svc = require_core_cli_service(ctx.modules)
        result = await svc.switch_profile(req_dto.provider_id, req_dto.profile_id)
        return JSONResponse(status_code=200, content=serialize_service_result(result))

    return (
        ModuleRouteDefinition(
            path="/api/ops/telemetry",
            methods=("GET",),
            handler=get_telemetry,
            auth="dashboard",
            summary="Collect 2 GB VPS RAM, PSI, SSD & heavy-job telemetry",
            module_id="core-ops",
        ),
        ModuleRouteDefinition(
            path="/api/ops/storage",
            methods=("GET",),
            handler=get_storage,
            auth="dashboard",
            summary="Collect SSD and workspace/store/db/logs storage breakdown",
            module_id="core-ops",
        ),
        ModuleRouteDefinition(
            path="/api/ops/housekeeping",
            methods=("POST",),
            handler=post_housekeeping,
            auth="admin",
            summary="Run heavy-job-aware WAL checkpoint, pruning & module cleanup",
            module_id="core-ops",
        ),
        ModuleRouteDefinition(
            path="/api/ops/cli/status",
            methods=("GET",),
            handler=get_cli_status,
            auth="dashboard",
            summary="Fetch CLI provider status via core-cli Service Bus",
            module_id="core-ops",
        ),
        ModuleRouteDefinition(
            path="/api/ops/cli/switch",
            methods=("POST",),
            handler=post_cli_switch,
            auth="admin",
            summary="Switch active CLI provider profile via core-cli Service Bus",
            module_id="core-ops",
        ),
    )
