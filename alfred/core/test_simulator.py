"""Isolated staging-only Discord chat simulator (`#testsim`), disabled outside `test` env."""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field

from alfred.core.agents_config import AgentsConfigManager, ResolvedAgent
from alfred.core.config import CoreSettings
from alfred.core.model_router import ModelRouter
from alfred.core.security.prompt_safety import wrap_untrusted
from alfred.core.tool_executor import ToolExecutor
from alfred.kernel.errors import ModuleError
from alfred.kernel.types import ModelProviderRequest, ProviderMessage


class TestSimRequest(BaseModel):
    """Input DTO for `POST /api/testsim/send`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    agent_id: str | None = Field(default=None, alias="agentId")
    channel_id: str | None = Field(default=None, alias="channelId")
    session_id: str = Field(default="testsim-session", alias="sessionId")
    message: str = Field(min_length=1)
    author_id: str = Field(default="testsim-user", alias="authorId")


class TestSimToolTrace(BaseModel):
    """Single simulated tool invocation trace entry."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    tool_name: str = Field(alias="toolName")
    ok: bool
    error: str | None = None


class TestSimResponse(BaseModel):
    """Simulated assistant reply with token usage and tool execution trace."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    ok: bool
    agent_id: str = Field(alias="agentId")
    model: str
    reply: str
    input_tokens: int = Field(alias="inputTokens")
    output_tokens: int = Field(alias="outputTokens")
    cost_usd: float = Field(alias="costUsd")
    tool_traces: list[TestSimToolTrace] = Field(default_factory=list, alias="toolTraces")


class TestSimulator:
    """Runs router + tool-executor pipeline locally without touching Discord network APIs."""

    def __init__(
        self,
        *,
        settings: CoreSettings,
        agents: AgentsConfigManager,
        router: ModelRouter,
        tool_executor: ToolExecutor,
    ) -> None:
        self._settings = settings
        self._agents = agents
        self._router = router
        self._tool_executor = tool_executor

    def _resolve_target(self, req: TestSimRequest) -> ResolvedAgent:
        if req.agent_id:
            found = self._agents.resolve_agent(req.agent_id)
        elif req.channel_id:
            found = self._agents.resolve_by_channel_id(req.channel_id)
        else:
            found = None
        if found is None:
            raise ModuleError(
                "Target agent or channel not found for simulator",
                code="AGENT_NOT_FOUND",
                status_code=404,
            )
        return found

    async def simulate(self, req: TestSimRequest) -> TestSimResponse:
        """Simulate a complete turn (`wrap_untrusted` -> `ModelRouter` -> `ToolExecutor`)."""
        if self._settings.environment != "test":
            raise ModuleError(
                "Test simulator is disabled unless ALFRED_ENV=test",
                code="TESTSIM_DISABLED",
                status_code=404,
            )

        cfg = self._agents.load()
        resolved = self._resolve_target(req)
        agent = resolved.config
        if not agent.enabled:
            raise ModuleError(
                f"Agent '{agent.id}' is disabled",
                code="AGENT_DISABLED",
                status_code=409,
            )

        workspace_dir = (self._settings.project_root / Path(agent.workspace)).resolve()
        tools = self._tool_executor.get_schemas_for_agent(agent)
        messages: list[ProviderMessage] = [
            ProviderMessage(
                role="user",
                content=wrap_untrusted(f"testsim:{req.author_id}", req.message),
            )
        ]

        total_in = 0
        total_out = 0
        total_cost = 0.0
        traces: list[TestSimToolTrace] = []
        max_iters = agent.max_tool_iterations or 5
        reply_text = ""

        for _ in range(max_iters):
            provider_req = ModelProviderRequest(
                agent_id=agent.id,
                session_id=req.session_id,
                model=resolved.effective_model,
                messages=messages,
                system_prompt=agent.system_prompt,
                tools=tools,
                workspace_dir=workspace_dir,
                protected_paths=list(agent.protected_paths),
            )
            resp = await self._router.generate(
                resolved_agent=resolved,
                global_budget_usd=cfg.global_config.daily_budget_usd,
                request=provider_req,
            )
            total_in += resp.input_tokens
            total_out += resp.output_tokens
            total_cost += resp.cost_usd
            reply_text = resp.content

            if not resp.tool_calls:
                break

            messages.append(ProviderMessage(role="assistant", content=resp.content or ""))
            for tc in resp.tool_calls:
                tool_res = await self._tool_executor.execute_tool(
                    agent=agent,
                    tool_name=tc.name,
                    raw_args=tc.arguments,
                    session_id=req.session_id,
                    workspace_dir=workspace_dir,
                )
                traces.append(
                    TestSimToolTrace(
                        tool_name=tc.name,
                        ok=tool_res.ok,
                        error=tool_res.error,
                    )
                )
                messages.append(
                    ProviderMessage(
                        role="tool",
                        tool_call_id=tc.id,
                        name=tc.name,
                        content=json.dumps(tool_res.model_dump(mode="json"), ensure_ascii=False),
                    )
                )

        return TestSimResponse(
            ok=True,
            agent_id=agent.id,
            model=resolved.effective_model,
            reply=reply_text,
            input_tokens=total_in,
            output_tokens=total_out,
            cost_usd=round(total_cost, 6),
            tool_traces=traces,
        )
