"""Thin whitelist + Pydantic-validated LLM tool schema and execution dispatcher."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from alfred.core.config import AgentConfig
from alfred.kernel.errors import ModuleDisabledError, ModuleSecurityError
from alfred.kernel.registry import ModuleRegistry
from alfred.kernel.types import (
    ModuleToolDefinition,
    ProviderToolSchema,
    ToolExecutionContext,
    ToolExecutionResult,
)


class ToolExecutor:
    """Dispatches agent-whitelisted tool calls exclusively through active registered modules."""

    def __init__(self, *, registry: ModuleRegistry) -> None:
        self._registry = registry

    def _is_agent_authorized_for_tool(
        self,
        agent: AgentConfig,
        tool_def: ModuleToolDefinition[Any],
    ) -> bool:
        allowed_agents = tool_def.authorized_agent_ids
        return allowed_agents is None or agent.id in allowed_agents

    def get_schemas_for_agent(self, agent: AgentConfig) -> list[ProviderToolSchema]:
        """Build JSON Schemas solely from active modules whose tools `agent` is allowed to use."""
        schemas: list[ProviderToolSchema] = []
        seen: set[str] = set()
        for tool_name in agent.tools:
            if tool_name in seen:
                continue
            tool_def = self._registry.get_tool(tool_name)
            if tool_def is None:
                continue
            if not self._is_agent_authorized_for_tool(agent, tool_def):
                continue
            seen.add(tool_name)
            schemas.append(
                ProviderToolSchema(
                    name=tool_def.name,
                    description=tool_def.description,
                    parameters=tool_def.json_schema(),
                )
            )
        return schemas

    async def execute_tool(
        self,
        *,
        agent: AgentConfig,
        tool_name: str,
        raw_args: Any,
        session_id: str,
        workspace_dir: Path,
    ) -> ToolExecutionResult:
        """Enforce agent whitelist, active-module gate, authorization & Pydantic validation."""
        if tool_name not in agent.tools:
            return ToolExecutionResult(
                ok=False,
                error_code="TOOL_NOT_ALLOWED",
                error=f"Agent '{agent.id}' is not permitted to invoke tool '{tool_name}'",
            )

        tool_def = self._registry.get_tool(tool_name)
        if tool_def is None:
            raise ModuleDisabledError(
                tool_name,
                message=f"Tool '{tool_name}' is unavailable because its owning module is inactive",
            )

        if not self._is_agent_authorized_for_tool(agent, tool_def):
            raise ModuleSecurityError(
                f"Agent '{agent.id}' is not authorized to invoke tool '{tool_name}'",
                module_id=tool_def.module_id or None,
            )

        mod_ctx = self._registry.get_context(tool_def.module_id)
        if mod_ctx is None:
            raise ModuleDisabledError(tool_def.module_id or tool_name)

        if isinstance(raw_args, dict) and "_alfred_json_parse_error" in raw_args:
            return ToolExecutionResult(
                ok=False,
                error_code="TOOL_JSON_ERROR",
                error=(
                    f"Malformed tool JSON arguments for '{tool_name}': "
                    f"{raw_args['_alfred_json_parse_error']}. Fix JSON formatting and retry."
                ),
            )

        ctx = ToolExecutionContext(
            agent_id=agent.id,
            session_id=session_id,
            workspace_dir=workspace_dir,
            module_ctx=mod_ctx,
        )
        return await tool_def.invoke(raw_args, ctx)
