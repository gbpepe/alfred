"""Comprehensive tests for `modules/batch-api` (adapters, GDPR, lifecycle, tools, routes, UI)."""

from __future__ import annotations

import functools
import json
import os
import re
import sqlite3
import sys
import time
from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI

from alfred.core.agents_config import AgentsConfigManager
from alfred.core.config import CoreSettings
from alfred.core.db import SqlitePool
from alfred.core.gcp_auth import GcpTokenProvider, ServiceAccountCredentials
from alfred.core.routes import create_core_router
from alfred.core.security.heavy_job_hold import HeavyJobHoldManager
from alfred.core.vault import VaultManager
from alfred.core.web_app import CoreAppContainer, build_core_container
from alfred.kernel import (
    AlfredModulePlugin,
    ModuleLoader,
    ModuleManifest,
    ModuleRegistry,
    ModuleSecurityError,
    module_package_name,
)
from alfred.kernel.http_bridge import mount_module_dispatcher, mount_module_ui_routes
from alfred.kernel.loader import apply_module_migrations

REPO_ROOT = Path(__file__).resolve().parent.parent
MODULES_DIR = REPO_ROOT / "modules"
BATCH_MODULE_DIR = MODULES_DIR / "batch-api"
AGENTS_CONFIG_PATH = REPO_ROOT / "config" / "agents.json"
TYPE_IGNORE_RE = re.compile(r"#\s*type:\s*ignore")

if str(BATCH_MODULE_DIR) not in sys.path:
    sys.path.insert(0, str(BATCH_MODULE_DIR))

from batch_api.adapters import (  # noqa: E402
    AnthropicBatchAdapter,
    BatchPayloadLimitError,
    BatchSubmitPayload,
    CanonicalBatchRequestItem,
    GdprBatchComplianceError,
    GeminiBatchAdapter,
    OpenAiBatchAdapter,
    VertexEuBatchAdapter,
    compute_batch_cost_usd,
)
from batch_api.migrations import BATCH_API_MIGRATIONS  # noqa: E402


def _cleanup_module_sys_modules() -> None:
    prefixes = (
        module_package_name("core-cli"),
        module_package_name("batch-api"),
        "_alfred_probe_batch_api_",
    )
    for key in list(sys.modules.keys()):
        matches = any(
            key == pref or key.startswith(f"{pref}.") or key.startswith(pref)
            for pref in prefixes
        )
        if matches:
            if key in (
                "batch_api",
                "batch_api.adapters",
                "batch_api.migrations",
                "batch_api.plugin",
                "batch_api.runner",
                "batch_api.tools",
                "batch_api.routes",
                "batch_api.probe",
            ):
                continue
            sys.modules.pop(key, None)


@pytest.fixture(autouse=True)
def _isolate_kernel_modules(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    for env_key in (
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "OPENAI_API_KEY",
        "VERTEX_EU_BATCH_BUCKET",
        "VERTEX_EU_BATCH_LOCATION",
        "VERTEX_EU_LOCATION",
        "VERTEX_LOCATION",
        "VERTEX_EU_ACCESS_TOKEN",
        "VERTEX_EU_PROJECT_ID",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT",
        "GEMINI_BATCH_MODEL",
    ):
        monkeypatch.delenv(env_key, raising=False)
    _cleanup_module_sys_modules()
    yield
    _cleanup_module_sys_modules()


@functools.lru_cache(maxsize=1)
def _generate_test_rsa_pem() -> str:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return pem.decode("ascii")


def _make_settings(tmp_path: Path) -> CoreSettings:
    store_dir = tmp_path / "store"
    return CoreSettings(
        project_root=tmp_path,
        store_dir=store_dir,
        modules_dir=MODULES_DIR,
        config_dir=REPO_ROOT / "config",
        agents_config_path=AGENTS_CONFIG_PATH,
        db_path=store_dir / "alfred.db",
        vault_path=store_dir / "vault.json",
        vault_key_path=store_dir / ".vault-key",
        env_path=tmp_path / ".env",
        heavy_job_lock_path=store_dir / ".heavy-job.lock",
        environment="test",
    )


def test_layout_manifest_agents_and_zero_type_ignore() -> None:
    """Verify package layout, empty `__init__.py`, manifest fields, agents.json & zero ignores."""
    init_file = BATCH_MODULE_DIR / "batch_api" / "__init__.py"
    assert init_file.is_file()
    assert init_file.read_text(encoding="utf-8").strip() == ""
    assert list(BATCH_MODULE_DIR.glob("*.py")) == []

    for path in list((BATCH_MODULE_DIR / "batch_api").glob("*.py")) + [
        Path(__file__),
    ]:
        text = path.read_text(encoding="utf-8")
        assert TYPE_IGNORE_RE.search(text) is None, f"Found type ignore in {path}"

    manifest = ModuleManifest.model_validate_json(
        (BATCH_MODULE_DIR / "module.json").read_text(encoding="utf-8")
    )
    assert manifest.id == "batch-api"
    assert manifest.built_in is False
    assert manifest.default_enabled is False
    assert manifest.entry == "batch_api/plugin.py"
    assert manifest.probe_entry == "batch_api/probe.py"
    assert manifest.depends == ["core-cli"]
    assert set(manifest.allowed_vault_keys) == {
        "GEMINI_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
    }
    assert manifest.tools == ["batch_submit", "batch_status", "batch_list", "batch_cancel"]
    assert manifest.ui_card_ids == ["vpsBatchCard"]
    assert manifest.setup_wizard is not None
    assert manifest.setup_wizard.steps[0].requirement_mode == "any_one"

    agents_cfg = AgentsConfigManager(AGENTS_CONFIG_PATH, modules_dir=MODULES_DIR).load(
        validate_manifests=True
    )
    batch_agent = agents_cfg.get_agent("alfred-batch")
    assert batch_agent is not None
    assert "batch_submit" in batch_agent.tools


async def test_idempotent_migration_v1_schema_and_indexes(tmp_path: Path) -> None:
    """Verify `batch_jobs` migration v1 is idempotent and matches exact schema."""
    async with SqlitePool(tmp_path / "store" / "alfred.db") as db:
        await db.initialize()
        first = await apply_module_migrations(db, "batch-api", BATCH_API_MIGRATIONS)
        second = await apply_module_migrations(db, "batch-api", BATCH_API_MIGRATIONS)
        assert first == [1]
        assert second == []

        def _inspect(conn: sqlite3.Connection) -> tuple[list[str], set[str]]:
            cols = [
                str(r["name"])
                for r in conn.execute("PRAGMA table_info(batch_jobs)").fetchall()
            ]
            idxs = {
                str(r["name"])
                for r in conn.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type = 'index' AND tbl_name = 'batch_jobs'"
                ).fetchall()
            }
            return cols, idxs

        cols, idxs = await db.read(_inspect)
        assert cols == [
            "id",
            "provider",
            "model",
            "status",
            "agent_id",
            "session_id",
            "external_job_id",
            "input_ref",
            "output_ref",
            "request_count",
            "completed_count",
            "input_tokens",
            "output_tokens",
            "cost_usd",
            "qa_sampled",
            "qa_status",
            "error_message",
            "created_at",
            "updated_at",
            "completed_at",
        ]
        assert {"idx_batch_jobs_status", "idx_batch_jobs_provider"} <= idxs


async def test_probe_inactive_module_never_imports_plugin_or_runner(tmp_path: Path) -> None:
    """Verify `probe_inactive_module('batch-api')` checks Vault/config without loading plugin."""
    settings = _make_settings(tmp_path)
    async with SqlitePool(settings.db_path) as db:
        await db.initialize()
        vault = VaultManager(settings.vault_path, settings.vault_key_path)
        await vault.initialize()
        registry = ModuleRegistry()
        loader = ModuleLoader(
            modules_dir=MODULES_DIR,
            store_dir=settings.store_dir,
            db=db,
            vault=vault,
            registry=registry,
            heavy_job=HeavyJobHoldManager(settings.heavy_job_lock_path),
            project_root=settings.project_root,
        )

        # Snapshot sys.modules before probe
        before_mod_keys = set(sys.modules.keys())
        res_empty = await loader.probe_inactive_module("batch-api")
        after_mod_keys = set(sys.modules.keys()) - before_mod_keys
        assert not any(
            k.endswith(".plugin") or k.endswith(".runner") for k in after_mod_keys
        ), f"Probe imported plugin/runner: {after_mod_keys}"
        assert not registry.is_active("batch-api")
        assert res_empty.ok is False

        # Adding GEMINI_API_KEY in Vault enables probe via list_secrets() without decrypting
        await vault.set_secret("GEMINI_API_KEY", "AIzaTestDummyKey123456")
        res_ok = await loader.probe_inactive_module("batch-api")
        assert res_ok.ok is True
        checks_map = {c.name: c for c in res_ok.checks}
        assert checks_map["provider:gemini"].ok is True
        assert checks_map["provider:anthropic"].ok is False

        # Non-EU Vertex location is flagged explicitly
        await db.set_module_config(
            "batch-api",
            {
                "VERTEX_EU_BATCH_BUCKET": "gs://bad-bucket",
                "VERTEX_EU_BATCH_LOCATION": "us-central1",
            },
            "2026-11-28T00:00:00+00:00",
        )
        res_bad_loc = await loader.probe_inactive_module("batch-api")
        v_check = {c.name: c for c in res_bad_loc.checks}["provider:vertex-eu"]
        assert v_check.ok is False
        assert "europe-*" in v_check.detail


async def test_anthropic_gemini_openai_adapters_with_mock_transport() -> None:
    """Verify Anthropic (ephemeral cache + limits), Gemini, and OpenAI async httpx adapters."""
    long_sys = "System guideline " * 300  # > 4096 chars
    assert len(long_sys) >= 4096

    # 1. Anthropic adapter
    seen_anthropic_reqs: list[httpx.Request] = []

    def _anthropic_handler(request: httpx.Request) -> httpx.Response:
        seen_anthropic_reqs.append(request)
        if request.method == "POST" and request.url.path == "/v1/messages/batches":
            body = json.loads(request.content.decode("utf-8"))
            req0_sys = body["requests"][0]["params"]["system"][0]
            assert req0_sys["cache_control"] == {"type": "ephemeral"}
            return httpx.Response(200, json={"id": "msgbatch_01"})
        if request.method == "GET" and request.url.path == "/v1/messages/batches/msgbatch_01":
            return httpx.Response(
                200,
                json={
                    "processing_status": "ended",
                    "results_url": "https://api.anthropic.com/v1/messages/batches/msgbatch_01/results",
                    "request_counts": {"succeeded": 2, "errored": 0, "canceled": 0, "expired": 0},
                },
            )
        if request.method == "GET" and request.url.path.endswith("/results"):
            lines = [
                json.dumps(
                    {
                        "custom_id": "item_1",
                        "result": {
                            "type": "succeeded",
                            "message": {
                                "content": [{"type": "text", "text": "alpha"}],
                                "usage": {
                                    "input_tokens": 1000,
                                    "output_tokens": 500,
                                    "cache_read_input_tokens": 200,
                                },
                            },
                        },
                    }
                ),
                json.dumps(
                    {
                        "custom_id": "item_2",
                        "result": {"type": "errored", "error": {"message": "rate"}},
                    }
                ),
            ]
            return httpx.Response(200, text="\n".join(lines) + "\n")
        if request.method == "POST" and request.url.path.endswith("/cancel"):
            return httpx.Response(200, json={"id": "msgbatch_01", "processing_status": "canceling"})
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(_anthropic_handler)) as ant_client:
        ant = AnthropicBatchAdapter(api_key="ant-key", http_client=ant_client, max_requests=5)
        items = [
            CanonicalBatchRequestItem(custom_id="item_1", system=long_sys, prompt="First"),
            CanonicalBatchRequestItem(custom_id="item_2", system=long_sys, prompt="Second"),
        ]
        sub = await ant.submit(
            BatchSubmitPayload(
                job_id="j1",
                provider="anthropic",
                model="claude-sonnet-4-6",
                items=items,
                shared_long_system_prefixes=(long_sys,),
            )
        )
        assert sub.external_job_id == "msgbatch_01"
        poll = await ant.poll("msgbatch_01", "claude-sonnet-4-6")
        assert poll.status == "completed"
        assert poll.completed_count == 1
        assert poll.failed_count == 1
        expected_cost, _, _ = compute_batch_cost_usd(
            "claude-sonnet-4-6",
            1000,
            500,
            cache_read_tokens=200,
        )
        assert poll.cost_usd == expected_cost
        cancel_res = await ant.cancel("msgbatch_01")
        assert cancel_res.cancelled is True

        # Max requests limit enforced
        with pytest.raises(BatchPayloadLimitError):
            await ant.submit(
                BatchSubmitPayload(
                    job_id="j_big",
                    provider="anthropic",
                    model="claude-sonnet-4-6",
                    items=[
                        CanonicalBatchRequestItem(custom_id=f"c_{i}", prompt="hi")
                        for i in range(6)
                    ],
                )
            )

    # 2. Gemini adapter (API key strictly in header, never query string)
    def _gemini_handler(request: httpx.Request) -> httpx.Response:
        assert "key=" not in str(request.url)
        assert request.headers.get("x-goog-api-key") == "gem-key"
        if request.method == "POST" and request.url.path == "/upload/v1beta/files":
            return httpx.Response(200, json={"file": {"name": "files/gem_in_1"}})
        if request.method == "POST" and request.url.path.endswith(":batchGenerateContent"):
            return httpx.Response(200, json={"name": "batches/gem_batch_1"})
        if request.method == "GET" and request.url.path == "/v1beta/batches/gem_batch_1":
            return httpx.Response(
                200,
                json={
                    "done": True,
                    "metadata": {"state": "BATCH_STATE_SUCCEEDED"},
                    "response": {"responsesFile": "files/gem_out_1"},
                },
            )
        if (
            request.method == "GET"
            and request.url.path == "/download/v1beta/files/gem_out_1:download"
        ):
            out_line = json.dumps(
                {
                    "key": "g_1",
                    "response": {
                        "candidates": [{"content": {"parts": [{"text": "gemini-ok"}]}}],
                        "usageMetadata": {
                            "promptTokenCount": 500,
                            "candidatesTokenCount": 120,
                            "cachedContentTokenCount": 100,
                        },
                    },
                }
            )
            return httpx.Response(200, text=out_line + "\n")
        if request.method == "POST" and request.url.path.endswith(":cancel"):
            return httpx.Response(200, json={})
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(_gemini_handler)) as gem_client:
        gem = GeminiBatchAdapter(api_key="gem-key", http_client=gem_client)
        gem_sub = await gem.submit(
            BatchSubmitPayload(
                job_id="j_gem",
                provider="gemini",
                model="gemini-3.8-flash",
                items=[CanonicalBatchRequestItem(custom_id="g_1", prompt="Translate hello")],
            )
        )
        assert gem_sub.external_job_id == "batches/gem_batch_1"
        gem_poll = await gem.poll("batches/gem_batch_1", "gemini-3.8-flash")
        assert gem_poll.status == "completed"
        assert gem_poll.input_tokens == 400
        assert gem_poll.output_tokens == 120
        assert gem_poll.cache_read_tokens == 100
        await gem.cancel("batches/gem_batch_1")

    # 3. OpenAI adapter (multipart upload + output/error files)
    def _openai_handler(request: httpx.Request) -> httpx.Response:
        assert request.headers.get("authorization") == "Bearer oai-key"
        if request.method == "POST" and request.url.path == "/v1/files":
            assert b"purpose" in request.content
            return httpx.Response(200, json={"id": "file-in-1"})
        if request.method == "POST" and request.url.path == "/v1/batches":
            return httpx.Response(200, json={"id": "batch_oai_1"})
        if request.method == "GET" and request.url.path == "/v1/batches/batch_oai_1":
            return httpx.Response(
                200,
                json={
                    "status": "completed",
                    "output_file_id": "file-out-1",
                    "error_file_id": "file-err-1",
                },
            )
        if request.method == "GET" and request.url.path == "/v1/files/file-out-1/content":
            ok_row = json.dumps(
                {
                    "custom_id": "o_1",
                    "response": {
                        "status_code": 200,
                        "body": {
                            "choices": [{"message": {"content": "openai-ok"}}],
                            "usage": {
                                "prompt_tokens": 300,
                                "completion_tokens": 80,
                                "prompt_tokens_details": {"cached_tokens": 50},
                            },
                        },
                    },
                }
            )
            return httpx.Response(200, text=ok_row + "\n")
        if request.method == "GET" and request.url.path == "/v1/files/file-err-1/content":
            err_row = json.dumps(
                {"custom_id": "o_2", "error": {"message": "context_length_exceeded"}}
            )
            return httpx.Response(200, text=err_row + "\n")
        if request.method == "POST" and request.url.path.endswith("/cancel"):
            return httpx.Response(200, json={"id": "batch_oai_1", "status": "cancelling"})
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(_openai_handler)) as oai_client:
        oai = OpenAiBatchAdapter(api_key="oai-key", http_client=oai_client)
        oai_sub = await oai.submit(
            BatchSubmitPayload(
                job_id="j_oai",
                provider="openai",
                model="gpt-4o-mini",
                items=[
                    CanonicalBatchRequestItem(custom_id="o_1", prompt="Hi"),
                    CanonicalBatchRequestItem(custom_id="o_2", prompt="Oops"),
                ],
            )
        )
        assert oai_sub.external_job_id == "batch_oai_1"
        oai_poll = await oai.poll("batch_oai_1", "gpt-4o-mini")
        assert oai_poll.status == "completed"
        assert oai_poll.completed_count == 1
        assert oai_poll.failed_count == 1
        assert oai_poll.input_tokens == 250
        await oai.cancel("batch_oai_1")


async def test_vertex_eu_strict_location_and_gcp_rs256_jwt_adapter() -> None:
    """Verify `VertexEuBatchAdapter` enforces EU region and uses `GcpTokenProvider`."""
    pem = _generate_test_rsa_pem()
    creds = ServiceAccountCredentials(
        client_email="alfred-batch@test-eu.iam.gserviceaccount.com",
        private_key=pem,
        project_id="test-eu-project",
    )

    for bad_loc in ("us-central1", "us-east4", "asia-northeast1", "global", ""):
        with pytest.raises(GdprBatchComplianceError):
            VertexEuBatchAdapter(
                bucket="gs://alfred-eu-bucket",
                location=bad_loc,
                credentials=creds,
            )

    seen_urls: list[str] = []

    def _gcp_vertex_handler(request: httpx.Request) -> httpx.Response:
        seen_urls.append(str(request.url))
        if request.url.host == "oauth2.googleapis.com":
            return httpx.Response(
                200,
                json={"access_token": "ya29.rs256-test-token", "expires_in": 3600},
            )
        if request.url.host == "storage.googleapis.com":
            assert request.headers.get("authorization") == "Bearer ya29.rs256-test-token"
            if (
                request.method == "POST"
                and "/upload/storage/v1/b/alfred-eu-bucket/o" in request.url.path
            ):
                return httpx.Response(200, json={"name": "alfred-batch/j_vtx/input.jsonl"})
            if request.method == "GET" and request.url.path == "/storage/v1/b/alfred-eu-bucket/o":
                return httpx.Response(
                    200,
                    json={
                        "items": [
                            {"name": "alfred-batch/j_vtx/output/predictions-00001.jsonl"},
                        ]
                    },
                )
            if request.method == "GET" and "predictions-00001.jsonl" in request.url.path:
                line = json.dumps(
                    {
                        "custom_id": "eu_1",
                        "response": {
                            "candidates": [{"content": {"parts": [{"text": "eu-gdpr-ok"}]}}],
                            "usageMetadata": {"promptTokenCount": 800, "candidatesTokenCount": 200},
                        },
                    }
                )
                return httpx.Response(200, text=line + "\n")
        if request.url.host == "europe-central2-aiplatform.googleapis.com":
            assert request.headers.get("authorization") == "Bearer ya29.rs256-test-token"
            if request.method == "POST" and request.url.path.endswith("/batchPredictionJobs"):
                return httpx.Response(
                    200,
                    json={
                        "name": (
                            "projects/test-eu-project/locations/europe-central2/"
                            "batchPredictionJobs/999"
                        )
                    },
                )
            if request.method == "GET" and request.url.path.endswith("/batchPredictionJobs/999"):
                return httpx.Response(
                    200,
                    json={
                        "state": "JOB_STATE_SUCCEEDED",
                        "outputInfo": {"gcsOutputDirectory": "gs://alfred-eu-bucket/alfred-batch/j_vtx/output/"},
                    },
                )
            if request.method == "POST" and request.url.path.endswith(":cancel"):
                return httpx.Response(200, json={})
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(_gcp_vertex_handler)) as client:
        tp = GcpTokenProvider(creds, http_client=client)
        adapter = VertexEuBatchAdapter(
            bucket="gs://alfred-eu-bucket",
            location="europe-central2",
            token_provider=tp,
            http_client=client,
        )
        sub = await adapter.submit(
            BatchSubmitPayload(
                job_id="j_vtx",
                provider="vertex-eu",
                model="gemini-2.5-flash",
                items=[
                    CanonicalBatchRequestItem(
                        custom_id="eu_1",
                        prompt="Summarize GDPR text",
                        eu_only=True,
                    )
                ],
                eu_only=True,
            )
        )
        assert "europe-central2" in sub.external_job_id
        poll = await adapter.poll(sub.external_job_id, "gemini-2.5-flash")
        assert poll.status == "completed"
        assert poll.completed_count == 1
        assert poll.output_items[0].text == "eu-gdpr-ok"
        await adapter.cancel(sub.external_job_id)

    assert any("oauth2.googleapis.com" in u for u in seen_urls)
    assert any("europe-central2-aiplatform.googleapis.com" in u for u in seen_urls)


async def test_runner_gdpr_secret_gate_recovery_heartbeat_costops_qa_and_housekeeping(
    tmp_path: Path,
) -> None:
    """Verify startup recovery, heartbeat poll, CostOps DB recording, QA mark & housekeeping."""
    settings = _make_settings(tmp_path)
    pem = _generate_test_rsa_pem()
    creds = ServiceAccountCredentials(
        client_email="alfred-batch@eu-test.iam.gserviceaccount.com",
        private_key=pem,
        project_id="eu-test-proj",
    )

    poll_state = {"done": False}

    def _handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "oauth2.googleapis.com":
            return httpx.Response(200, json={"access_token": "ya29.tok", "expires_in": 3600})
        if request.url.host == "storage.googleapis.com":
            if request.method == "POST":
                return httpx.Response(200, json={"name": "input.jsonl"})
            if request.method == "GET" and request.url.path.endswith("/o"):
                return httpx.Response(
                    200,
                    json={"items": [{"name": "alfred-batch/out/predictions.jsonl"}]},
                )
            if request.method == "GET":
                row = json.dumps(
                    {
                        "custom_id": "doc_1",
                        "response": {
                            "candidates": [{"content": {"parts": [{"text": "Kész válasz"}]}}],
                            "usageMetadata": {
                                "promptTokenCount": 1200,
                                "candidatesTokenCount": 300,
                            },
                        },
                    }
                )
                return httpx.Response(200, text=row + "\n")
        if request.url.host == "europe-west1-aiplatform.googleapis.com":
            if request.method == "POST" and request.url.path.endswith("/batchPredictionJobs"):
                return httpx.Response(
                    200,
                    json={
                        "name": (
                            "projects/eu-test-proj/locations/europe-west1/"
                            "batchPredictionJobs/77"
                        )
                    },
                )
            if request.method == "GET":
                if not poll_state["done"]:
                    return httpx.Response(200, json={"state": "JOB_STATE_RUNNING"})
                return httpx.Response(
                    200,
                    json={
                        "state": "JOB_STATE_SUCCEEDED",
                        "outputInfo": {
                            "gcsOutputDirectory": "gs://eu-bucket/alfred-batch/out/"
                        },
                    },
                )
        if request.url.host == "generativelanguage.googleapis.com":
            if request.method == "POST" and request.url.path == "/upload/v1beta/files":
                return httpx.Response(200, json={"file": {"name": "files/in_g"}})
            if request.method == "POST" and request.url.path.endswith(":batchGenerateContent"):
                return httpx.Response(200, json={"name": "batches/g_77"})
        return httpx.Response(404)

    async with (
        SqlitePool(settings.db_path) as db,
        httpx.AsyncClient(transport=httpx.MockTransport(_handler)) as mock_http,
    ):
        await db.initialize()
        vault = VaultManager(settings.vault_path, settings.vault_key_path)
        await vault.initialize()
        await vault.set_secret("GEMINI_API_KEY", "AIzaFakeGeminiKey99999999")

        registry = ModuleRegistry()
        loader = ModuleLoader(
            modules_dir=MODULES_DIR,
            store_dir=settings.store_dir,
            db=db,
            vault=vault,
            registry=registry,
            heavy_job=HeavyJobHoldManager(settings.heavy_job_lock_path),
            project_root=settings.project_root,
        )
        await loader.load_active_modules(active_ids={"core-cli", "batch-api"})
        batch_ctx = registry.get_context("batch-api")
        batch_plugin = registry.get_plugin("batch-api")
        assert batch_ctx is not None and batch_plugin is not None
        assert isinstance(batch_plugin, AlfredModulePlugin)
        assert tuple(batch_plugin.cli_env_sanitize_keys) == (
            "ANTHROPIC_API_KEY",
            "GEMINI_API_KEY",
            "OPENAI_API_KEY",
        )

        # Configure Vertex EU via config_json + injectable GcpTokenProvider & httpx client
        await batch_ctx.security.config.update(
            {
                "VERTEX_EU_BATCH_BUCKET": "eu-bucket",
                "VERTEX_EU_BATCH_LOCATION": "europe-west1",
            }
        )
        batch_ctx.extra["http_client"] = mock_http
        batch_ctx.extra["gcp_token_provider"] = GcpTokenProvider(creds, http_client=mock_http)

        runner = registry.get_service("batch-api")
        mod_pkg = module_package_name("batch-api")
        mod_runner = sys.modules[f"{mod_pkg}.runner"]
        mod_adapters = sys.modules[f"{mod_pkg}.adapters"]
        assert isinstance(runner, mod_runner.BatchRunner)

        # 1. Secret-gate blocks embedded secrets before any HTTP request
        with pytest.raises(mod_runner.BatchValidationError, match="Secret gate blocked"):
            await runner.submit_job(
                mod_runner.BatchSubmitInput(
                    items=[
                        mod_adapters.CanonicalBatchRequestItem(
                            custom_id="bad_sec",
                            prompt="Use key sk-proj-abcdefghijklmnopqrstuvwxyz1234",
                        )
                    ]
                )
            )

        # 1b. Duplicate custom_id in JSONL rejected
        dup_file = tmp_path / "batch" / "dup.jsonl"
        dup_file.parent.mkdir(parents=True, exist_ok=True)
        dup_file.write_text(
            json.dumps({"custom_id": "dup_1", "prompt": "One"})
            + "\n"
            + json.dumps({"custom_id": "dup_1", "prompt": "Two"})
            + "\n",
            encoding="utf-8",
        )
        with pytest.raises(mod_runner.BatchValidationError, match="Duplicate custom_id"):
            await runner.submit_job(
                mod_runner.BatchSubmitInput(input_path="batch/dup.jsonl"),
                workspace_dir=tmp_path,
            )

        # 2. Path traversal blocked
        with pytest.raises(ModuleSecurityError):
            await runner.submit_job(
                mod_runner.BatchSubmitInput(input_path="../../etc/passwd"),
                workspace_dir=tmp_path,
            )

        # 3. GDPR eu_only=True rejects non-EU provider & never falls back to Gemini
        with pytest.raises(mod_adapters.GdprBatchComplianceError):
            await runner.submit_job(
                mod_runner.BatchSubmitInput(
                    items=[
                        mod_adapters.CanonicalBatchRequestItem(
                            custom_id="eu_req",
                            prompt="GDPR",
                        )
                    ],
                    provider="gemini",
                    eu_only=True,
                )
            )

        # 4. Valid eu_only=True auto-routes strictly to vertex-eu
        job = await runner.submit_job(
            mod_runner.BatchSubmitInput(
                items=[
                    mod_adapters.CanonicalBatchRequestItem(
                        custom_id="doc_1",
                        prompt="Analyze EU doc",
                        eu_only=True,
                    )
                ],
                provider="auto",
                eu_only=True,
            )
        )
        assert job.provider == "vertex-eu"
        assert job.status == "submitted"
        # Input staged inside data_dir (ProtectSystem=strict)
        assert batch_ctx.security.data_dir.resolve_path(job.input_ref).is_file()

        # 5. Simulate crashed `downloading` row + orphaned `.tmp` file -> on_startup recovers
        await db.write(
            lambda c: c.execute(
                "UPDATE batch_jobs SET status = 'downloading' WHERE id = ?",
                (job.id,),
            )
        )
        orphan_tmp = batch_ctx.security.data_dir.resolve_path("outputs/orphan.tmp")
        orphan_tmp.parent.mkdir(parents=True, exist_ok=True)
        orphan_tmp.write_text("partial", encoding="utf-8")

        await batch_plugin.on_startup(batch_ctx)
        recovered = await runner.get_job(job.id)
        assert recovered.status == "running"
        assert not orphan_tmp.exists()

        # 6. Heartbeat #1 (still running)
        hb1 = await batch_plugin.on_heartbeat(batch_ctx, int(time.time() * 1000))
        assert hb1 is not None and hb1["polled"] == 1 and hb1["completed"] == 0

        # 7. Heartbeat #2 (completed -> writes output under data_dir, records token_usage, marks QA)
        poll_state["done"] = True
        hb2 = await batch_plugin.on_heartbeat(batch_ctx, int(time.time() * 1000))
        assert hb2 is not None and hb2["completed"] == 1

        done_job = await runner.get_job(job.id)
        assert done_job.status == "completed"
        assert done_job.completed_count == 1
        assert done_job.input_tokens == 1200
        assert done_job.output_tokens == 300
        assert done_job.cost_usd > 0.0
        assert done_job.qa_sampled is True
        assert done_job.qa_status == "pending_qa"
        assert done_job.output_ref is not None
        out_path = batch_ctx.security.data_dir.resolve_path(done_job.output_ref)
        assert out_path.is_file()
        assert "Kész válasz" in out_path.read_text(encoding="utf-8")
        qa_file = batch_ctx.security.data_dir.resolve_path(f"qa/{job.id}.sample.json")
        assert qa_file.is_file()
        assert "<untrusted" in qa_file.read_text(encoding="utf-8")

        # Verify CostOps DB token_usage row recorded exactly once
        tok_rows = await db.read(
            lambda c: c.execute(
                "SELECT model, input_tokens, output_tokens, cost_usd, tool_name "
                "FROM token_usage"
            ).fetchall()
        )
        assert len(tok_rows) == 1
        assert tok_rows[0]["model"] == f"batch:{done_job.model}"
        assert tok_rows[0]["tool_name"] == "batch"
        assert float(tok_rows[0]["cost_usd"]) == pytest.approx(done_job.cost_usd)

        # Heartbeat #3 does not duplicate usage
        hb3 = await batch_plugin.on_heartbeat(batch_ctx, int(time.time() * 1000))
        assert hb3 is not None and hb3["polled"] == 0

        # 8. Housekeeping prunes expired batch work files while keeping fresh/active files
        stale_file = batch_ctx.security.data_dir.resolve_path("outputs/stale_old.output.jsonl")
        stale_file.write_text('{"old":true}\n', encoding="utf-8")
        old_ts = time.time() - (45 * 86_400)
        os.utime(stale_file, (old_ts, old_ts))

        hk_stats = await batch_plugin.on_housekeeping(
            batch_ctx,
            retention_days=30,
            disk_used_pct=42.0,
        )
        assert hk_stats.module_id == "batch-api"
        assert hk_stats.freed_bytes > 0
        assert not stale_file.exists()
        assert out_path.exists()


async def test_tools_routes_auth_csrf_validation_and_ui_serving(tmp_path: Path) -> None:
    """Verify tools via ToolExecutor, 4 HTTP routes, Auth/CSRF, safe ValidationError & UI."""
    settings = _make_settings(tmp_path)

    def _gemini_mock(request: httpx.Request) -> httpx.Response:
        if request.method == "POST" and request.url.path == "/upload/v1beta/files":
            return httpx.Response(200, json={"file": {"name": "files/f_ui_1"}})
        if request.method == "POST" and request.url.path.endswith(":batchGenerateContent"):
            return httpx.Response(200, json={"name": "batches/ui_1"})
        if request.method == "GET" and request.url.path == "/v1beta/batches/ui_1":
            return httpx.Response(
                200,
                json={
                    "done": True,
                    "metadata": {"state": "BATCH_STATE_SUCCEEDED"},
                    "response": {"responsesFile": "files/f_ui_out"},
                },
            )
        if request.method == "GET" and request.url.path.startswith("/download/v1beta/"):
            row = json.dumps(
                {
                    "key": "k_1",
                    "response": {
                        "candidates": [{"content": {"parts": [{"text": "done"}]}}],
                        "usageMetadata": {"promptTokenCount": 200, "candidatesTokenCount": 50},
                    },
                }
            )
            return httpx.Response(200, text=row + "\n")
        if request.method == "POST" and request.url.path.endswith(":cancel"):
            return httpx.Response(200, json={})
        return httpx.Response(404)

    container: CoreAppContainer = build_core_container(settings, admin_token="batch-admin-token")
    await container.db.initialize()
    await container.vault.initialize()
    await container.vault.set_secret("GEMINI_API_KEY", "AIzaTestBatchUiKey12345")

    app = FastAPI(title="Alfred Batch Test")
    app.state.container = container
    mount_module_ui_routes(app, container.registry)
    app.include_router(create_core_router(container))
    mount_module_dispatcher(app, container.registry, container.auth)

    try:
        await container.loader.load_active_modules(active_ids={"core-cli", "batch-api"})
        batch_ctx = container.registry.get_context("batch-api")
        assert batch_ctx is not None

        async with httpx.AsyncClient(transport=httpx.MockTransport(_gemini_mock)) as mock_http:
            batch_ctx.extra["http_client"] = mock_http

            # 1. ToolExecutor permissions + 4 tools
            agents_cfg = container.agents.load(validate_manifests=True)
            batch_agent = agents_cfg.get_agent("alfred-batch")
            qa_agent = agents_cfg.get_agent("alfred-qa")
            assert batch_agent is not None and qa_agent is not None

            denied = await container.tool_executor.execute_tool(
                agent=qa_agent,
                tool_name="batch_submit",
                raw_args={"items": [{"custom_id": "x1", "prompt": "hi"}]},
                session_id="s-qa",
                workspace_dir=tmp_path,
            )
            assert denied.ok is False and denied.error_code == "TOOL_NOT_ALLOWED"

            # Workspace batch/ file read by tool
            ws_batch_file = tmp_path / "batch" / "sample.jsonl"
            ws_batch_file.parent.mkdir(parents=True, exist_ok=True)
            ws_batch_file.write_text(
                json.dumps({"custom_id": "k_1", "prompt": "Translate"}) + "\n",
                encoding="utf-8",
            )
            t_sub = await container.tool_executor.execute_tool(
                agent=batch_agent,
                tool_name="batch_submit",
                raw_args={"input_path": "batch/sample.jsonl", "provider": "gemini"},
                session_id="s-batch-tool",
                workspace_dir=tmp_path,
            )
            assert t_sub.ok is True
            tool_job_id = str(t_sub.output["id"])

            t_status = await container.tool_executor.execute_tool(
                agent=batch_agent,
                tool_name="batch_status",
                raw_args={"job_id": tool_job_id, "poll": True},
                session_id="s-batch-tool",
                workspace_dir=tmp_path,
            )
            assert t_status.ok is True
            assert t_status.output["status"] == "completed"

            t_list = await container.tool_executor.execute_tool(
                agent=batch_agent,
                tool_name="batch_list",
                raw_args={"limit": 10},
                session_id="s-batch-tool",
                workspace_dir=tmp_path,
            )
            assert t_list.ok is True
            assert t_list.output["summary"]["total_batches"] == 1

            # 2. HTTP routes + Auth/CSRF + ValidationError without secret input leak + UI asset
            transport = httpx.ASGITransport(app=app)
            admin_cookie, admin_csrf = container.auth.issue_dashboard_session(role="admin")

            async with httpx.AsyncClient(transport=transport, base_url="http://test") as anon:
                assert (await anon.get("/api/batch/jobs")).status_code == 401
                assert (await anon.post("/api/batch/jobs", json={})).status_code == 401

                ui_resp = await anon.get("/api/modules/batch-api/ui/batch-card.js")
                assert ui_resp.status_code == 200
                etag = ui_resp.headers.get("etag")
                assert etag
                assert re.search(r"\bexport\s+function\s+mount\s*\(", ui_resp.text)
                assert re.search(r"\bexport\s+function\s+unmount\s*\(", ui_resp.text)
                assert "innerHTML" not in ui_resp.text
                assert "outerHTML" not in ui_resp.text
                assert "insertAdjacentHTML" not in ui_resp.text
                not_mod = await anon.get(
                    "/api/modules/batch-api/ui/batch-card.js",
                    headers={"If-None-Match": etag},
                )
                assert not_mod.status_code == 304

            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
                cookies={"alfred_session": admin_cookie},
            ) as admin:
                # Missing CSRF rejected on POST
                no_csrf = await admin.post("/api/batch/jobs", json={})
                assert no_csrf.status_code == 403

                # ValidationError never leaks raw secret input values
                secret_canary = "SUPER_SECRET_CANARY_INPUT_VALUE"
                bad_req = await admin.post(
                    "/api/batch/jobs",
                    headers={"X-CSRF-Token": admin_csrf},
                    json={"provider": secret_canary, "unknownField": secret_canary},
                )
                assert bad_req.status_code == 400
                assert secret_canary not in bad_req.text

                # Create second job via POST /api/batch/jobs
                created = await admin.post(
                    "/api/batch/jobs",
                    headers={"X-CSRF-Token": admin_csrf},
                    json={
                        "provider": "gemini",
                        "items": [{"custom_id": "api_1", "prompt": "Summarize"}],
                    },
                )
                assert created.status_code == 201
                api_job_id = created.json()["id"]

                # GET /api/batch/jobs/{job_id}
                fetched = await admin.get(f"/api/batch/jobs/{api_job_id}")
                assert fetched.status_code == 200
                assert fetched.json()["status"] == "submitted"

                # POST /api/batch/jobs/{job_id}/cancel
                cancelled = await admin.post(
                    f"/api/batch/jobs/{api_job_id}/cancel",
                    headers={"X-CSRF-Token": admin_csrf},
                )
                assert cancelled.status_code == 200
                assert cancelled.json()["status"] == "cancelled"

                # Also verify tool batch_cancel on already cancelled or missing job
                t_cancel = await container.tool_executor.execute_tool(
                    agent=batch_agent,
                    tool_name="batch_cancel",
                    raw_args={"job_id": api_job_id},
                    session_id="s-batch-tool",
                    workspace_dir=tmp_path,
                )
                assert t_cancel.ok is True
                assert t_cancel.output["status"] == "cancelled"

                # 404 on unknown job
                assert (await admin.get("/api/batch/jobs/missing_job")).status_code == 404

                # Overview GET /api/batch/jobs
                overview = await admin.get("/api/batch/jobs")
                assert overview.status_code == 200
                ov_json = overview.json()
                assert ov_json["summary"]["total_batches"] == 2
                assert len(ov_json["by_provider"]) == 4

                # UI contribution registered
                mods = await admin.get("/api/modules")
                contribs = {c["id"]: c for c in mods.json()["uiContributions"]}
                assert contribs["vpsBatchCard"]["slot"] == "vps-card"
                assert contribs["vpsBatchCard"]["entryFile"] == "batch-card.js"
                assert contribs["vpsBatchCard"]["order"] == 50
    finally:
        await container.db.close()


async def test_batch_get_read_only_admin_poll_route_output_limit_and_bucket_verify(
    tmp_path: Path,
) -> None:
    """Verify GET ?poll=true is read-only, POST /poll runs, output cap & bucket verify work."""
    settings = _make_settings(tmp_path)
    poll_http_hits = 0
    bucket_verify_hits = 0
    poll_state = {"done": False}

    def _mock_handler(request: httpx.Request) -> httpx.Response:
        nonlocal poll_http_hits, bucket_verify_hits
        if request.method == "POST" and request.url.path == "/upload/v1beta/files":
            return httpx.Response(200, json={"file": {"name": "files/f_ro"}})
        if request.method == "POST" and request.url.path.endswith(":batchGenerateContent"):
            return httpx.Response(200, json={"name": "batches/ro_1"})
        if request.method == "GET" and request.url.path == "/v1beta/batches/ro_1":
            poll_http_hits += 1
            if not poll_state["done"]:
                return httpx.Response(
                    200,
                    json={"done": False, "metadata": {"state": "BATCH_STATE_RUNNING"}},
                )
            return httpx.Response(
                200,
                json={
                    "done": True,
                    "metadata": {"state": "BATCH_STATE_SUCCEEDED"},
                    "response": {"responsesFile": "files/f_ro_out"},
                },
            )
        if (
            request.method == "GET"
            and request.url.path == "/download/v1beta/files/f_ro_out:download"
        ):
            row = json.dumps(
                {
                    "key": "r_1",
                    "response": {
                        "candidates": [{"content": {"parts": [{"text": "polled-ok"}]}}],
                        "usageMetadata": {"promptTokenCount": 50, "candidatesTokenCount": 10},
                    },
                }
            )
            return httpx.Response(200, text=row + "\n")
        if request.url.host == "oauth2.googleapis.com":
            return httpx.Response(200, json={"access_token": "ya29.bkt", "expires_in": 3600})
        if request.url.host == "storage.googleapis.com":
            if request.method == "GET" and request.url.path == "/storage/v1/b/eu-verified-bkt":
                bucket_verify_hits += 1
                return httpx.Response(200, json={"location": "EU"})
            if request.method == "POST" and "/upload/storage/v1/b/" in request.url.path:
                return httpx.Response(200, json={"name": "input.jsonl"})
        if "aiplatform.googleapis.com" in request.url.host and request.method == "POST":
            return httpx.Response(
                200,
                json={"name": "projects/eu-proj/locations/europe-west1/batchPredictionJobs/55"},
            )
        # Oversized stream test endpoint
        if (
            request.method == "GET"
            and request.url.path == "/download/v1beta/files/oversized:download"
        ):
            return httpx.Response(200, content=b"X" * 512)
        if request.method == "GET" and request.url.path == "/v1beta/batches/big_1":
            return httpx.Response(
                200,
                json={
                    "done": True,
                    "metadata": {"state": "BATCH_STATE_SUCCEEDED"},
                    "response": {"responsesFile": "files/oversized"},
                },
            )
        return httpx.Response(404)

    container = build_core_container(settings, admin_token="batch-hardening-tok")
    await container.db.initialize()
    await container.vault.initialize()
    await container.vault.set_secret("GEMINI_API_KEY", "AIzaHardeningKey12345")

    app = FastAPI()
    app.state.container = container
    mount_module_ui_routes(app, container.registry)
    app.include_router(create_core_router(container))
    mount_module_dispatcher(app, container.registry, container.auth)

    try:
        await container.loader.load_active_modules(active_ids={"core-cli", "batch-api"})
        batch_ctx = container.registry.get_context("batch-api")
        assert batch_ctx is not None
        pem = _generate_test_rsa_pem()
        creds = ServiceAccountCredentials(
            client_email="b@eu.iam.gserviceaccount.com",
            private_key=pem,
            project_id="eu-proj",
        )

        async with httpx.AsyncClient(transport=httpx.MockTransport(_mock_handler)) as mock_http:
            batch_ctx.extra["http_client"] = mock_http
            batch_ctx.extra["gcp_token_provider"] = GcpTokenProvider(creds, http_client=mock_http)

            transport = httpx.ASGITransport(app=app)
            dash_cookie, dash_csrf = container.auth.issue_dashboard_session(role="dashboard")
            admin_cookie, admin_csrf = container.auth.issue_dashboard_session(role="admin")

            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
                cookies={"alfred_session": admin_cookie},
            ) as admin:
                sub = await admin.post(
                    "/api/batch/jobs",
                    headers={"X-CSRF-Token": admin_csrf},
                    json={"provider": "gemini", "items": [{"custom_id": "r_1", "prompt": "Hi"}]},
                )
                assert sub.status_code == 201
                job_id = sub.json()["id"]

            # 1. Dashboard GET /api/batch/jobs/{id}?poll=true must NOT trigger remote poll or POST
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
                cookies={"alfred_session": dash_cookie},
            ) as dash:
                ro_get = await dash.get(f"/api/batch/jobs/{job_id}?poll=true")
                assert ro_get.status_code == 200
                assert ro_get.json()["status"] == "submitted"
                assert poll_http_hits == 0

                deny_poll = await dash.post(
                    f"/api/batch/jobs/{job_id}/poll",
                    headers={"X-CSRF-Token": dash_csrf},
                )
                assert deny_poll.status_code == 403

            # 2. Admin POST /api/batch/jobs/{id}/poll requires CSRF & executes poll
            poll_state["done"] = True
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
                cookies={"alfred_session": admin_cookie},
            ) as admin:
                no_csrf_poll = await admin.post(f"/api/batch/jobs/{job_id}/poll")
                assert no_csrf_poll.status_code == 403
                ok_poll = await admin.post(
                    f"/api/batch/jobs/{job_id}/poll",
                    headers={"X-CSRF-Token": admin_csrf},
                )
                assert ok_poll.status_code == 200
                assert ok_poll.json()["status"] == "completed"
                assert poll_http_hits == 1

            # 3. Adapter max_output_bytes limit aborts oversized download before buffering
            limited_gem = GeminiBatchAdapter(
                api_key="AIzaLimit",
                http_client=mock_http,
                max_output_bytes=128,
            )
            with pytest.raises(BatchPayloadLimitError):
                await limited_gem.poll("batches/big_1", "gemini-3.8-flash")

            # 4. VERTEX_EU_VERIFY_BUCKET_LOCATION wired via module config
            await batch_ctx.security.config.update(
                {
                    "VERTEX_EU_BATCH_BUCKET": "eu-verified-bkt",
                    "VERTEX_EU_BATCH_LOCATION": "europe-west1",
                    "VERTEX_EU_VERIFY_BUCKET_LOCATION": "true",
                }
            )
            runner = container.registry.get_service("batch-api")
            assert runner is not None
            mod_runner = sys.modules[f"{module_package_name('batch-api')}.runner"]
            mod_adapters = sys.modules[f"{module_package_name('batch-api')}.adapters"]
            await runner.submit_job(
                mod_runner.BatchSubmitInput(
                    provider="vertex-eu",
                    eu_only=True,
                    items=[
                        mod_adapters.CanonicalBatchRequestItem(
                            custom_id="v1",
                            prompt="Verify bkt",
                            eu_only=True,
                        )
                    ],
                )
            )
            assert bucket_verify_hits == 1
    finally:
        await container.db.close()
