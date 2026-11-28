"""LLM tool definitions (`batch_submit`, `batch_status`, `batch_list`, `batch_cancel`)."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from alfred.kernel.errors import ModuleError
from alfred.kernel.types import (
    ModuleToolDefinition,
    ToolExecutionContext,
    ToolExecutionResult,
)

from .adapters import (
    BatchJobStatus,
    BatchProviderName,
    BatchTaskType,
    CanonicalBatchRequestItem,
    RequestedBatchProvider,
)
from .runner import BatchRunner, BatchSubmitInput


class BatchSubmitArgs(BaseModel):
    """Strict Pydantic v2 arguments for `batch_submit`."""

    model_config = ConfigDict(extra="forbid")

    input_path: str | None = Field(
        default=None,
        min_length=1,
        description="Relative JSONL input path inside workspace (`batch/`) or module data_dir.",
    )
    items: list[CanonicalBatchRequestItem] | None = Field(
        default=None,
        min_length=1,
        description="Optional inline canonical batch items when `input_path` is omitted.",
    )
    provider: RequestedBatchProvider = Field(
        default="auto",
        description="Target batch provider ('auto', 'anthropic', 'gemini', 'vertex-eu', 'openai').",
    )
    model: str | None = Field(
        default=None,
        min_length=1,
        description="Optional explicit model override for the chosen provider.",
    )
    task_type: BatchTaskType | None = Field(
        default=None,
        description=(
            "Optional workload hint ('code', 'reasoning', 'translation', 'extraction', 'general')."
        ),
    )
    eu_only: bool = Field(
        default=False,
        description="If true, enforce strict GDPR EU residency (`vertex-eu` only, zero fallback).",
    )

    @model_validator(mode="after")
    def _require_source(self) -> BatchSubmitArgs:
        if self.input_path is None and self.items is None:
            raise ValueError("Either 'input_path' or 'items' must be provided")
        return self


class BatchStatusArgs(BaseModel):
    """Strict Pydantic v2 arguments for `batch_status`."""

    model_config = ConfigDict(extra="forbid")

    job_id: str = Field(min_length=1, max_length=128, description="Batch job identifier.")
    poll: bool = Field(
        default=False,
        description="Poll remote provider immediately if the job is still in-flight.",
    )


class BatchListArgs(BaseModel):
    """Strict Pydantic v2 arguments for `batch_list`."""

    model_config = ConfigDict(extra="forbid")

    status: BatchJobStatus | None = Field(
        default=None,
        description="Optional status filter.",
    )
    provider: BatchProviderName | None = Field(
        default=None,
        description="Optional provider filter.",
    )
    limit: int = Field(
        default=20,
        ge=1,
        le=100,
        description="Maximum number of batch jobs to return.",
    )


class BatchCancelArgs(BaseModel):
    """Strict Pydantic v2 arguments for `batch_cancel`."""

    model_config = ConfigDict(extra="forbid")

    job_id: str = Field(
        min_length=1,
        max_length=128,
        description="Batch job identifier to cancel.",
    )


def _resolve_runner(ctx: ToolExecutionContext) -> BatchRunner:
    svc = ctx.module_ctx.modules.get_service("batch-api")
    if isinstance(svc, BatchRunner):
        return svc
    return BatchRunner(ctx.module_ctx)


async def execute_batch_submit(
    args: BatchSubmitArgs,
    ctx: ToolExecutionContext,
) -> ToolExecutionResult:
    """Submit a canonical JSONL batch job through `BatchRunner`."""
    runner = _resolve_runner(ctx)
    try:
        job = await runner.submit_job(
            BatchSubmitInput(
                input_path=args.input_path,
                items=args.items,
                provider=args.provider,
                model=args.model,
                task_type=args.task_type,
                eu_only=args.eu_only,
                agent_id=ctx.agent_id,
                session_id=ctx.session_id,
            ),
            workspace_dir=ctx.workspace_dir,
        )
    except ModuleError as exc:
        return ToolExecutionResult(
            ok=False,
            error_code=exc.code,
            error=exc.message,
        )
    return ToolExecutionResult(ok=True, output=job.model_dump(mode="json"))


async def execute_batch_status(
    args: BatchStatusArgs,
    ctx: ToolExecutionContext,
) -> ToolExecutionResult:
    """Retrieve status (and optional live poll) for a batch job."""
    runner = _resolve_runner(ctx)
    try:
        job = await runner.get_job(args.job_id, poll=args.poll)
    except ModuleError as exc:
        return ToolExecutionResult(
            ok=False,
            error_code=exc.code,
            error=exc.message,
        )
    return ToolExecutionResult(ok=True, output=job.model_dump(mode="json"))


async def execute_batch_list(
    args: BatchListArgs,
    ctx: ToolExecutionContext,
) -> ToolExecutionResult:
    """List recent batch jobs and CostOps savings summary."""
    runner = _resolve_runner(ctx)
    try:
        overview = await runner.get_overview(
            status=args.status,
            provider=args.provider,
            limit=args.limit,
        )
    except ModuleError as exc:
        return ToolExecutionResult(
            ok=False,
            error_code=exc.code,
            error=exc.message,
        )
    return ToolExecutionResult(ok=True, output=overview.model_dump(mode="json"))


async def execute_batch_cancel(
    args: BatchCancelArgs,
    ctx: ToolExecutionContext,
) -> ToolExecutionResult:
    """Cancel an in-flight batch job."""
    runner = _resolve_runner(ctx)
    try:
        job = await runner.cancel_job(args.job_id)
    except ModuleError as exc:
        return ToolExecutionResult(
            ok=False,
            error_code=exc.code,
            error=exc.message,
        )
    return ToolExecutionResult(ok=True, output=job.model_dump(mode="json"))


def build_batch_tools() -> Sequence[ModuleToolDefinition[Any]]:
    """Build the 4 `batch-api` LLM tool definitions."""
    return (
        ModuleToolDefinition(
            name="batch_submit",
            description=(
                "Submit an asynchronous 50%-discounted multi-provider Batch API job "
                "from a canonical JSONL file or inline items."
            ),
            args_model=BatchSubmitArgs,
            execute=execute_batch_submit,
            module_id="batch-api",
        ),
        ModuleToolDefinition(
            name="batch_status",
            description="Check status, token usage, savings, and QA state for a batch job.",
            args_model=BatchStatusArgs,
            execute=execute_batch_status,
            module_id="batch-api",
        ),
        ModuleToolDefinition(
            name="batch_list",
            description="List batch jobs and 4-provider CostOps savings breakdown.",
            args_model=BatchListArgs,
            execute=execute_batch_list,
            module_id="batch-api",
        ),
        ModuleToolDefinition(
            name="batch_cancel",
            description="Cancel an in-flight batch job at the remote provider.",
            args_model=BatchCancelArgs,
            execute=execute_batch_cancel,
            module_id="batch-api",
        ),
    )
