"""Module lifecycle manager with `builtIn` protection and `.modules-generation` hot-sync."""

from __future__ import annotations

import secrets
import time
from datetime import UTC, datetime
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from alfred.core.config import CoreSettings
from alfred.core.db import ModuleState, SqlitePool
from alfred.core.env_file import atomic_write_text
from alfred.core.vault import VaultManager
from alfred.kernel.errors import MissingDependencyError, ModuleError, ModuleLoadError
from alfred.kernel.loader import ModuleLoader, resolve_load_order
from alfred.kernel.registry import ModuleRegistry


class ModuleSummaryDTO(BaseModel):
    """Non-secret module status summary exposed over Core HTTP & Service endpoints."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str
    name: str
    category: str
    version: str
    description: str
    built_in: bool = Field(alias="builtIn")
    state: ModuleState
    ram_impact_mb: int = Field(alias="ramImpactMb")
    depends: list[str]
    tools: list[str]
    ui_card_ids: list[str] = Field(alias="uiCardIds")
    missing_secrets: list[str] = Field(alias="missingSecrets")
    active_dependents: list[str] = Field(alias="activeDependents")


class ModuleLifecycleResult(BaseModel):
    """Result returned by `activate_module()` and `deactivate_module()`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    module_id: str = Field(alias="moduleId")
    state: ModuleState
    generation_mtime_ns: int = Field(alias="generationMtimeNs")
    loaded_modules: list[str] = Field(alias="loadedModules")


def _read_generation_token(marker: Path) -> str | None:
    if not marker.exists():
        return None
    return marker.read_text(encoding="ascii").strip()


class ModuleManager:
    """Coordinates persistent `installed_modules` state, kernel activation & cross-process sync."""

    def __init__(
        self,
        *,
        settings: CoreSettings,
        db: SqlitePool,
        vault: VaultManager,
        registry: ModuleRegistry,
        loader: ModuleLoader,
    ) -> None:
        self.settings = settings
        self.db = db
        self.vault = vault
        self.registry = registry
        self.loader = loader
        self._last_generation_token: str | None = None

    def touch_generation(self) -> int:
        """Atomically bump `store/.modules-generation` to signal sibling worker processes."""
        marker = self.settings.modules_generation_path
        ts_ns = time.time_ns()
        token = f"{ts_ns}:{secrets.token_hex(8)}"
        atomic_write_text(
            marker,
            f"{token}\n",
            mode=0o600,
            dir_mode=0o700,
        )
        self._last_generation_token = token
        return ts_ns

    async def list_modules(self) -> list[ModuleSummaryDTO]:
        """List discovered modules paired with DB state and key-name-only missing secrets."""
        discovered = self.loader.discover()
        db_rows = {row.module_id: row for row in await self.db.list_module_rows()}
        present_keys = {item.key_id for item in self.vault.list_secrets()}

        summaries: list[ModuleSummaryDTO] = []
        for mod_id, (_, manifest) in sorted(discovered.items()):
            row = db_rows.get(mod_id)
            if row is not None:
                state: ModuleState = row.state
            else:
                state = (
                    "active" if (manifest.built_in or manifest.default_enabled) else "available"
                )
            missing = [k for k in manifest.required_secrets if k not in present_keys]
            summaries.append(
                ModuleSummaryDTO(
                    id=manifest.id,
                    name=manifest.name,
                    category=manifest.category,
                    version=manifest.version,
                    description=manifest.description,
                    built_in=manifest.built_in,
                    state=state,
                    ram_impact_mb=manifest.ram_impact_mb,
                    depends=list(manifest.depends),
                    tools=list(manifest.tools),
                    ui_card_ids=list(manifest.ui_card_ids),
                    missing_secrets=missing,
                    active_dependents=self.registry.active_dependents_of(mod_id),
                )
            )
        return summaries

    async def activate_module(self, module_id: str) -> ModuleLifecycleResult:
        """Activate a discovered module, enforcing declared `depends`, and bump generation."""
        discovered = self.loader.discover()
        if module_id not in discovered:
            raise ModuleLoadError(f"Unknown module '{module_id}'", module_id=module_id)

        _, manifest = discovered[module_id]
        for dep_id in manifest.depends:
            if not self.registry.is_active(dep_id):
                raise MissingDependencyError(dep_id, module_id=module_id)

        now_iso = datetime.now(tz=UTC).isoformat()
        await self.db.set_module_state(module_id, "active", now_iso)

        target_active = set(self.registry.active_module_ids()) | {module_id}
        loaded = await self.loader.load_active_modules(active_ids=target_active)
        gen_ns = self.touch_generation()
        return ModuleLifecycleResult(
            module_id=module_id,
            state="active",
            generation_mtime_ns=gen_ns,
            loaded_modules=loaded,
        )

    async def deactivate_module(
        self,
        module_id: str,
        *,
        force: bool = False,
    ) -> ModuleLifecycleResult:
        """Deactivate an optional module (`builtIn` is protected) and bump generation."""
        discovered = self.loader.discover()
        if module_id not in discovered:
            raise ModuleLoadError(f"Unknown module '{module_id}'", module_id=module_id)
        _, manifest = discovered[module_id]
        if manifest.built_in:
            raise ModuleError(
                f"Built-in module '{module_id}' cannot be disabled",
                code="BUILTIN_MODULE_PROTECTED",
                module_id=module_id,
                status_code=403,
            )

        await self.loader.deactivate_module(module_id, force=force)
        gen_ns = self.touch_generation()
        return ModuleLifecycleResult(
            module_id=module_id,
            state="installed_disabled",
            generation_mtime_ns=gen_ns,
            loaded_modules=self.registry.active_module_ids(),
        )

    async def sync_with_database(self, *, force: bool = False) -> bool:
        """Reconcile in-memory registry with DB when `store/.modules-generation` changed."""
        current_token = _read_generation_token(self.settings.modules_generation_path)
        if current_token is not None:
            if not force and self._last_generation_token == current_token:
                return False
            self._last_generation_token = current_token
        elif not force and self._last_generation_token is not None:
            return False

        discovered = self.loader.discover()
        manifests = {mid: pair[1] for mid, pair in discovered.items()}
        rows = await self.db.list_module_rows()
        desired_active = {
            row.module_id
            for row in rows
            if row.state == "active" and row.module_id in manifests
        }
        current_active = set(self.registry.active_module_ids())
        if desired_active == current_active:
            return False

        # Unload removed modules in reverse dependency order first
        to_unload = current_active - desired_active
        if to_unload:
            load_order = resolve_load_order(manifests, current_active)
            for mid in reversed(load_order):
                if mid in to_unload:
                    await self.registry.unregister_module(mid, force=True)

        # Load newly activated modules in topological order
        if desired_active:
            await self.loader.load_active_modules(active_ids=desired_active)
        return True
