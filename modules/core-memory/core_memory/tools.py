"""LLM `memory` tool definition with Pydantic v2 schema and strict namespace isolation."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from alfred.kernel.types import (
    ModuleToolDefinition,
    ToolExecutionContext,
    ToolExecutionResult,
)

from .engine import MemoryEngine, MemoryNamespaceError, MemorySaveInput


class MemoryToolArgs(BaseModel):
    """Pydantic v2 argument schema for the `memory` LLM tool."""

    model_config = ConfigDict(extra="forbid")

    action: Literal["save", "search", "list", "delete"]
    namespace: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
        description="Optional namespace; must match the agent's assigned namespace if supplied.",
    )
    memory_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
        description="Memory ID (required for 'delete'; optional in 'save' to update in-place).",
    )
    title: str | None = Field(
        default=None,
        max_length=300,
        description="Short memory title (used for 'save').",
    )
    content: str | None = Field(
        default=None,
        max_length=100_000,
        description="Memory content text (required for 'save').",
    )
    keywords: str | None = Field(
        default=None,
        max_length=1000,
        description="Comma-separated search keywords (used for 'save').",
    )
    category: str | None = Field(
        default=None,
        min_length=1,
        max_length=64,
        description="Optional category filter or assignment.",
    )
    importance: int | None = Field(
        default=None,
        ge=1,
        le=10,
        description="Importance score from 1 to 10 (default 5).",
    )
    query: str | None = Field(
        default=None,
        description="Full-text search query (used for 'search').",
    )
    limit: int = Field(
        default=20,
        ge=1,
        le=100,
        description="Maximum number of results for 'search' or 'list'.",
    )


def _resolve_engine(ctx: ToolExecutionContext) -> MemoryEngine:
    svc = ctx.module_ctx.modules.get_service("core-memory")
    if isinstance(svc, MemoryEngine):
        return svc
    return MemoryEngine(ctx.module_ctx.db)


def _resolve_authorized_namespace(
    args: MemoryToolArgs,
    ctx: ToolExecutionContext,
) -> tuple[str | None, ToolExecutionResult | None]:
    default_ns = (ctx.memory_namespace or ctx.agent_id).strip()
    if not default_ns:
        return None, ToolExecutionResult(
            ok=False,
            error_code="NAMESPACE_ERROR",
            error="Agent has no configured memory namespace or agent_id.",
        )
    if args.namespace is not None:
        requested = args.namespace.strip()
        if requested != default_ns:
            return None, ToolExecutionResult(
                ok=False,
                error_code="NAMESPACE_FORBIDDEN",
                error=(
                    f"Access denied to namespace '{args.namespace}'. "
                    f"Agent '{ctx.agent_id}' is isolated to namespace '{default_ns}'."
                ),
            )
    return default_ns, None


async def execute_memory_tool(
    args: MemoryToolArgs,
    ctx: ToolExecutionContext,
) -> ToolExecutionResult:
    """Execute `memory` tool actions strictly within the caller's isolated namespace."""
    namespace, denial = _resolve_authorized_namespace(args, ctx)
    if denial is not None or namespace is None:
        return denial or ToolExecutionResult(
            ok=False,
            error_code="NAMESPACE_ERROR",
            error="Unable to resolve memory namespace.",
        )

    engine = _resolve_engine(ctx)

    if args.action == "save":
        raw_content = (args.content or "").strip()
        if not raw_content:
            return ToolExecutionResult(
                ok=False,
                error_code="TOOL_VALIDATION_ERROR",
                error="Field 'content' is required and must be non-empty for action='save'.",
            )
        save_payload = MemorySaveInput(
            id=args.memory_id,
            namespace=namespace,
            title=(args.title or "").strip(),
            content=raw_content,
            keywords=(args.keywords or "").strip(),
            category=(args.category or "general").strip(),
            importance=args.importance if args.importance is not None else 5,
        )
        try:
            saved = await engine.save_memory(save_payload)
        except MemoryNamespaceError as exc:
            return ToolExecutionResult(
                ok=False,
                error_code="NAMESPACE_FORBIDDEN",
                error=exc.message,
            )
        return ToolExecutionResult(
            ok=True,
            output=saved.model_dump(mode="json"),
        )

    if args.action == "search":
        result = await engine.search_memories(
            namespace=namespace,
            query=args.query or "",
            category=args.category,
            limit=args.limit,
            track_use=True,
            agent_id=ctx.agent_id,
            session_id=ctx.session_id,
        )
        return ToolExecutionResult(
            ok=True,
            output=result.model_dump(mode="json"),
        )

    if args.action == "list":
        result = await engine.list_memories(
            namespace=namespace,
            category=args.category,
            limit=args.limit,
        )
        return ToolExecutionResult(
            ok=True,
            output=result.model_dump(mode="json"),
        )

    # action == "delete"
    if not args.memory_id:
        return ToolExecutionResult(
            ok=False,
            error_code="TOOL_VALIDATION_ERROR",
            error="Field 'memory_id' is required for action='delete'.",
        )
    deleted = await engine.delete_memory(args.memory_id, namespace=namespace)
    if not deleted:
        return ToolExecutionResult(
            ok=False,
            error_code="MEMORY_NOT_FOUND",
            error=f"Memory '{args.memory_id}' was not found in namespace '{namespace}'.",
        )
    return ToolExecutionResult(
        ok=True,
        output={
            "deleted": True,
            "memory_id": args.memory_id,
            "namespace": namespace,
        },
    )


def build_memory_tools() -> Sequence[ModuleToolDefinition[Any]]:
    """Build the tool definitions exported by `CoreMemoryPlugin`."""
    return (
        ModuleToolDefinition(
            name="memory",
            description=(
                "Persistent namespace-isolated agent memory. "
                "Supports actions: 'save', 'search', 'list', 'delete'."
            ),
            args_model=MemoryToolArgs,
            execute=execute_memory_tool,
            module_id="core-memory",
        ),
    )
