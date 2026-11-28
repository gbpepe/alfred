"""Batch API orchestration: GDPR routing, JSONL secret scan, lifecycle, CostOps & QA."""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import time
import uuid
from collections import Counter
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final

import httpx
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from alfred.core.env_file import atomic_write_text
from alfred.core.gcp_auth import GcpTokenProvider, ServiceAccountCredentials
from alfred.core.model_router import is_eu_vertex_location
from alfred.core.security.prompt_safety import wrap_untrusted
from alfred.core.security.secret_gate import SecretScanInput, scan_inputs
from alfred.kernel.errors import ForbiddenVaultAccessError, ModuleSecurityError
from alfred.kernel.types import ComputeUsageRecord, HousekeepingStats, ModuleContext

from .adapters import (
    ANTHROPIC_EPHEMERAL_CACHE_MIN_CHARS,
    BATCH_PROVIDERS,
    DEFAULT_BATCH_MODELS,
    AnthropicBatchAdapter,
    BaseBatchAdapter,
    BatchAdapterError,
    BatchJobStatus,
    BatchPayloadLimitError,
    BatchProviderAuthError,
    BatchProviderName,
    BatchSubmitPayload,
    BatchTaskType,
    CanonicalBatchOutputItem,
    CanonicalBatchRequestItem,
    GdprBatchComplianceError,
    GeminiBatchAdapter,
    OpenAiBatchAdapter,
    RequestedBatchProvider,
    VertexEuBatchAdapter,
)

_TERMINAL_STATUSES: Final[frozenset[str]] = frozenset({"completed", "failed", "cancelled"})
_ACTIVE_STATUSES: Final[frozenset[str]] = frozenset(
    {"queued", "submitted", "running", "downloading"}
)
_TEMP_MAX_AGE_SECONDS: Final[int] = 86_400
_QA_MAX_SAMPLE_ITEMS: Final[int] = 5


class BatchNotFoundError(BatchAdapterError):
    """Raised when a batch job ID does not exist in SQLite."""

    def __init__(self, job_id: str) -> None:
        super().__init__(
            f"Batch job '{job_id}' not found",
            code="BATCH_NOT_FOUND",
            status_code=404,
        )


class BatchValidationError(BatchAdapterError):
    """Raised when batch input JSONL, custom_id, or configuration is invalid."""

    def __init__(self, message: str, *, code: str = "BATCH_VALIDATION_ERROR") -> None:
        super().__init__(
            message,
            code=code,
            status_code=400,
        )


class BatchJobRecord(BaseModel):
    """Strict Pydantic v2 projection of a `batch_jobs` SQLite row."""

    model_config = ConfigDict(extra="forbid")

    id: str
    provider: BatchProviderName
    model: str
    status: BatchJobStatus
    agent_id: str
    session_id: str
    external_job_id: str | None = None
    input_ref: str
    output_ref: str | None = None
    request_count: int = Field(default=0, ge=0)
    completed_count: int = Field(default=0, ge=0)
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    cost_usd: float = Field(default=0.0, ge=0.0)
    saved_cost_usd: float = Field(default=0.0, ge=0.0)
    baseline_cost_usd: float = Field(default=0.0, ge=0.0)
    qa_sampled: bool = False
    qa_status: str | None = None
    error_message: str | None = None
    created_at: str
    updated_at: str
    completed_at: str | None = None


class BatchProviderSummary(BaseModel):
    """Per-provider batch readiness and CostOps savings summary."""

    model_config = ConfigDict(extra="forbid")

    provider: BatchProviderName
    configured: bool
    batch_count: int = Field(default=0, ge=0)
    completed_items: int = Field(default=0, ge=0)
    spent_usd: float = Field(default=0.0, ge=0.0)
    saved_usd: float = Field(default=0.0, ge=0.0)
    baseline_usd: float = Field(default=0.0, ge=0.0)


class BatchOverviewSummary(BaseModel):
    """Aggregate CostOps KPI summary across all batch jobs."""

    model_config = ConfigDict(extra="forbid")

    total_batches: int = Field(default=0, ge=0)
    active_batches: int = Field(default=0, ge=0)
    total_items: int = Field(default=0, ge=0)
    total_spent_usd: float = Field(default=0.0, ge=0.0)
    total_saved_usd: float = Field(default=0.0, ge=0.0)
    total_baseline_usd: float = Field(default=0.0, ge=0.0)


class BatchOverviewResponse(BaseModel):
    """Combined summary, 4-provider breakdown, and job list DTO."""

    model_config = ConfigDict(extra="forbid")

    summary: BatchOverviewSummary
    by_provider: list[BatchProviderSummary]
    jobs: list[BatchJobRecord]


class BatchSubmitInput(BaseModel):
    """Validated request for submitting a new asynchronous batch job."""

    model_config = ConfigDict(extra="forbid")

    input_path: str | None = Field(default=None, min_length=1)
    items: list[CanonicalBatchRequestItem] | None = Field(default=None, min_length=1)
    provider: RequestedBatchProvider = "auto"
    model: str | None = Field(default=None, min_length=1)
    task_type: BatchTaskType | None = None
    eu_only: bool = False
    agent_id: str = Field(default="alfred-batch", min_length=1, max_length=128)
    session_id: str = Field(default="", max_length=256)

    @model_validator(mode="after")
    def _require_input_source(self) -> BatchSubmitInput:
        if self.input_path is None and self.items is None:
            raise ValueError("Either 'input_path' or 'items' must be provided")
        return self


def _row_to_job(row: sqlite3.Row) -> BatchJobRecord:
    cost = round(float(row["cost_usd"] or 0.0), 6)
    saved = cost
    baseline = round(cost * 2.0, 6)
    return BatchJobRecord(
        id=str(row["id"]),
        provider=row["provider"],
        model=str(row["model"]),
        status=row["status"],
        agent_id=str(row["agent_id"]),
        session_id=str(row["session_id"]),
        external_job_id=str(row["external_job_id"]) if row["external_job_id"] else None,
        input_ref=str(row["input_ref"]),
        output_ref=str(row["output_ref"]) if row["output_ref"] else None,
        request_count=int(row["request_count"] or 0),
        completed_count=int(row["completed_count"] or 0),
        input_tokens=int(row["input_tokens"] or 0),
        output_tokens=int(row["output_tokens"] or 0),
        cost_usd=cost,
        saved_cost_usd=saved,
        baseline_cost_usd=baseline,
        qa_sampled=bool(row["qa_sampled"]),
        qa_status=str(row["qa_status"]) if row["qa_status"] is not None else None,
        error_message=str(row["error_message"]) if row["error_message"] is not None else None,
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
        completed_at=str(row["completed_at"]) if row["completed_at"] is not None else None,
    )


def _now_iso(ts_sec: float | None = None) -> str:
    if ts_sec is None:
        return datetime.now(tz=UTC).isoformat()
    return datetime.fromtimestamp(ts_sec, tz=UTC).isoformat()


def _resolve_read_input_path(
    ctx: ModuleContext,
    raw_path: str,
    *,
    workspace_dir: Path | None,
) -> tuple[Path, str]:
    clean = raw_path.strip()
    if not clean or "\x00" in clean or "\\" in clean:
        raise ModuleSecurityError(
            f"Invalid batch input path: {raw_path!r}",
            module_id=ctx.module_id,
        )
    rel = Path(clean)
    if rel.is_absolute():
        raise ModuleSecurityError(
            f"Absolute batch input path is forbidden: {raw_path!r}",
            module_id=ctx.module_id,
        )

    data_root = ctx.security.data_dir.base_dir.resolve()
    data_candidate = (data_root / rel).resolve()
    if data_candidate.is_relative_to(data_root) and data_candidate.is_file():
        return data_candidate, rel.as_posix()

    if workspace_dir is not None:
        ws_root = workspace_dir.resolve()
        lexical = ws_root / rel
        lexical_norm = Path(os.path.normpath(str(lexical)))
        if not lexical_norm.is_relative_to(ws_root):
            raise ModuleSecurityError(
                f"Batch input path '{raw_path}' escapes workspace",
                module_id=ctx.module_id,
            )
        resolved = lexical.resolve()
        if not resolved.is_relative_to(ws_root):
            raise ModuleSecurityError(
                f"Symlinked batch input path '{raw_path}' escapes workspace",
                module_id=ctx.module_id,
            )
        rel_posix = resolved.relative_to(ws_root).as_posix()
        if rel_posix == ".env" or rel_posix.startswith(".env."):
            raise ModuleSecurityError(
                "Reading .env files as batch input is forbidden",
                module_id=ctx.module_id,
            )
        if rel_posix == "store" or rel_posix.startswith("store/"):
            raise ModuleSecurityError(
                "Reading protected 'store/' directory as batch input is forbidden",
                module_id=ctx.module_id,
            )
        if not resolved.exists() or not resolved.is_file():
            raise BatchValidationError(
                f"Batch input file not found: {raw_path}",
                code="BATCH_INPUT_NOT_FOUND",
            )
        return resolved, rel_posix

    # When no workspace_dir is provided, enforce strict module data_dir confinement
    confined = ctx.security.data_dir.resolve_path(rel)
    if not confined.exists() or not confined.is_file():
        raise BatchValidationError(
            f"Batch input file not found in module data_dir: {raw_path}",
            code="BATCH_INPUT_NOT_FOUND",
        )
    return confined, rel.as_posix()


def _parse_and_scan_jsonl_sync(
    abs_path: Path,
    display_ref: str,
    ctx: ModuleContext,
) -> list[CanonicalBatchRequestItem]:
    size = abs_path.stat().st_size
    if size <= 2 * 1024 * 1024:
        file_gate = ctx.security.scan_file_for_secrets(abs_path, display_path=display_ref)
        if not file_gate.ok:
            reasons = "; ".join(f"{f.detector}: {f.reason}" for f in file_gate.findings)
            raise BatchValidationError(
                f"Secret gate blocked batch input ({reasons})",
                code="BATCH_SECRET_GATE_BLOCKED",
            )

    items: list[CanonicalBatchRequestItem] = []
    seen_ids: set[str] = set()
    with abs_path.open("r", encoding="utf-8") as handle:
        for line_no, raw_line in enumerate(handle, start=1):
            trimmed = raw_line.strip()
            if not trimmed:
                continue
            try:
                raw_obj = json.loads(trimmed)
            except json.JSONDecodeError as exc:
                raise BatchValidationError(
                    f"Malformed JSON at line {line_no} of {Path(display_ref).name}: {exc.msg}",
                    code="INVALID_JSONL_LINE",
                ) from exc
            if not isinstance(raw_obj, dict):
                raise BatchValidationError(
                    f"Expected JSON object at line {line_no}",
                    code="INVALID_JSONL_OBJECT",
                )
            try:
                item = CanonicalBatchRequestItem.model_validate(raw_obj)
            except ValidationError as exc:
                msg = "; ".join(
                    str(e.get("msg", "Invalid value"))
                    for e in exc.errors(include_url=False, include_input=False)
                )
                raise BatchValidationError(
                    f"Invalid batch item at line {line_no}: {msg}",
                    code="INVALID_BATCH_ITEM",
                ) from exc
            if item.custom_id in seen_ids:
                raise BatchValidationError(
                    f"Duplicate custom_id '{item.custom_id}' at line {line_no}",
                    code="DUPLICATE_CUSTOM_ID",
                )
            seen_ids.add(item.custom_id)
            items.append(item)

    if not items:
        raise BatchValidationError(
            "Batch JSONL input contains 0 items",
            code="EMPTY_BATCH_INPUT",
        )
    if size > 2 * 1024 * 1024:
        _scan_items_secrets(items, display_ref)
    return items


def _scan_items_secrets(items: list[CanonicalBatchRequestItem], display_ref: str) -> None:
    seen_ids: set[str] = set()
    scan_batch: list[SecretScanInput] = []
    for idx, item in enumerate(items, start=1):
        if item.custom_id in seen_ids:
            raise BatchValidationError(
                f"Duplicate custom_id '{item.custom_id}' at item {idx}",
                code="DUPLICATE_CUSTOM_ID",
            )
        seen_ids.add(item.custom_id)
        combined = f"{item.system}\n{item.prompt}" if item.system else item.prompt
        scan_batch.append(SecretScanInput(path=display_ref, content=combined))

    gate = scan_inputs(scan_batch)
    if not gate.ok:
        reasons = "; ".join(f"{f.detector}: {f.reason}" for f in gate.findings)
        raise BatchValidationError(
            f"Secret gate blocked batch input ({reasons})",
            code="BATCH_SECRET_GATE_BLOCKED",
        )


def _write_canonical_jsonl_sync(path: Path, items: list[CanonicalBatchRequestItem]) -> None:
    lines = [item.model_dump_json() for item in items]
    atomic_write_text(path, "\n".join(lines) + "\n", mode=0o600, dir_mode=0o700)


def _write_output_jsonl_sync(path: Path, output_items: list[CanonicalBatchOutputItem]) -> None:
    lines = [item.model_dump_json() for item in output_items]
    payload = ("\n".join(lines) + "\n") if lines else ""
    atomic_write_text(path, payload, mode=0o600, dir_mode=0o700)


def _write_qa_sample_sync(
    path: Path,
    job_id: str,
    provider: str,
    model: str,
    output_items: list[CanonicalBatchOutputItem],
) -> None:
    sample = output_items[:_QA_MAX_SAMPLE_ITEMS]
    envelopes = [
        {
            "custom_id": item.custom_id,
            "status": item.status,
            "wrapped_preview": wrap_untrusted(
                f"batch-output:{job_id}:{item.custom_id}",
                (item.text if item.status == "ok" else (item.error or "error"))[:1200],
            ),
        }
        for item in sample
    ]
    doc = {
        "job_id": job_id,
        "provider": provider,
        "model": model,
        "sample_count": len(sample),
        "total_items": len(output_items),
        "samples": envelopes,
    }
    atomic_write_text(path, json.dumps(doc, indent=2) + "\n", mode=0o600, dir_mode=0o700)


def _cleanup_temp_files_sync(base_dir: Path) -> int:
    if not base_dir.is_dir():
        return 0
    removed = 0
    for cur_root, _, filenames in os.walk(base_dir):
        for fname in filenames:
            if not (fname.endswith(".tmp") or fname.endswith(".part")):
                continue
            target = Path(cur_root) / fname
            if target.is_symlink() or not target.is_file():
                continue
            try:
                target.unlink()
                removed += 1
            except OSError:
                continue
    return removed


def _prune_expired_files_sync(
    base_dir: Path,
    *,
    protected_rel_paths: frozenset[str],
    cutoff_sec: float,
    tmp_cutoff_sec: float,
) -> tuple[int, int]:
    if not base_dir.is_dir():
        return 0, 0
    resolved_base = base_dir.resolve()
    pruned_count = 0
    freed_bytes = 0

    for cur_root, dirnames, filenames in os.walk(resolved_base, topdown=False):
        for fname in filenames:
            target = Path(cur_root) / fname
            try:
                if target.is_symlink() or not target.is_file():
                    continue
                resolved_target = target.resolve()
                if not resolved_target.is_relative_to(resolved_base):
                    continue
                rel_posix = resolved_target.relative_to(resolved_base).as_posix()
                if rel_posix in protected_rel_paths:
                    continue
                st = target.stat(follow_symlinks=False)
                is_temp = fname.endswith(".tmp") or fname.endswith(".part")
                effective_cutoff = tmp_cutoff_sec if is_temp else cutoff_sec
                if st.st_mtime < effective_cutoff:
                    size = int(st.st_size)
                    target.unlink()
                    pruned_count += 1
                    freed_bytes += size
            except OSError:
                continue
        for dname in dirnames:
            dpath = Path(cur_root) / dname
            try:
                if dpath.is_dir() and not dpath.is_symlink() and not any(dpath.iterdir()):
                    dpath.rmdir()
            except OSError:
                continue

    return pruned_count, freed_bytes


class BatchRunner:
    """Async multi-provider Batch API runner with SQLite recovery, CostOps & QA sampling."""

    def __init__(
        self,
        ctx: ModuleContext,
        *,
        http_client: httpx.AsyncClient | None = None,
        gcp_token_provider: GcpTokenProvider | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self.ctx = ctx
        self._http_client = http_client
        self._gcp_token_provider = gcp_token_provider
        self._clock = clock or time.time
        self._in_flight_polls: set[str] = set()

    def set_http_client(self, client: httpx.AsyncClient | None) -> None:
        """Override injectable `httpx.AsyncClient` for deterministic testing."""
        self._http_client = client

    def set_gcp_token_provider(self, provider: GcpTokenProvider | None) -> None:
        """Override injectable `GcpTokenProvider` for Vertex EU calls."""
        self._gcp_token_provider = provider

    def _effective_http_client(self) -> httpx.AsyncClient | None:
        if self._http_client is not None:
            return self._http_client
        extra_client = self.ctx.extra.get("http_client") or self.ctx.extra.get(
            "batch_http_client"
        )
        if isinstance(extra_client, httpx.AsyncClient):
            return extra_client
        return None

    def _effective_env_str(self, key: str) -> str:
        raw_env = self.ctx.extra.get("env")
        if isinstance(raw_env, Mapping):
            val = raw_env.get(key)
            return val.strip() if isinstance(val, str) else ""
        return os.environ.get(key, "").strip()

    async def _resolve_secret(self, key: str) -> str:
        try:
            secret = await self.ctx.security.vault.get_secret(key)
            if secret and secret.strip():
                return secret.strip()
        except ForbiddenVaultAccessError:
            pass
        return self._effective_env_str(key)

    def _resolve_gcp_provider(self) -> tuple[GcpTokenProvider | None, str | None, str]:
        tp = self._gcp_token_provider
        if tp is None:
            extra_tp = self.ctx.extra.get("gcp_token_provider")
            if isinstance(extra_tp, GcpTokenProvider):
                tp = extra_tp
        if tp is None:
            creds_path_str = self._effective_env_str("GOOGLE_APPLICATION_CREDENTIALS")
            if creds_path_str:
                creds_path = Path(creds_path_str)
                if creds_path.is_file():
                    creds = ServiceAccountCredentials.model_validate_json(
                        creds_path.read_text(encoding="utf-8")
                    )
                    tp = GcpTokenProvider(creds, http_client=self._effective_http_client())
        static_tok = self._effective_env_str("VERTEX_EU_ACCESS_TOKEN") or None
        proj_id = (
            self._effective_env_str("GOOGLE_CLOUD_PROJECT")
            or self._effective_env_str("VERTEX_EU_PROJECT_ID")
            or (tp.credentials.project_id if tp and tp.credentials.project_id else "")
        )
        return tp, static_tok, proj_id

    async def _get_vertex_settings(
        self,
    ) -> tuple[str, str, str, GcpTokenProvider | None, str | None]:
        cfg = await self.ctx.security.config.get()
        raw_bucket = cfg.get("VERTEX_EU_BATCH_BUCKET")
        bucket = (
            raw_bucket.strip()
            if isinstance(raw_bucket, str) and raw_bucket.strip()
            else self._effective_env_str("VERTEX_EU_BATCH_BUCKET")
        )
        raw_loc = (
            cfg.get("VERTEX_EU_BATCH_LOCATION")
            or cfg.get("VERTEX_EU_LOCATION")
            or self._effective_env_str("VERTEX_EU_BATCH_LOCATION")
            or self._effective_env_str("VERTEX_EU_LOCATION")
            or self._effective_env_str("VERTEX_LOCATION")
            or "europe-central2"
        )
        location = str(raw_loc).strip()
        tp, static_tok, proj_id = self._resolve_gcp_provider()
        return bucket, location, proj_id, tp, static_tok

    async def is_provider_configured(self, provider: BatchProviderName) -> bool:
        """Check whether `provider` has credentials/config without decrypting unnecessary keys."""
        vault_keys = {item.key_id for item in self.ctx.security.vault.list_secrets()}
        if provider == "anthropic":
            return "ANTHROPIC_API_KEY" in vault_keys or bool(
                self._effective_env_str("ANTHROPIC_API_KEY")
            )
        if provider == "gemini":
            return "GEMINI_API_KEY" in vault_keys or bool(
                self._effective_env_str("GEMINI_API_KEY")
            )
        if provider == "openai":
            return "OPENAI_API_KEY" in vault_keys or bool(
                self._effective_env_str("OPENAI_API_KEY")
            )
        bucket, location, proj_id, tp, static_tok = await self._get_vertex_settings()
        has_auth = (tp is not None or bool(static_tok)) and bool(proj_id)
        return bool(bucket) and is_eu_vertex_location(location) and has_auth

    async def resolve_provider_chain(
        self,
        *,
        requested_provider: RequestedBatchProvider,
        task_type: BatchTaskType,
        eu_only: bool,
    ) -> list[BatchProviderName]:
        """Determine ordered candidate providers while enforcing `eu_only` GDPR rules."""
        if eu_only:
            if requested_provider not in ("auto", "vertex-eu"):
                raise GdprBatchComplianceError(
                    f"eu_only=True strictly requires provider 'vertex-eu' "
                    f"(got '{requested_provider}')"
                )
            _, location, _, _, _ = await self._get_vertex_settings()
            if not is_eu_vertex_location(location):
                raise GdprBatchComplianceError(
                    f"eu_only=True rejected non-EU Vertex location '{location}'"
                )
            if not await self.is_provider_configured("vertex-eu"):
                raise GdprBatchComplianceError(
                    "eu_only=True requires configured 'vertex-eu' "
                    "(VERTEX_EU_BATCH_BUCKET + europe-* location + GCP credentials)"
                )
            return ["vertex-eu"]

        if requested_provider != "auto":
            if requested_provider == "vertex-eu":
                _, location, _, _, _ = await self._get_vertex_settings()
                if not is_eu_vertex_location(location):
                    raise GdprBatchComplianceError(
                        f"Vertex EU requires an 'europe-*' location, got '{location}'"
                    )
            if not await self.is_provider_configured(requested_provider):
                raise BatchProviderAuthError(
                    f"Requested batch provider '{requested_provider}' is not configured"
                )
            return [requested_provider]

        preference: tuple[BatchProviderName, ...] = (
            ("anthropic", "gemini", "vertex-eu", "openai")
            if task_type in ("code", "reasoning")
            else ("gemini", "vertex-eu", "openai", "anthropic")
        )
        configured = [p for p in preference if await self.is_provider_configured(p)]
        if not configured:
            raise BatchProviderAuthError(
                "No Batch API provider is configured "
                "(configure GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or Vertex EU)"
            )
        return configured

    async def _build_adapter(
        self,
        provider: BatchProviderName,
        *,
        timeout_sec: float = 60.0,
    ) -> BaseBatchAdapter:
        http_client = self._effective_http_client()
        if provider == "anthropic":
            api_key = await self._resolve_secret("ANTHROPIC_API_KEY")
            base_url = self._effective_env_str("ANTHROPIC_BASE_URL") or "https://api.anthropic.com"
            return AnthropicBatchAdapter(
                api_key=api_key,
                base_url=base_url,
                http_client=http_client,
                timeout_sec=timeout_sec,
            )
        if provider == "gemini":
            api_key = await self._resolve_secret("GEMINI_API_KEY")
            base_url = (
                self._effective_env_str("GEMINI_BATCH_API_BASE")
                or "https://generativelanguage.googleapis.com"
            )
            return GeminiBatchAdapter(
                api_key=api_key,
                base_url=base_url,
                http_client=http_client,
                timeout_sec=timeout_sec,
            )
        if provider == "openai":
            api_key = await self._resolve_secret("OPENAI_API_KEY")
            base_url = self._effective_env_str("OPENAI_BASE_URL") or "https://api.openai.com/v1"
            return OpenAiBatchAdapter(
                api_key=api_key,
                base_url=base_url,
                http_client=http_client,
                timeout_sec=timeout_sec,
            )

        bucket, location, proj_id, tp, static_tok = await self._get_vertex_settings()
        cfg = await self.ctx.security.config.get()
        raw_verify = cfg.get("VERTEX_EU_VERIFY_BUCKET_LOCATION")
        if raw_verify is None:
            raw_verify = self._effective_env_str("VERTEX_EU_VERIFY_BUCKET_LOCATION")
        verify_bucket = (
            raw_verify is True
            or (
                isinstance(raw_verify, str)
                and raw_verify.strip().lower() in ("1", "true", "yes")
            )
        )
        gcs_base = self._effective_env_str("GCS_BASE_URL") or "https://storage.googleapis.com"
        vertex_base = self._effective_env_str("VERTEX_BASE_URL") or None
        return VertexEuBatchAdapter(
            bucket=bucket,
            location=location,
            project_id=proj_id or None,
            token_provider=tp,
            access_token=static_tok,
            http_client=http_client,
            gcs_base_url=gcs_base,
            vertex_base_url=vertex_base,
            verify_bucket_location=verify_bucket,
            timeout_sec=timeout_sec,
        )

    async def _default_model_for(self, provider: BatchProviderName) -> str:
        if provider == "gemini":
            cfg = await self.ctx.security.config.get()
            cfg_model = cfg.get("GEMINI_BATCH_MODEL")
            if isinstance(cfg_model, str) and cfg_model.strip():
                return cfg_model.strip()
            env_model = self._effective_env_str("GEMINI_BATCH_MODEL")
            if env_model:
                return env_model
        return DEFAULT_BATCH_MODELS[provider]

    async def submit_job(
        self,
        payload: BatchSubmitInput,
        *,
        workspace_dir: Path | None = None,
    ) -> BatchJobRecord:
        """Validate/scan canonical batch input, select provider, submit & persist SQLite row."""
        now_sec = self._clock()
        job_id = f"batch_{int(now_sec)}_{uuid.uuid4().hex[:8]}"

        if payload.items is not None:
            items = list(payload.items)
            display_ref = f"inputs/{job_id}.jsonl"
            await asyncio.to_thread(_scan_items_secrets, items, display_ref)
        elif payload.input_path is not None:
            abs_in, display_ref = _resolve_read_input_path(
                self.ctx,
                payload.input_path,
                workspace_dir=workspace_dir,
            )
            items = await asyncio.to_thread(
                _parse_and_scan_jsonl_sync,
                abs_in,
                display_ref,
                self.ctx,
            )
        else:
            raise BatchValidationError("Either 'input_path' or 'items' must be provided")

        any_eu_only = payload.eu_only or any(it.eu_only for it in items)
        task_counts = Counter(it.task_type for it in items)
        effective_task_type = payload.task_type or task_counts.most_common(1)[0][0]
        sys_counts = Counter(
            it.system
            for it in items
            if len(it.system) >= ANTHROPIC_EPHEMERAL_CACHE_MIN_CHARS
        )
        shared_prefixes = tuple(sys for sys, cnt in sys_counts.items() if cnt >= 2)

        chain = await self.resolve_provider_chain(
            requested_provider=payload.provider,
            task_type=effective_task_type,
            eu_only=any_eu_only,
        )

        # Stage normalized JSONL inside confined module data_dir (ProtectSystem=strict safe)
        staged_rel = f"inputs/{job_id}.jsonl"
        staged_abs = self.ctx.security.data_dir.resolve_path(staged_rel)
        await asyncio.to_thread(_write_canonical_jsonl_sync, staged_abs, items)

        chosen_provider: BatchProviderName | None = None
        chosen_model = ""
        external_job_id: str | None = None
        errors: list[str] = []

        for idx, candidate in enumerate(chain):
            model_name = (
                payload.model.strip()
                if (idx == 0 and payload.model and payload.model.strip())
                else await self._default_model_for(candidate)
            )
            adapter = await self._build_adapter(candidate)
            try:
                res = await adapter.submit(
                    BatchSubmitPayload(
                        job_id=job_id,
                        provider=candidate,
                        model=model_name,
                        items=items,
                        eu_only=any_eu_only,
                        shared_long_system_prefixes=shared_prefixes,
                    )
                )
                chosen_provider = candidate
                chosen_model = model_name
                external_job_id = res.external_job_id
                break
            except (GdprBatchComplianceError, BatchPayloadLimitError):
                raise
            except BatchAdapterError as exc:
                errors.append(f"{candidate}: {exc.message}")
                self.ctx.logger.warning(
                    "Batch provider '%s' submit failed for %s: %s",
                    candidate,
                    job_id,
                    exc.message,
                )

        if chosen_provider is None or external_job_id is None:
            raise BatchAdapterError(
                "All configured batch providers failed: " + " | ".join(errors),
                code="BATCH_SUBMIT_FAILED",
                status_code=502,
            )

        now_iso = _now_iso(now_sec)

        def _insert(conn: sqlite3.Connection) -> BatchJobRecord:
            conn.execute(
                "INSERT INTO batch_jobs ("
                "id, provider, model, status, agent_id, session_id, external_job_id, "
                "input_ref, output_ref, request_count, completed_count, input_tokens, "
                "output_tokens, cost_usd, qa_sampled, qa_status, error_message, "
                "created_at, updated_at, completed_at"
                ") VALUES (?, ?, ?, 'submitted', ?, ?, ?, ?, NULL, ?, 0, 0, 0, 0.0, 0, NULL, "
                "NULL, ?, ?, NULL)",
                (
                    job_id,
                    chosen_provider,
                    chosen_model,
                    payload.agent_id,
                    payload.session_id,
                    external_job_id,
                    staged_rel,
                    len(items),
                    now_iso,
                    now_iso,
                ),
            )
            row = conn.execute("SELECT * FROM batch_jobs WHERE id = ?", (job_id,)).fetchone()
            if row is None:  # pragma: no cover - immediate read after insert
                raise RuntimeError(f"Failed to reload inserted batch job '{job_id}'")
            return _row_to_job(row)

        return await self.ctx.db.write(_insert)

    async def get_job(self, job_id: str, *, poll: bool = False) -> BatchJobRecord:
        """Fetch a single batch job by ID, optionally polling remote provider if active."""

        def _fetch(conn: sqlite3.Connection) -> BatchJobRecord | None:
            row = conn.execute("SELECT * FROM batch_jobs WHERE id = ?", (job_id,)).fetchone()
            return _row_to_job(row) if row is not None else None

        job = await self.ctx.db.read(_fetch)
        if job is None:
            raise BatchNotFoundError(job_id)
        if poll and job.status in ("queued", "submitted", "running"):
            await self.poll_single_job(job.id)
            reloaded = await self.ctx.db.read(_fetch)
            if reloaded is not None:
                return reloaded
        return job

    async def list_jobs(
        self,
        *,
        status: BatchJobStatus | None = None,
        provider: BatchProviderName | None = None,
        limit: int = 20,
    ) -> list[BatchJobRecord]:
        """List batch jobs ordered newest-first with optional filters."""
        safe_limit = max(1, min(100, int(limit)))

        def _query(conn: sqlite3.Connection) -> list[BatchJobRecord]:
            clauses: list[str] = []
            params: list[Any] = []
            if status is not None:
                clauses.append("status = ?")
                params.append(status)
            if provider is not None:
                clauses.append("provider = ?")
                params.append(provider)
            where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
            params.append(safe_limit)
            rows = conn.execute(
                f"SELECT * FROM batch_jobs {where} ORDER BY created_at DESC LIMIT ?",  # noqa: S608
                params,
            ).fetchall()
            return [_row_to_job(r) for r in rows]

        return await self.ctx.db.read(_query)

    async def get_overview(
        self,
        *,
        status: BatchJobStatus | None = None,
        provider: BatchProviderName | None = None,
        limit: int = 20,
    ) -> BatchOverviewResponse:
        """Build CostOps savings KPIs, 4-provider readiness breakdown, and filtered job list."""

        def _fetch_all(conn: sqlite3.Connection) -> list[BatchJobRecord]:
            rows = conn.execute("SELECT * FROM batch_jobs ORDER BY created_at DESC").fetchall()
            return [_row_to_job(r) for r in rows]

        all_jobs = await self.ctx.db.read(_fetch_all)
        by_prov: dict[BatchProviderName, BatchProviderSummary] = {}
        for p in BATCH_PROVIDERS:
            by_prov[p] = BatchProviderSummary(
                provider=p,
                configured=await self.is_provider_configured(p),
            )

        active_batches = 0
        total_items = 0
        total_spent = 0.0
        total_saved = 0.0
        for job in all_jobs:
            if job.status in _ACTIVE_STATUSES:
                active_batches += 1
            total_items += job.completed_count
            total_spent += job.cost_usd
            total_saved += job.saved_cost_usd
            entry = by_prov[job.provider]
            entry.batch_count += 1
            entry.completed_items += job.completed_count
            entry.spent_usd = round(entry.spent_usd + job.cost_usd, 6)
            entry.saved_usd = round(entry.saved_usd + job.saved_cost_usd, 6)
            entry.baseline_usd = round(entry.baseline_usd + job.baseline_cost_usd, 6)

        filtered = [
            j
            for j in all_jobs
            if (status is None or j.status == status)
            and (provider is None or j.provider == provider)
        ][: max(1, min(100, int(limit)))]

        spent_round = round(total_spent, 6)
        saved_round = round(total_saved, 6)
        return BatchOverviewResponse(
            summary=BatchOverviewSummary(
                total_batches=len(all_jobs),
                active_batches=active_batches,
                total_items=total_items,
                total_spent_usd=spent_round,
                total_saved_usd=saved_round,
                total_baseline_usd=round(spent_round + saved_round, 6),
            ),
            by_provider=[by_prov[p] for p in BATCH_PROVIDERS],
            jobs=filtered,
        )

    async def cancel_job(self, job_id: str) -> BatchJobRecord:
        """Cancel an in-flight batch job via provider adapter and mark SQLite cancelled."""
        job = await self.get_job(job_id)
        if job.status in _TERMINAL_STATUSES:
            return job

        if job.external_job_id:
            adapter = await self._build_adapter(job.provider)
            await adapter.cancel(job.external_job_id)

        now_iso = _now_iso(self._clock())

        def _mark_cancelled(conn: sqlite3.Connection) -> BatchJobRecord:
            conn.execute(
                "UPDATE batch_jobs SET status = 'cancelled', updated_at = ?, completed_at = ? "
                "WHERE id = ?",
                (now_iso, now_iso, job_id),
            )
            row = conn.execute("SELECT * FROM batch_jobs WHERE id = ?", (job_id,)).fetchone()
            if row is None:  # pragma: no cover
                raise BatchNotFoundError(job_id)
            return _row_to_job(row)

        return await self.ctx.db.write(_mark_cancelled)

    async def recover_on_startup(self) -> dict[str, int]:
        """Recover crashed `downloading` rows back to `running` and clean temp files."""
        now_iso = _now_iso(self._clock())

        def _recover(conn: sqlite3.Connection) -> tuple[int, int]:
            cur = conn.execute(
                "UPDATE batch_jobs SET status = 'running', updated_at = ? "
                "WHERE status = 'downloading'",
                (now_iso,),
            )
            recovered = max(0, int(cur.rowcount))
            active_row = conn.execute(
                "SELECT COUNT(*) FROM batch_jobs "
                "WHERE status IN ('queued', 'submitted', 'running')"
            ).fetchone()
            active_count = int(active_row[0]) if active_row is not None else 0
            return recovered, active_count

        recovered_downloading, active_jobs = await self.ctx.db.write(_recover)
        cleaned_temps = await asyncio.to_thread(
            _cleanup_temp_files_sync,
            self.ctx.security.data_dir.base_dir,
        )
        return {
            "recovered_downloading": recovered_downloading,
            "active_jobs": active_jobs,
            "cleaned_temp_files": cleaned_temps,
        }

    async def poll_single_job(self, job_id: str, *, timeout_sec: float = 60.0) -> str:
        """Poll one active job with atomic DB lock, output persistence, CostOps & QA mark."""
        if job_id in self._in_flight_polls:
            return "skipped"
        self._in_flight_polls.add(job_id)
        try:
            job = await self.get_job(job_id)
            if job.status in _TERMINAL_STATUSES:
                return job.status
            if not job.external_job_id:
                now_iso = _now_iso(self._clock())
                await self.ctx.db.write(
                    lambda c: c.execute(
                        "UPDATE batch_jobs SET status = 'failed', "
                        "error_message = 'Missing external_job_id', "
                        "updated_at = ?, completed_at = ? WHERE id = ?",
                        (now_iso, now_iso, job.id),
                    )
                )
                return "failed"

            adapter = await self._build_adapter(job.provider, timeout_sec=timeout_sec)
            poll_res = await adapter.poll(job.external_job_id, job.model)
            now_sec = self._clock()
            now_iso = _now_iso(now_sec)

            if poll_res.status == "running":
                await self.ctx.db.write(
                    lambda c: c.execute(
                        "UPDATE batch_jobs SET status = 'running', completed_count = ?, "
                        "updated_at = ? WHERE id = ? "
                        "AND status IN ('queued', 'submitted', 'running')",
                        (poll_res.completed_count, now_iso, job.id),
                    )
                )
                return "running"

            def _acquire_download_lock(conn: sqlite3.Connection) -> bool:
                cur = conn.execute(
                    "UPDATE batch_jobs SET status = 'downloading', updated_at = ? "
                    "WHERE id = ? AND status IN ('queued', 'submitted', 'running')",
                    (now_iso, job.id),
                )
                return cur.rowcount == 1

            locked = await self.ctx.db.write(_acquire_download_lock)
            if not locked:
                return "skipped"

            output_rel: str | None = None
            qa_sampled = 0
            qa_status: str | None = None
            try:
                if poll_res.status == "completed":
                    output_rel = f"outputs/{job.id}.output.jsonl"
                    abs_out = self.ctx.security.data_dir.resolve_path(output_rel)
                    await asyncio.to_thread(
                        _write_output_jsonl_sync,
                        abs_out,
                        poll_res.output_items,
                    )
                    if poll_res.output_items or poll_res.completed_count > 0:
                        qa_sampled = 1
                        qa_status = "pending_qa"
                        if poll_res.output_items:
                            qa_rel = f"qa/{job.id}.sample.json"
                            qa_abs = self.ctx.security.data_dir.resolve_path(qa_rel)
                            await asyncio.to_thread(
                                _write_qa_sample_sync,
                                qa_abs,
                                job.id,
                                job.provider,
                                job.model,
                                poll_res.output_items,
                            )
            except Exception:
                revert_iso = _now_iso(self._clock())
                await self.ctx.db.write(
                    lambda c: c.execute(
                        "UPDATE batch_jobs SET status = 'running', updated_at = ? "
                        "WHERE id = ? AND status = 'downloading'",
                        (revert_iso, job.id),
                    )
                )
                raise

            final_status = poll_res.status

            def _finalize_job(conn: sqlite3.Connection) -> bool:
                cur = conn.execute(
                    "UPDATE batch_jobs SET "
                    "status = ?, output_ref = ?, completed_count = ?, input_tokens = ?, "
                    "output_tokens = ?, cost_usd = ?, qa_sampled = ?, qa_status = ?, "
                    "error_message = ?, updated_at = ?, completed_at = ? "
                    "WHERE id = ? AND status = 'downloading'",
                    (
                        final_status,
                        output_rel,
                        poll_res.completed_count,
                        poll_res.input_tokens,
                        poll_res.output_tokens,
                        poll_res.cost_usd,
                        qa_sampled,
                        qa_status,
                        poll_res.error_message,
                        now_iso,
                        now_iso,
                        job.id,
                    ),
                )
                return cur.rowcount == 1

            finalized = await self.ctx.db.write(_finalize_job)
            if finalized and final_status == "completed":
                has_tokens = (
                    poll_res.input_tokens > 0
                    or poll_res.output_tokens > 0
                    or poll_res.cache_read_tokens > 0
                    or poll_res.cache_creation_tokens > 0
                )
                if has_tokens:
                    await self.ctx.db.record_token_usage(
                        agent=job.agent_id,
                        session_id=job.session_id or f"batch:{job.id}",
                        timestamp_sec=int(now_sec),
                        input_tokens=poll_res.input_tokens,
                        output_tokens=poll_res.output_tokens,
                        cache_read_tokens=poll_res.cache_read_tokens,
                        cache_creation_tokens=poll_res.cache_creation_tokens,
                        thinking_tokens=0,
                        model=f"batch:{job.model}",
                        cost_usd=poll_res.cost_usd,
                        content_preview=(
                            f"Batch {job.id} ({poll_res.completed_count}/{job.request_count} ok)"
                        ),
                        tool_name="batch",
                    )
                elif poll_res.cost_usd > 0.0:
                    await self.ctx.record_compute_usage(
                        ComputeUsageRecord(
                            module_id=self.ctx.module_id,
                            agent=job.agent_id,
                            session_id=job.session_id or f"batch:{job.id}",
                            resource_label=f"batch:{job.provider}:{job.model}",
                            duration_sec=0.0,
                            cost_usd=poll_res.cost_usd,
                        )
                    )
            return final_status
        finally:
            self._in_flight_polls.discard(job_id)

    async def poll_active_jobs(self, *, now_ms: int | None = None) -> dict[str, Any]:
        """Non-blocking heartbeat sweep polling up to 25 active batch jobs (`Semaphore(3)`)."""
        del now_ms

        def _list_active_ids(conn: sqlite3.Connection) -> list[str]:
            rows = conn.execute(
                "SELECT id FROM batch_jobs "
                "WHERE status IN ('queued', 'submitted', 'running') "
                "ORDER BY updated_at ASC LIMIT 25"
            ).fetchall()
            return [str(r["id"]) for r in rows]

        active_ids = await self.ctx.db.read(_list_active_ids)
        sem = asyncio.Semaphore(3)

        async def _poll_one(jid: str) -> tuple[str, str | None, str | None]:
            async with sem:
                try:
                    outcome = await self.poll_single_job(jid, timeout_sec=20.0)
                    return jid, outcome, None
                except Exception as exc:
                    return jid, None, str(exc)

        results = await asyncio.gather(*(_poll_one(jid) for jid in active_ids))
        polled = 0
        completed = 0
        failed = 0
        cancelled = 0
        errors: list[dict[str, str]] = []

        for jid, outcome, err_msg in results:
            if err_msg is not None:
                errors.append({"job_id": jid, "error": err_msg})
                self.ctx.logger.warning("Heartbeat batch poll error for %s: %s", jid, err_msg)
                continue
            if outcome is not None and outcome != "skipped":
                polled += 1
            if outcome == "completed":
                completed += 1
            elif outcome == "failed":
                failed += 1
            elif outcome == "cancelled":
                cancelled += 1

        return {
            "polled": polled,
            "completed": completed,
            "failed": failed,
            "cancelled": cancelled,
            "errors": errors,
        }

    async def housekeep(
        self,
        *,
        retention_days: int,
        disk_used_pct: float,
    ) -> HousekeepingStats:
        """Prune expired batch work/output files under `ctx.security.data_dir` safely."""

        def _collect_active_refs(conn: sqlite3.Connection) -> frozenset[str]:
            rows = conn.execute(
                "SELECT input_ref, output_ref FROM batch_jobs "
                "WHERE status IN ('queued', 'submitted', 'running', 'downloading')"
            ).fetchall()
            refs: set[str] = set()
            for row in rows:
                in_ref = row["input_ref"]
                out_ref = row["output_ref"]
                if isinstance(in_ref, str) and in_ref:
                    refs.add(in_ref)
                if isinstance(out_ref, str) and out_ref:
                    refs.add(out_ref)
            return frozenset(refs)

        protected = await self.ctx.db.read(_collect_active_refs)
        now_sec = self._clock()
        safe_days = max(0, int(retention_days))
        cutoff_sec = now_sec - (safe_days * 86_400)
        tmp_cutoff_sec = now_sec - min(_TEMP_MAX_AGE_SECONDS, safe_days * 86_400 or 0)

        pruned_count, freed_bytes = await asyncio.to_thread(
            _prune_expired_files_sync,
            self.ctx.security.data_dir.base_dir,
            protected_rel_paths=protected,
            cutoff_sec=cutoff_sec,
            tmp_cutoff_sec=tmp_cutoff_sec,
        )
        return HousekeepingStats(
            module_id=self.ctx.module_id,
            deleted_rows=0,
            freed_bytes=freed_bytes,
            notes=(
                f"pruned {pruned_count} expired batch file(s) older than {safe_days}d "
                f"(disk={disk_used_pct:.1f}%)"
            ),
        )
