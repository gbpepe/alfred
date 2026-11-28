"""Lightweight readiness probe for `batch-api` without importing `plugin.py` or `runner.py`."""

from __future__ import annotations

import asyncio
import os
from collections.abc import Mapping
from pathlib import Path

from alfred.core.model_router import is_eu_vertex_location
from alfred.kernel.types import ModuleContext, ProbeCheck, ProbeResult


def _is_file_sync(path_str: str) -> bool:
    return bool(path_str and Path(path_str).is_file())


def _lookup_env(env_override: Mapping[str, object] | None, key: str) -> str:
    if env_override is not None:
        raw = env_override.get(key)
        return raw.strip() if isinstance(raw, str) else ""
    return os.environ.get(key, "").strip()


async def probe(ctx: ModuleContext) -> ProbeResult:
    """Inspect configured batch providers via Vault metadata & config without activating plugin."""
    vault_keys = {item.key_id for item in ctx.security.vault.list_secrets()}
    cfg = await ctx.security.config.get()
    raw_env = ctx.extra.get("env")
    env_map: Mapping[str, object] | None = raw_env if isinstance(raw_env, Mapping) else None

    checks: list[ProbeCheck] = []
    configured_providers: list[str] = []

    # 1. Gemini Batch API
    gemini_ok = "GEMINI_API_KEY" in vault_keys or bool(_lookup_env(env_map, "GEMINI_API_KEY"))
    if gemini_ok:
        configured_providers.append("gemini")
    checks.append(
        ProbeCheck(
            name="provider:gemini",
            ok=gemini_ok,
            detail=(
                "GEMINI_API_KEY configured"
                if gemini_ok
                else "GEMINI_API_KEY not configured"
            ),
        )
    )

    # 2. Anthropic Messages Batches
    anthropic_ok = "ANTHROPIC_API_KEY" in vault_keys or bool(
        _lookup_env(env_map, "ANTHROPIC_API_KEY")
    )
    if anthropic_ok:
        configured_providers.append("anthropic")
    checks.append(
        ProbeCheck(
            name="provider:anthropic",
            ok=anthropic_ok,
            detail=(
                "ANTHROPIC_API_KEY configured"
                if anthropic_ok
                else "ANTHROPIC_API_KEY not configured"
            ),
        )
    )

    # 3. OpenAI Batch API
    openai_ok = "OPENAI_API_KEY" in vault_keys or bool(_lookup_env(env_map, "OPENAI_API_KEY"))
    if openai_ok:
        configured_providers.append("openai")
    checks.append(
        ProbeCheck(
            name="provider:openai",
            ok=openai_ok,
            detail=(
                "OPENAI_API_KEY configured"
                if openai_ok
                else "OPENAI_API_KEY not configured"
            ),
        )
    )

    # 4. Vertex AI EU (GDPR-only)
    raw_bucket = cfg.get("VERTEX_EU_BATCH_BUCKET")
    bucket = (
        raw_bucket.strip()
        if isinstance(raw_bucket, str) and raw_bucket.strip()
        else _lookup_env(env_map, "VERTEX_EU_BATCH_BUCKET")
    )
    raw_loc = (
        cfg.get("VERTEX_EU_BATCH_LOCATION")
        or cfg.get("VERTEX_EU_LOCATION")
        or _lookup_env(env_map, "VERTEX_EU_BATCH_LOCATION")
        or _lookup_env(env_map, "VERTEX_EU_LOCATION")
        or _lookup_env(env_map, "VERTEX_LOCATION")
        or "europe-central2"
    )
    location = str(raw_loc).strip()
    eu_loc_ok = is_eu_vertex_location(location)

    creds_path_str = _lookup_env(env_map, "GOOGLE_APPLICATION_CREDENTIALS")
    has_creds_file = (
        await asyncio.to_thread(_is_file_sync, creds_path_str) if creds_path_str else False
    )
    has_gcp_auth = (
        has_creds_file
        or ctx.extra.get("gcp_token_provider") is not None
        or bool(_lookup_env(env_map, "VERTEX_EU_ACCESS_TOKEN"))
    )

    vertex_ok = bool(bucket) and eu_loc_ok and has_gcp_auth
    if not eu_loc_ok:
        vertex_detail = (
            f"Non-EU Vertex location '{location}' rejected (requires 'europe-*')"
        )
    elif not bucket:
        vertex_detail = "VERTEX_EU_BATCH_BUCKET not configured"
    elif not has_gcp_auth:
        vertex_detail = "GCP Service Account credentials not configured"
    else:
        vertex_detail = f"Vertex EU ready (bucket={bucket}, location={location})"

    if vertex_ok:
        configured_providers.append("vertex-eu")
    checks.append(
        ProbeCheck(
            name="provider:vertex-eu",
            ok=vertex_ok,
            detail=vertex_detail,
        )
    )

    # 5. Confined data_dir readiness
    data_dir = ctx.security.data_dir.base_dir
    checks.append(
        ProbeCheck(
            name="data_dir",
            ok=True,
            detail=f"Confined module data_dir: {data_dir.name}",
        )
    )

    any_ready = len(configured_providers) > 0
    if any_ready:
        summary = (
            f"{len(configured_providers)}/4 batch provider(s) configured: "
            + ", ".join(configured_providers)
        )
    else:
        summary = (
            "0/4 batch providers configured (configure at least one API key or Vertex EU)"
        )

    return ProbeResult(
        ok=any_ready,
        module_id=ctx.module_id,
        summary=summary,
        checks=checks,
    )
