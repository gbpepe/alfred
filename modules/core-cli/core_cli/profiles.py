"""CLI provider registry, env sanitization, runtime state tracker, and confined profile store."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import time
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final, Literal

from alfred.core.env_file import atomic_write_text
from alfred.kernel.types import ModuleContext

CliProviderId = Literal["claude-cli", "agy-cli", "codex-cli", "gemini-cli"]

SUPPORTED_CLI_PROVIDERS: Final[tuple[CliProviderId, ...]] = (
    "claude-cli",
    "agy-cli",
    "codex-cli",
    "gemini-cli",
)

EXPLICIT_SANITIZE_ENV_KEYS: Final[frozenset[str]] = frozenset(
    {
        "DISCORD_BOT_TOKEN",
        "ALFRED_DASHBOARD_TOKEN",
        "DASHBOARD_TOKEN",
        "VAULT_MASTER_KEY",
        "ALFRED_VAULT_KEY",
        "GOOGLE_APPLICATION_CREDENTIALS",
    }
)

_SANITIZE_KEY_PATTERNS: Final[tuple[re.Pattern[str], ...]] = (
    re.compile(r".*_API_KEY$", re.IGNORECASE),
    re.compile(r".*_SECRET$", re.IGNORECASE),
    re.compile(r".*_TOKEN$", re.IGNORECASE),
    re.compile(r".*_PASSWORD$", re.IGNORECASE),
    re.compile(r".*_PRIVATE_KEY$", re.IGNORECASE),
    re.compile(r"^ALFRED_CLOUD_", re.IGNORECASE),
    re.compile(r"^CLOUD_", re.IGNORECASE),
)

_SAFE_PROFILE_ID_RE: Final[re.Pattern[str]] = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$")


@dataclass(frozen=True, slots=True)
class CliProviderSpec:
    """Static definition of a supported headless subscription CLI."""

    provider_id: CliProviderId
    binary_name: str
    binary_env_var: str
    config_env_var: str
    zero_cost_prefix: str
    auth_files: tuple[str, ...]
    mcp_files: tuple[str, ...]


CLI_PROVIDER_SPECS: Final[dict[CliProviderId, CliProviderSpec]] = {
    "claude-cli": CliProviderSpec(
        provider_id="claude-cli",
        binary_name="claude",
        binary_env_var="ALFRED_CLAUDE_BIN",
        config_env_var="CLAUDE_CONFIG_DIR",
        zero_cost_prefix=r"^claude-cli:",
        auth_files=(".credentials.json", "credentials.json", ".oauth-token"),
        mcp_files=(".claude.json", ".mcp.json"),
    ),
    "agy-cli": CliProviderSpec(
        provider_id="agy-cli",
        binary_name="agy",
        binary_env_var="ALFRED_AGY_BIN",
        config_env_var="AGY_CONFIG_DIR",
        zero_cost_prefix=r"^agy-cli:",
        auth_files=(
            "antigravity-oauth-token",
            "credentials.json",
            "oauth_creds.json",
            "auth.json",
            "tokens.json",
            "token.json",
        ),
        mcp_files=("mcp_config.json", "settings.json"),
    ),
    "codex-cli": CliProviderSpec(
        provider_id="codex-cli",
        binary_name="codex",
        binary_env_var="ALFRED_CODEX_BIN",
        config_env_var="CODEX_HOME",
        zero_cost_prefix=r"^codex-cli:",
        auth_files=("auth.json", "credentials.json"),
        mcp_files=("config.toml",),
    ),
    "gemini-cli": CliProviderSpec(
        provider_id="gemini-cli",
        binary_name="gemini",
        binary_env_var="ALFRED_GEMINI_BIN",
        config_env_var="GEMINI_CLI_HOME",
        zero_cost_prefix=r"^gemini-cli:",
        auth_files=("oauth_creds.json", "google_accounts.json"),
        mcp_files=("settings.json",),
    ),
}


def is_valid_provider_id(value: str) -> bool:
    """Return True if `value` is one of the 4 supported CLI providers."""
    return value in CLI_PROVIDER_SPECS


def coerce_provider_id(value: str) -> CliProviderId | None:
    """Narrow an arbitrary string to `CliProviderId` or return `None`."""
    for spec in CLI_PROVIDER_SPECS.values():
        if spec.provider_id == value:
            return spec.provider_id
    return None


def validate_profile_id(profile_id: str) -> str:
    """Validate and normalize a CLI profile identifier without allowing path escapes."""
    clean = profile_id.strip()
    if not clean or ".." in clean or not _SAFE_PROFILE_ID_RE.match(clean):
        raise ValueError(
            "Invalid profile_id: must match ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$ without '..'"
        )
    return clean


def resolve_cli_binary(
    provider_id: CliProviderId,
    env: Mapping[str, str] | None = None,
) -> str:
    """Resolve CLI executable name or explicit env override binary."""
    spec = CLI_PROVIDER_SPECS[provider_id]
    source = env if env is not None else os.environ
    override = source.get(spec.binary_env_var, "").strip()
    return override or spec.binary_name


def check_binary_available(
    binary: str,
    *,
    env: Mapping[str, str] | None = None,
) -> str | None:
    """Return resolved executable path if available on PATH or filesystem, else None."""
    candidate_path = Path(binary)
    if candidate_path.is_absolute() or "/" in binary or "\\" in binary:
        if candidate_path.is_file():
            return str(candidate_path)
        return None
    path_val = env.get("PATH") if env is not None else os.environ.get("PATH")
    return shutil.which(binary, path=path_val)


def is_sanitized_env_key(key: str, extra_keys: Iterable[str] = ()) -> bool:
    """Return True if an environment variable name must be stripped from child processes."""
    norm = key.strip()
    if not norm:
        return True
    upper = norm.upper()
    extra_upper = {k.strip().upper() for k in extra_keys if k.strip()}
    if upper in EXPLICIT_SANITIZE_ENV_KEYS or upper in extra_upper:
        return True
    if upper in {"LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONSTARTUP", "PYTHONINSPECT"}:
        return True
    return any(rx.match(norm) for rx in _SANITIZE_KEY_PATTERNS)


def build_sanitized_env(
    *,
    source_env: Mapping[str, str] | None = None,
    module_sanitize_keys: Iterable[str] = (),
    provider_id: CliProviderId | None = None,
    profile_dir: Path | None = None,
) -> dict[str, str]:
    """Construct a sanitized child-process environment without secrets or API keys."""
    raw = source_env if source_env is not None else os.environ
    extra = tuple(module_sanitize_keys)
    sanitized: dict[str, str] = {}
    for key, val in raw.items():
        if is_sanitized_env_key(key, extra_keys=extra):
            continue
        sanitized[key] = val

    if provider_id is not None and profile_dir is not None:
        spec = CLI_PROVIDER_SPECS[provider_id]
        sanitized[spec.config_env_var] = str(profile_dir)
    if provider_id == "gemini-cli":
        sanitized["GEMINI_CLI_TRUST_WORKSPACE"] = "true"
    return sanitized


@dataclass(slots=True)
class ProviderCooldownState:
    """In-memory runtime status for a single CLI provider."""

    quota_limited: bool = False
    cooldown_until: int | None = None
    detail: str = ""


@dataclass(slots=True)
class CliRuntimeTracker:
    """Tracks invocation counts and per-provider cooldown state."""

    total_invocations: int = 0
    _states: dict[CliProviderId, ProviderCooldownState] = field(default_factory=dict)

    def record_invocation(self) -> None:
        """Increment total CLI invocation counter."""
        self.total_invocations += 1

    def record_quota_limit(
        self,
        provider_id: CliProviderId,
        *,
        cooldown_sec: int = 300,
        detail: str = "Rate limit / quota exhausted",
        now_sec: int | None = None,
    ) -> None:
        """Mark provider as temporarily quota-limited until `now + cooldown_sec`."""
        ts = now_sec if now_sec is not None else int(time.time())
        self._states[provider_id] = ProviderCooldownState(
            quota_limited=True,
            cooldown_until=ts + max(cooldown_sec, 1),
            detail=detail,
        )

    def record_error_detail(self, provider_id: CliProviderId, detail: str) -> None:
        """Record non-quota diagnostic detail without forcing cooldown."""
        state = self._states.setdefault(provider_id, ProviderCooldownState())
        state.detail = detail

    def clear_quota_limit(self, provider_id: CliProviderId) -> None:
        """Clear provider cooldown after a successful invocation."""
        self._states[provider_id] = ProviderCooldownState()

    def get_state(
        self,
        provider_id: CliProviderId,
        *,
        now_sec: int | None = None,
    ) -> ProviderCooldownState:
        """Return effective cooldown state, expiring elapsed cooldowns automatically."""
        state = self._states.get(provider_id)
        if state is None:
            return ProviderCooldownState()
        ts = now_sec if now_sec is not None else int(time.time())
        if state.quota_limited and state.cooldown_until is not None and ts >= state.cooldown_until:
            state.quota_limited = False
            state.cooldown_until = None
            state.detail = ""
        return state


@dataclass(frozen=True, slots=True)
class StoredProfileInfo:
    """Internal profile metadata resolved inside `ctx.security.data_dir`."""

    provider_id: CliProviderId
    profile_id: str
    label: str
    active: bool
    email_hint: str | None
    profile_dir: Path


def _read_profile_meta_sync(profile_dir: Path) -> tuple[str | None, str | None]:
    meta_file = profile_dir / "profile.json"
    label: str | None = None
    email_hint: str | None = None
    if meta_file.is_file():
        try:
            data = json.loads(meta_file.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                raw_label = data.get("label")
                if isinstance(raw_label, str) and raw_label.strip():
                    label = raw_label.strip()
                raw_email = data.get("email_hint") or data.get("emailHint")
                if isinstance(raw_email, str) and raw_email.strip():
                    email_hint = raw_email.strip()
        except (OSError, ValueError):
            pass

    if email_hint is None:
        google_accounts = profile_dir / "google_accounts.json"
        if google_accounts.is_file():
            try:
                ga = json.loads(google_accounts.read_text(encoding="utf-8"))
                if isinstance(ga, dict) and isinstance(ga.get("active"), str):
                    active_email = ga["active"].strip()
                    if active_email:
                        email_hint = active_email
            except (OSError, ValueError):
                pass
    return label, email_hint


def _ensure_profile_dir_sync(
    profile_dir: Path,
    *,
    label: str | None = None,
    email_hint: str | None = None,
) -> None:
    profile_dir.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(profile_dir, 0o700)
    except OSError:
        pass
    if label is not None or email_hint is not None:
        meta_path = profile_dir / "profile.json"
        existing: dict[str, Any] = {}
        if meta_path.is_file():
            try:
                loaded = json.loads(meta_path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    existing = loaded
            except (OSError, ValueError):
                existing = {}
        if label is not None:
            existing["label"] = label
        if email_hint is not None:
            existing["email_hint"] = email_hint
        atomic_write_text(
            meta_path,
            json.dumps(existing, indent=2) + "\n",
            mode=0o600,
            dir_mode=0o700,
        )


def _discover_profiles_sync(
    profiles_root: Path,
    provider_id: CliProviderId,
    active_profile_id: str,
    config_profiles: Mapping[str, Any],
) -> list[StoredProfileInfo]:
    provider_root = profiles_root / provider_id
    discovered: dict[str, StoredProfileInfo] = {}

    default_dir = provider_root / "default"
    d_label, d_email = _read_profile_meta_sync(default_dir)
    discovered["default"] = StoredProfileInfo(
        provider_id=provider_id,
        profile_id="default",
        label=d_label or "Default",
        active=(active_profile_id == "default"),
        email_hint=d_email,
        profile_dir=default_dir,
    )

    for raw_pid, raw_meta in config_profiles.items():
        try:
            pid = validate_profile_id(raw_pid)
        except ValueError:
            continue
        p_dir = provider_root / pid
        label = pid.title() if pid != "default" else "Default"
        email_hint: str | None = None
        if isinstance(raw_meta, Mapping):
            if isinstance(raw_meta.get("label"), str) and raw_meta["label"].strip():
                label = raw_meta["label"].strip()
            raw_e = raw_meta.get("email_hint") or raw_meta.get("emailHint")
            if isinstance(raw_e, str) and raw_e.strip():
                email_hint = raw_e.strip()
        disk_label, disk_email = _read_profile_meta_sync(p_dir)
        discovered[pid] = StoredProfileInfo(
            provider_id=provider_id,
            profile_id=pid,
            label=disk_label or label,
            active=(active_profile_id == pid),
            email_hint=disk_email or email_hint,
            profile_dir=p_dir,
        )

    if provider_root.is_dir():
        for child in sorted(provider_root.iterdir(), key=lambda p: p.name):
            if not child.is_dir():
                continue
            try:
                pid = validate_profile_id(child.name)
            except ValueError:
                continue
            if not child.resolve().is_relative_to(provider_root.resolve()):
                continue
            disk_label, disk_email = _read_profile_meta_sync(child)
            existing = discovered.get(pid)
            discovered[pid] = StoredProfileInfo(
                provider_id=provider_id,
                profile_id=pid,
                label=disk_label or (existing.label if existing else pid.title()),
                active=(active_profile_id == pid),
                email_hint=disk_email or (existing.email_hint if existing else None),
                profile_dir=child.resolve(),
            )

    ordered = sorted(
        discovered.values(),
        key=lambda item: (0 if item.profile_id == "default" else 1, item.profile_id),
    )
    return ordered


class ProfileManager:
    """Manages per-provider CLI profiles strictly inside `ctx.security.data_dir` and `ctx.db`."""

    def __init__(self, ctx: ModuleContext) -> None:
        self._ctx = ctx

    def _profiles_base(self) -> Path:
        return self._ctx.security.data_dir.resolve_path("profiles")

    def resolve_profile_dir(self, provider_id: CliProviderId, profile_id: str) -> Path:
        """Resolve a confined profile directory inside `store/modules/core-cli/profiles/`."""
        clean_pid = validate_profile_id(profile_id)
        return self._ctx.security.data_dir.resolve_path(f"profiles/{provider_id}/{clean_pid}")

    async def get_active_profile_id(self, provider_id: CliProviderId) -> str:
        """Return configured active profile id for `provider_id` (defaulting to 'default')."""
        cfg = await self._ctx.security.config.get()
        active_map = cfg.get("active_profiles")
        if isinstance(active_map, Mapping):
            raw = active_map.get(provider_id)
            if isinstance(raw, str):
                try:
                    return validate_profile_id(raw)
                except ValueError:
                    return "default"
        return "default"

    async def ensure_profile(
        self,
        provider_id: CliProviderId,
        profile_id: str,
        *,
        label: str | None = None,
        email_hint: str | None = None,
    ) -> StoredProfileInfo:
        """Create or update a profile directory and metadata inside `ctx.security.data_dir`."""
        clean_pid = validate_profile_id(profile_id)
        profile_dir = self.resolve_profile_dir(provider_id, clean_pid)
        effective_label = label or ("Default" if clean_pid == "default" else clean_pid.title())
        await asyncio.to_thread(
            _ensure_profile_dir_sync,
            profile_dir,
            label=effective_label,
            email_hint=email_hint,
        )

        cfg = await self._ctx.security.config.get()
        raw_profiles = cfg.get("profiles")
        profiles_by_prov: dict[str, Any] = (
            dict(raw_profiles) if isinstance(raw_profiles, Mapping) else {}
        )
        raw_prov_map = profiles_by_prov.get(provider_id)
        prov_map: dict[str, Any] = (
            dict(raw_prov_map) if isinstance(raw_prov_map, Mapping) else {}
        )
        entry: dict[str, Any] = {"label": effective_label}
        if email_hint is not None:
            entry["email_hint"] = email_hint
        prov_map[clean_pid] = entry
        profiles_by_prov[provider_id] = prov_map
        await self._ctx.security.config.update({"profiles": profiles_by_prov})

        active_id = await self.get_active_profile_id(provider_id)
        return StoredProfileInfo(
            provider_id=provider_id,
            profile_id=clean_pid,
            label=effective_label,
            active=(active_id == clean_pid),
            email_hint=email_hint,
            profile_dir=profile_dir,
        )

    async def list_profiles(
        self,
        provider_id: CliProviderId | None = None,
    ) -> list[StoredProfileInfo]:
        """List discovered profiles across one or all supported CLI providers."""
        cfg = await self._ctx.security.config.get()
        active_map = cfg.get("active_profiles")
        profiles_cfg = cfg.get("profiles")
        profiles_root = self._profiles_base()

        target_providers: tuple[CliProviderId, ...] = (
            (provider_id,) if provider_id is not None else SUPPORTED_CLI_PROVIDERS
        )
        results: list[StoredProfileInfo] = []
        for pid in target_providers:
            active_id = "default"
            if isinstance(active_map, Mapping) and isinstance(active_map.get(pid), str):
                try:
                    active_id = validate_profile_id(str(active_map[pid]))
                except ValueError:
                    active_id = "default"
            prov_cfg: Mapping[str, Any] = {}
            if isinstance(profiles_cfg, Mapping) and isinstance(profiles_cfg.get(pid), Mapping):
                prov_cfg = profiles_cfg[pid]
            items = await asyncio.to_thread(
                _discover_profiles_sync,
                profiles_root,
                pid,
                active_id,
                prov_cfg,
            )
            results.extend(items)
        return results

    async def switch_profile(
        self,
        provider_id: CliProviderId,
        profile_id: str,
    ) -> tuple[bool, str, str]:
        """Switch active profile for `provider_id`; returns `(ok, active_profile, message)`."""
        current_active = await self.get_active_profile_id(provider_id)
        try:
            clean_pid = validate_profile_id(profile_id)
        except ValueError as exc:
            return False, current_active, str(exc)

        available = await self.list_profiles(provider_id=provider_id)
        known_ids = {item.profile_id for item in available}
        if clean_pid not in known_ids:
            return (
                False,
                current_active,
                f"Profile '{clean_pid}' does not exist for provider '{provider_id}'",
            )

        target_dir = self.resolve_profile_dir(provider_id, clean_pid)
        await asyncio.to_thread(_ensure_profile_dir_sync, target_dir)

        cfg = await self._ctx.security.config.get()
        raw_active = cfg.get("active_profiles")
        active_map: dict[str, str] = (
            {str(k): str(v) for k, v in raw_active.items()}
            if isinstance(raw_active, Mapping)
            else {}
        )
        active_map[provider_id] = clean_pid
        await self._ctx.security.config.update({"active_profiles": active_map})
        return True, clean_pid, f"Switched '{provider_id}' active profile to '{clean_pid}'"
