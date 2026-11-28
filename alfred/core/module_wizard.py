"""Declarative Setup Wizard service with env-key safety and inactive `probe.py` execution."""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Final

from pydantic import BaseModel, ConfigDict, Field

from alfred.core.config import CoreSettings
from alfred.core.db import ModuleState, SqlitePool
from alfred.core.env_file import parse_env_file, update_env_file
from alfred.core.vault import VaultManager
from alfred.kernel.errors import ModuleError, ModuleLoadError, ModuleSecurityError
from alfred.kernel.loader import ModuleLoader
from alfred.kernel.types import ModuleManifest, ProbeResult, WizardField

FORBIDDEN_WIZARD_ENV_KEYS: Final[frozenset[str]] = frozenset(
    {
        "PATH",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "PYTHONPATH",
        "PYTHONHOME",
        "NODE_OPTIONS",
        "ALFRED_DASHBOARD_TOKEN",
        "DASHBOARD_TOKEN",
        "VAULT_MASTER_KEY",
        "HOME",
        "USER",
        "SHELL",
        "SSH_AUTH_SOCK",
    }
)


class WizardFieldStatusDTO(BaseModel):
    """Safe field status for UI rendering (`value` always `None` for secret/vault items)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    key: str
    label: str
    type: str
    storage: str
    required: bool
    configured: bool
    value: str | int | float | bool | None = None


class WizardStepStatusDTO(BaseModel):
    """Rendered Setup Wizard step with current safe field statuses."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str
    title: str
    description: str
    type: str | None = None
    requirement_mode: str | None = Field(default=None, alias="requirementMode")
    fields: list[WizardFieldStatusDTO] = Field(default_factory=list)


class WizardStateResponse(BaseModel):
    """Response DTO for `GET /api/modules/{id}/wizard`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    module_id: str = Field(alias="moduleId")
    title: str
    summary: str
    doc_chapter: str | None = Field(default=None, alias="docChapter")
    state: ModuleState
    steps: list[WizardStepStatusDTO] = Field(default_factory=list)


class WizardSaveRequest(BaseModel):
    """Input DTO for `POST /api/modules/{id}/wizard`."""

    model_config = ConfigDict(extra="forbid")

    values: dict[str, str | int | float | bool] = Field(default_factory=dict)


class WizardSaveResponse(BaseModel):
    """Safe response DTO confirming saved Setup Wizard keys (zero secret values echoed)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    ok: bool
    module_id: str = Field(alias="moduleId")
    saved_keys: list[str] = Field(alias="savedKeys")
    message: str


class ModuleWizardService:
    """Evaluates, validates, persists, and probes `module.json` Setup Wizard steps."""

    def __init__(
        self,
        *,
        settings: CoreSettings,
        db: SqlitePool,
        vault: VaultManager,
        loader: ModuleLoader,
    ) -> None:
        self.settings = settings
        self.db = db
        self.vault = vault
        self.loader = loader

    def _index_wizard_fields(
        self,
        module_id: str,
    ) -> tuple[WizardStateResponse, ModuleManifest, dict[str, WizardField]]:
        discovered = self.loader.discover()
        if module_id not in discovered:
            raise ModuleLoadError(f"Unknown module '{module_id}'", module_id=module_id)
        _, manifest = discovered[module_id]
        if manifest.setup_wizard is None:
            raise ModuleError(
                f"Module '{module_id}' does not define a Setup Wizard",
                code="WIZARD_NOT_SUPPORTED",
                module_id=module_id,
                status_code=404,
            )
        field_map: dict[str, WizardField] = {}
        for step in manifest.setup_wizard.steps:
            for wf in step.fields:
                field_map[wf.key] = wf
        skeleton = WizardStateResponse(
            module_id=module_id,
            title=manifest.setup_wizard.title,
            summary=manifest.setup_wizard.summary,
            doc_chapter=manifest.setup_wizard.doc_chapter,
            state="available",
            steps=[],
        )
        return skeleton, manifest, field_map

    async def get_wizard_state(self, module_id: str) -> WizardStateResponse:
        """Build safe Setup Wizard status without exposing Vault secret values."""
        skeleton, manifest, _ = self._index_wizard_fields(module_id)
        wizard_spec = manifest.setup_wizard
        if wizard_spec is None:  # pragma: no cover - guarded by _index_wizard_fields
            return skeleton

        row = await self.db.get_module_row(module_id)
        state: ModuleState = (
            row.state
            if row is not None
            else ("active" if (manifest.built_in or manifest.default_enabled) else "available")
        )
        config_json = row.config_json if row is not None else {}
        env_values = parse_env_file(self.settings.env_path)
        vault_keys = {item.key_id for item in self.vault.list_secrets()}

        steps_out: list[WizardStepStatusDTO] = []
        for step in wizard_spec.steps:
            fields_out: list[WizardFieldStatusDTO] = []
            for wf in step.fields:
                configured = False
                safe_value: str | int | float | bool | None = None
                if wf.storage == "vault" or wf.type == "secret":
                    configured = wf.key in vault_keys
                    safe_value = None  # Never return secrets
                elif wf.storage == "env":
                    raw_env = env_values.get(wf.key)
                    configured = bool(raw_env)
                    safe_value = raw_env if raw_env is not None else wf.default_value
                elif wf.storage == "config_json":
                    configured = wf.key in config_json and config_json[wf.key] not in (None, "")
                    raw_cfg = config_json.get(wf.key, wf.default_value)
                    if isinstance(raw_cfg, (str, int, float, bool)) or raw_cfg is None:
                        safe_value = raw_cfg
                else:  # action
                    configured = True
                    safe_value = wf.default_value

                fields_out.append(
                    WizardFieldStatusDTO(
                        key=wf.key,
                        label=wf.label,
                        type=wf.type,
                        storage=wf.storage,
                        required=wf.required,
                        configured=configured,
                        value=safe_value,
                    )
                )
            steps_out.append(
                WizardStepStatusDTO(
                    id=step.id,
                    title=step.title,
                    description=step.description,
                    type=step.type,
                    requirement_mode=step.requirement_mode,
                    fields=fields_out,
                )
            )
        return skeleton.model_copy(update={"state": state, "steps": steps_out})

    async def save_wizard_values(
        self,
        module_id: str,
        payload: WizardSaveRequest,
    ) -> WizardSaveResponse:
        """Validate submitted Setup Wizard inputs and persist across Vault, `.env` & config."""
        _, _, field_map = self._index_wizard_fields(module_id)
        env_updates: dict[str, str | None] = {}
        config_patch: dict[str, str | int | float | bool] = {}
        vault_writes: list[tuple[str, str, str]] = []
        saved_keys: list[str] = []

        for key, raw_val in payload.values.items():
            if key.upper() in FORBIDDEN_WIZARD_ENV_KEYS or key in FORBIDDEN_WIZARD_ENV_KEYS:
                raise ModuleSecurityError(
                    f"Environment/system key '{key}' is forbidden in module Setup Wizard",
                    module_id=module_id,
                )
            wf = field_map.get(key)
            if wf is None:
                raise ModuleSecurityError(
                    f"Unknown wizard field '{key}' for module '{module_id}'",
                    module_id=module_id,
                )

            if wf.validation_regex and isinstance(raw_val, str) and raw_val != "":
                if not re.match(wf.validation_regex, raw_val):
                    raise ModuleError(
                        f"Field '{key}' failed regex validation",
                        code="WIZARD_VALIDATION_ERROR",
                        module_id=module_id,
                        status_code=400,
                    )

            if wf.storage == "vault":
                val_str = str(raw_val).strip()
                if val_str:
                    vault_writes.append((key, val_str, wf.label))
                    saved_keys.append(key)
            elif wf.storage == "env":
                env_updates[key] = str(raw_val)
                saved_keys.append(key)
            elif wf.storage == "config_json":
                config_patch[key] = raw_val
                saved_keys.append(key)

        for key, secret_val, label in vault_writes:
            await self.vault.set_secret(key, secret_val, label=label)
        if env_updates:
            update_env_file(self.settings.env_path, env_updates)
        if config_patch:
            now_iso = datetime.now(tz=UTC).isoformat()
            await self.db.update_module_config(module_id, config_patch, now_iso)

        return WizardSaveResponse(
            ok=True,
            module_id=module_id,
            saved_keys=saved_keys,
            message=f"Saved {len(saved_keys)} field(s) for '{module_id}'",
        )

    async def run_probe(self, module_id: str) -> ProbeResult:
        """Execute module Setup Wizard `probe.py` without activating `plugin.py`."""
        self._index_wizard_fields(module_id)
        return await self.loader.probe_inactive_module(module_id)
