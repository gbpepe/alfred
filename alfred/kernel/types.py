"""Microkernel contracts, Pydantic v2 boundary DTOs, and `AlfredModulePlugin` Protocol."""

from __future__ import annotations

import logging
import sqlite3
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, Protocol, runtime_checkable

from fastapi import Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from starlette.responses import Response

from alfred.kernel.errors import ToolValidationError

if TYPE_CHECKING:
    from alfred.core.db import SqlitePool
    from alfred.core.security.heavy_job_hold import HeavyJobHoldManager
    from alfred.kernel.security import ModuleSecurityProxy


class WizardFieldOption(BaseModel):
    """Selectable option for `select` fields inside a module Setup Wizard."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    value: str
    label: str


class WizardField(BaseModel):
    """Single input field definition in a module Setup Wizard step."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    key: str = Field(min_length=1)
    label: str = Field(min_length=1)
    type: Literal[
        "secret",
        "text",
        "number",
        "boolean",
        "select",
        "discord_channel",
        "oauth_redirect",
    ]
    storage: Literal["vault", "config_json", "env", "action"]
    required: bool = True
    default_value: str | int | float | bool | None = Field(default=None, alias="defaultValue")
    placeholder: str | None = None
    validation_regex: str | None = Field(default=None, alias="validationRegex")
    help_text: str | None = Field(default=None, alias="helpText")
    options: list[WizardFieldOption] = Field(default_factory=list)
    target_agent_id: str | None = Field(default=None, alias="targetAgentId")


class WizardStep(BaseModel):
    """Logical onboarding step declared in `module.json`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    description: str = ""
    type: str | None = None
    requirement_mode: Literal["any_one", "all_required"] | None = Field(
        default=None,
        alias="requirementMode",
    )
    fields: list[WizardField] = Field(default_factory=list)


class SetupWizardSpec(BaseModel):
    """Declarative Setup Wizard specification inside `module.json`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    title: str = Field(min_length=1)
    summary: str = ""
    test_action: str | None = Field(default=None, alias="testAction")
    doc_chapter: str | None = Field(default=None, alias="docChapter")
    steps: list[WizardStep] = Field(default_factory=list)


class ModuleManifest(BaseModel):
    """Strict boundary schema for `modules/<id>/module.json`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str = Field(min_length=1, pattern=r"^[a-z0-9][a-z0-9-]*$")
    name: str = Field(min_length=1)
    category: str = Field(min_length=1)
    version: str = Field(min_length=1)
    description: str = ""
    depends: list[str] = Field(default_factory=list)
    required_secrets: list[str] = Field(default_factory=list, alias="requiredSecrets")
    allowed_vault_keys: list[str] = Field(default_factory=list, alias="allowedVaultKeys")
    allowed_vault_prefixes: list[str] = Field(default_factory=list, alias="allowedVaultPrefixes")
    providers: list[str] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    ui_card_ids: list[str] = Field(default_factory=list, alias="uiCardIds")
    ram_impact_mb: int = Field(default=0, alias="ramImpactMb", ge=0)
    built_in: bool = Field(default=False, alias="builtIn")
    default_enabled: bool = Field(default=False, alias="defaultEnabled")
    entry: str = "plugin.py"
    probe_entry: str | None = Field(default=None, alias="probeEntry")
    setup_wizard: SetupWizardSpec | None = Field(default=None, alias="setupWizard")

    @model_validator(mode="after")
    def _validate_module_entries(self) -> ModuleManifest:
        if any(not prefix for prefix in self.allowed_vault_prefixes):
            raise ValueError("allowedVaultPrefixes must not contain empty prefix strings")
        return self

    def effective_vault_keys(self) -> frozenset[str]:
        """Collect all exact Vault keys permitted for this module from secrets & wizard."""
        keys: set[str] = set(self.required_secrets) | set(self.allowed_vault_keys)
        if self.setup_wizard is not None:
            for step in self.setup_wizard.steps:
                for wizard_field in step.fields:
                    if wizard_field.storage == "vault":
                        keys.add(wizard_field.key)
        return frozenset(keys)


class ProbeCheck(BaseModel):
    """Single check item reported by a Setup Wizard probe."""

    model_config = ConfigDict(extra="forbid")

    name: str
    ok: bool
    detail: str = ""


class ProbeResult(BaseModel):
    """Structured result returned by `probe.py` or `plugin.wizard_probe()`."""

    model_config = ConfigDict(extra="forbid")

    ok: bool
    module_id: str
    summary: str
    checks: list[ProbeCheck] = Field(default_factory=list)


class HousekeepingStats(BaseModel):
    """Metrics returned by module `on_housekeeping()` runs."""

    model_config = ConfigDict(extra="forbid")

    module_id: str
    deleted_rows: int = Field(default=0, ge=0)
    freed_bytes: int = Field(default=0, ge=0)
    notes: str = ""


class ComputeUsageRecord(BaseModel):
    """Non-token CostOps accounting entry for external worker/video compute."""

    model_config = ConfigDict(extra="forbid")

    module_id: str
    agent: str
    session_id: str
    resource_label: str
    duration_sec: float = Field(default=0.0, ge=0.0)
    cost_usd: float = Field(default=0.0, ge=0.0)


class ProviderMessage(BaseModel):
    """Single chat message sent to a `ModuleModelProvider`."""

    model_config = ConfigDict(extra="forbid")

    role: Literal["system", "user", "assistant", "tool"]
    content: str
    tool_call_id: str | None = None
    name: str | None = None


class ProviderToolSchema(BaseModel):
    """Serialized tool schema forwarded to pluggable model providers."""

    model_config = ConfigDict(extra="forbid")

    name: str
    description: str
    parameters: dict[str, Any] = Field(default_factory=dict)


class ProviderToolCall(BaseModel):
    """Structured tool call returned by a `ModuleModelProvider`."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class ModelProviderRequest(BaseModel):
    """Concrete request DTO passed to every `ModuleModelProvider.generate()` implementation."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    agent_id: str
    session_id: str
    model: str
    messages: list[ProviderMessage] = Field(default_factory=list)
    system_prompt: str = ""
    tools: list[ProviderToolSchema] = Field(default_factory=list)
    workspace_dir: Path
    protected_paths: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ModelProviderResponse(BaseModel):
    """Concrete response DTO returned by every `ModuleModelProvider.generate()` implementation."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    content: str = ""
    tool_calls: list[ProviderToolCall] = Field(default_factory=list)
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    cache_read_tokens: int = Field(default=0, ge=0)
    cache_creation_tokens: int = Field(default=0, ge=0)
    thinking_tokens: int = Field(default=0, ge=0)
    cost_usd: float = Field(default=0.0, ge=0.0)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ModuleUiContribution(BaseModel):
    """UI mount metadata exposed cleanly to the build-free Dashboard host."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str = Field(min_length=1)
    module_id: str = Field(min_length=1, alias="moduleId")
    slot: Literal["vps-card", "providers-panel", "sidebar-page", "modules-badge"]
    title: str = Field(min_length=1)
    entry_file: str = Field(min_length=1, alias="entryFile")
    mount_id: str | None = Field(default=None, alias="mountId")
    route_hash: str | None = Field(default=None, alias="routeHash")
    order: int = 100


class ToolExecutionResult(BaseModel):
    """Standardized output envelope returned from every LLM tool execution."""

    model_config = ConfigDict(extra="forbid")

    ok: bool
    output: Any = None
    error: str | None = None
    error_code: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


@dataclass(slots=True)
class ToolExecutionContext:
    """Per-invocation context supplied to an LLM tool handler."""

    agent_id: str
    session_id: str
    workspace_dir: Path
    module_ctx: ModuleContext
    protected_paths: tuple[str, ...] = ()
    allowed_bash_commands: tuple[str, ...] = ()
    bash_timeout_ms: int = 30_000
    memory_namespace: str | None = None


@dataclass(slots=True)
class ModuleToolDefinition[TArgs: BaseModel]:
    """Typed LLM tool contract backed by a Pydantic v2 `args_model`."""

    name: str
    description: str
    args_model: type[TArgs]
    execute: Callable[[TArgs, ToolExecutionContext], Awaitable[ToolExecutionResult]]
    module_id: str = ""
    authorized_agent_ids: tuple[str, ...] | None = None

    def json_schema(self) -> dict[str, Any]:
        """Generate LLM JSON Schema directly from `args_model` (single source of truth)."""
        return self.args_model.model_json_schema()

    async def invoke(
        self,
        raw_args: Any,
        ctx: ToolExecutionContext,
    ) -> ToolExecutionResult:
        """Validate raw arguments with `args_model` and execute or return LLM-fixable error."""
        try:
            validated = self.args_model.model_validate(raw_args)
        except ValidationError as exc:
            err = ToolValidationError.from_pydantic(
                self.name,
                exc,
                module_id=self.module_id or None,
            )
            return ToolExecutionResult(
                ok=False,
                error=err.to_llm_message(),
                error_code=err.code,
                metadata={"errors": err.errors},
            )
        return await self.execute(validated, ctx)


@dataclass(frozen=True, slots=True)
class ModuleMigration:
    """Versioned SQLite migration owned by a module."""

    version: int
    name: str
    sql: str | None = None
    apply: Callable[[sqlite3.Connection], None] | None = None

    def __post_init__(self) -> None:
        if self.version < 1:
            raise ValueError("Migration version must be >= 1")
        if self.sql is None and self.apply is None:
            raise ValueError("Migration must provide either `sql` or `apply`")


AuthRequirement = Literal["admin", "dashboard", "public_oauth_callback"]
RouteReturn = Response | BaseModel


@dataclass(frozen=True, slots=True)
class ModuleRouteDefinition:
    """HTTP route mounted dynamically by `alfred/kernel/http_bridge.py`."""

    path: str
    methods: tuple[str, ...]
    handler: Callable[[Request], Awaitable[RouteReturn]]
    auth: AuthRequirement = "admin"
    summary: str = ""
    module_id: str = ""


@runtime_checkable
class ModuleModelProvider(Protocol):
    """Protocol for pluggable AI/compute model providers registered by modules."""

    @property
    def provider_id(self) -> str: ...

    @property
    def zero_cost_model_prefixes(self) -> Sequence[str]: ...

    @property
    def eu_only_compliant(self) -> bool: ...

    def supports_model(self, model: str) -> bool: ...

    async def generate(self, request: ModelProviderRequest) -> ModelProviderResponse: ...


@runtime_checkable
class ServiceBus(Protocol):
    """Dependency-enforced inter-module typed Service Bus interface."""

    def require_service(self, module_id: str) -> Any: ...

    def get_service(self, module_id: str) -> Any | None: ...

    def list_cli_env_sanitize_keys(self) -> tuple[str, ...]: ...

    def list_active_module_ids(self) -> list[str]: ...

    async def run_all_housekeeping(
        self,
        *,
        retention_days: int,
        disk_used_pct: float,
        exclude_module_ids: frozenset[str] = frozenset(),
    ) -> list[HousekeepingStats]: ...


@dataclass(slots=True)
class ModuleContext:
    """Isolated runtime context injected into each active module."""

    module_id: str
    manifest: ModuleManifest
    module_dir: Path
    project_root: Path
    db: SqlitePool
    security: ModuleSecurityProxy
    modules: ServiceBus
    heavy_job: HeavyJobHoldManager
    logger: logging.Logger
    extra: dict[str, Any] = field(default_factory=dict)

    async def record_compute_usage(self, record: ComputeUsageRecord) -> None:
        """Persist non-token compute billing telemetry into `compute_usage`."""
        await self.db.record_compute_usage(
            module_id=record.module_id or self.module_id,
            agent=record.agent,
            session_id=record.session_id,
            resource_label=record.resource_label,
            duration_sec=record.duration_sec,
            cost_usd=record.cost_usd,
            timestamp_sec=int(time.time()),
        )


@runtime_checkable
class AlfredModulePlugin(Protocol):
    """Protocol implemented by every `modules/<id>/plugin.py` entrypoint."""

    @property
    def id(self) -> str: ...

    def create_service(self, ctx: ModuleContext) -> Any: ...

    def migrations(self) -> Sequence[ModuleMigration]: ...

    def tools(self) -> Sequence[ModuleToolDefinition[Any]]: ...

    def routes(self) -> Sequence[ModuleRouteDefinition]: ...

    def providers(self) -> Sequence[ModuleModelProvider]: ...

    def ui_contributions(self) -> Sequence[ModuleUiContribution]: ...

    @property
    def cli_env_sanitize_keys(self) -> Sequence[str]: ...

    async def wizard_probe(self, ctx: ModuleContext) -> ProbeResult: ...

    async def on_load(self, ctx: ModuleContext) -> None: ...

    async def on_unload(self, ctx: ModuleContext) -> None: ...

    async def on_startup(self, ctx: ModuleContext) -> None: ...

    async def on_heartbeat(self, ctx: ModuleContext, now_ms: int) -> dict[str, Any] | None: ...

    async def on_housekeeping(
        self,
        ctx: ModuleContext,
        retention_days: int,
        disk_used_pct: float,
    ) -> HousekeepingStats: ...


class BaseModulePlugin:
    """Optional base class providing default empty hook implementations."""

    id: str = ""

    def create_service(self, ctx: ModuleContext) -> Any:
        return None

    def migrations(self) -> Sequence[ModuleMigration]:
        return ()

    def tools(self) -> Sequence[ModuleToolDefinition[Any]]:
        return ()

    def routes(self) -> Sequence[ModuleRouteDefinition]:
        return ()

    def providers(self) -> Sequence[ModuleModelProvider]:
        return ()

    def ui_contributions(self) -> Sequence[ModuleUiContribution]:
        return ()

    @property
    def cli_env_sanitize_keys(self) -> Sequence[str]:
        return ()

    async def wizard_probe(self, ctx: ModuleContext) -> ProbeResult:
        return ProbeResult(ok=True, module_id=self.id or ctx.module_id, summary="OK")

    async def on_load(self, ctx: ModuleContext) -> None:
        return None

    async def on_unload(self, ctx: ModuleContext) -> None:
        return None

    async def on_startup(self, ctx: ModuleContext) -> None:
        return None

    async def on_heartbeat(self, ctx: ModuleContext, now_ms: int) -> dict[str, Any] | None:
        return None

    async def on_housekeeping(
        self,
        ctx: ModuleContext,
        retention_days: int,
        disk_used_pct: float,
    ) -> HousekeepingStats:
        return HousekeepingStats(module_id=self.id or ctx.module_id)
