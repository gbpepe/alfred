"""Core FastAPI routes with strict Pydantic v2 DTOs and Auth/CSRF verification."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import TYPE_CHECKING, Final

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.responses import JSONResponse, Response

from alfred.core.auth import AuthError, AuthLevel
from alfred.core.circuit_breaker import utc_day_start_sec
from alfred.core.model_router import (
    BudgetExceededError,
    GdprComplianceError,
    ProviderNotFoundError,
    RouterError,
)
from alfred.core.module_manager import ModuleLifecycleResult, ModuleSummaryDTO
from alfred.core.module_wizard import WizardSaveRequest, WizardSaveResponse, WizardStateResponse
from alfred.core.test_simulator import TestSimRequest, TestSimResponse
from alfred.core.vault import VaultError, VaultSecretMetadata
from alfred.kernel.errors import ModuleError
from alfred.kernel.types import ModuleUiContribution, ProbeResult

if TYPE_CHECKING:
    from alfred.core.web_app import CoreAppContainer

_SAFE_DOC_FILENAME_RE: Final[re.Pattern[str]] = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.md$")


class CoreHealthResponse(BaseModel):
    """Health check DTO."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    ok: bool
    version: str
    environment: str
    active_modules: list[str] = Field(alias="activeModules")


class OverviewResponse(BaseModel):
    """Dashboard overview status summary DTO."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    ok: bool
    environment: str
    daily_spend_usd: float = Field(alias="dailySpendUsd")
    global_daily_budget_usd: float = Field(alias="globalDailyBudgetUsd")
    active_modules: int = Field(alias="activeModules")
    total_modules: int = Field(alias="totalModules")
    agents_total: int = Field(alias="agentsTotal")
    agents_enabled: int = Field(alias="agentsEnabled")


class AgentViewDTO(BaseModel):
    """Safe agent view DTO for `#agents` Dashboard rendering."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str
    display_name: str = Field(alias="displayName")
    role: str
    provider: str | None
    model: str | None
    effective_provider: str = Field(alias="effectiveProvider")
    effective_model: str = Field(alias="effectiveModel")
    has_override: bool = Field(alias="hasOverride")
    enabled: bool
    eu_only: bool = Field(alias="euOnly")
    daily_budget_usd: float = Field(alias="dailyBudgetUsd")
    tools: list[str]


class AgentsListResponse(BaseModel):
    """List wrapper DTO for `GET /api/agents`."""

    model_config = ConfigDict(extra="forbid")

    agents: list[AgentViewDTO]


class AgentPatchRequest(BaseModel):
    """Validated patch payload for `PATCH /api/agents/{agent_id}`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    display_name: str | None = Field(default=None, alias="displayName", min_length=1)
    role: str | None = Field(default=None, min_length=1)
    provider: str | None = None
    model: str | None = None
    enabled: bool | None = None
    eu_only: bool | None = Field(default=None, alias="euOnly")
    daily_budget_usd: float | None = Field(default=None, alias="dailyBudgetUsd", ge=0)
    tools: list[str] | None = None


class VaultListResponse(BaseModel):
    """Structurally secret-free Vault metadata list response."""

    model_config = ConfigDict(extra="forbid")

    secrets: list[VaultSecretMetadata]


class VaultSetRequest(BaseModel):
    """Validated Vault upsert input DTO."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    key_id: str = Field(alias="keyId", min_length=1)
    value: str = Field(min_length=1)
    label: str | None = None


class VaultSetResponse(BaseModel):
    """Secret-free confirmation DTO after Vault write."""

    model_config = ConfigDict(extra="forbid")

    ok: bool
    metadata: VaultSecretMetadata


class VaultDeleteResponse(BaseModel):
    """Confirmation DTO for Vault key deletion."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    ok: bool
    deleted: bool
    key_id: str = Field(alias="keyId")


class ModulesListResponse(BaseModel):
    """Combined module status and active UI contribution slots DTO."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    modules: list[ModuleSummaryDTO]
    ui_contributions: list[ModuleUiContribution] = Field(alias="uiContributions")


class DocsListResponse(BaseModel):
    """Available markdown handbook chapters DTO."""

    model_config = ConfigDict(extra="forbid")

    chapters: list[str]


class DocContentResponse(BaseModel):
    """Markdown handbook chapter content DTO."""

    model_config = ConfigDict(extra="forbid")

    filename: str
    content: str


def _json_dto(dto: BaseModel, status_code: int = 200) -> JSONResponse:
    return JSONResponse(status_code=status_code, content=dto.model_dump(mode="json", by_alias=True))


def _auth_error_response(err: AuthError) -> JSONResponse:
    return JSONResponse(
        status_code=err.status_code,
        content={"error": err.code, "message": err.message},
    )


def _error_json(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": code, "message": message})


def _agents_missing_error() -> JSONResponse:
    return _error_json(404, "AGENTS_CONFIG_NOT_FOUND", "Agent configuration file is missing")


def format_validation_error(exc: ValidationError) -> str:
    """Format Pydantic `ValidationError` safely without echoing raw `input_value` secrets."""
    parts: list[str] = []
    for err in exc.errors(include_url=False, include_input=False):
        loc = ".".join(str(part) for part in err.get("loc", ())) or "<root>"
        msg = str(err.get("msg", "Invalid value"))
        parts.append(f"{loc}: {msg}")
    return "; ".join(parts) if parts else "Validation failed"


def _list_docs_sync(docs_dir: Path) -> list[str]:
    if not docs_dir.exists() or not docs_dir.is_dir():
        return []
    return sorted(
        path.name
        for path in docs_dir.iterdir()
        if path.is_file() and _SAFE_DOC_FILENAME_RE.match(path.name)
    )


def _read_doc_sync(docs_dir: Path, filename: str) -> str | None:
    if not _SAFE_DOC_FILENAME_RE.match(filename):
        raise ValueError("Invalid documentation chapter filename")
    root = docs_dir.resolve()
    target = (root / filename).resolve()
    if not target.is_relative_to(root) or not target.is_file():
        return None
    try:
        return target.read_text(encoding="utf-8")
    except OSError:
        return None


def create_core_router(container: CoreAppContainer) -> APIRouter:
    """Create the thin core FastAPI `APIRouter` wired to `CoreAppContainer`."""
    router = APIRouter()

    def _require_auth(request: Request, level: AuthLevel) -> JSONResponse | None:
        try:
            container.auth.verify_request(request, level)
        except AuthError as auth_err:
            return _auth_error_response(auth_err)
        return None

    @router.get("/api/core/health")
    async def core_health() -> Response:
        return _json_dto(
            CoreHealthResponse(
                ok=True,
                version="2.0.0",
                environment=container.settings.environment,
                active_modules=container.registry.active_module_ids(),
            )
        )

    @router.get("/api/overview")
    async def get_overview(request: Request) -> Response:
        denied = _require_auth(request, "dashboard")
        if denied is not None:
            return denied
        try:
            cfg = container.agents.load()
        except FileNotFoundError:
            return _agents_missing_error()
        since = utc_day_start_sec()
        spend = await container.db.get_daily_spend_usd(since_ts=since)
        modules = await container.module_manager.list_modules()
        return _json_dto(
            OverviewResponse(
                ok=True,
                environment=container.settings.environment,
                daily_spend_usd=round(spend, 6),
                global_daily_budget_usd=cfg.global_config.daily_budget_usd,
                active_modules=len(container.registry.active_module_ids()),
                total_modules=len(modules),
                agents_total=len(cfg.agents),
                agents_enabled=sum(1 for a in cfg.agents if a.enabled),
            )
        )

    @router.get("/api/agents")
    async def list_agents(request: Request) -> Response:
        denied = _require_auth(request, "dashboard")
        if denied is not None:
            return denied
        try:
            resolved_list = container.agents.list_resolved_agents()
        except FileNotFoundError:
            return _agents_missing_error()
        items = [
            AgentViewDTO(
                id=item.config.id,
                display_name=item.config.display_name,
                role=item.config.role,
                provider=item.config.provider,
                model=item.config.model,
                effective_provider=item.effective_provider,
                effective_model=item.effective_model,
                has_override=item.has_override,
                enabled=item.config.enabled,
                eu_only=item.config.eu_only,
                daily_budget_usd=item.config.daily_budget_usd,
                tools=list(item.config.tools),
            )
            for item in resolved_list
        ]
        return _json_dto(AgentsListResponse(agents=items))

    @router.patch("/api/agents/{agent_id}")
    async def patch_agent(agent_id: str, request: Request) -> Response:
        denied = _require_auth(request, "admin")
        if denied is not None:
            return denied
        try:
            patch = AgentPatchRequest.model_validate(await request.json())
        except ValidationError as exc:
            return _error_json(
                400,
                "INVALID_REQUEST",
                f"Invalid agent patch payload: {format_validation_error(exc)}",
            )
        except ValueError:
            return _error_json(400, "INVALID_REQUEST", "Malformed JSON request body")

        try:
            cfg = container.agents.load(validate_manifests=False)
        except FileNotFoundError:
            return _agents_missing_error()
        target = cfg.get_agent(agent_id)
        if target is None:
            return _error_json(404, "AGENT_NOT_FOUND", f"Unknown agent '{agent_id}'")

        updates = patch.model_dump(exclude_unset=True)
        updated_agent = target.model_copy(update=updates)
        new_agents = [updated_agent if a.id == agent_id else a for a in cfg.agents]
        new_cfg = cfg.model_copy(update={"agents": new_agents})
        try:
            container.agents.save(new_cfg)
        except ValueError as exc:
            return _error_json(400, "INVALID_AGENT_CONFIG", str(exc))

        resolved = container.agents.resolve_agent(agent_id)
        if resolved is None:
            return _error_json(404, "AGENT_NOT_FOUND", f"Unknown agent '{agent_id}'")
        return _json_dto(
            AgentViewDTO(
                id=resolved.config.id,
                display_name=resolved.config.display_name,
                role=resolved.config.role,
                provider=resolved.config.provider,
                model=resolved.config.model,
                effective_provider=resolved.effective_provider,
                effective_model=resolved.effective_model,
                has_override=resolved.has_override,
                enabled=resolved.config.enabled,
                eu_only=resolved.config.eu_only,
                daily_budget_usd=resolved.config.daily_budget_usd,
                tools=list(resolved.config.tools),
            )
        )

    @router.get("/api/vault")
    async def list_vault_secrets(request: Request) -> Response:
        denied = _require_auth(request, "admin")
        if denied is not None:
            return denied
        try:
            secrets = container.vault.list_secrets()
        except VaultError as exc:
            return _error_json(500, "VAULT_ERROR", str(exc))
        return _json_dto(VaultListResponse(secrets=secrets))

    @router.post("/api/vault")
    async def set_vault_secret(request: Request) -> Response:
        denied = _require_auth(request, "admin")
        if denied is not None:
            return denied
        try:
            body = VaultSetRequest.model_validate(await request.json())
            metadata = await container.vault.set_secret(
                body.key_id,
                body.value,
                label=body.label,
            )
        except ValidationError as exc:
            return _error_json(
                400,
                "VAULT_SET_ERROR",
                f"Invalid Vault payload: {format_validation_error(exc)}",
            )
        except json.JSONDecodeError:
            return _error_json(400, "VAULT_SET_ERROR", "Malformed JSON request body")
        except (ValueError, VaultError) as exc:
            return _error_json(400, "VAULT_SET_ERROR", str(exc))
        return _json_dto(VaultSetResponse(ok=True, metadata=metadata))

    @router.delete("/api/vault/{key_id}")
    async def delete_vault_secret(key_id: str, request: Request) -> Response:
        denied = _require_auth(request, "admin")
        if denied is not None:
            return denied
        try:
            deleted = await container.vault.delete_secret(key_id)
        except (ValueError, VaultError) as exc:
            return _error_json(400, "VAULT_DELETE_ERROR", str(exc))
        return _json_dto(VaultDeleteResponse(ok=True, deleted=deleted, key_id=key_id))

    @router.get("/api/modules")
    async def list_modules(request: Request) -> Response:
        denied = _require_auth(request, "dashboard")
        if denied is not None:
            return denied
        modules = await container.module_manager.list_modules()
        ui_slots = container.registry.list_ui_contributions()
        return _json_dto(ModulesListResponse(modules=modules, ui_contributions=ui_slots))

    @router.post("/api/modules/{module_id}/activate")
    async def activate_module(module_id: str, request: Request) -> Response:
        denied = _require_auth(request, "admin")
        if denied is not None:
            return denied
        try:
            res: ModuleLifecycleResult = await container.module_manager.activate_module(module_id)
        except ModuleError as mod_err:
            return JSONResponse(status_code=mod_err.status_code, content=mod_err.to_payload())
        return _json_dto(res)

    @router.post("/api/modules/{module_id}/deactivate")
    async def deactivate_module(module_id: str, request: Request) -> Response:
        denied = _require_auth(request, "admin")
        if denied is not None:
            return denied
        try:
            res = await container.module_manager.deactivate_module(module_id)
        except ModuleError as mod_err:
            return JSONResponse(status_code=mod_err.status_code, content=mod_err.to_payload())
        return _json_dto(res)

    @router.get("/api/modules/{module_id}/wizard")
    async def get_wizard(module_id: str, request: Request) -> Response:
        denied = _require_auth(request, "admin")
        if denied is not None:
            return denied
        try:
            state: WizardStateResponse = await container.module_wizard.get_wizard_state(module_id)
        except ModuleError as mod_err:
            return JSONResponse(status_code=mod_err.status_code, content=mod_err.to_payload())
        return _json_dto(state)

    @router.post("/api/modules/{module_id}/wizard")
    async def save_wizard(module_id: str, request: Request) -> Response:
        denied = _require_auth(request, "admin")
        if denied is not None:
            return denied
        try:
            body = WizardSaveRequest.model_validate(await request.json())
            saved: WizardSaveResponse = await container.module_wizard.save_wizard_values(
                module_id,
                body,
            )
        except ModuleError as mod_err:
            return JSONResponse(status_code=mod_err.status_code, content=mod_err.to_payload())
        except ValidationError as exc:
            return _error_json(
                400,
                "INVALID_WIZARD_PAYLOAD",
                f"Invalid wizard payload: {format_validation_error(exc)}",
            )
        except ValueError:
            return _error_json(400, "INVALID_WIZARD_PAYLOAD", "Malformed JSON request body")
        return _json_dto(saved)

    @router.post("/api/modules/{module_id}/probe")
    async def probe_module(module_id: str, request: Request) -> Response:
        denied = _require_auth(request, "admin")
        if denied is not None:
            return denied
        try:
            probe_res: ProbeResult = await container.module_wizard.run_probe(module_id)
        except ModuleError as mod_err:
            return JSONResponse(status_code=mod_err.status_code, content=mod_err.to_payload())
        return _json_dto(probe_res)

    @router.get("/api/docs")
    async def list_docs(request: Request) -> Response:
        denied = _require_auth(request, "dashboard")
        if denied is not None:
            return denied
        chapters = _list_docs_sync(container.settings.docs_dir)
        return _json_dto(DocsListResponse(chapters=chapters))

    @router.get("/api/docs/{filename}")
    async def get_doc(filename: str, request: Request) -> Response:
        denied = _require_auth(request, "dashboard")
        if denied is not None:
            return denied
        try:
            content = _read_doc_sync(container.settings.docs_dir, filename)
        except ValueError as exc:
            return _error_json(403, "INVALID_DOC_PATH", str(exc))
        if content is None:
            return _error_json(404, "DOC_NOT_FOUND", f"Documentation '{filename}' not found")
        return _json_dto(DocContentResponse(filename=filename, content=content))

    @router.post("/api/testsim/send")
    async def testsim_send(request: Request) -> Response:
        denied = _require_auth(request, "admin")
        if denied is not None:
            return denied
        try:
            req = TestSimRequest.model_validate(await request.json())
            resp: TestSimResponse = await container.test_simulator.simulate(req)
        except ModuleError as mod_err:
            return JSONResponse(status_code=mod_err.status_code, content=mod_err.to_payload())
        except GdprComplianceError as exc:
            return _error_json(403, "GDPR_COMPLIANCE_ERROR", str(exc))
        except BudgetExceededError as exc:
            return _error_json(429, "BUDGET_EXCEEDED", str(exc))
        except ProviderNotFoundError as exc:
            return _error_json(400, "PROVIDER_NOT_FOUND", str(exc))
        except RouterError as exc:
            return _error_json(502, "ROUTER_ERROR", str(exc))
        except FileNotFoundError:
            return _agents_missing_error()
        except ValidationError as exc:
            return _error_json(
                400,
                "INVALID_TESTSIM_REQUEST",
                f"Invalid testsim payload: {format_validation_error(exc)}",
            )
        except ValueError:
            return _error_json(400, "INVALID_TESTSIM_REQUEST", "Malformed JSON request body")
        return _json_dto(resp)

    return router
