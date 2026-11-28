"""CoreCliService implementation & frozen Service Bus DTOs (`ProtectSystem=strict` safe)."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, Final

from pydantic import BaseModel, ConfigDict

from alfred.core.env_file import atomic_write_text
from alfred.kernel.types import ModuleContext

from .profiles import (
    SUPPORTED_CLI_PROVIDERS,
    CliProviderId,
    CliRuntimeTracker,
    ProfileManager,
    check_binary_available,
    coerce_provider_id,
    resolve_cli_binary,
)

_SAFE_SKILL_ID_RE: Final[re.Pattern[str]] = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$")
_SAFE_SERVER_NAME_RE: Final[re.Pattern[str]] = re.compile(r"^[A-Za-z0-9_-]+$")
_CODEX_MCP_BEGIN: Final[str] = "# BEGIN ALFRED MANAGED MCP"
_CODEX_MCP_END: Final[str] = "# END ALFRED MANAGED MCP"


class CliProviderStatus(BaseModel):
    """Runtime status of a single headless CLI provider."""

    model_config = ConfigDict(extra="forbid")

    provider_id: str
    binary: str
    available: bool
    active_profile: str | None = None
    quota_limited: bool = False
    cooldown_until: int | None = None
    detail: str = ""


class CliStatusReport(BaseModel):
    """Aggregated CLI status report returned by `CoreCliService.get_cli_status()`."""

    model_config = ConfigDict(extra="forbid")

    providers: list[CliProviderStatus]
    total_invocations: int = 0


class CliProfileSummary(BaseModel):
    """Summary of one isolated CLI profile."""

    model_config = ConfigDict(extra="forbid")

    provider_id: str
    profile_id: str
    label: str
    active: bool = False
    email_hint: str | None = None


class CliProfilesResponse(BaseModel):
    """Response DTO returned by `CoreCliService.list_profiles()`."""

    model_config = ConfigDict(extra="forbid")

    profiles: list[CliProfileSummary]


class CliSwitchResult(BaseModel):
    """Result DTO returned by `CoreCliService.switch_profile()`."""

    model_config = ConfigDict(extra="forbid")

    ok: bool
    provider_id: str
    active_profile: str
    message: str = ""


class McpSkillSyncResult(BaseModel):
    """Result DTO returned by `CoreCliService.sync_mcp_and_skills()`."""

    model_config = ConfigDict(extra="forbid")

    ok: bool
    synced_skills: list[str]
    blocked_skills: list[dict[str, Any]]
    synced_mcp_servers: int = 0


def _read_skills_directory_sync(source_dir: Path) -> list[tuple[str, str | None, str | None]]:
    """Read `(skill_id, text_or_none, read_error_or_none)` from `source_dir/*/SKILL.md`."""
    if not source_dir.exists() or not source_dir.is_dir():
        return []
    resolved_root = source_dir.resolve()
    entries: list[tuple[str, str | None, str | None]] = []
    for child in sorted(resolved_root.iterdir(), key=lambda p: p.name):
        if child.name.startswith((".", "__")):
            continue
        if not child.is_dir():
            continue
        resolved_child = child.resolve()
        if not resolved_child.is_relative_to(resolved_root):
            continue
        skill_id = child.name
        if not _SAFE_SKILL_ID_RE.match(skill_id):
            entries.append((skill_id, None, "invalid skill directory name"))
            continue
        skill_md = resolved_child / "SKILL.md"
        if not skill_md.exists():
            continue
        resolved_md = skill_md.resolve()
        if not resolved_md.is_relative_to(resolved_child) or not resolved_md.is_file():
            entries.append((skill_id, None, "SKILL.md symlink escapes skill directory"))
            continue
        try:
            text = resolved_md.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            entries.append((skill_id, None, f"unreadable UTF-8 SKILL.md: {exc}"))
            continue
        entries.append((skill_id, text, None))
    return entries


def _sync_skills_to_target_sync(
    skills_root: Path,
    clean_skills: Mapping[str, str],
) -> None:
    """Write ONLY scanned clean skills inside `skills_root` and prune stale ones."""
    skills_root.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(skills_root, 0o700)
    except OSError:
        pass

    for child in list(skills_root.iterdir()):
        if child.is_dir() and child.name not in clean_skills:
            shutil.rmtree(child, ignore_errors=True)

    for skill_id, content in clean_skills.items():
        skill_dir = skills_root / skill_id
        skill_dir.mkdir(parents=True, exist_ok=True)
        atomic_write_text(skill_dir / "SKILL.md", content, mode=0o600, dir_mode=0o700)


def _extract_mcp_servers(raw_config: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    """Normalize either `{'mcpServers': {...}}` or direct `{name: {...}}` server mapping."""
    candidate: Any = raw_config.get("mcpServers") if "mcpServers" in raw_config else raw_config
    if not isinstance(candidate, Mapping):
        return {}
    servers: dict[str, dict[str, Any]] = {}
    for name, cfg in candidate.items():
        if isinstance(name, str) and name.strip() and isinstance(cfg, Mapping):
            servers[name.strip()] = dict(cfg)
    return servers


def _load_default_mcp_config_sync(project_root: Path) -> dict[str, Any]:
    mcp_path = project_root / ".mcp.json"
    if not mcp_path.is_file():
        return {}
    try:
        parsed = json.loads(mcp_path.read_text(encoding="utf-8"))
        return parsed if isinstance(parsed, dict) else {}
    except (OSError, ValueError):
        return {}


def _format_codex_toml(servers: Mapping[str, dict[str, Any]]) -> str:
    lines: list[str] = [_CODEX_MCP_BEGIN]
    for name, srv in servers.items():
        safe_key = name if _SAFE_SERVER_NAME_RE.match(name) else json.dumps(name)
        lines.append(f"[mcp_servers.{safe_key}]")
        cmd = srv.get("command")
        if isinstance(cmd, str) and cmd:
            lines.append(f"command = {json.dumps(cmd)}")
        args = srv.get("args")
        if isinstance(args, list) and args:
            args_lit = ", ".join(json.dumps(str(a)) for a in args)
            lines.append(f"args = [{args_lit}]")
        url = srv.get("url")
        if isinstance(url, str) and url:
            lines.append(f"url = {json.dumps(url)}")
        env_map = srv.get("env")
        if isinstance(env_map, Mapping) and env_map:
            lines.append(f"[mcp_servers.{safe_key}.env]")
            for ek, ev in env_map.items():
                ek_str = str(ek)
                safe_ek = ek_str if re.match(r"^[A-Za-z0-9_]+$", ek_str) else json.dumps(ek_str)
                lines.append(f"{safe_ek} = {json.dumps(str(ev))}")
        lines.append("")
    lines.append(_CODEX_MCP_END)
    return "\n".join(lines) + "\n"


def _write_mcp_artifacts_sync(
    data_mcp_file: Path,
    profile_targets: list[tuple[CliProviderId, Path]],
    servers: Mapping[str, dict[str, Any]],
) -> None:
    atomic_write_text(
        data_mcp_file,
        json.dumps({"mcpServers": dict(servers)}, indent=2) + "\n",
        mode=0o600,
        dir_mode=0o700,
    )
    for provider_id, profile_dir in profile_targets:
        profile_dir.mkdir(parents=True, exist_ok=True)
        if provider_id == "claude-cli":
            for fname in (".claude.json", ".mcp.json"):
                atomic_write_text(
                    profile_dir / fname,
                    json.dumps({"mcpServers": dict(servers)}, indent=2) + "\n",
                    mode=0o600,
                    dir_mode=0o700,
                )
        elif provider_id == "gemini-cli":
            atomic_write_text(
                profile_dir / "settings.json",
                json.dumps({"trustedFolder": True, "mcpServers": dict(servers)}, indent=2) + "\n",
                mode=0o600,
                dir_mode=0o700,
            )
        elif provider_id == "agy-cli":
            for fname in ("mcp_config.json", "settings.json"):
                atomic_write_text(
                    profile_dir / fname,
                    json.dumps({"mcpServers": dict(servers)}, indent=2) + "\n",
                    mode=0o600,
                    dir_mode=0o700,
                )
        elif provider_id == "codex-cli":
            atomic_write_text(
                profile_dir / "config.toml",
                _format_codex_toml(servers),
                mode=0o600,
                dir_mode=0o700,
            )


class CoreCliService:
    """Service Bus interface exported by `core-cli` for `core-ops` and Dashboard routes."""

    def __init__(
        self,
        ctx: ModuleContext,
        *,
        tracker: CliRuntimeTracker | None = None,
        profiles: ProfileManager | None = None,
        env_source: Mapping[str, str] | None = None,
        which_fn: Callable[[str], str | None] | None = None,
    ) -> None:
        self._ctx = ctx
        self._tracker = tracker or CliRuntimeTracker()
        self._profiles = profiles or ProfileManager(ctx)
        self._env_source = env_source
        self._which_fn = which_fn

    @property
    def profiles(self) -> ProfileManager:
        """Return underlying `ProfileManager`."""
        return self._profiles

    @property
    def tracker(self) -> CliRuntimeTracker:
        """Return runtime invocation & cooldown tracker."""
        return self._tracker

    def _effective_env(self) -> Mapping[str, str]:
        if self._env_source is not None:
            return self._env_source
        extra_env = self._ctx.extra.get("cli_env")
        if isinstance(extra_env, Mapping):
            return {str(k): str(v) for k, v in extra_env.items()}
        return os.environ

    def _is_binary_available(self, binary: str, env: Mapping[str, str]) -> bool:
        if self._which_fn is not None:
            return self._which_fn(binary) is not None
        extra_which = self._ctx.extra.get("cli_which")
        if callable(extra_which):
            return extra_which(binary) is not None
        return check_binary_available(binary, env=env) is not None

    async def get_cli_status(self) -> CliStatusReport:
        """Inspect binary availability, active profiles, and cooldowns for all 4 CLI providers."""
        env = self._effective_env()
        statuses: list[CliProviderStatus] = []
        for provider_id in SUPPORTED_CLI_PROVIDERS:
            binary = resolve_cli_binary(provider_id, env)
            available = await asyncio.to_thread(self._is_binary_available, binary, env)
            active_profile = await self._profiles.get_active_profile_id(provider_id)
            rt_state = self._tracker.get_state(provider_id)
            detail = rt_state.detail
            if not detail:
                detail = "ready" if available else f"binary '{binary}' not found in PATH"
            statuses.append(
                CliProviderStatus(
                    provider_id=provider_id,
                    binary=binary,
                    available=available,
                    active_profile=active_profile,
                    quota_limited=rt_state.quota_limited,
                    cooldown_until=rt_state.cooldown_until,
                    detail=detail,
                )
            )
        return CliStatusReport(
            providers=statuses,
            total_invocations=self._tracker.total_invocations,
        )

    async def list_profiles(self, provider_id: str | None = None) -> CliProfilesResponse:
        """List available isolated CLI profiles, optionally filtered by `provider_id`."""
        filter_pid: CliProviderId | None = None
        if provider_id is not None:
            filter_pid = coerce_provider_id(provider_id)
            if filter_pid is None:
                raise ValueError(f"Unsupported CLI provider '{provider_id}'")
        items = await self._profiles.list_profiles(provider_id=filter_pid)
        return CliProfilesResponse(
            profiles=[
                CliProfileSummary(
                    provider_id=item.provider_id,
                    profile_id=item.profile_id,
                    label=item.label,
                    active=item.active,
                    email_hint=item.email_hint,
                )
                for item in items
            ]
        )

    async def switch_profile(self, provider_id: str, profile_id: str) -> CliSwitchResult:
        """Switch active CLI profile for `provider_id` inside confined `data_dir`/`db`."""
        pid = coerce_provider_id(provider_id)
        if pid is None:
            return CliSwitchResult(
                ok=False,
                provider_id=provider_id,
                active_profile="",
                message=f"Unsupported CLI provider '{provider_id}'",
            )
        ok, active_profile, message = await self._profiles.switch_profile(pid, profile_id)
        return CliSwitchResult(
            ok=ok,
            provider_id=provider_id,
            active_profile=active_profile,
            message=message,
        )

    async def sync_mcp_and_skills(
        self,
        *,
        skills_source_dir: Path | None = None,
        mcp_config: dict[str, Any] | None = None,
    ) -> McpSkillSyncResult:
        """Scan every `SKILL.md` with `scan_skill_text` before writing to `data_dir`."""
        src_dir = (
            skills_source_dir
            if skills_source_dir is not None
            else (self._ctx.project_root / "skills")
        )
        raw_skills = await asyncio.to_thread(_read_skills_directory_sync, src_dir)

        clean_skills: dict[str, str] = {}
        synced_skills: list[str] = []
        blocked_skills: list[dict[str, Any]] = []

        for skill_id, text, read_err in raw_skills:
            if read_err is not None or text is None:
                blocked_skills.append(
                    {
                        "skill_id": skill_id,
                        "reason": read_err or "unreadable skill",
                        "findings": [],
                    }
                )
                continue

            scan_res = self._ctx.security.scan_skill_text(text)
            if not scan_res.ok:
                blocked_skills.append(
                    {
                        "skill_id": skill_id,
                        "reason": ", ".join(f.rule for f in scan_res.findings),
                        "findings": [f.model_dump(mode="json") for f in scan_res.findings],
                    }
                )
                continue

            clean_skills[skill_id] = text
            synced_skills.append(skill_id)

        skills_target_root = self._ctx.security.data_dir.resolve_path("skills")
        await asyncio.to_thread(_sync_skills_to_target_sync, skills_target_root, clean_skills)

        # Also sync clean skills & MCP configuration into each provider's active profile dir
        profile_targets: list[tuple[CliProviderId, Path]] = []
        for pid in SUPPORTED_CLI_PROVIDERS:
            active_pid = await self._profiles.get_active_profile_id(pid)
            p_dir = self._profiles.resolve_profile_dir(pid, active_pid)
            await asyncio.to_thread(_sync_skills_to_target_sync, p_dir / "skills", clean_skills)
            profile_targets.append((pid, p_dir))

        raw_mcp = (
            mcp_config
            if mcp_config is not None
            else await asyncio.to_thread(_load_default_mcp_config_sync, self._ctx.project_root)
        )
        servers = _extract_mcp_servers(raw_mcp)
        data_mcp_file = self._ctx.security.data_dir.resolve_path("mcp/mcp_servers.json")
        await asyncio.to_thread(_write_mcp_artifacts_sync, data_mcp_file, profile_targets, servers)

        return McpSkillSyncResult(
            ok=True,
            synced_skills=synced_skills,
            blocked_skills=blocked_skills,
            synced_mcp_servers=len(servers),
        )
