"""SDK-free async `httpx` Batch API adapters (`anthropic`, `gemini`, `vertex-eu`, `openai`)."""

from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from typing import Any, Final, Literal
from urllib.parse import quote

import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator

from alfred.core.gcp_auth import GcpAuthError, GcpTokenProvider, ServiceAccountCredentials
from alfred.core.model_router import is_eu_vertex_location
from alfred.kernel.errors import ModuleError

BatchProviderName = Literal["anthropic", "gemini", "vertex-eu", "openai"]
RequestedBatchProvider = Literal["auto", "anthropic", "gemini", "vertex-eu", "openai"]
BatchTaskType = Literal["code", "reasoning", "translation", "extraction", "general"]
BatchJobStatus = Literal[
    "queued",
    "submitted",
    "running",
    "downloading",
    "completed",
    "failed",
    "cancelled",
]

BATCH_PROVIDERS: Final[tuple[BatchProviderName, ...]] = (
    "anthropic",
    "gemini",
    "vertex-eu",
    "openai",
)

BATCH_DISCOUNT_MULTIPLIER: Final[float] = 0.5
CUSTOM_ID_RE: Final[re.Pattern[str]] = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
DEFAULT_MAX_ANTHROPIC_REQUESTS: Final[int] = 10_000
DEFAULT_MAX_ANTHROPIC_BYTES: Final[int] = 32 * 1024 * 1024
ANTHROPIC_EPHEMERAL_CACHE_MIN_CHARS: Final[int] = 4_096

DEFAULT_BATCH_MODELS: Final[dict[BatchProviderName, str]] = {
    "anthropic": "claude-sonnet-4-6",
    "gemini": "gemini-3.8-flash",
    "vertex-eu": "gemini-2.5-flash",
    "openai": "gpt-4o-mini",
}

# Baseline per-1M token USD rates: (input, output, cache_write, cache_read)
_MODEL_TOKEN_RATES_PER_M: Final[dict[str, tuple[float, float, float, float]]] = {
    "claude-sonnet-4-6": (3.00, 15.00, 3.75, 0.30),
    "claude-sonnet-4-20250514": (3.00, 15.00, 3.75, 0.30),
    "claude-3-5-sonnet-20241022": (3.00, 15.00, 3.75, 0.30),
    "claude-haiku-4-5": (0.80, 4.00, 1.00, 0.08),
    "claude-3-5-haiku-20241022": (0.80, 4.00, 1.00, 0.08),
    "claude-opus-4-6": (15.00, 75.00, 18.75, 1.50),
    "gemini-2.5-flash": (0.15, 0.60, 0.15, 0.0375),
    "gemini-3.8-flash": (0.15, 0.60, 0.15, 0.0375),
    "gemini-3.5-flash-lite": (0.075, 0.30, 0.075, 0.01875),
    "gemini-2.5-pro": (1.25, 10.00, 1.25, 0.3125),
    "gpt-4o": (2.50, 10.00, 2.50, 1.25),
    "gpt-4o-mini": (0.15, 0.60, 0.15, 0.075),
    "gpt-4.1": (2.00, 8.00, 2.00, 0.50),
    "gpt-4.1-mini": (0.40, 1.60, 0.40, 0.10),
}
_DEFAULT_RATES: Final[tuple[float, float, float, float]] = (0.50, 1.50, 0.50, 0.125)


class BatchAdapterError(ModuleError):
    """Base error raised by Batch API adapters or validation."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "BATCH_ADAPTER_ERROR",
        status_code: int = 502,
    ) -> None:
        super().__init__(
            message,
            code=code,
            module_id="batch-api",
            status_code=status_code,
        )


class GdprBatchComplianceError(BatchAdapterError):
    """Raised when `eu_only=True` or `vertex-eu` encounters a non-EU location/provider."""

    def __init__(self, message: str) -> None:
        super().__init__(
            message,
            code="GDPR_EU_ONLY_BATCH_ERROR",
            status_code=403,
        )


class BatchPayloadLimitError(BatchAdapterError):
    """Raised when a batch request exceeds provider item count or byte limits."""

    def __init__(self, message: str) -> None:
        super().__init__(
            message,
            code="BATCH_PAYLOAD_TOO_LARGE",
            status_code=400,
        )


class BatchProviderAuthError(BatchAdapterError):
    """Raised when provider credentials or token exchange fail."""

    def __init__(self, message: str) -> None:
        super().__init__(
            message,
            code="BATCH_AUTH_ERROR",
            status_code=400,
        )


class CanonicalBatchRequestItem(BaseModel):
    """Strict canonical JSONL input item shared across all 4 batch adapters."""

    model_config = ConfigDict(extra="forbid")

    custom_id: str = Field(min_length=1, max_length=64)
    prompt: str = Field(min_length=1)
    system: str = ""
    max_tokens: int = Field(default=1024, ge=1, le=32_768)
    task_type: BatchTaskType = "general"
    eu_only: bool = False

    @field_validator("custom_id")
    @classmethod
    def _validate_custom_id(cls, value: str) -> str:
        stripped = value.strip()
        if not CUSTOM_ID_RE.match(stripped):
            raise ValueError("custom_id must match ^[a-zA-Z0-9_-]{1,64}$")
        return stripped

    @field_validator("prompt")
    @classmethod
    def _validate_prompt(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("prompt must not be blank")
        return value


class CanonicalBatchOutputItem(BaseModel):
    """Normalized per-item batch response written to output JSONL."""

    model_config = ConfigDict(extra="forbid")

    custom_id: str
    status: Literal["ok", "error"]
    text: str = ""
    error: str | None = None
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    cache_read_tokens: int = Field(default=0, ge=0)
    cache_creation_tokens: int = Field(default=0, ge=0)
    cost_usd: float = Field(default=0.0, ge=0.0)


class BatchSubmitPayload(BaseModel):
    """Adapter submission input DTO."""

    model_config = ConfigDict(extra="forbid")

    job_id: str = Field(min_length=1)
    provider: BatchProviderName
    model: str = Field(min_length=1)
    items: list[CanonicalBatchRequestItem] = Field(min_length=1)
    eu_only: bool = False
    shared_long_system_prefixes: tuple[str, ...] = ()


class AdapterSubmitResult(BaseModel):
    """Structured submission outcome returned by every provider adapter."""

    model_config = ConfigDict(extra="forbid")

    provider: BatchProviderName
    model: str
    external_job_id: str
    status: BatchJobStatus = "submitted"


class AdapterPollResult(BaseModel):
    """Structured poll outcome returned by every provider adapter."""

    model_config = ConfigDict(extra="forbid")

    status: Literal["running", "completed", "failed", "cancelled"]
    completed_count: int = Field(default=0, ge=0)
    failed_count: int = Field(default=0, ge=0)
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    cache_read_tokens: int = Field(default=0, ge=0)
    cache_creation_tokens: int = Field(default=0, ge=0)
    cost_usd: float = Field(default=0.0, ge=0.0)
    output_items: list[CanonicalBatchOutputItem] = Field(default_factory=list)
    error_message: str | None = None


class AdapterCancelResult(BaseModel):
    """Structured cancellation outcome returned by every provider adapter."""

    model_config = ConfigDict(extra="forbid")

    external_job_id: str
    cancelled: bool
    status: BatchJobStatus
    detail: str = ""


def compute_batch_cost_usd(
    model: str,
    input_tokens: int,
    output_tokens: int,
    *,
    cache_read_tokens: int = 0,
    cache_creation_tokens: int = 0,
) -> tuple[float, float, float]:
    """Compute `(batch_cost_usd, baseline_cost_usd, saved_cost_usd)` with 0.5x discount."""
    safe_in = max(0, input_tokens)
    safe_out = max(0, output_tokens)
    safe_cr = max(0, cache_read_tokens)
    safe_cw = max(0, cache_creation_tokens)
    if safe_in == 0 and safe_out == 0 and safe_cr == 0 and safe_cw == 0:
        return 0.0, 0.0, 0.0

    in_rate, out_rate, cw_rate, cr_rate = _MODEL_TOKEN_RATES_PER_M.get(model, _DEFAULT_RATES)
    baseline = (
        (safe_in * in_rate)
        + (safe_out * out_rate)
        + (safe_cw * cw_rate)
        + (safe_cr * cr_rate)
    ) / 1_000_000.0
    batch_cost = round(baseline * BATCH_DISCOUNT_MULTIPLIER, 6)
    baseline_rounded = round(baseline, 6)
    saved = round(max(0.0, baseline_rounded - batch_cost), 6)
    return batch_cost, baseline_rounded, saved


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_int(value: object, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return default
    return default


def _as_str(value: object, default: str = "") -> str:
    return value if isinstance(value, str) else default


def _aggregate_poll_items(
    model: str,
    output_items: list[CanonicalBatchOutputItem],
) -> tuple[int, int, int, int, int, int, float]:
    completed = sum(1 for item in output_items if item.status == "ok")
    failed = sum(1 for item in output_items if item.status == "error")
    in_tok = sum(item.input_tokens for item in output_items)
    out_tok = sum(item.output_tokens for item in output_items)
    cr_tok = sum(item.cache_read_tokens for item in output_items)
    cw_tok = sum(item.cache_creation_tokens for item in output_items)
    total_cost, _, _ = compute_batch_cost_usd(
        model,
        in_tok,
        out_tok,
        cache_read_tokens=cr_tok,
        cache_creation_tokens=cw_tok,
    )
    return completed, failed, in_tok, out_tok, cr_tok, cw_tok, total_cost


class BaseBatchAdapter(ABC):
    """Abstract async `httpx` interface implemented by all 4 batch adapters."""

    provider_id: BatchProviderName

    def __init__(self, *, http_client: httpx.AsyncClient | None = None) -> None:
        self._http_client = http_client

    async def _request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        json_body: dict[str, Any] | None = None,
        content: bytes | None = None,
        data: dict[str, str] | None = None,
        files: dict[str, tuple[str, bytes, str]] | None = None,
    ) -> httpx.Response:
        owns_client = self._http_client is None
        client = self._http_client or httpx.AsyncClient(timeout=60.0)
        try:
            return await client.request(
                method,
                url,
                headers=headers,
                json=json_body,
                content=content,
                data=data,
                files=files,
            )
        except httpx.HTTPError as exc:
            raise BatchAdapterError(
                f"{self.provider_id} HTTP request failed: {exc}",
                code="BATCH_HTTP_ERROR",
                status_code=502,
            ) from exc
        finally:
            if owns_client:
                await client.aclose()

    @abstractmethod
    async def submit(self, payload: BatchSubmitPayload) -> AdapterSubmitResult:
        """Submit canonical batch items to the remote provider."""

    @abstractmethod
    async def poll(self, external_job_id: str, model: str) -> AdapterPollResult:
        """Poll remote batch status and download outputs when ready."""

    @abstractmethod
    async def cancel(self, external_job_id: str) -> AdapterCancelResult:
        """Cancel an in-flight remote batch job."""


class AnthropicBatchAdapter(BaseBatchAdapter):
    """Anthropic Messages Batches API adapter (`/v1/messages/batches`)."""

    provider_id: BatchProviderName = "anthropic"

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = "https://api.anthropic.com",
        http_client: httpx.AsyncClient | None = None,
        max_requests: int = DEFAULT_MAX_ANTHROPIC_REQUESTS,
        max_bytes: int = DEFAULT_MAX_ANTHROPIC_BYTES,
    ) -> None:
        super().__init__(http_client=http_client)
        clean_key = api_key.strip()
        if not clean_key:
            raise BatchProviderAuthError("ANTHROPIC_API_KEY is missing")
        self._api_key = clean_key
        self._base_url = base_url.rstrip("/")
        self._max_requests = max_requests
        self._max_bytes = max_bytes

    def _headers(self, *, with_json: bool = True) -> dict[str, str]:
        hdrs = {
            "x-api-key": self._api_key,
            "anthropic-version": "2023-06-01",
        }
        if with_json:
            hdrs["Content-Type"] = "application/json"
        return hdrs

    def build_request_item(
        self,
        item: CanonicalBatchRequestItem,
        model: str,
        shared_long_prefixes: frozenset[str],
    ) -> dict[str, Any]:
        """Convert canonical item to Anthropic Batch entry with ephemeral caching."""
        params: dict[str, Any] = {
            "model": model,
            "max_tokens": item.max_tokens,
            "messages": [{"role": "user", "content": item.prompt}],
        }
        if item.system.strip():
            use_cache = (
                len(item.system) >= ANTHROPIC_EPHEMERAL_CACHE_MIN_CHARS
                and item.system in shared_long_prefixes
            )
            block: dict[str, Any] = {"type": "text", "text": item.system}
            if use_cache:
                block["cache_control"] = {"type": "ephemeral"}
            params["system"] = [block]
        return {"custom_id": item.custom_id, "params": params}

    async def submit(self, payload: BatchSubmitPayload) -> AdapterSubmitResult:
        if len(payload.items) > self._max_requests:
            raise BatchPayloadLimitError(
                f"Anthropic batch limit exceeded: {len(payload.items)} > {self._max_requests}"
            )
        prefixes = frozenset(payload.shared_long_system_prefixes)
        requests: list[dict[str, Any]] = []
        approx_bytes = 20
        for item in payload.items:
            entry = self.build_request_item(item, payload.model, prefixes)
            approx_bytes += len(json.dumps(entry).encode("utf-8")) + 2
            if approx_bytes > self._max_bytes:
                raise BatchPayloadLimitError(
                    f"Anthropic batch payload exceeds {self._max_bytes} byte limit"
                )
            requests.append(entry)

        resp = await self._request(
            "POST",
            f"{self._base_url}/v1/messages/batches",
            headers=self._headers(with_json=True),
            json_body={"requests": requests},
        )
        if resp.status_code >= 400:
            raise BatchAdapterError(
                f"Anthropic Batches submit error {resp.status_code}: {resp.text[:240]}"
            )
        data = _as_dict(resp.json())
        batch_id = _as_str(data.get("id"))
        if not batch_id:
            raise BatchAdapterError("Anthropic Batches API returned no batch id")
        return AdapterSubmitResult(
            provider="anthropic",
            model=payload.model,
            external_job_id=batch_id,
            status="submitted",
        )

    async def poll(self, external_job_id: str, model: str) -> AdapterPollResult:
        resp = await self._request(
            "GET",
            f"{self._base_url}/v1/messages/batches/{quote(external_job_id, safe='')}",
            headers=self._headers(with_json=False),
        )
        if resp.status_code >= 400:
            raise BatchAdapterError(
                f"Anthropic Batches poll error {resp.status_code}: {resp.text[:240]}"
            )
        data = _as_dict(resp.json())
        counts = _as_dict(data.get("request_counts"))
        succeeded = _as_int(counts.get("succeeded"))
        errored = _as_int(counts.get("errored")) + _as_int(counts.get("expired"))
        canceled = _as_int(counts.get("canceled"))

        if _as_str(data.get("processing_status")) != "ended":
            return AdapterPollResult(
                status="running",
                completed_count=succeeded,
                failed_count=errored,
            )

        results_url = _as_str(data.get("results_url"))
        if not results_url:
            if canceled > 0 and succeeded == 0:
                return AdapterPollResult(
                    status="cancelled",
                    completed_count=0,
                    failed_count=canceled,
                )
            return AdapterPollResult(
                status="failed",
                error_message="Anthropic batch ended without results_url",
            )

        res_resp = await self._request(
            "GET",
            results_url,
            headers=self._headers(with_json=False),
        )
        if res_resp.status_code >= 400:
            raise BatchAdapterError(
                f"Anthropic results download error {res_resp.status_code}"
            )

        output_items: list[CanonicalBatchOutputItem] = []
        for raw_line in res_resp.text.splitlines():
            trimmed = raw_line.strip()
            if not trimmed:
                continue
            row = _as_dict(json.loads(trimmed))
            cid = _as_str(row.get("custom_id"), "unknown")
            result = _as_dict(row.get("result"))
            rtype = _as_str(result.get("type"))
            if rtype == "succeeded":
                msg = _as_dict(result.get("message"))
                blocks = _as_list(msg.get("content"))
                text = "\n".join(
                    _as_str(_as_dict(b).get("text"))
                    for b in blocks
                    if _as_str(_as_dict(b).get("type")) == "text"
                    and isinstance(_as_dict(b).get("text"), str)
                )
                usage = _as_dict(msg.get("usage"))
                in_tok = _as_int(usage.get("input_tokens"))
                out_tok = _as_int(usage.get("output_tokens"))
                cw_tok = _as_int(usage.get("cache_creation_input_tokens"))
                cr_tok = _as_int(usage.get("cache_read_input_tokens"))
                item_cost, _, _ = compute_batch_cost_usd(
                    model,
                    in_tok,
                    out_tok,
                    cache_read_tokens=cr_tok,
                    cache_creation_tokens=cw_tok,
                )
                output_items.append(
                    CanonicalBatchOutputItem(
                        custom_id=cid,
                        status="ok",
                        text=text,
                        input_tokens=in_tok,
                        output_tokens=out_tok,
                        cache_read_tokens=cr_tok,
                        cache_creation_tokens=cw_tok,
                        cost_usd=item_cost,
                    )
                )
            else:
                err_obj = _as_dict(result.get("error"))
                output_items.append(
                    CanonicalBatchOutputItem(
                        custom_id=cid,
                        status="error",
                        error=_as_str(err_obj.get("message")) or rtype or "unknown_error",
                    )
                )

        comp, fail, in_t, out_t, cr_t, cw_t, tot_cost = _aggregate_poll_items(model, output_items)
        return AdapterPollResult(
            status="completed",
            completed_count=comp,
            failed_count=fail,
            input_tokens=in_t,
            output_tokens=out_t,
            cache_read_tokens=cr_t,
            cache_creation_tokens=cw_t,
            cost_usd=tot_cost,
            output_items=output_items,
        )

    async def cancel(self, external_job_id: str) -> AdapterCancelResult:
        resp = await self._request(
            "POST",
            f"{self._base_url}/v1/messages/batches/{quote(external_job_id, safe='')}/cancel",
            headers=self._headers(with_json=False),
        )
        if resp.status_code >= 400 and resp.status_code not in (404, 409):
            raise BatchAdapterError(
                f"Anthropic Batches cancel error {resp.status_code}: {resp.text[:200]}"
            )
        return AdapterCancelResult(
            external_job_id=external_job_id,
            cancelled=True,
            status="cancelled",
            detail=f"HTTP {resp.status_code}",
        )


def _build_google_batch_request(item: CanonicalBatchRequestItem) -> dict[str, Any]:
    is_reasoning = item.task_type == "reasoning"
    gen_cfg: dict[str, Any] = {
        "maxOutputTokens": max(item.max_tokens, 2048) if is_reasoning else item.max_tokens,
    }
    if not is_reasoning:
        gen_cfg["thinkingConfig"] = {"thinkingBudget": 0}
    request: dict[str, Any] = {
        "contents": [{"role": "user", "parts": [{"text": item.prompt}]}],
        "generationConfig": gen_cfg,
    }
    if item.system.strip():
        request["systemInstruction"] = {"parts": [{"text": item.system}]}
    return request


def _parse_google_prediction_row(
    row: dict[str, Any],
    *,
    model: str,
    id_key: str,
) -> CanonicalBatchOutputItem:
    cid = _as_str(row.get(id_key)) or _as_str(row.get("custom_id")) or "unknown"
    err_raw = row.get("error")
    status_str = _as_str(row.get("status"))
    if isinstance(err_raw, dict):
        return CanonicalBatchOutputItem(
            custom_id=cid,
            status="error",
            error=_as_str(err_raw.get("message"), "google_batch_item_error"),
        )
    if status_str.strip():
        return CanonicalBatchOutputItem(
            custom_id=cid,
            status="error",
            error=status_str.strip(),
        )

    response = _as_dict(row.get("response"))
    candidates = _as_list(response.get("candidates"))
    first_cand = _as_dict(candidates[0]) if candidates else {}
    parts = _as_list(_as_dict(first_cand.get("content")).get("parts"))
    text = "\n".join(_as_str(_as_dict(p).get("text")) for p in parts).strip()

    usage = _as_dict(response.get("usageMetadata"))
    cached = _as_int(usage.get("cachedContentTokenCount"))
    prompt_tokens = _as_int(usage.get("promptTokenCount"))
    uncached_in = max(0, prompt_tokens - cached)
    out_tok = _as_int(usage.get("candidatesTokenCount"))
    item_cost, _, _ = compute_batch_cost_usd(
        model,
        uncached_in,
        out_tok,
        cache_read_tokens=cached,
    )
    return CanonicalBatchOutputItem(
        custom_id=cid,
        status="ok",
        text=text,
        input_tokens=uncached_in,
        output_tokens=out_tok,
        cache_read_tokens=cached,
        cost_usd=item_cost,
    )


class GeminiBatchAdapter(BaseBatchAdapter):
    """Google Gemini Batch API adapter (`generativelanguage.googleapis.com`)."""

    provider_id: BatchProviderName = "gemini"

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = "https://generativelanguage.googleapis.com",
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        super().__init__(http_client=http_client)
        clean_key = api_key.strip()
        if not clean_key:
            raise BatchProviderAuthError("GEMINI_API_KEY is missing")
        self._api_key = clean_key
        self._base_url = base_url.rstrip("/")

    def _to_gemini_jsonl(self, items: list[CanonicalBatchRequestItem]) -> bytes:
        lines = [
            json.dumps({"key": item.custom_id, "request": _build_google_batch_request(item)})
            for item in items
        ]
        return ("\n".join(lines) + "\n").encode("utf-8")

    async def submit(self, payload: BatchSubmitPayload) -> AdapterSubmitResult:
        jsonl_bytes = self._to_gemini_jsonl(payload.items)
        upload_resp = await self._request(
            "POST",
            f"{self._base_url}/upload/v1beta/files",
            headers={
                "x-goog-api-key": self._api_key,
                "X-Goog-Upload-Protocol": "raw",
                "X-Goog-Upload-Command": "start, upload, finalize",
                "X-Goog-Upload-Header-Content-Type": "application/jsonl",
                "Content-Type": "application/jsonl",
            },
            content=jsonl_bytes,
        )
        if upload_resp.status_code >= 400:
            raise BatchAdapterError(
                f"Gemini File upload error {upload_resp.status_code}: {upload_resp.text[:240]}"
            )
        upload_data = _as_dict(upload_resp.json())
        file_obj = _as_dict(upload_data.get("file"))
        file_name = _as_str(file_obj.get("name")) or _as_str(upload_data.get("name"))
        if not file_name:
            raise BatchAdapterError("Gemini File upload returned no file.name")

        batch_resp = await self._request(
            "POST",
            f"{self._base_url}/v1beta/models/{quote(payload.model, safe='')}:batchGenerateContent",
            headers={
                "x-goog-api-key": self._api_key,
                "Content-Type": "application/json",
            },
            json_body={
                "batch": {
                    "display_name": f"alfred-batch-{payload.job_id}",
                    "input_config": {"file_name": file_name},
                }
            },
        )
        if batch_resp.status_code >= 400:
            raise BatchAdapterError(
                f"Gemini batchGenerateContent error {batch_resp.status_code}: "
                f"{batch_resp.text[:240]}"
            )
        batch_data = _as_dict(batch_resp.json())
        batch_name = _as_str(batch_data.get("name"))
        if not batch_name:
            raise BatchAdapterError("Gemini batchGenerateContent returned no batch name")
        return AdapterSubmitResult(
            provider="gemini",
            model=payload.model,
            external_job_id=batch_name,
            status="submitted",
        )

    async def poll(self, external_job_id: str, model: str) -> AdapterPollResult:
        clean_id = external_job_id.lstrip("/")
        resp = await self._request(
            "GET",
            f"{self._base_url}/v1beta/{clean_id}",
            headers={"x-goog-api-key": self._api_key},
        )
        if resp.status_code >= 400:
            raise BatchAdapterError(
                f"Gemini batch poll error {resp.status_code}: {resp.text[:240]}"
            )
        data = _as_dict(resp.json())
        metadata = _as_dict(data.get("metadata"))
        state = _as_str(metadata.get("state"))
        err_obj = _as_dict(data.get("error"))

        if state == "BATCH_STATE_CANCELLED":
            return AdapterPollResult(status="cancelled")
        if state == "BATCH_STATE_FAILED" or err_obj:
            return AdapterPollResult(
                status="failed",
                error_message=_as_str(err_obj.get("message")) or f"Gemini batch failed ({state})",
            )
        if not bool(data.get("done")) and state != "BATCH_STATE_SUCCEEDED":
            stats = _as_dict(metadata.get("batchStats"))
            return AdapterPollResult(
                status="running",
                completed_count=_as_int(stats.get("successfulRequestCount")),
                failed_count=_as_int(stats.get("failedRequestCount")),
            )

        response = _as_dict(data.get("response"))
        output_file = _as_str(response.get("responsesFile")) or _as_str(
            response.get("output_file_name")
        )
        if not output_file:
            return AdapterPollResult(
                status="failed",
                error_message="Gemini batch completed without responsesFile",
            )

        clean_out = output_file.lstrip("/")
        dl_resp = await self._request(
            "GET",
            f"{self._base_url}/download/v1beta/{clean_out}:download?alt=media",
            headers={"x-goog-api-key": self._api_key},
        )
        if dl_resp.status_code >= 400:
            raise BatchAdapterError(f"Gemini batch output download error {dl_resp.status_code}")

        output_items: list[CanonicalBatchOutputItem] = []
        for raw_line in dl_resp.text.splitlines():
            trimmed = raw_line.strip()
            if not trimmed:
                continue
            row = _as_dict(json.loads(trimmed))
            output_items.append(_parse_google_prediction_row(row, model=model, id_key="key"))

        comp, fail, in_t, out_t, cr_t, cw_t, tot_cost = _aggregate_poll_items(model, output_items)
        return AdapterPollResult(
            status="completed",
            completed_count=comp,
            failed_count=fail,
            input_tokens=in_t,
            output_tokens=out_t,
            cache_read_tokens=cr_t,
            cache_creation_tokens=cw_t,
            cost_usd=tot_cost,
            output_items=output_items,
        )

    async def cancel(self, external_job_id: str) -> AdapterCancelResult:
        clean_id = external_job_id.lstrip("/")
        resp = await self._request(
            "POST",
            f"{self._base_url}/v1beta/{clean_id}:cancel",
            headers={"x-goog-api-key": self._api_key},
        )
        if resp.status_code >= 400 and resp.status_code not in (404, 409):
            raise BatchAdapterError(
                f"Gemini batch cancel error {resp.status_code}: {resp.text[:200]}"
            )
        return AdapterCancelResult(
            external_job_id=external_job_id,
            cancelled=True,
            status="cancelled",
            detail=f"HTTP {resp.status_code}",
        )


def _assert_eu_vertex_location(location: str) -> str:
    clean = location.strip()
    if not is_eu_vertex_location(clean):
        raise GdprBatchComplianceError(
            f"Vertex EU batch adapter requires an 'europe-*' region, got '{location}'"
        )
    return clean


class VertexEuBatchAdapter(BaseBatchAdapter):
    """GDPR-strict Vertex AI EU batch adapter (`GcpTokenProvider` + `batchPredictionJobs`)."""

    provider_id: BatchProviderName = "vertex-eu"

    def __init__(
        self,
        *,
        bucket: str,
        location: str = "europe-central2",
        project_id: str | None = None,
        token_provider: GcpTokenProvider | None = None,
        credentials: ServiceAccountCredentials | None = None,
        access_token: str | None = None,
        http_client: httpx.AsyncClient | None = None,
        gcs_base_url: str = "https://storage.googleapis.com",
        vertex_base_url: str | None = None,
        verify_bucket_location: bool = False,
    ) -> None:
        super().__init__(http_client=http_client)
        self._location = _assert_eu_vertex_location(location)
        clean_bucket = bucket.strip().removeprefix("gs://").strip("/")
        if not clean_bucket:
            raise BatchProviderAuthError("VERTEX_EU_BATCH_BUCKET is required for vertex-eu")
        self._bucket = clean_bucket

        resolved_tp = token_provider
        if resolved_tp is None and credentials is not None:
            resolved_tp = GcpTokenProvider(credentials, http_client=http_client)
        self._token_provider = resolved_tp
        self._static_access_token = access_token.strip() if access_token else None

        resolved_project = (
            (project_id or "").strip()
            or (resolved_tp.credentials.project_id if resolved_tp else None)
            or ""
        )
        if not resolved_project:
            raise BatchProviderAuthError("GCP project_id is required for vertex-eu")
        self._project_id = resolved_project

        if self._token_provider is None and not self._static_access_token:
            raise BatchProviderAuthError(
                "Vertex EU requires configured GcpTokenProvider or ServiceAccountCredentials"
            )

        self._gcs_base_url = gcs_base_url.rstrip("/")
        self._vertex_base_url = (
            vertex_base_url.rstrip("/")
            if vertex_base_url is not None
            else f"https://{self._location}-aiplatform.googleapis.com"
        )
        self._verify_bucket_location = verify_bucket_location

    async def _get_bearer_token(self) -> str:
        _assert_eu_vertex_location(self._location)
        if self._token_provider is not None:
            try:
                return await self._token_provider.get_access_token()
            except GcpAuthError as exc:
                raise BatchProviderAuthError(f"Vertex EU OAuth2 failed: {exc}") from exc
        if self._static_access_token:
            return self._static_access_token
        raise BatchProviderAuthError("No Vertex EU authentication credentials configured")

    async def _verify_gcs_bucket_eu(self, token: str) -> None:
        resp = await self._request(
            "GET",
            f"{self._gcs_base_url}/storage/v1/b/{quote(self._bucket, safe='')}?fields=location",
            headers={"Authorization": f"Bearer {token}"},
        )
        if resp.status_code >= 400:
            raise GdprBatchComplianceError(
                f"Failed to verify GCS bucket '{self._bucket}' location (HTTP {resp.status_code})"
            )
        loc = _as_str(_as_dict(resp.json()).get("location")).strip().lower()
        if loc != "eu" and not is_eu_vertex_location(loc):
            raise GdprBatchComplianceError(
                f"GCS bucket '{self._bucket}' is in non-EU location '{loc or 'unknown'}'"
            )

    def _to_vertex_jsonl(self, items: list[CanonicalBatchRequestItem]) -> bytes:
        lines = [
            json.dumps({"custom_id": item.custom_id, "request": _build_google_batch_request(item)})
            for item in items
        ]
        return ("\n".join(lines) + "\n").encode("utf-8")

    async def submit(self, payload: BatchSubmitPayload) -> AdapterSubmitResult:
        location = _assert_eu_vertex_location(self._location)
        token = await self._get_bearer_token()
        if self._verify_bucket_location:
            await self._verify_gcs_bucket_eu(token)

        object_name = f"alfred-batch/{payload.job_id}/input.jsonl"
        output_prefix = f"alfred-batch/{payload.job_id}/output/"
        jsonl_bytes = self._to_vertex_jsonl(payload.items)

        upload_resp = await self._request(
            "POST",
            f"{self._gcs_base_url}/upload/storage/v1/b/{quote(self._bucket, safe='')}/o"
            f"?uploadType=media&name={quote(object_name, safe='')}",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/jsonl",
            },
            content=jsonl_bytes,
        )
        if upload_resp.status_code >= 400:
            raise BatchAdapterError(
                f"Vertex EU GCS upload error {upload_resp.status_code}: {upload_resp.text[:240]}"
            )

        job_url = (
            f"{self._vertex_base_url}/v1/projects/{quote(self._project_id, safe='')}/"
            f"locations/{quote(location, safe='')}/batchPredictionJobs"
        )
        job_resp = await self._request(
            "POST",
            job_url,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            json_body={
                "displayName": f"alfred-batch-{payload.job_id}",
                "model": f"publishers/google/models/{payload.model}",
                "inputConfig": {
                    "instancesFormat": "jsonl",
                    "gcsSource": {"uris": [f"gs://{self._bucket}/{object_name}"]},
                },
                "outputConfig": {
                    "predictionsFormat": "jsonl",
                    "gcsDestination": {"outputUriPrefix": f"gs://{self._bucket}/{output_prefix}"},
                },
            },
        )
        if job_resp.status_code >= 400:
            raise BatchAdapterError(
                f"Vertex EU batchPredictionJobs error {job_resp.status_code}: "
                f"{job_resp.text[:240]}"
            )
        job_data = _as_dict(job_resp.json())
        job_name = _as_str(job_data.get("name"))
        if not job_name:
            raise BatchAdapterError("Vertex EU batchPredictionJobs returned no job name")
        return AdapterSubmitResult(
            provider="vertex-eu",
            model=payload.model,
            external_job_id=job_name,
            status="submitted",
        )

    async def poll(self, external_job_id: str, model: str) -> AdapterPollResult:
        _assert_eu_vertex_location(self._location)
        token = await self._get_bearer_token()
        clean_name = external_job_id.lstrip("/")
        resp = await self._request(
            "GET",
            f"{self._vertex_base_url}/v1/{clean_name}",
            headers={"Authorization": f"Bearer {token}"},
        )
        if resp.status_code >= 400:
            raise BatchAdapterError(
                f"Vertex EU batch poll error {resp.status_code}: {resp.text[:240]}"
            )
        data = _as_dict(resp.json())
        state = _as_str(data.get("state"))
        if state in ("JOB_STATE_CANCELLED", "JOB_STATE_CANCELLING"):
            return AdapterPollResult(status="cancelled")
        if state in ("JOB_STATE_FAILED", "JOB_STATE_EXPIRED"):
            err_obj = _as_dict(data.get("error"))
            return AdapterPollResult(
                status="failed",
                error_message=_as_str(err_obj.get("message")) or f"Vertex EU batch {state}",
            )
        if state != "JOB_STATE_SUCCEEDED":
            return AdapterPollResult(status="running")

        out_bucket = self._bucket
        prefix = ""
        output_info = _as_dict(data.get("outputInfo"))
        gcs_out_dir = _as_str(output_info.get("gcsOutputDirectory"))
        if gcs_out_dir.startswith("gs://"):
            without_scheme = gcs_out_dir.removeprefix("gs://")
            if "/" in without_scheme:
                out_bucket, raw_prefix = without_scheme.split("/", 1)
                prefix = raw_prefix.lstrip("/")
                if prefix and not prefix.endswith("/"):
                    prefix += "/"
        if not prefix:
            job_tail = clean_name.rsplit("/", 1)[-1]
            prefix = f"alfred-batch/{job_tail}/output/"

        list_resp = await self._request(
            "GET",
            f"{self._gcs_base_url}/storage/v1/b/{quote(out_bucket, safe='')}/o"
            f"?prefix={quote(prefix, safe='')}",
            headers={"Authorization": f"Bearer {token}"},
        )
        if list_resp.status_code >= 400:
            raise BatchAdapterError(
                f"Vertex EU GCS list output shards error {list_resp.status_code}"
            )
        items = _as_list(_as_dict(list_resp.json()).get("items"))
        shards = sorted(
            _as_str(_as_dict(it).get("name"))
            for it in items
            if _as_str(_as_dict(it).get("name")).endswith(".jsonl")
        )

        output_items: list[CanonicalBatchOutputItem] = []
        for shard_name in shards:
            dl_resp = await self._request(
                "GET",
                f"{self._gcs_base_url}/storage/v1/b/{quote(out_bucket, safe='')}/o/"
                f"{quote(shard_name, safe='')}?alt=media",
                headers={"Authorization": f"Bearer {token}"},
            )
            if dl_resp.status_code >= 400:
                raise BatchAdapterError(
                    f"Vertex EU GCS shard download error {dl_resp.status_code} for {shard_name}"
                )
            for raw_line in dl_resp.text.splitlines():
                trimmed = raw_line.strip()
                if not trimmed:
                    continue
                row = _as_dict(json.loads(trimmed))
                output_items.append(
                    _parse_google_prediction_row(row, model=model, id_key="custom_id")
                )

        comp, fail, in_t, out_t, cr_t, cw_t, tot_cost = _aggregate_poll_items(model, output_items)
        return AdapterPollResult(
            status="completed",
            completed_count=comp,
            failed_count=fail,
            input_tokens=in_t,
            output_tokens=out_t,
            cache_read_tokens=cr_t,
            cache_creation_tokens=cw_t,
            cost_usd=tot_cost,
            output_items=output_items,
        )

    async def cancel(self, external_job_id: str) -> AdapterCancelResult:
        _assert_eu_vertex_location(self._location)
        token = await self._get_bearer_token()
        clean_name = external_job_id.lstrip("/")
        resp = await self._request(
            "POST",
            f"{self._vertex_base_url}/v1/{clean_name}:cancel",
            headers={"Authorization": f"Bearer {token}"},
        )
        if resp.status_code >= 400 and resp.status_code not in (404, 409):
            raise BatchAdapterError(
                f"Vertex EU batch cancel error {resp.status_code}: {resp.text[:200]}"
            )
        return AdapterCancelResult(
            external_job_id=external_job_id,
            cancelled=True,
            status="cancelled",
            detail=f"HTTP {resp.status_code}",
        )


class OpenAiBatchAdapter(BaseBatchAdapter):
    """OpenAI Batch API adapter (`/v1/files` + `/v1/batches`)."""

    provider_id: BatchProviderName = "openai"

    def __init__(
        self,
        *,
        api_key: str,
        base_url: str = "https://api.openai.com/v1",
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        super().__init__(http_client=http_client)
        clean_key = api_key.strip()
        if not clean_key:
            raise BatchProviderAuthError("OPENAI_API_KEY is missing")
        self._api_key = clean_key
        self._base_url = base_url.rstrip("/")

    def _auth_headers(self, *, with_json: bool = False) -> dict[str, str]:
        hdrs = {"Authorization": f"Bearer {self._api_key}"}
        if with_json:
            hdrs["Content-Type"] = "application/json"
        return hdrs

    def _to_openai_jsonl(self, items: list[CanonicalBatchRequestItem], model: str) -> bytes:
        lines: list[str] = []
        for item in items:
            messages: list[dict[str, str]] = []
            if item.system.strip():
                messages.append({"role": "system", "content": item.system})
            messages.append({"role": "user", "content": item.prompt})
            lines.append(
                json.dumps(
                    {
                        "custom_id": item.custom_id,
                        "method": "POST",
                        "url": "/v1/chat/completions",
                        "body": {
                            "model": model,
                            "messages": messages,
                            "max_tokens": item.max_tokens,
                        },
                    }
                )
            )
        return ("\n".join(lines) + "\n").encode("utf-8")

    async def submit(self, payload: BatchSubmitPayload) -> AdapterSubmitResult:
        jsonl_bytes = self._to_openai_jsonl(payload.items, payload.model)
        upload_resp = await self._request(
            "POST",
            f"{self._base_url}/files",
            headers=self._auth_headers(),
            data={"purpose": "batch"},
            files={"file": (f"{payload.job_id}.jsonl", jsonl_bytes, "application/jsonl")},
        )
        if upload_resp.status_code >= 400:
            raise BatchAdapterError(
                f"OpenAI Files upload error {upload_resp.status_code}: {upload_resp.text[:240]}"
            )
        input_file_id = _as_str(_as_dict(upload_resp.json()).get("id"))
        if not input_file_id:
            raise BatchAdapterError("OpenAI Files API returned no file id")

        batch_resp = await self._request(
            "POST",
            f"{self._base_url}/batches",
            headers=self._auth_headers(with_json=True),
            json_body={
                "input_file_id": input_file_id,
                "endpoint": "/v1/chat/completions",
                "completion_window": "24h",
            },
        )
        if batch_resp.status_code >= 400:
            raise BatchAdapterError(
                f"OpenAI Batches create error {batch_resp.status_code}: {batch_resp.text[:240]}"
            )
        batch_id = _as_str(_as_dict(batch_resp.json()).get("id"))
        if not batch_id:
            raise BatchAdapterError("OpenAI Batches API returned no batch id")
        return AdapterSubmitResult(
            provider="openai",
            model=payload.model,
            external_job_id=batch_id,
            status="submitted",
        )

    def _parse_openai_jsonl(
        self,
        raw_text: str,
        *,
        model: str,
        force_error: bool,
        output_items: list[CanonicalBatchOutputItem],
    ) -> None:
        for raw_line in raw_text.splitlines():
            trimmed = raw_line.strip()
            if not trimmed:
                continue
            row = _as_dict(json.loads(trimmed))
            cid = _as_str(row.get("custom_id"), "unknown")
            row_err = _as_dict(row.get("error"))
            resp_obj = _as_dict(row.get("response"))
            status_code = _as_int(resp_obj.get("status_code"), 200)
            body = _as_dict(resp_obj.get("body"))
            body_err = _as_dict(body.get("error"))

            if force_error or row_err or status_code >= 400 or body_err:
                err_msg = (
                    _as_str(row_err.get("message"))
                    or _as_str(body_err.get("message"))
                    or f"HTTP {status_code}"
                )
                output_items.append(
                    CanonicalBatchOutputItem(
                        custom_id=cid,
                        status="error",
                        error=err_msg,
                    )
                )
                continue

            choices = _as_list(body.get("choices"))
            first_choice = _as_dict(choices[0]) if choices else {}
            text = _as_str(_as_dict(first_choice.get("message")).get("content"))
            usage = _as_dict(body.get("usage"))
            prompt_details = _as_dict(usage.get("prompt_tokens_details"))
            cached = _as_int(prompt_details.get("cached_tokens"))
            uncached_in = max(0, _as_int(usage.get("prompt_tokens")) - cached)
            out_tok = _as_int(usage.get("completion_tokens"))
            item_cost, _, _ = compute_batch_cost_usd(
                model,
                uncached_in,
                out_tok,
                cache_read_tokens=cached,
            )
            output_items.append(
                CanonicalBatchOutputItem(
                    custom_id=cid,
                    status="ok",
                    text=text,
                    input_tokens=uncached_in,
                    output_tokens=out_tok,
                    cache_read_tokens=cached,
                    cost_usd=item_cost,
                )
            )

    async def poll(self, external_job_id: str, model: str) -> AdapterPollResult:
        resp = await self._request(
            "GET",
            f"{self._base_url}/batches/{quote(external_job_id, safe='')}",
            headers=self._auth_headers(),
        )
        if resp.status_code >= 400:
            raise BatchAdapterError(
                f"OpenAI Batches poll error {resp.status_code}: {resp.text[:240]}"
            )
        data = _as_dict(resp.json())
        status = _as_str(data.get("status"))
        if status in ("cancelled", "cancelling"):
            return AdapterPollResult(status="cancelled")
        if status in ("validating", "in_progress", "finalizing"):
            counts = _as_dict(data.get("request_counts"))
            return AdapterPollResult(
                status="running",
                completed_count=_as_int(counts.get("completed")),
                failed_count=_as_int(counts.get("failed")),
            )

        output_items: list[CanonicalBatchOutputItem] = []
        output_file_id = _as_str(data.get("output_file_id"))
        error_file_id = _as_str(data.get("error_file_id"))

        if output_file_id:
            out_resp = await self._request(
                "GET",
                f"{self._base_url}/files/{quote(output_file_id, safe='')}/content",
                headers=self._auth_headers(),
            )
            if out_resp.status_code >= 400:
                raise BatchAdapterError(
                    f"OpenAI output file download error {out_resp.status_code}"
                )
            self._parse_openai_jsonl(
                out_resp.text,
                model=model,
                force_error=False,
                output_items=output_items,
            )

        if error_file_id:
            err_resp = await self._request(
                "GET",
                f"{self._base_url}/files/{quote(error_file_id, safe='')}/content",
                headers=self._auth_headers(),
            )
            if err_resp.status_code >= 400:
                raise BatchAdapterError(
                    f"OpenAI error file download error {err_resp.status_code}"
                )
            self._parse_openai_jsonl(
                err_resp.text,
                model=model,
                force_error=True,
                output_items=output_items,
            )

        if status == "failed" and not output_items:
            return AdapterPollResult(
                status="failed",
                error_message="OpenAI batch failed with no output items",
            )
        comp, fail, in_t, out_t, cr_t, cw_t, tot_cost = _aggregate_poll_items(model, output_items)
        if status == "expired" and comp == 0:
            return AdapterPollResult(
                status="failed",
                completed_count=0,
                failed_count=fail,
                output_items=output_items,
                error_message="OpenAI batch expired before completing any items",
            )

        return AdapterPollResult(
            status="completed",
            completed_count=comp,
            failed_count=fail,
            input_tokens=in_t,
            output_tokens=out_t,
            cache_read_tokens=cr_t,
            cache_creation_tokens=cw_t,
            cost_usd=tot_cost,
            output_items=output_items,
        )

    async def cancel(self, external_job_id: str) -> AdapterCancelResult:
        resp = await self._request(
            "POST",
            f"{self._base_url}/batches/{quote(external_job_id, safe='')}/cancel",
            headers=self._auth_headers(),
        )
        if resp.status_code >= 400 and resp.status_code not in (404, 409):
            raise BatchAdapterError(
                f"OpenAI Batches cancel error {resp.status_code}: {resp.text[:200]}"
            )
        return AdapterCancelResult(
            external_job_id=external_job_id,
            cancelled=True,
            status="cancelled",
            detail=f"HTTP {resp.status_code}",
        )
