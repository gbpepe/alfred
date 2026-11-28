"""CostOps daily circuit breaker combining `token_usage` and `compute_usage` spend."""

from __future__ import annotations

import asyncio
import logging
import math
import re
import time
from datetime import UTC, datetime
from typing import Final

from pydantic import BaseModel, ConfigDict, Field

from alfred.core.db import SqlitePool
from alfred.kernel.registry import ModuleRegistry
from alfred.kernel.types import ComputeUsageRecord

_logger = logging.getLogger("alfred.circuit_breaker")

BUILTIN_ZERO_COST_PREFIXES: Final[tuple[str, ...]] = (
    r"^claude-cli:",
    r"^agy-cli:",
    r"^codex-cli:",
    r"^gemini-cli:",
    r"^qwen-plan:",
)


class TokenUsageRecord(BaseModel):
    """Structured token + USD usage event persisted to `token_usage`."""

    model_config = ConfigDict(extra="forbid")

    agent: str
    session_id: str | None = None
    model: str
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    cache_read_tokens: int = Field(default=0, ge=0)
    cache_creation_tokens: int = Field(default=0, ge=0)
    thinking_tokens: int = Field(default=0, ge=0)
    cost_usd: float = Field(default=0.0, ge=0.0, allow_inf_nan=False)
    content_preview: str | None = None
    tool_name: str | None = None
    task_title: str | None = None
    project: str | None = None


class BudgetCheckResult(BaseModel):
    """Decision returned by `CircuitBreaker.check_budget()`."""

    model_config = ConfigDict(extra="forbid")

    allowed: bool
    zero_cost: bool
    agent_spend_usd: float
    global_spend_usd: float
    agent_limit_usd: float
    global_limit_usd: float
    reason: str = ""


def utc_day_start_sec(now_ts: int | None = None) -> int:
    """Return Unix timestamp (seconds) for `00:00:00 UTC` of the day containing `now_ts`."""
    ts = now_ts if now_ts is not None else int(time.time())
    dt = datetime.fromtimestamp(ts, tz=UTC)
    midnight = dt.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(midnight.timestamp())


class CircuitBreaker:
    """Enforces per-agent and global daily USD budgets across token + compute spend."""

    def __init__(self, db: SqlitePool, registry: ModuleRegistry | None = None) -> None:
        self._db = db
        self._registry = registry
        self._budget_lock = asyncio.Lock()
        self._in_flight_usd: dict[str, float] = {}

    def zero_cost_patterns(self) -> tuple[str, ...]:
        """Return built-in plus active-plugin `$0.00` regex prefixes."""
        extra = self._registry.list_zero_cost_model_prefixes() if self._registry else ()
        return BUILTIN_ZERO_COST_PREFIXES + extra

    def is_zero_cost_model(self, model: str) -> bool:
        """Check whether `model` matches any subscription / `$0.00` quota prefix."""
        for pattern in self.zero_cost_patterns():
            try:
                if re.match(pattern, model):
                    return True
            except re.error:
                _logger.warning("Ignoring invalid zero-cost regex pattern: %r", pattern)
        return False

    async def _evaluate_budget_unlocked(
        self,
        *,
        agent_id: str,
        model: str,
        agent_daily_limit_usd: float,
        global_daily_limit_usd: float,
        now_ts: int | None = None,
    ) -> BudgetCheckResult:
        if not math.isfinite(agent_daily_limit_usd) or not math.isfinite(global_daily_limit_usd):
            raise ValueError("Budget limits must be finite numbers")

        since = utc_day_start_sec(now_ts)
        db_agent_spend = await self._db.get_daily_spend_usd(since_ts=since, agent=agent_id)
        db_global_spend = await self._db.get_daily_spend_usd(since_ts=since)

        in_flight_agent = self._in_flight_usd.get(agent_id, 0.0)
        in_flight_global = sum(self._in_flight_usd.values())
        agent_spend = db_agent_spend + in_flight_agent
        global_spend = db_global_spend + in_flight_global

        if self.is_zero_cost_model(model):
            return BudgetCheckResult(
                allowed=True,
                zero_cost=True,
                agent_spend_usd=agent_spend,
                global_spend_usd=global_spend,
                agent_limit_usd=agent_daily_limit_usd,
                global_limit_usd=global_daily_limit_usd,
                reason="zero-cost model prefix exempt",
            )

        if agent_daily_limit_usd >= 0 and agent_spend >= agent_daily_limit_usd:
            return BudgetCheckResult(
                allowed=False,
                zero_cost=False,
                agent_spend_usd=agent_spend,
                global_spend_usd=global_spend,
                agent_limit_usd=agent_daily_limit_usd,
                global_limit_usd=global_daily_limit_usd,
                reason=(
                    f"Agent '{agent_id}' daily budget reached "
                    f"(${agent_spend:.4f} >= ${agent_daily_limit_usd:.4f})"
                ),
            )

        if global_daily_limit_usd >= 0 and global_spend >= global_daily_limit_usd:
            return BudgetCheckResult(
                allowed=False,
                zero_cost=False,
                agent_spend_usd=agent_spend,
                global_spend_usd=global_spend,
                agent_limit_usd=agent_daily_limit_usd,
                global_limit_usd=global_daily_limit_usd,
                reason=(
                    f"Global daily budget reached "
                    f"(${global_spend:.4f} >= ${global_daily_limit_usd:.4f})"
                ),
            )

        return BudgetCheckResult(
            allowed=True,
            zero_cost=False,
            agent_spend_usd=agent_spend,
            global_spend_usd=global_spend,
            agent_limit_usd=agent_daily_limit_usd,
            global_limit_usd=global_daily_limit_usd,
        )

    async def check_budget(
        self,
        *,
        agent_id: str,
        model: str,
        agent_daily_limit_usd: float,
        global_daily_limit_usd: float,
        now_ts: int | None = None,
    ) -> BudgetCheckResult:
        """Check whether an agent invocation fits within combined token+compute daily budgets."""
        async with self._budget_lock:
            return await self._evaluate_budget_unlocked(
                agent_id=agent_id,
                model=model,
                agent_daily_limit_usd=agent_daily_limit_usd,
                global_daily_limit_usd=global_daily_limit_usd,
                now_ts=now_ts,
            )

    async def reserve_budget(
        self,
        *,
        agent_id: str,
        model: str,
        agent_daily_limit_usd: float,
        global_daily_limit_usd: float,
        estimated_cost_usd: float = 0.01,
        now_ts: int | None = None,
    ) -> tuple[BudgetCheckResult, float]:
        """Atomically evaluate daily budget and reserve estimated in-flight USD if allowed."""
        if not math.isfinite(estimated_cost_usd) or estimated_cost_usd < 0.0:
            raise ValueError("estimated_cost_usd must be finite and non-negative")
        async with self._budget_lock:
            decision = await self._evaluate_budget_unlocked(
                agent_id=agent_id,
                model=model,
                agent_daily_limit_usd=agent_daily_limit_usd,
                global_daily_limit_usd=global_daily_limit_usd,
                now_ts=now_ts,
            )
            if not decision.allowed or decision.zero_cost or estimated_cost_usd == 0.0:
                return decision, 0.0
            self._in_flight_usd[agent_id] = (
                self._in_flight_usd.get(agent_id, 0.0) + estimated_cost_usd
            )
            return decision, estimated_cost_usd

    async def release_reservation(self, agent_id: str, reserved_usd: float) -> None:
        """Release previously reserved in-flight USD budget after request completion."""
        if reserved_usd <= 0.0:
            return
        async with self._budget_lock:
            remaining = self._in_flight_usd.get(agent_id, 0.0) - reserved_usd
            if remaining <= 1e-12:
                self._in_flight_usd.pop(agent_id, None)
            else:
                self._in_flight_usd[agent_id] = remaining

    async def record_token_usage(
        self,
        record: TokenUsageRecord,
        *,
        now_ts: int | None = None,
    ) -> None:
        """Persist LLM token & USD usage row."""
        if not math.isfinite(record.cost_usd):
            raise ValueError("Token cost_usd must be finite")
        ts = now_ts if now_ts is not None else int(time.time())
        cost = 0.0 if self.is_zero_cost_model(record.model) else record.cost_usd
        await self._db.record_token_usage(
            agent=record.agent,
            session_id=record.session_id,
            timestamp_sec=ts,
            input_tokens=record.input_tokens,
            output_tokens=record.output_tokens,
            cache_read_tokens=record.cache_read_tokens,
            cache_creation_tokens=record.cache_creation_tokens,
            thinking_tokens=record.thinking_tokens,
            model=record.model,
            cost_usd=cost,
            content_preview=record.content_preview,
            tool_name=record.tool_name,
            task_title=record.task_title,
            project=record.project,
        )

    async def record_compute_usage(
        self,
        record: ComputeUsageRecord,
        *,
        now_ts: int | None = None,
    ) -> None:
        """Persist non-token compute billing entry to `compute_usage`."""
        if not math.isfinite(record.cost_usd):
            raise ValueError("Compute cost_usd must be finite")
        ts = now_ts if now_ts is not None else int(time.time())
        await self._db.record_compute_usage(
            module_id=record.module_id,
            agent=record.agent,
            session_id=record.session_id,
            resource_label=record.resource_label,
            duration_sec=record.duration_sec,
            cost_usd=record.cost_usd,
            timestamp_sec=ts,
        )
