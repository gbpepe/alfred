"""Authorized `core-ops` LLM tools & zero-cross-import Service Bus Protocol contracts."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Final, Literal, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field, model_validator

from alfred.kernel.errors import ModuleError
from alfred.kernel.types import (
    ModuleToolDefinition,
    ServiceBus,
    ToolExecutionContext,
    ToolExecutionResult,
)

from .housekeeper import Housekeeper
from .system_monitor import collect_telemetry

AUTHORIZED_OPS_AGENTS: Final[tuple[str, ...]] = ("alfred-ops", "alfred", "alfred-core")


@runtime_checkable
class CoreCliServiceProtocol(Protocol):
    """Local structural Protocol matching `core-cli`'s `CoreCliService` without cross-imports."""

    async def get_cli_status(self) -> Any: ...

    async def list_profiles(self, provider_id: str | None = None) -> Any: ...

    async def switch_profile(self, provider_id: str, profile_id: str) -> Any: ...

    async def sync_mcp_and_skills(
        self,
        *,
        skills_source_dir: Path | None = None,
        mcp_config: dict[str, Any] | None = None,
    ) -> Any: ...


def require_core_cli_service(modules: ServiceBus) -> CoreCliServiceProtocol:
    """Resolve `core-cli` exclusively via Service Bus and verify structural Protocol."""
    svc = modules.require_service("core-cli")
    if not isinstance(svc, CoreCliServiceProtocol):
        raise ModuleError(
            "Registered 'core-cli' service does not match CoreCliServiceProtocol",
            code="INVALID_SERVICE_CONTRACT",
            module_id="core-ops",
            status_code=502,
        )
    return svc


def serialize_service_result(result: Any) -> dict[str, Any]:
    """Serialize a `BaseModel` or `dict` returned across the Service Bus boundary."""
    if isinstance(result, BaseModel):
        return result.model_dump(mode="json")
    if isinstance(result, dict):
        return dict(result)
    raise ModuleError(
        f"Unexpected service response type '{type(result).__name__}'",
        code="INVALID_SERVICE_RESPONSE",
        module_id="core-ops",
        status_code=502,
    )


class CliManageArgs(BaseModel):
    """Strict arguments for `cli_manage` tool."""

    model_config = ConfigDict(extra="forbid")

    action: Literal["status", "list_profiles", "switch_profile", "sync_skills"]
    provider_id: str | None = Field(
        default=None,
        min_length=1,
        description="CLI provider ID (e.g. claude-cli, agy-cli, codex-cli, gemini-cli).",
    )
    profile_id: str | None = Field(
        default=None,
        min_length=1,
        description="Target profile ID (required when action='switch_profile').",
    )
    skills_source_dir: str | None = Field(
        default=None,
        min_length=1,
        description="Workspace-confined path to skills directory for sync_skills.",
    )
    mcp_config: dict[str, Any] | None = Field(
        default=None,
        description="Optional MCP server configuration dictionary for sync_skills.",
    )

    @model_validator(mode="after")
    def _validate_action_requirements(self) -> CliManageArgs:
        if self.action == "switch_profile" and (not self.provider_id or not self.profile_id):
            raise ValueError("action='switch_profile' requires both 'provider_id' and 'profile_id'")
        return self


class SystemStorageArgs(BaseModel):
    """Strict arguments for `system_storage` tool."""

    model_config = ConfigDict(extra="forbid")

    include_psi: bool = Field(
        default=True,
        description="Include Linux PSI cpu/memory/io stall metrics when available.",
    )
    include_heavy_holds: bool = Field(
        default=True,
        description="Include active heavy-job hold counts and labels.",
    )


class ModuleManageArgs(BaseModel):
    """Strict arguments for `module_manage` tool."""

    model_config = ConfigDict(extra="forbid")

    action: Literal["list", "housekeeping"]
    retention_days: int = Field(
        default=30,
        ge=1,
        le=3650,
        description="Retention window in days when action='housekeeping'.",
    )


def _confine_skills_dir(raw_path: str, ctx: ToolExecutionContext) -> Path:
    if "\x00" in raw_path:
        raise ValueError("NUL byte is not allowed in skills_source_dir")
    ws_root = ctx.workspace_dir.resolve()
    proj_root = ctx.module_ctx.project_root.resolve()
    candidate = Path(raw_path)
    resolved = candidate.resolve() if candidate.is_absolute() else (ws_root / candidate).resolve()
    if resolved.is_relative_to(ws_root) or resolved.is_relative_to(proj_root):
        return resolved
    raise ValueError(f"skills_source_dir '{raw_path}' escapes workspace/project root")


async def _exec_cli_manage(args: CliManageArgs, ctx: ToolExecutionContext) -> ToolExecutionResult:
    try:
        svc = require_core_cli_service(ctx.module_ctx.modules)
    except ModuleError as exc:
        return ToolExecutionResult(ok=False, error=exc.message, error_code=exc.code)

    if args.action == "status":
        res = await svc.get_cli_status()
        return ToolExecutionResult(ok=True, output=serialize_service_result(res))

    if args.action == "list_profiles":
        res = await svc.list_profiles(provider_id=args.provider_id)
        return ToolExecutionResult(ok=True, output=serialize_service_result(res))

    if args.action == "switch_profile":
        provider_id = args.provider_id or ""
        profile_id = args.profile_id or ""
        res = await svc.switch_profile(provider_id, profile_id)
        payload = serialize_service_result(res)
        ok = bool(payload.get("ok", True))
        return ToolExecutionResult(
            ok=ok,
            output=payload,
            error=None if ok else str(payload.get("message") or "Profile switch failed"),
            error_code=None if ok else "CLI_SWITCH_FAILED",
        )

    skills_dir: Path | None = None
    if args.skills_source_dir is not None:
        try:
            skills_dir = _confine_skills_dir(args.skills_source_dir, ctx)
        except ValueError as exc:
            return ToolExecutionResult(
                ok=False,
                error=str(exc),
                error_code="PATH_OUTSIDE_WORKSPACE",
            )
    res = await svc.sync_mcp_and_skills(
        skills_source_dir=skills_dir,
        mcp_config=args.mcp_config,
    )
    payload = serialize_service_result(res)
    ok = bool(payload.get("ok", True))
    return ToolExecutionResult(
        ok=ok,
        output=payload,
        error=None if ok else "MCP/skill sync reported blocked or failed items",
        error_code=None if ok else "SKILL_SYNC_BLOCKED",
    )


async def _exec_system_storage(
    args: SystemStorageArgs,
    ctx: ToolExecutionContext,
) -> ToolExecutionResult:
    report = await collect_telemetry(ctx.module_ctx, workspace_dir=ctx.workspace_dir)
    payload = report.model_dump(mode="json")
    if not args.include_psi:
        payload.pop("psi", None)
    if not args.include_heavy_holds:
        payload.pop("active_heavy_holds", None)
        payload.pop("heavy_hold_labels", None)
    return ToolExecutionResult(ok=True, output=payload)


async def _exec_module_manage(
    args: ModuleManageArgs,
    ctx: ToolExecutionContext,
) -> ToolExecutionResult:
    if args.action == "list":
        active_ids = ctx.module_ctx.modules.list_active_module_ids()
        active_set = set(active_ids)
        rows = await ctx.module_ctx.db.list_module_rows()
        return ToolExecutionResult(
            ok=True,
            output={
                "active_module_ids": active_ids,
                "active_count": len(active_ids),
                "installed_modules": [
                    {
                        "module_id": row.module_id,
                        "state": row.state,
                        "installed_at": row.installed_at,
                        "updated_at": row.updated_at,
                        "active_in_registry": row.module_id in active_set,
                    }
                    for row in rows
                ],
            },
        )

    report = await Housekeeper().run(ctx.module_ctx, retention_days=args.retention_days)
    return ToolExecutionResult(ok=True, output=report.model_dump(mode="json"))


def build_ops_tools() -> tuple[ModuleToolDefinition[Any], ...]:
    """Build the three `core-ops` tools restricted to ops/core agents."""
    return (
        ModuleToolDefinition(
            name="cli_manage",
            description=(
                "Manage headless CLI providers, profiles, and skill/MCP sync "
                "via the core-cli Service Bus."
            ),
            args_model=CliManageArgs,
            execute=_exec_cli_manage,
            module_id="core-ops",
            authorized_agent_ids=AUTHORIZED_OPS_AGENTS,
        ),
        ModuleToolDefinition(
            name="system_storage",
            description=(
                "Collect 2 GB VPS RAM, Linux PSI, disk usage, workspace/store/db/logs "
                "breakdown, and heavy-job holds."
            ),
            args_model=SystemStorageArgs,
            execute=_exec_system_storage,
            module_id="core-ops",
            authorized_agent_ids=AUTHORIZED_OPS_AGENTS,
        ),
        ModuleToolDefinition(
            name="module_manage",
            description="List active/installed modules or trigger heavy-job-aware housekeeping.",
            args_model=ModuleManageArgs,
            execute=_exec_module_manage,
            module_id="core-ops",
            authorized_agent_ids=AUTHORIZED_OPS_AGENTS,
        ),
    )
