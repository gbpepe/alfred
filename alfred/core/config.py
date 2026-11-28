"""Core settings and strict Pydantic v2 `config/agents.json` models."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class GlobalAgentConfig(BaseModel):
    """Global defaults block in `config/agents.json`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    default_provider: str = Field(alias="defaultProvider")
    default_model: str = Field(alias="defaultModel")
    daily_budget_usd: float = Field(alias="dailyBudgetUsd", gt=0)
    workspaces_root: str = Field(default="workspaces", alias="workspacesRoot")


class RoleConfig(BaseModel):
    """Named organizational role template mapping to default provider/model."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    label: str
    description: str
    provider: str
    model: str


class AgentFallbackConfig(BaseModel):
    """Fallback provider/model pair for an agent."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    provider: str
    model: str


class AgentConfig(BaseModel):
    """Strict boundary model for a single agent entry in `config/agents.json`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str = Field(min_length=1, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    display_name: str = Field(alias="displayName", min_length=1)
    channel_name: str | None = Field(default=None, alias="channelName")
    discord_channel_id: str | None = Field(default=None, alias="discordChannelId")
    role: str = Field(min_length=1)
    provider: str | None = None
    model: str | None = None
    fallback: AgentFallbackConfig | None = None
    workspace: str = "."
    memory_namespace: str | None = Field(default=None, alias="memoryNamespace")
    daily_budget_usd: float = Field(default=2.0, alias="dailyBudgetUsd", ge=0)
    allowed_user_ids: list[str] = Field(default_factory=list, alias="allowedUserIds")
    tools: list[str] = Field(default_factory=list)
    max_tool_iterations: int | None = Field(default=None, alias="maxToolIterations", ge=1)
    protected_paths: list[str] = Field(default_factory=list, alias="protectedPaths")
    allowed_bash_commands: list[str] = Field(default_factory=list, alias="allowedBashCommands")
    bash_timeout_ms: int | None = Field(default=None, alias="bashTimeoutMs", ge=1000)
    soul_file: str | None = Field(default=None, alias="soulFile")
    system_prompt: str = Field(default="", alias="systemPrompt")
    enabled: bool = True
    eu_only: bool = Field(default=False, alias="euOnly")
    response_mode: Literal["text", "voice", "auto"] | None = Field(
        default=None,
        alias="responseMode",
    )
    voice_model: str | None = Field(default=None, alias="voiceModel")
    avatar_url: str | None = Field(default=None, alias="avatarUrl")


class AgentsConfig(BaseModel):
    """Top-level `config/agents.json` configuration model."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    version: int = 1
    global_config: GlobalAgentConfig = Field(alias="global")
    roles: dict[str, RoleConfig] = Field(default_factory=dict)
    agents: list[AgentConfig] = Field(default_factory=list)

    def get_agent(self, agent_id: str) -> AgentConfig | None:
        """Look up an agent configuration by id."""
        for agent in self.agents:
            if agent.id == agent_id:
                return agent
        return None


class CoreSettings(BaseModel):
    """Resolved core filesystem locations for an Alfred v2 instance."""

    model_config = ConfigDict(extra="forbid")

    project_root: Path
    store_dir: Path
    modules_dir: Path
    config_dir: Path
    agents_config_path: Path
    db_path: Path
    vault_path: Path
    vault_key_path: Path
    env_path: Path
    heavy_job_lock_path: Path
    environment: Literal["prod", "staging", "test", "dev"] = "dev"

    @property
    def docs_dir(self) -> Path:
        """Directory containing markdown user handbook chapters."""
        return self.project_root / "docs"

    @property
    def modules_generation_path(self) -> Path:
        """Cross-process module activation generation marker file."""
        return self.store_dir / ".modules-generation"

    @classmethod
    def from_project_root(
        cls,
        project_root: Path,
        *,
        db_filename: str = "alfred.db",
        environment: Literal["prod", "staging", "test", "dev"] = "dev",
    ) -> CoreSettings:
        """Construct standard Alfred v2 paths relative to a project root."""
        root = project_root.resolve()
        store = root / "store"
        config = root / "config"
        return cls(
            project_root=root,
            store_dir=store,
            modules_dir=root / "modules",
            config_dir=config,
            agents_config_path=config / "agents.json",
            db_path=store / db_filename,
            vault_path=store / "vault.json",
            vault_key_path=store / ".vault-key",
            env_path=root / ".env",
            heavy_job_lock_path=store / ".heavy-job.lock",
            environment=environment,
        )
