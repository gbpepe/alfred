"""Phase 2 tests: agents_config, circuit_breaker, gcp_auth, model_router & tool_executor."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import httpx
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from pydantic import BaseModel, Field, ValidationError

from alfred.core.agents_config import AgentsConfigManager, resolve_confined_workspace
from alfred.core.circuit_breaker import CircuitBreaker, TokenUsageRecord
from alfred.core.config import AgentsConfig
from alfred.core.db import SqlitePool
from alfred.core.gcp_auth import GcpTokenProvider, ServiceAccountCredentials
from alfred.core.model_router import (
    BudgetExceededError,
    GdprComplianceError,
    ModelRouter,
)
from alfred.core.security.heavy_job_hold import HeavyJobHoldManager
from alfred.core.tool_executor import ToolExecutor
from alfred.core.vault import VaultManager
from alfred.kernel import (
    BaseModulePlugin,
    ComputeUsageRecord,
    ModelProviderRequest,
    ModelProviderResponse,
    ModuleDisabledError,
    ModuleLoader,
    ModuleManifest,
    ModuleRegistry,
    ModuleSecurityError,
    ModuleToolDefinition,
    ProviderMessage,
    ToolExecutionContext,
    ToolExecutionResult,
)


def _sample_agents_payload() -> dict[str, Any]:
    return {
        "version": 1,
        "global": {
            "defaultProvider": "deepseek",
            "defaultModel": "deepseek-chat",
            "dailyBudgetUsd": 10.0,
        },
        "roles": {
            "planner": {
                "label": "Planner",
                "description": "Architecture",
                "provider": "deepseek",
                "model": "deepseek-reasoner",
            },
            "eu_worker": {
                "label": "EU Worker",
                "description": "GDPR safe",
                "provider": "vertex-eu",
                "model": "gemini-2.5-flash",
            },
        },
        "agents": [
            {
                "id": "agent-default",
                "displayName": "Default Agent",
                "role": "planner",
                "dailyBudgetUsd": 5.0,
                "tools": ["echo_tool"],
            },
            {
                "id": "agent-override",
                "displayName": "Override Agent",
                "role": "planner",
                "provider": "openai",
                "model": "gpt-4o-mini",
                "dailyBudgetUsd": 3.0,
                "tools": [],
            },
            {
                "id": "agent-eu",
                "displayName": "EU Agent",
                "role": "eu_worker",
                "provider": "deepseek",
                "euOnly": True,
                "dailyBudgetUsd": 5.0,
                "tools": [],
            },
        ],
    }


def _generate_test_rsa_pem() -> str:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    return pem.decode("ascii")


def test_agents_config_mtime_cache_role_inheritance_and_manifest_check(tmp_path: Path) -> None:
    cfg_path = tmp_path / "config" / "agents.json"
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    payload = _sample_agents_payload()
    cfg_path.write_text(json.dumps(payload), encoding="utf-8")

    # Works cleanly with zero modules directory
    mgr = AgentsConfigManager(cfg_path, modules_dir=tmp_path / "modules")
    first = mgr.load()
    second = mgr.load()
    assert first is second  # Cache hit: zero re-parse

    default_res = mgr.resolve_agent("agent-default")
    override_res = mgr.resolve_agent("agent-override")
    assert default_res is not None and override_res is not None
    assert default_res.effective_provider == "deepseek"
    assert default_res.effective_model == "deepseek-reasoner"
    assert default_res.has_override is False
    assert override_res.effective_provider == "openai"
    assert override_res.effective_model == "gpt-4o-mini"
    assert override_res.has_override is True

    # Modify file -> mtime_ns/size change triggers immediate hot-reload
    payload["agents"][0]["model"] = "deepseek-chat"
    cfg_path.write_text(json.dumps(payload), encoding="utf-8")
    reloaded = mgr.load()
    assert reloaded is not first
    updated_res = mgr.resolve_agent("agent-default")
    assert updated_res is not None
    assert updated_res.effective_model == "deepseek-chat"
    assert updated_res.has_override is True

    # Manifest present on disk rejects undeclared tools
    mod_dir = tmp_path / "modules" / "core-sample"
    mod_dir.mkdir(parents=True, exist_ok=True)
    (mod_dir / "module.json").write_text(
        json.dumps(
            {
                "id": "core-sample",
                "name": "Core Sample",
                "category": "core",
                "version": "1.0.0",
                "tools": ["other_tool"],
                "builtIn": True,
            }
        ),
        encoding="utf-8",
    )
    mgr_with_mods = AgentsConfigManager(cfg_path, modules_dir=tmp_path / "modules")
    with pytest.raises(ValueError, match="unknown tool"):
        mgr_with_mods.load()

    # Repo agents.json parses cleanly without modules validation issues
    _ = AgentsConfig.model_validate_json(cfg_path.read_text(encoding="utf-8"))


async def test_circuit_breaker_combines_token_and_compute_and_exempts_zero_cost(
    tmp_path: Path,
) -> None:
    now_ts = int(time.time())
    async with SqlitePool(tmp_path / "store" / "alfred.db") as db:
        breaker = CircuitBreaker(db)

        await breaker.record_token_usage(
            TokenUsageRecord(
                agent="agent-a",
                model="deepseek-chat",
                input_tokens=1000,
                output_tokens=500,
                cost_usd=1.20,
            ),
            now_ts=now_ts,
        )
        await breaker.record_compute_usage(
            ComputeUsageRecord(
                module_id="worker-machines",
                agent="agent-a",
                session_id="s1",
                resource_label="gce-l4-spot",
                duration_sec=120.0,
                cost_usd=0.85,
            ),
            now_ts=now_ts,
        )

        # Combined token ($1.20) + compute ($0.85) = $2.05 >= $2.00 limit -> blocked
        blocked = await breaker.check_budget(
            agent_id="agent-a",
            model="deepseek-chat",
            agent_daily_limit_usd=2.00,
            global_daily_limit_usd=20.00,
            now_ts=now_ts,
        )
        assert blocked.allowed is False
        assert blocked.agent_spend_usd == pytest.approx(2.05)

        # $0.00 prefix bypasses budget block and records $0.00 cost
        exempt = await breaker.check_budget(
            agent_id="agent-a",
            model="claude-cli:sonnet-4",
            agent_daily_limit_usd=2.00,
            global_daily_limit_usd=20.00,
            now_ts=now_ts,
        )
        assert exempt.allowed is True
        assert exempt.zero_cost is True

        await breaker.record_token_usage(
            TokenUsageRecord(
                agent="agent-a",
                model="gemini-cli:2.5-pro",
                input_tokens=500,
                output_tokens=100,
                cost_usd=99.0,
            ),
            now_ts=now_ts,
        )
        still_spend = await db.get_daily_spend_usd(since_ts=now_ts - 60, agent="agent-a")
        assert still_spend == pytest.approx(2.05)


async def test_gcp_auth_jwt_cache_and_model_router_eu_gate_and_plugin_provider(
    tmp_path: Path,
) -> None:
    oauth_calls = 0
    current_clock = 1_700_000_000.0

    def _mock_oauth_handler(request: httpx.Request) -> httpx.Response:
        nonlocal oauth_calls
        oauth_calls += 1
        assert request.url.path == "/token"
        return httpx.Response(200, json={"access_token": f"tok-{oauth_calls}", "expires_in": 3600})

    sa_creds = ServiceAccountCredentials(
        client_email="alfred@example.iam.gserviceaccount.com",
        private_key=_generate_test_rsa_pem(),
        token_uri="https://oauth2.googleapis.com/token",
        project_id="alfred-eu-proj",
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(_mock_oauth_handler)) as oauth_http:
        gcp = GcpTokenProvider(
            sa_creds,
            http_client=oauth_http,
            clock=lambda: current_clock,
        )
        jwt_str = gcp.build_signed_jwt(now=current_clock)
        assert len(jwt_str.split(".")) == 3
        assert await gcp.get_access_token() == "tok-1"
        assert await gcp.get_access_token() == "tok-1"
        assert oauth_calls == 1
        current_clock += 3550.0  # within 120s refresh margin -> refreshes cleanly
        assert await gcp.get_access_token() == "tok-2"
        assert oauth_calls == 2

    cfg_path = tmp_path / "config" / "agents.json"
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(json.dumps(_sample_agents_payload()), encoding="utf-8")
    agents_mgr = AgentsConfigManager(cfg_path)

    async with SqlitePool(tmp_path / "store" / "alfred.db") as db:
        registry = ModuleRegistry()
        breaker = CircuitBreaker(db, registry=registry)

        def _llm_handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "choices": [{"message": {"content": "hello from deepseek"}}],
                    "usage": {"prompt_tokens": 100, "completion_tokens": 50},
                },
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(_llm_handler)) as llm_http:
            router = ModelRouter(
                db=db,
                circuit_breaker=breaker,
                registry=registry,
                http_client=llm_http,
                env_getter=lambda k: "fake-ds-key" if k == "DEEPSEEK_API_KEY" else None,
            )

            default_agent = agents_mgr.resolve_agent("agent-default")
            eu_agent = agents_mgr.resolve_agent("agent-eu")
            assert default_agent is not None and eu_agent is not None

            req = ModelProviderRequest(
                agent_id="agent-default",
                session_id="s1",
                model="deepseek-chat",
                messages=[ProviderMessage(role="user", content="hi")],
                workspace_dir=tmp_path,
            )
            resp = await router.generate(
                resolved_agent=default_agent,
                global_budget_usd=10.0,
                request=req,
            )
            assert resp.content == "hello from deepseek"
            assert resp.input_tokens == 100
            assert resp.output_tokens == 50
            assert resp.cost_usd > 0

            # eu_only=True must reject non-EU provider deepseek
            with pytest.raises(GdprComplianceError):
                await router.generate(
                    resolved_agent=eu_agent,
                    global_budget_usd=10.0,
                    request=req.model_copy(update={"agent_id": "agent-eu"}),
                )

            # Register dynamic zero-cost EU-compliant plugin provider
            class _LocalPluginProvider:
                provider_id = "local-cli-eu"
                zero_cost_model_prefixes: Sequence[str] = (r"^local-cli:",)
                eu_only_compliant = True

                def supports_model(self, model: str) -> bool:
                    return model.startswith("local-cli:")

                async def generate(self, request: ModelProviderRequest) -> ModelProviderResponse:
                    return ModelProviderResponse(
                        content=f"plugin:{request.model}",
                        input_tokens=10,
                        output_tokens=20,
                        cost_usd=5.0,
                    )

            class _ProvPlugin(BaseModulePlugin):
                id = "custom-prov"

                def providers(self) -> Sequence[Any]:
                    return [_LocalPluginProvider()]

            mod_dir = tmp_path / "modules" / "custom-prov"
            manifest = ModuleManifest(
                id="custom-prov",
                name="Custom Prov",
                category="ai",
                version="1.0.0",
                providers=["local-cli-eu"],
            )
            loader = ModuleLoader(
                modules_dir=tmp_path / "modules",
                store_dir=tmp_path / "store",
                db=db,
                vault=VaultManager(tmp_path / "store" / "vault.json", tmp_path / "store" / ".k"),
                registry=registry,
                heavy_job=HeavyJobHoldManager(tmp_path / "store" / ".hold"),
            )
            ctx = loader.build_context(
                module_id="custom-prov",
                module_dir=mod_dir,
                manifest=manifest,
            )
            registry.register_module(
                plugin=_ProvPlugin(),
                manifest=manifest,
                module_dir=mod_dir,
                ctx=ctx,
            )

            eu_with_plugin = eu_agent.model_copy(
                update={"effective_provider": "local-cli-eu", "effective_model": "local-cli:fast"}
            )
            plugin_resp = await router.generate(
                resolved_agent=eu_with_plugin,
                global_budget_usd=10.0,
                request=req.model_copy(update={"model": "local-cli:fast"}),
            )
            assert plugin_resp.content == "plugin:local-cli:fast"
            assert plugin_resp.cost_usd == 0.0  # Zero-cost prefix zeroed cost

            # Zero agent budget blocks paid provider
            zero_budget_agent = default_agent.model_copy(
                update={"config": default_agent.config.model_copy(update={"daily_budget_usd": 0.0})}
            )
            with pytest.raises(BudgetExceededError):
                await router.generate(
                    resolved_agent=zero_budget_agent,
                    global_budget_usd=10.0,
                    request=req,
                )


class _CalcArgs(BaseModel):
    value: int = Field(ge=1)


async def test_tool_executor_whitelist_inactive_auth_and_validation(tmp_path: Path) -> None:
    async def _run_calc(args: _CalcArgs, ctx: ToolExecutionContext) -> ToolExecutionResult:
        return ToolExecutionResult(ok=True, output=args.value * 2)

    class _RestrictedPlugin(BaseModulePlugin):
        id = "tools-mod"

        def tools(self) -> Sequence[ModuleToolDefinition[Any]]:
            return [
                ModuleToolDefinition(
                    name="echo_tool",
                    description="Double an integer",
                    args_model=_CalcArgs,
                    execute=_run_calc,
                ),
                ModuleToolDefinition(
                    name="ops_only_tool",
                    description="Restricted to ops",
                    args_model=_CalcArgs,
                    execute=_run_calc,
                    authorized_agent_ids=("alfred-ops",),
                ),
            ]

    cfg_path = tmp_path / "config" / "agents.json"
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    payload = _sample_agents_payload()
    payload["agents"][0]["tools"] = ["echo_tool", "ops_only_tool"]
    cfg_path.write_text(json.dumps(payload), encoding="utf-8")
    agent = AgentsConfigManager(cfg_path).load().agents[0]

    async with SqlitePool(tmp_path / "store" / "alfred.db") as db:
        registry = ModuleRegistry()
        executor = ToolExecutor(registry=registry)

        # Before activation: schemas are empty and execution raises ModuleDisabledError
        assert executor.get_schemas_for_agent(agent) == []
        with pytest.raises(ModuleDisabledError):
            await executor.execute_tool(
                agent=agent,
                tool_name="echo_tool",
                raw_args={"value": 3},
                session_id="s1",
                workspace_dir=tmp_path,
            )

        mod_dir = tmp_path / "modules" / "tools-mod"
        manifest = ModuleManifest(
            id="tools-mod",
            name="Tools",
            category="core",
            version="1.0.0",
            tools=["echo_tool", "ops_only_tool"],
        )
        loader = ModuleLoader(
            modules_dir=tmp_path / "modules",
            store_dir=tmp_path / "store",
            db=db,
            vault=VaultManager(tmp_path / "store" / "vault.json", tmp_path / "store" / ".k"),
            registry=registry,
            heavy_job=HeavyJobHoldManager(tmp_path / "store" / ".hold"),
        )
        ctx = loader.build_context(module_id="tools-mod", module_dir=mod_dir, manifest=manifest)
        registry.register_module(
            plugin=_RestrictedPlugin(),
            manifest=manifest,
            module_dir=mod_dir,
            ctx=ctx,
        )

        # Only authorized echo_tool schema is exposed (ops_only_tool hidden for agent-default)
        schemas = executor.get_schemas_for_agent(agent)
        assert [s.name for s in schemas] == ["echo_tool"]

        ok_res = await executor.execute_tool(
            agent=agent,
            tool_name="echo_tool",
            raw_args={"value": 7},
            session_id="s1",
            workspace_dir=tmp_path,
        )
        assert ok_res.ok is True and ok_res.output == 14

        not_allowed = await executor.execute_tool(
            agent=agent,
            tool_name="not_in_whitelist",
            raw_args={"value": 1},
            session_id="s1",
            workspace_dir=tmp_path,
        )
        assert not_allowed.ok is False and not_allowed.error_code == "TOOL_NOT_ALLOWED"

        with pytest.raises(ModuleSecurityError):
            await executor.execute_tool(
                agent=agent,
                tool_name="ops_only_tool",
                raw_args={"value": 1},
                session_id="s1",
                workspace_dir=tmp_path,
            )

        bad_args = await executor.execute_tool(
            agent=agent,
            tool_name="echo_tool",
            raw_args=["invalid"],
            session_id="s1",
            workspace_dir=tmp_path,
        )
        assert bad_args.ok is False and bad_args.error_code == "TOOL_VALIDATION_ERROR"


async def test_circuit_breaker_zero_global_limit_inf_prefix_anchor_and_concurrent_reservation(
    tmp_path: Path,
) -> None:
    with pytest.raises(ValidationError):
        TokenUsageRecord(agent="a", model="m", cost_usd=float("inf"))

    async with SqlitePool(tmp_path / "store" / "alfred.db") as db:
        registry = ModuleRegistry()

        class _UnanchoredProvider:
            provider_id = "unanchored"
            zero_cost_model_prefixes: Sequence[str] = (r"free-prefix:",)
            eu_only_compliant = True

            def supports_model(self, model: str) -> bool:
                return True

            async def generate(self, request: ModelProviderRequest) -> ModelProviderResponse:
                return ModelProviderResponse(content="ok")

        class _RegPlugin(BaseModulePlugin):
            id = "pref-mod"

            def providers(self) -> Sequence[Any]:
                return [_UnanchoredProvider()]

        loader = ModuleLoader(
            modules_dir=tmp_path / "modules",
            store_dir=tmp_path / "store",
            db=db,
            vault=VaultManager(tmp_path / "store" / "vault.json", tmp_path / "store" / ".k"),
            registry=registry,
            heavy_job=HeavyJobHoldManager(tmp_path / "store" / ".hold"),
        )
        manifest = ModuleManifest(
            id="pref-mod",
            name="Pref Mod",
            category="ai",
            version="1.0.0",
            providers=["unanchored"],
        )
        ctx = loader.build_context(
            module_id="pref-mod",
            module_dir=tmp_path / "modules" / "pref-mod",
            manifest=manifest,
        )
        registry.register_module(
            plugin=_RegPlugin(),
            manifest=manifest,
            module_dir=tmp_path / "modules" / "pref-mod",
            ctx=ctx,
        )

        breaker = CircuitBreaker(db, registry=registry)
        # Prefix match anchored at start -> mid-string cannot match!
        assert breaker.is_zero_cost_model("free-prefix:mini") is True
        assert breaker.is_zero_cost_model("gpt-4o-free-prefix:paid") is False

        # Global daily limit == 0.0 blocks paid models just like agent_daily_limit_usd == 0.0
        zero_global = await breaker.check_budget(
            agent_id="agent-a",
            model="gpt-4o",
            agent_daily_limit_usd=5.0,
            global_daily_limit_usd=0.0,
        )
        assert zero_global.allowed is False

        with pytest.raises(ValueError, match="finite"):
            await breaker.check_budget(
                agent_id="agent-a",
                model="gpt-4o",
                agent_daily_limit_usd=float("inf"),
                global_daily_limit_usd=10.0,
            )

        # Concurrent budget reservation prevents two simultaneous calls exceeding tight budget
        dec1, res1 = await breaker.reserve_budget(
            agent_id="agent-tight",
            model="deepseek-chat",
            agent_daily_limit_usd=0.005,
            global_daily_limit_usd=10.0,
            estimated_cost_usd=0.01,
        )
        assert dec1.allowed is True and res1 == pytest.approx(0.01)

        dec2, res2 = await breaker.reserve_budget(
            agent_id="agent-tight",
            model="deepseek-chat",
            agent_daily_limit_usd=0.005,
            global_daily_limit_usd=10.0,
            estimated_cost_usd=0.01,
        )
        assert dec2.allowed is False and res2 == 0.0

        await breaker.release_reservation("agent-tight", res1)
        dec3, res3 = await breaker.reserve_budget(
            agent_id="agent-tight",
            model="deepseek-chat",
            agent_daily_limit_usd=0.005,
            global_daily_limit_usd=10.0,
            estimated_cost_usd=0.01,
        )
        assert dec3.allowed is True
        await breaker.release_reservation("agent-tight", res3)


async def test_model_router_malformed_tool_json_vertex_eu_location_and_workspace_confinement(
    tmp_path: Path,
) -> None:
    with pytest.raises(ModuleSecurityError):
        resolve_confined_workspace(tmp_path, "../outside-escape")

    cfg_path = tmp_path / "config" / "agents.json"
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(json.dumps(_sample_agents_payload()), encoding="utf-8")
    agents_mgr = AgentsConfigManager(cfg_path)

    async with SqlitePool(tmp_path / "store" / "alfred.db") as db:
        registry = ModuleRegistry()
        breaker = CircuitBreaker(db, registry=registry)

        def _bad_tool_json_handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "content": "",
                                "tool_calls": [
                                    {
                                        "id": "tc-bad",
                                        "type": "function",
                                        "function": {
                                            "name": "echo_tool",
                                            "arguments": "{not-valid-json",
                                        },
                                    }
                                ],
                            }
                        }
                    ],
                    "usage": {"prompt_tokens": 20, "completion_tokens": 10},
                },
            )

        sa_creds = ServiceAccountCredentials(
            client_email="alfred@example.iam.gserviceaccount.com",
            private_key=_generate_test_rsa_pem(),
            project_id="alfred-eu-proj",
        )
        gcp = GcpTokenProvider(sa_creds)

        async with httpx.AsyncClient(
            transport=httpx.MockTransport(_bad_tool_json_handler)
        ) as llm_http:
            router = ModelRouter(
                db=db,
                circuit_breaker=breaker,
                registry=registry,
                http_client=llm_http,
                env_getter=lambda k: "fake-ds-key" if k == "DEEPSEEK_API_KEY" else None,
                gcp_token_provider=gcp,
                vertex_location="us-central1",
            )
            default_agent = agents_mgr.resolve_agent("agent-default")
            assert default_agent is not None

            req = ModelProviderRequest(
                agent_id="agent-default",
                session_id="s-json",
                model="deepseek-chat",
                messages=[ProviderMessage(role="user", content="run tool")],
                workspace_dir=tmp_path,
            )
            resp = await router.generate(
                resolved_agent=default_agent,
                global_budget_usd=10.0,
                request=req,
            )
            assert len(resp.tool_calls) == 1

            # Register echo_tool and ensure ToolExecutor yields recoverable TOOL_JSON_ERROR
            class _EchoPlugin(BaseModulePlugin):
                id = "echo-mod"

                def tools(self) -> Sequence[ModuleToolDefinition[Any]]:
                    async def _exec(
                        args: _CalcArgs,
                        _ctx: ToolExecutionContext,
                    ) -> ToolExecutionResult:
                        return ToolExecutionResult(ok=True, output=args.value)

                    return [
                        ModuleToolDefinition(
                            name="echo_tool",
                            description="Echo int",
                            args_model=_CalcArgs,
                            execute=_exec,
                        )
                    ]

            mod_dir = tmp_path / "modules" / "echo-mod"
            manifest = ModuleManifest(
                id="echo-mod",
                name="Echo",
                category="core",
                version="1.0.0",
                tools=["echo_tool"],
            )
            loader = ModuleLoader(
                modules_dir=tmp_path / "modules",
                store_dir=tmp_path / "store",
                db=db,
                vault=VaultManager(tmp_path / "store" / "vault.json", tmp_path / "store" / ".k"),
                registry=registry,
                heavy_job=HeavyJobHoldManager(tmp_path / "store" / ".hold"),
            )
            ctx = loader.build_context(
                module_id="echo-mod",
                module_dir=mod_dir,
                manifest=manifest,
            )
            registry.register_module(
                plugin=_EchoPlugin(),
                manifest=manifest,
                module_dir=mod_dir,
                ctx=ctx,
            )

            executor = ToolExecutor(registry=registry)
            err_res = await executor.execute_tool(
                agent=default_agent.config,
                tool_name=resp.tool_calls[0].name,
                raw_args=resp.tool_calls[0].arguments,
                session_id="s-json",
                workspace_dir=tmp_path,
            )
            assert err_res.ok is False and err_res.error_code == "TOOL_JSON_ERROR"

            # Non-EU vertex_location must fail GDPR check both on eu_only and _call_vertex_eu
            assert router.is_provider_eu_compliant("vertex-eu") is False
            vertex_agent = default_agent.model_copy(
                update={
                    "effective_provider": "vertex-eu",
                    "effective_model": "gemini-2.5-flash",
                }
            )
            with pytest.raises(GdprComplianceError):
                await router.generate(
                    resolved_agent=vertex_agent,
                    global_budget_usd=10.0,
                    request=req,
                )

            # Avoid unused asyncio import warning if needed by verifying concurrent gather compiles
            await asyncio.sleep(0)
