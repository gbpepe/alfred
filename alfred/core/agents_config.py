"""Hot-reloading `config/agents.json` manager with `mtime_ns` cache and dynamic manifests."""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Final

from pydantic import BaseModel, ConfigDict

from alfred.core.config import AgentConfig, AgentsConfig
from alfred.core.env_file import atomic_write_text
from alfred.kernel.loader import discover_manifests

BUILTIN_HTTP_PROVIDERS: Final[frozenset[str]] = frozenset(
    {"deepseek", "vertex-eu", "gemini", "openai", "xai"}
)
_ENV_PLACEHOLDER_RE: Final[re.Pattern[str]] = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")


class ResolvedAgent(BaseModel):
    """Agent configuration paired with resolved effective provider/model and override state."""

    model_config = ConfigDict(extra="forbid")

    config: AgentConfig
    effective_provider: str
    effective_model: str
    has_override: bool


def _expand_env_ref(raw: str | None, env_lookup: Mapping[str, str]) -> str | None:
    if not raw:
        return None
    match = _ENV_PLACEHOLDER_RE.match(raw.strip())
    if match:
        val = env_lookup.get(match.group(1), "").strip()
        return val or None
    return raw.strip() or None


class AgentsConfigManager:
    """Thread-safe `mtime_ns` cache + role inheritance + manifest-validated agent resolver."""

    def __init__(
        self,
        config_path: Path,
        *,
        modules_dir: Path | None = None,
        env_lookup: Mapping[str, str] | None = None,
    ) -> None:
        self.config_path = config_path
        self.modules_dir = modules_dir
        self._env_lookup = env_lookup
        self._cache_stat: tuple[int, int] | None = None
        self._cached_config: AgentsConfig | None = None

    def _collect_manifest_capabilities(self) -> tuple[set[str], set[str], bool]:
        if self.modules_dir is None or not self.modules_dir.exists():
            return set(), set(), False
        discovered = discover_manifests(self.modules_dir)
        if not discovered:
            return set(), set(), False
        known_tools: set[str] = set()
        known_providers: set[str] = set()
        for _, manifest in discovered.values():
            known_tools.update(manifest.tools)
            known_providers.update(manifest.providers)
        return known_tools, known_providers, True

    def _validate_against_manifests(self, cfg: AgentsConfig) -> None:
        known_tools, known_providers, has_manifests = self._collect_manifest_capabilities()
        if not has_manifests:
            return
        allowed_providers = BUILTIN_HTTP_PROVIDERS | known_providers
        for agent in cfg.agents:
            eff_provider = self._resolve_raw_provider(cfg, agent)
            if eff_provider not in allowed_providers:
                raise ValueError(
                    f"Agent '{agent.id}' references unknown provider '{eff_provider}'"
                )
            unknown_tools = [tool for tool in agent.tools if tool not in known_tools]
            if unknown_tools:
                raise ValueError(
                    f"Agent '{agent.id}' references unknown tool(s): {', '.join(unknown_tools)}"
                )

    @staticmethod
    def _resolve_raw_provider(cfg: AgentsConfig, agent: AgentConfig) -> str:
        role_cfg = cfg.roles.get(agent.role)
        role_provider = role_cfg.provider if role_cfg else cfg.global_config.default_provider
        return agent.provider or role_provider

    def load(self, *, validate_manifests: bool = True) -> AgentsConfig:
        """Load `agents.json`, skipping JSON parse when `(mtime_ns, st_size)` is unchanged."""
        stat = self.config_path.stat()
        fingerprint = (stat.st_mtime_ns, stat.st_size)
        if self._cached_config is not None and self._cache_stat == fingerprint:
            return self._cached_config

        cfg = AgentsConfig.model_validate_json(self.config_path.read_text(encoding="utf-8"))
        if validate_manifests:
            self._validate_against_manifests(cfg)
        self._cached_config = cfg
        self._cache_stat = fingerprint
        return cfg

    def save(self, config: AgentsConfig, *, validate_manifests: bool = True) -> AgentsConfig:
        """Persist validated `AgentsConfig` atomically and refresh the `mtime_ns` cache."""
        if validate_manifests:
            self._validate_against_manifests(config)
        payload = config.model_dump_json(indent=2, by_alias=True) + "\n"
        atomic_write_text(self.config_path, payload, mode=0o600)
        stat = self.config_path.stat()
        self._cached_config = config
        self._cache_stat = (stat.st_mtime_ns, stat.st_size)
        return config

    def resolve_agent(self, agent_id: str) -> ResolvedAgent | None:
        """Resolve an agent's effective provider/model with role inheritance and override check."""
        cfg = self.load()
        agent = cfg.get_agent(agent_id)
        if agent is None:
            return None
        return self._resolve_single(cfg, agent)

    def list_resolved_agents(self) -> list[ResolvedAgent]:
        """List all configured agents with resolved effective providers and models."""
        cfg = self.load()
        return [self._resolve_single(cfg, agent) for agent in cfg.agents]

    def resolve_by_channel_id(self, discord_channel_id: str) -> ResolvedAgent | None:
        """Find enabled agent matching a Discord channel ID (expanding `${ENV_VAR}` specs)."""
        cfg = self.load()
        env_map: Mapping[str, str] = (
            self._env_lookup if self._env_lookup is not None else os.environ
        )
        for agent in cfg.agents:
            if not agent.enabled:
                continue
            resolved_ch = _expand_env_ref(agent.discord_channel_id, env_map)
            if resolved_ch == discord_channel_id:
                return self._resolve_single(cfg, agent)
        return None

    def _resolve_single(self, cfg: AgentsConfig, agent: AgentConfig) -> ResolvedAgent:
        role_cfg = cfg.roles.get(agent.role)
        role_provider = role_cfg.provider if role_cfg else cfg.global_config.default_provider
        role_model = role_cfg.model if role_cfg else cfg.global_config.default_model
        eff_provider = agent.provider or role_provider
        eff_model = agent.model or role_model
        has_override = (
            (agent.provider is not None and agent.provider != role_provider)
            or (agent.model is not None and agent.model != role_model)
        )
        return ResolvedAgent(
            config=agent,
            effective_provider=eff_provider,
            effective_model=eff_model,
            has_override=has_override,
        )
