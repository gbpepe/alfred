"""`core-cli` microkernel plugin entrypoint, HTTP routes, UI contribution & wizard probe."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from fastapi import Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.responses import JSONResponse

from alfred.kernel.errors import ModuleDisabledError
from alfred.kernel.types import (
    BaseModulePlugin,
    ModuleContext,
    ModuleModelProvider,
    ModuleRouteDefinition,
    ModuleToolDefinition,
    ModuleUiContribution,
    ProbeCheck,
    ProbeResult,
    RouteReturn,
)

from .cli_manager import CoreCliService
from .cli_runner import BaseCliModelProvider, CliSubprocessRunner, create_cli_providers
from .profiles import (
    SUPPORTED_CLI_PROVIDERS,
    CliProviderId,
    CliRuntimeTracker,
    check_binary_available,
    coerce_provider_id,
    resolve_cli_binary,
)
from .tools import build_core_cli_tools


class SwitchProfileRequest(BaseModel):
    """Validated JSON body for `POST /api/cli/switch`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    provider_id: CliProviderId = Field(alias="providerId")
    profile_id: str = Field(
        alias="profileId",
        min_length=1,
        pattern=r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$",
    )


class SyncSkillsMcpRequest(BaseModel):
    """Validated JSON body for `POST /api/cli/sync`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    skills_source_dir: str | None = Field(default=None, alias="skillsSourceDir")
    mcp_config: dict[str, Any] | None = Field(default=None, alias="mcpConfig")


def format_validation_errors(exc: ValidationError) -> str:
    """Format Pydantic `ValidationError` safely without exposing input secrets or URLs."""
    parts: list[str] = []
    for err in exc.errors(include_url=False, include_input=False):
        loc = ".".join(str(part) for part in err.get("loc", ())) or "<root>"
        msg = str(err.get("msg", "Invalid value"))
        parts.append(f"{loc}: {msg}")
    return "; ".join(parts) if parts else "Validation failed"


def _error_json(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": code, "message": message})


class CoreCliPlugin(BaseModulePlugin):
    """Built-in Alfred `core-cli` plugin registering workspace tools, CLI models & routes."""

    id = "core-cli"

    def __init__(self, *, subprocess_runner: CliSubprocessRunner | None = None) -> None:
        self._tracker = CliRuntimeTracker()
        self._subprocess_runner = subprocess_runner
        self._ctx: ModuleContext | None = None
        self._service: CoreCliService | None = None
        self._providers: tuple[BaseCliModelProvider, ...] = create_cli_providers(
            ctx_getter=self._get_ctx,
            tracker=self._tracker,
            subprocess_runner=self._subprocess_runner,
        )

    def _get_ctx(self) -> ModuleContext | None:
        return self._ctx

    def _require_service(self) -> CoreCliService:
        if self._service is None:
            raise ModuleDisabledError(self.id)
        return self._service

    def _require_ctx(self) -> ModuleContext:
        if self._ctx is None:
            raise ModuleDisabledError(self.id)
        return self._ctx

    @property
    def cli_env_sanitize_keys(self) -> Sequence[str]:
        """Environment keys stripped by default from all CLI child processes."""
        return ("ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY")

    def create_service(self, ctx: ModuleContext) -> CoreCliService:
        """Instantiate and export `CoreCliService` on the microkernel Service Bus."""
        self._ctx = ctx
        self._service = CoreCliService(ctx, tracker=self._tracker)
        return self._service

    def tools(self) -> Sequence[ModuleToolDefinition[Any]]:
        """Expose `fs_read`, `fs_write`, `bash`, and `git` tools."""
        return build_core_cli_tools()

    def providers(self) -> Sequence[ModuleModelProvider]:
        """Expose the 4 subscription CLI `ModuleModelProvider` adapters."""
        return self._providers

    def ui_contributions(self) -> Sequence[ModuleUiContribution]:
        """Register the `vpsCliProvidersCard` UI contribution in `providers-panel`."""
        return (
            ModuleUiContribution(
                id="vpsCliProvidersCard",
                module_id=self.id,
                slot="providers-panel",
                title="CLI Providers & Skills",
                entry_file="providers-panel.js",
                order=10,
            ),
        )

    def routes(self) -> Sequence[ModuleRouteDefinition]:
        """Expose Auth/CSRF-gated CLI status, profile switching, and skill/MCP sync routes."""

        async def handle_status(_request: Request) -> RouteReturn:
            svc = self._require_service()
            return await svc.get_cli_status()

        async def handle_profiles(request: Request) -> RouteReturn:
            svc = self._require_service()
            raw_provider = (
                request.query_params.get("provider_id")
                or request.query_params.get("providerId")
            )
            if raw_provider is not None:
                pid = coerce_provider_id(raw_provider)
                if pid is None:
                    return _error_json(
                        400,
                        "INVALID_PROVIDER",
                        f"Unsupported CLI provider '{raw_provider}'",
                    )
                return await svc.list_profiles(provider_id=pid)
            return await svc.list_profiles()

        async def handle_switch(request: Request) -> RouteReturn:
            svc = self._require_service()
            try:
                raw_json = await request.json()
            except ValueError:
                return _error_json(400, "INVALID_REQUEST", "Malformed JSON request body")
            try:
                payload = SwitchProfileRequest.model_validate(raw_json)
            except ValidationError as exc:
                return _error_json(400, "INVALID_REQUEST", format_validation_errors(exc))

            result = await svc.switch_profile(payload.provider_id, payload.profile_id)
            if not result.ok:
                return JSONResponse(
                    status_code=404,
                    content={
                        "error": "PROFILE_NOT_FOUND",
                        **result.model_dump(mode="json"),
                    },
                )
            return result

        async def handle_sync(request: Request) -> RouteReturn:
            svc = self._require_service()
            ctx = self._require_ctx()
            body_bytes = await request.body()
            if not body_bytes.strip():
                raw_json: Any = {}
            else:
                try:
                    raw_json = json.loads(body_bytes)
                except ValueError:
                    return _error_json(400, "INVALID_REQUEST", "Malformed JSON request body")

            try:
                payload = SyncSkillsMcpRequest.model_validate(raw_json)
            except ValidationError as exc:
                return _error_json(400, "INVALID_REQUEST", format_validation_errors(exc))

            skills_dir: Path | None = None
            if payload.skills_source_dir is not None:
                if "\x00" in payload.skills_source_dir:
                    return _error_json(403, "MODULE_SECURITY_ERROR", "Invalid skills_source_dir")
                root = ctx.project_root.resolve()
                candidate = (root / payload.skills_source_dir).resolve()
                if not candidate.is_relative_to(root):
                    return _error_json(
                        403,
                        "MODULE_SECURITY_ERROR",
                        "skills_source_dir escapes project_root",
                    )
                skills_dir = candidate

            return await svc.sync_mcp_and_skills(
                skills_source_dir=skills_dir,
                mcp_config=payload.mcp_config,
            )

        return (
            ModuleRouteDefinition(
                path="/api/cli/status",
                methods=("GET",),
                handler=handle_status,
                auth="dashboard",
                summary="Get CLI providers status and active profiles",
                module_id=self.id,
            ),
            ModuleRouteDefinition(
                path="/api/cli/profiles",
                methods=("GET",),
                handler=handle_profiles,
                auth="dashboard",
                summary="List CLI profiles",
                module_id=self.id,
            ),
            ModuleRouteDefinition(
                path="/api/cli/switch",
                methods=("POST",),
                handler=handle_switch,
                auth="admin",
                summary="Switch active CLI profile",
                module_id=self.id,
            ),
            ModuleRouteDefinition(
                path="/api/cli/sync",
                methods=("POST",),
                handler=handle_sync,
                auth="admin",
                summary="Scan and sync skills & MCP configurations",
                module_id=self.id,
            ),
        )

    async def wizard_probe(self, ctx: ModuleContext) -> ProbeResult:
        """Probe CLI binaries and confined `store/modules/core-cli` writability."""
        checks: list[ProbeCheck] = []
        data_ok = True
        try:
            data_path = await asyncio.to_thread(ctx.security.data_dir.ensure_exists)
            checks.append(
                ProbeCheck(
                    name="data_dir",
                    ok=data_path.is_dir(),
                    detail=f"Confined store ready: {data_path.name}",
                )
            )
        except OSError as exc:
            data_ok = False
            checks.append(ProbeCheck(name="data_dir", ok=False, detail=str(exc)))

        available_count = 0
        for pid in SUPPORTED_CLI_PROVIDERS:
            binary = resolve_cli_binary(pid)
            resolved = await asyncio.to_thread(check_binary_available, binary)
            found = resolved is not None
            if found:
                available_count += 1
            checks.append(
                ProbeCheck(
                    name=f"cli:{pid}",
                    ok=found,
                    detail=resolved if resolved else f"Binary '{binary}' not found",
                )
            )

        return ProbeResult(
            ok=data_ok,
            module_id=self.id,
            summary=(
                f"{available_count}/{len(SUPPORTED_CLI_PROVIDERS)} CLI binaries available; "
                "workspace tools ready"
            ),
            checks=checks,
        )

    async def on_unload(self, ctx: ModuleContext) -> None:
        """Clear bound runtime references when `core-cli` unloads."""
        self._service = None
        self._ctx = None


plugin = CoreCliPlugin()
