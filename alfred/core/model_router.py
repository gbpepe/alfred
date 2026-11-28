"""Thin async `httpx` model router with GDPR `eu_only`, CostOps, and plugin delegation."""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from typing import Any, Final

import httpx

from alfred.core.agents_config import ResolvedAgent
from alfred.core.circuit_breaker import CircuitBreaker, TokenUsageRecord
from alfred.core.db import SqlitePool
from alfred.core.gcp_auth import GcpTokenProvider
from alfred.core.vault import VaultManager
from alfred.kernel.registry import ModuleRegistry
from alfred.kernel.types import (
    ModelProviderRequest,
    ModelProviderResponse,
    ProviderToolCall,
)

BUILTIN_PROVIDER_EU_COMPLIANCE: Final[dict[str, bool]] = {
    "vertex-eu": True,
    "deepseek": False,
    "gemini": False,
    "openai": False,
    "xai": False,
}

_OPENAI_COMPAT_ENDPOINTS: Final[dict[str, tuple[str, str]]] = {
    "deepseek": ("https://api.deepseek.com/v1/chat/completions", "DEEPSEEK_API_KEY"),
    "openai": ("https://api.openai.com/v1/chat/completions", "OPENAI_API_KEY"),
    "xai": ("https://api.x.ai/v1/chat/completions", "XAI_API_KEY"),
}

# Approximate per-1M-token USD rates (input, output) for CostOps estimation
_MODEL_RATES_PER_M: Final[dict[str, tuple[float, float]]] = {
    "deepseek-chat": (0.27, 1.10),
    "deepseek-reasoner": (0.55, 2.19),
    "gpt-4o": (2.50, 10.00),
    "gpt-4o-mini": (0.15, 0.60),
    "gemini-2.5-flash": (0.15, 0.60),
    "gemini-3.5-flash-lite": (0.075, 0.30),
    "gemini-3.8-flash": (0.15, 0.60),
    "grok-3": (3.00, 15.00),
}


class RouterError(Exception):
    """Base error raised by `ModelRouter`."""


class GdprComplianceError(RouterError):
    """Raised when an `eu_only=True` agent attempts to call a non-EU provider."""


class BudgetExceededError(RouterError):
    """Raised when `CircuitBreaker` rejects a call due to daily budget limits."""


class ProviderNotFoundError(RouterError):
    """Raised when neither built-in adapters nor active plugin providers match `provider_id`."""


def is_eu_vertex_location(location: str) -> bool:
    """Return True only when Vertex AI location targets an European (`europe-*`) region."""
    return location.strip().lower().startswith("europe-")


def estimate_cost_usd(model: str, input_tokens: int, output_tokens: int) -> float:
    """Estimate USD cost using per-1M token rates."""
    in_rate, out_rate = _MODEL_RATES_PER_M.get(model, (0.50, 1.50))
    return round((input_tokens * in_rate + output_tokens * out_rate) / 1_000_000.0, 6)


class ModelRouter:
    """Async SDK-free `httpx` router with GDPR gate, CircuitBreaker & plugin delegation."""

    def __init__(
        self,
        *,
        db: SqlitePool,
        circuit_breaker: CircuitBreaker,
        registry: ModuleRegistry | None = None,
        http_client: httpx.AsyncClient | None = None,
        vault: VaultManager | None = None,
        env_getter: Callable[[str], str | None] | None = None,
        gcp_token_provider: GcpTokenProvider | None = None,
        vertex_project_id: str | None = None,
        vertex_location: str = "europe-west1",
    ) -> None:
        self._db = db
        self._circuit_breaker = circuit_breaker
        self._registry = registry
        self._http_client = http_client
        self._vault = vault
        self._env_getter = env_getter or os.environ.get
        self._gcp_token_provider = gcp_token_provider
        self._vertex_project_id = vertex_project_id
        self._vertex_location = vertex_location.strip() or "europe-west1"

    def is_provider_eu_compliant(self, provider_id: str) -> bool:
        """Return whether `provider_id` is GDPR / EU-residency compliant."""
        if provider_id == "vertex-eu":
            return is_eu_vertex_location(self._vertex_location)
        if provider_id in BUILTIN_PROVIDER_EU_COMPLIANCE:
            return BUILTIN_PROVIDER_EU_COMPLIANCE[provider_id]
        plugin_provider = self._registry.get_provider(provider_id) if self._registry else None
        if plugin_provider is not None:
            return plugin_provider.eu_only_compliant
        return False

    async def _resolve_api_key(self, env_key: str) -> str:
        if self._vault is not None:
            secret = await self._vault.get_secret(env_key)
            if secret:
                return secret
        env_val = self._env_getter(env_key)
        if env_val:
            return env_val
        raise RouterError(f"Missing API credential '{env_key}' in Vault and environment")

    async def generate(
        self,
        *,
        resolved_agent: ResolvedAgent,
        global_budget_usd: float,
        request: ModelProviderRequest,
    ) -> ModelProviderResponse:
        """Route model inference through GDPR, budget, HTTP/plugin adapter, and CostOps."""
        provider_id = resolved_agent.effective_provider
        model = request.model or resolved_agent.effective_model

        is_builtin = provider_id in BUILTIN_PROVIDER_EU_COMPLIANCE
        plugin_provider = (
            self._registry.get_provider(provider_id)
            if (not is_builtin and self._registry is not None)
            else None
        )
        if not is_builtin and plugin_provider is None:
            raise ProviderNotFoundError(
                f"Provider '{provider_id}' is neither built-in nor registered by an active module"
            )

        if resolved_agent.config.eu_only and not self.is_provider_eu_compliant(provider_id):
            raise GdprComplianceError(
                f"Agent '{resolved_agent.config.id}' enforces eu_only=True, "
                f"blocked non-EU provider '{provider_id}'"
            )

        budget, reserved_usd = await self._circuit_breaker.reserve_budget(
            agent_id=resolved_agent.config.id,
            model=model,
            agent_daily_limit_usd=resolved_agent.config.daily_budget_usd,
            global_daily_limit_usd=global_budget_usd,
        )
        if not budget.allowed:
            raise BudgetExceededError(budget.reason)

        norm_request = request.model_copy(update={"model": model})
        try:
            if plugin_provider is not None:
                response = await plugin_provider.generate(norm_request)
            elif provider_id in _OPENAI_COMPAT_ENDPOINTS:
                response = await self._call_openai_compat(provider_id, norm_request)
            elif provider_id == "gemini":
                response = await self._call_gemini(norm_request)
            elif provider_id == "vertex-eu":
                response = await self._call_vertex_eu(norm_request)
            else:  # pragma: no cover - defensive fallback
                raise ProviderNotFoundError(f"Unsupported provider '{provider_id}'")

            computed_cost = (
                0.0
                if self._circuit_breaker.is_zero_cost_model(model)
                else (
                    response.cost_usd
                    if response.cost_usd > 0
                    else estimate_cost_usd(model, response.input_tokens, response.output_tokens)
                )
            )
            final_response = response.model_copy(update={"cost_usd": computed_cost})
            await self._circuit_breaker.record_token_usage(
                TokenUsageRecord(
                    agent=resolved_agent.config.id,
                    session_id=request.session_id,
                    model=model,
                    input_tokens=final_response.input_tokens,
                    output_tokens=final_response.output_tokens,
                    cache_read_tokens=final_response.cache_read_tokens,
                    cache_creation_tokens=final_response.cache_creation_tokens,
                    thinking_tokens=final_response.thinking_tokens,
                    cost_usd=final_response.cost_usd,
                    content_preview=(
                        final_response.content[:160] if final_response.content else None
                    ),
                )
            )
            return final_response
        finally:
            if reserved_usd > 0.0:
                await self._circuit_breaker.release_reservation(
                    resolved_agent.config.id,
                    reserved_usd,
                )

    async def _post_json(
        self,
        url: str,
        *,
        headers: dict[str, str],
        body: dict[str, Any],
    ) -> dict[str, Any]:
        owns_client = self._http_client is None
        client = self._http_client or httpx.AsyncClient(timeout=60.0)
        try:
            resp = await client.post(url, headers=headers, json=body)
        except httpx.HTTPError as exc:
            raise RouterError(f"Model HTTP request failed: {exc}") from exc
        finally:
            if owns_client:
                await client.aclose()
        if resp.status_code >= 400:
            raise RouterError(f"Provider returned HTTP {resp.status_code}: {resp.text[:300]}")
        parsed = resp.json()
        if not isinstance(parsed, dict):
            raise RouterError("Provider JSON payload is not an object")
        return parsed

    async def _call_openai_compat(
        self,
        provider_id: str,
        request: ModelProviderRequest,
    ) -> ModelProviderResponse:
        endpoint, env_key = _OPENAI_COMPAT_ENDPOINTS[provider_id]
        api_key = await self._resolve_api_key(env_key)
        messages: list[dict[str, Any]] = []
        if request.system_prompt:
            messages.append({"role": "system", "content": request.system_prompt})
        for msg in request.messages:
            item: dict[str, Any] = {"role": msg.role, "content": msg.content}
            if msg.tool_call_id:
                item["tool_call_id"] = msg.tool_call_id
            if msg.name:
                item["name"] = msg.name
            messages.append(item)

        body: dict[str, Any] = {"model": request.model, "messages": messages}
        if request.tools:
            body["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    },
                }
                for t in request.tools
            ]

        data = await self._post_json(
            endpoint,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            body=body,
        )
        choices = data.get("choices") or []
        message = choices[0].get("message", {}) if choices else {}
        content = str(message.get("content") or "")
        tool_calls: list[ProviderToolCall] = []
        for idx, tc in enumerate(message.get("tool_calls") or []):
            fn = tc.get("function", {})
            raw_args = fn.get("arguments", "{}")
            parsed_args: dict[str, Any]
            if isinstance(raw_args, str):
                try:
                    loaded_args = json.loads(raw_args)
                except json.JSONDecodeError as exc:
                    parsed_args = {"_alfred_json_parse_error": exc.msg}
                else:
                    parsed_args = loaded_args if isinstance(loaded_args, dict) else {}
            elif isinstance(raw_args, dict):
                parsed_args = dict(raw_args)
            else:
                parsed_args = {}
            tool_calls.append(
                ProviderToolCall(
                    id=str(tc.get("id") or f"call_{idx}"),
                    name=str(fn.get("name") or ""),
                    arguments=parsed_args,
                )
            )
        usage = data.get("usage") or {}
        prompt_details = usage.get("prompt_tokens_details") or {}
        comp_details = usage.get("completion_tokens_details") or {}
        return ModelProviderResponse(
            content=content,
            tool_calls=tool_calls,
            input_tokens=int(usage.get("prompt_tokens", 0)),
            output_tokens=int(usage.get("completion_tokens", 0)),
            cache_read_tokens=int(
                prompt_details.get("cached_tokens", usage.get("prompt_cache_hit_tokens", 0))
            ),
            cache_creation_tokens=int(usage.get("prompt_cache_miss_tokens", 0)),
            thinking_tokens=int(comp_details.get("reasoning_tokens", 0)),
        )

    async def _call_gemini(self, request: ModelProviderRequest) -> ModelProviderResponse:
        api_key = await self._resolve_api_key("GEMINI_API_KEY")
        url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/"
            f"{request.model}:generateContent"
        )
        body = _build_google_generate_body(request)
        data = await self._post_json(
            url,
            headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
            body=body,
        )
        return _parse_google_generate_response(data)

    async def _call_vertex_eu(self, request: ModelProviderRequest) -> ModelProviderResponse:
        if not is_eu_vertex_location(self._vertex_location):
            raise GdprComplianceError(
                f"Vertex EU provider requires an 'europe-*' region, got '{self._vertex_location}'"
            )
        if self._gcp_token_provider is None:
            raise RouterError("Vertex EU requires configured GcpTokenProvider")
        project_id = (
            self._vertex_project_id
            or self._gcp_token_provider.credentials.project_id
            or self._env_getter("GOOGLE_CLOUD_PROJECT")
        )
        if not project_id:
            raise RouterError("Vertex EU requires project_id")
        token = await self._gcp_token_provider.get_access_token()
        url = (
            f"https://{self._vertex_location}-aiplatform.googleapis.com/v1/"
            f"projects/{project_id}/locations/{self._vertex_location}/"
            f"publishers/google/models/{request.model}:generateContent"
        )
        data = await self._post_json(
            url,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            body=_build_google_generate_body(request),
        )
        return _parse_google_generate_response(data)


def _build_google_generate_body(request: ModelProviderRequest) -> dict[str, Any]:
    contents: list[dict[str, Any]] = []
    for msg in request.messages:
        role = "model" if msg.role == "assistant" else "user"
        contents.append({"role": role, "parts": [{"text": msg.content}]})
    body: dict[str, Any] = {"contents": contents}
    if request.system_prompt:
        body["systemInstruction"] = {"parts": [{"text": request.system_prompt}]}
    if request.tools:
        body["tools"] = [
            {
                "functionDeclarations": [
                    {"name": t.name, "description": t.description, "parameters": t.parameters}
                    for t in request.tools
                ]
            }
        ]
    return body


def _parse_google_generate_response(data: dict[str, Any]) -> ModelProviderResponse:
    candidates = data.get("candidates") or []
    parts = candidates[0].get("content", {}).get("parts", []) if candidates else []
    text_chunks: list[str] = []
    tool_calls: list[ProviderToolCall] = []
    for idx, part in enumerate(parts):
        if isinstance(part, dict) and "text" in part:
            text_chunks.append(str(part["text"]))
        elif isinstance(part, dict) and "functionCall" in part:
            fc = part["functionCall"]
            args = fc.get("args") or {}
            tool_calls.append(
                ProviderToolCall(
                    id=f"gcall_{idx}",
                    name=str(fc.get("name") or ""),
                    arguments=args if isinstance(args, dict) else {},
                )
            )
    usage = data.get("usageMetadata") or {}
    return ModelProviderResponse(
        content="".join(text_chunks),
        tool_calls=tool_calls,
        input_tokens=int(usage.get("promptTokenCount", 0)),
        output_tokens=int(usage.get("candidatesTokenCount", 0)),
        cache_read_tokens=int(usage.get("cachedContentTokenCount", 0)),
        thinking_tokens=int(usage.get("thoughtsTokenCount", 0)),
    )
