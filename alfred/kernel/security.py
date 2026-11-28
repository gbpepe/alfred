"""Module security sandbox: scoped Vault/config access and confined `store/modules/<id>/`."""

from __future__ import annotations

import os
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from alfred.core.db import SqlitePool
from alfred.core.env_file import ensure_secure_dir
from alfred.core.security.secret_gate import SecretGateResult, scan_file
from alfred.core.security.skill_scan import SkillScanResult, scan_skill_text
from alfred.core.vault import VaultManager, VaultSecretMetadata, validate_vault_key_id
from alfred.kernel.errors import ForbiddenVaultAccessError, ModuleSecurityError


class ScopedVaultProxy:
    """Restricts Vault access exclusively to keys and prefixes declared in `module.json`."""

    def __init__(
        self,
        *,
        module_id: str,
        vault: VaultManager,
        allowed_keys: frozenset[str],
        allowed_prefixes: tuple[str, ...],
    ) -> None:
        self.module_id = module_id
        self._vault = vault
        self._allowed_keys = allowed_keys
        self._allowed_prefixes = tuple(p for p in allowed_prefixes if p)

    def is_key_allowed(self, key_id: str) -> bool:
        """Check whether `key_id` is syntactically valid and within the module's Vault grant."""
        try:
            validate_vault_key_id(key_id)
        except ValueError:
            return False
        if key_id in self._allowed_keys:
            return True
        return any(key_id.startswith(prefix) for prefix in self._allowed_prefixes)

    def _assert_allowed(self, key_id: str) -> None:
        validate_vault_key_id(key_id)
        if not self.is_key_allowed(key_id):
            raise ForbiddenVaultAccessError(self.module_id, key_id)

    async def get_secret(self, key_id: str) -> str | None:
        """Read an allowed secret key; raises `ForbiddenVaultAccessError` otherwise."""
        self._assert_allowed(key_id)
        return await self._vault.get_secret(key_id)

    async def set_secret(
        self,
        key_id: str,
        value: str,
        *,
        label: str | None = None,
    ) -> VaultSecretMetadata:
        """Store an allowed secret key; raises `ForbiddenVaultAccessError` otherwise."""
        self._assert_allowed(key_id)
        return await self._vault.set_secret(key_id, value, label=label)

    async def delete_secret(self, key_id: str) -> bool:
        """Delete an allowed secret key; raises `ForbiddenVaultAccessError` otherwise."""
        self._assert_allowed(key_id)
        return await self._vault.delete_secret(key_id)

    async def has_secret(self, key_id: str) -> bool:
        """Check whether an allowed secret key exists."""
        self._assert_allowed(key_id)
        return await self._vault.has_secret(key_id)

    def list_secrets(self) -> list[VaultSecretMetadata]:
        """Return metadata strictly filtered to the module's permitted keys (no decryption)."""
        return [item for item in self._vault.list_secrets() if self.is_key_allowed(item.key_id)]


class ScopedConfigProxy:
    """Reads and writes only this module's `config_json` row in `installed_modules`."""

    def __init__(self, *, module_id: str, db: SqlitePool) -> None:
        self.module_id = module_id
        self._db = db

    async def get(self) -> dict[str, Any]:
        """Return the module's parsed `config_json` dictionary."""
        return await self._db.get_module_config(self.module_id)

    async def update(self, patch: Mapping[str, Any]) -> dict[str, Any]:
        """Atomically read, merge, and persist `config_json` inside one `BEGIN IMMEDIATE` tx."""
        now = datetime.now(tz=UTC).isoformat()
        return await self._db.update_module_config(self.module_id, patch, now)

    async def replace(self, config: Mapping[str, Any]) -> dict[str, Any]:
        """Replace this module's `config_json` object atomically."""
        now = datetime.now(tz=UTC).isoformat()
        return await self._db.set_module_config(self.module_id, dict(config), now)


class ModuleDataDir:
    """Confined writable data directory `store/modules/<module_id>/` (`0o700`)."""

    def __init__(self, *, module_id: str, base_dir: Path) -> None:
        self.module_id = module_id
        self.base_dir = base_dir.resolve()

    def ensure_exists(self) -> Path:
        """Create `store/modules/<module_id>/` (`0o700`, `ProtectSystem=strict` safe)."""
        ensure_secure_dir(self.base_dir.parent, mode=0o700)
        self.base_dir.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.base_dir, 0o700)
        except OSError:
            pass
        return self.base_dir

    def resolve_path(self, relative_path: str | Path) -> Path:
        """Resolve a relative path inside the module's data directory; block traversal/symlinks."""
        raw = str(relative_path)
        if "\x00" in raw or "\\" in raw:
            raise ModuleSecurityError(
                f"Invalid path separator or NUL byte in module path: {raw!r}",
                module_id=self.module_id,
            )
        rel = Path(relative_path)
        if rel.is_absolute():
            raise ModuleSecurityError(
                f"Absolute path not allowed inside module data_dir: {raw!r}",
                module_id=self.module_id,
            )
        self.ensure_exists()
        candidate = (self.base_dir / rel).resolve()
        if not candidate.is_relative_to(self.base_dir):
            raise ModuleSecurityError(
                f"Path '{raw}' escapes module data directory",
                module_id=self.module_id,
            )
        return candidate


class ModuleSecurityProxy:
    """Facet injected as `ctx.security` into each active module or probe."""

    def __init__(
        self,
        *,
        module_id: str,
        vault: ScopedVaultProxy,
        config: ScopedConfigProxy,
        data_dir: ModuleDataDir,
    ) -> None:
        self.module_id = module_id
        self.vault = vault
        self.config = config
        self.data_dir = data_dir

    def scan_file_for_secrets(
        self,
        path: Path,
        *,
        display_path: str | None = None,
    ) -> SecretGateResult:
        """Fail-closed EVIDGUARD818 file scan helper for outbound cloud/artifact modules."""
        return scan_file(path, display_path=display_path)

    def scan_skill_text(self, text: str) -> SkillScanResult:
        """Scan skill text using native Python `mio-scan` rules."""
        return scan_skill_text(text)
