"""Phase 2 tests: ModuleManager hot-sync, Wizard safety, TestSimulator, Daemon & FastAPI app."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest

from alfred.core.config import CoreSettings
from alfred.core.db import SqlitePool
from alfred.core.module_manager import ModuleManager
from alfred.core.module_wizard import (
    FORBIDDEN_WIZARD_ENV_KEYS,
    ModuleWizardService,
    WizardSaveRequest,
)
from alfred.core.run import AlfredDaemon
from alfred.core.security.heavy_job_hold import HeavyJobHoldManager
from alfred.core.vault import VaultManager
from alfred.core.web_app import build_core_container, create_app
from alfred.kernel import (
    ModuleError,
    ModuleLoader,
    ModuleLoadError,
    ModuleRegistry,
    ModuleSecurityError,
    module_package_name,
)


def _setup_workspace(
    tmp_path: Path,
    *,
    include_modules: bool = True,
) -> Path:
    (tmp_path / "config").mkdir(parents=True, exist_ok=True)
    (tmp_path / "docs").mkdir(parents=True, exist_ok=True)
    (tmp_path / "docs" / "01-intro.md").write_text("# Alfred v2\nClean doc.\n", encoding="utf-8")
    (tmp_path / "config" / "agents.json").write_text(
        json.dumps(
            {
                "version": 1,
                "global": {
                    "defaultProvider": "deepseek",
                    "defaultModel": "deepseek-chat",
                    "dailyBudgetUsd": 10.0,
                },
                "roles": {
                    "planner": {
                        "label": "Planner",
                        "description": "Planning",
                        "provider": "deepseek",
                        "model": "deepseek-chat",
                    }
                },
                "agents": [
                    {
                        "id": "alfred-architect",
                        "displayName": "Alfred Architect",
                        "channelName": "#alfred-hq",
                        "discordChannelId": "chan-hq",
                        "role": "planner",
                        "dailyBudgetUsd": 5.0,
                        "tools": [],
                        "systemPrompt": "Be helpful.",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    if include_modules:
        builtin_dir = tmp_path / "modules" / "core-base"
        builtin_dir.mkdir(parents=True, exist_ok=True)
        (builtin_dir / "module.json").write_text(
            json.dumps(
                {
                    "id": "core-base",
                    "name": "Core Base",
                    "category": "core",
                    "version": "1.0.0",
                    "builtIn": True,
                    "defaultEnabled": True,
                }
            ),
            encoding="utf-8",
        )
        (builtin_dir / "plugin.py").write_text(
            "from alfred.kernel.types import BaseModulePlugin\n"
            "class CoreBasePlugin(BaseModulePlugin):\n"
            "    id = 'core-base'\n"
            "    async def on_startup(self, ctx):\n"
            "        ctx.extra['started'] = True\n"
            "    async def on_heartbeat(self, ctx, now_ms):\n"
            "        return {'hb': now_ms}\n"
            "plugin = CoreBasePlugin()\n",
            encoding="utf-8",
        )

        opt_dir = tmp_path / "modules" / "opt-ext"
        opt_dir.mkdir(parents=True, exist_ok=True)
        (opt_dir / "module.json").write_text(
            json.dumps(
                {
                    "id": "opt-ext",
                    "name": "Optional Ext",
                    "category": "ai",
                    "version": "1.0.0",
                    "builtIn": False,
                    "defaultEnabled": False,
                    "depends": ["core-base"],
                    "requiredSecrets": ["OPT_API_KEY"],
                    "setupWizard": {
                        "title": "Opt Wizard",
                        "summary": "Setup opt-ext",
                        "steps": [
                            {
                                "id": "creds",
                                "title": "Credentials",
                                "fields": [
                                    {
                                        "key": "OPT_API_KEY",
                                        "label": "Opt Key",
                                        "type": "secret",
                                        "storage": "vault",
                                    },
                                    {
                                        "key": "OPT_ENV_FLAG",
                                        "label": "Opt Env",
                                        "type": "text",
                                        "storage": "env",
                                    },
                                    {
                                        "key": "opt_mode",
                                        "label": "Opt Mode",
                                        "type": "text",
                                        "storage": "config_json",
                                    },
                                    {
                                        "key": "OPT_PORT",
                                        "label": "Opt Port",
                                        "type": "text",
                                        "storage": "env",
                                        "validationRegex": r"^\d+$",
                                    },
                                    {
                                        "key": "PATH",
                                        "label": "Forbidden Key Test",
                                        "type": "text",
                                        "storage": "env",
                                    },
                                ],
                            }
                        ],
                    },
                }
            ),
            encoding="utf-8",
        )
        (opt_dir / "plugin.py").write_text(
            "from alfred.kernel.types import BaseModulePlugin\n"
            "class OptExtPlugin(BaseModulePlugin):\n"
            "    id = 'opt-ext'\n"
            "plugin = OptExtPlugin()\n",
            encoding="utf-8",
        )
        (opt_dir / "probe.py").write_text(
            "from alfred.kernel.types import ProbeResult\n"
            "async def probe(ctx):\n"
            "    return ProbeResult(ok=True, module_id=ctx.module_id, summary='opt probe ok')\n",
            encoding="utf-8",
        )
    return tmp_path


async def test_module_manager_builtin_protection_and_cross_process_hotsync(
    tmp_path: Path,
) -> None:
    root = _setup_workspace(tmp_path, include_modules=True)
    settings = CoreSettings.from_project_root(root)
    try:
        async with SqlitePool(settings.db_path) as db:
            vault = VaultManager(settings.vault_path, settings.vault_key_path)

            # Process A (Web Dashboard side)
            reg_web = ModuleRegistry()
            loader_web = ModuleLoader(
                modules_dir=settings.modules_dir,
                store_dir=settings.store_dir,
                db=db,
                vault=vault,
                registry=reg_web,
                heavy_job=HeavyJobHoldManager(settings.heavy_job_lock_path),
                project_root=settings.project_root,
            )
            await loader_web.load_active_modules()
            mgr_web = ModuleManager(
                settings=settings,
                db=db,
                vault=vault,
                registry=reg_web,
                loader=loader_web,
            )

            # Process B (Daemon worker side)
            reg_worker = ModuleRegistry()
            loader_worker = ModuleLoader(
                modules_dir=settings.modules_dir,
                store_dir=settings.store_dir,
                db=db,
                vault=vault,
                registry=reg_worker,
                heavy_job=HeavyJobHoldManager(settings.heavy_job_lock_path),
                project_root=settings.project_root,
            )
            await loader_worker.load_active_modules()
            mgr_worker = ModuleManager(
                settings=settings,
                db=db,
                vault=vault,
                registry=reg_worker,
                loader=loader_worker,
            )

            # Built-in module cannot be deactivated
            with pytest.raises(ModuleError) as prot_err:
                await mgr_web.deactivate_module("core-base")
            assert prot_err.value.status_code == 403
            assert prot_err.value.code == "BUILTIN_MODULE_PROTECTED"

            # Web activates opt-ext -> touches .modules-generation -> worker hot-syncs cleanly
            assert not reg_worker.is_active("opt-ext")
            await mgr_web.activate_module("opt-ext")
            assert settings.modules_generation_path.exists()
            assert await mgr_worker.sync_with_database() is True
            assert reg_worker.is_active("opt-ext")
            assert await mgr_worker.sync_with_database() is False  # generation unchanged

            # Web deactivates opt-ext -> worker hot-syncs unload
            await mgr_web.deactivate_module("opt-ext")
            assert await mgr_worker.sync_with_database() is True
            assert not reg_worker.is_active("opt-ext")
    finally:
        for mid in ("core-base", "opt-ext"):
            sys.modules.pop(module_package_name(mid), None)


async def test_module_wizard_forbidden_keys_storage_routing_and_probe(tmp_path: Path) -> None:
    root = _setup_workspace(tmp_path, include_modules=True)
    settings = CoreSettings.from_project_root(root)
    opt_pkg = module_package_name("opt-ext")
    try:
        async with SqlitePool(settings.db_path) as db:
            vault = VaultManager(settings.vault_path, settings.vault_key_path)
            registry = ModuleRegistry()
            loader = ModuleLoader(
                modules_dir=settings.modules_dir,
                store_dir=settings.store_dir,
                db=db,
                vault=vault,
                registry=registry,
                heavy_job=HeavyJobHoldManager(settings.heavy_job_lock_path),
                project_root=settings.project_root,
            )
            wizard = ModuleWizardService(settings=settings, db=db, vault=vault, loader=loader)

            # Rejects FORBIDDEN_WIZARD_ENV_KEYS (e.g. PATH)
            assert "PATH" in FORBIDDEN_WIZARD_ENV_KEYS
            with pytest.raises(ModuleSecurityError):
                await wizard.save_wizard_values(
                    "opt-ext",
                    WizardSaveRequest(values={"PATH": "/evil"}),
                )

            # Saves Vault + .env + config_json cleanly without leaking secret values in GET
            saved = await wizard.save_wizard_values(
                "opt-ext",
                WizardSaveRequest(
                    values={
                        "OPT_API_KEY": "super-secret-opt-val",
                        "OPT_ENV_FLAG": "enabled",
                        "opt_mode": "turbo",
                    }
                ),
            )
            assert saved.ok is True
            assert await vault.get_secret("OPT_API_KEY") == "super-secret-opt-val"
            assert "OPT_ENV_FLAG=enabled" in settings.env_path.read_text(encoding="utf-8")

            state = await wizard.get_wizard_state("opt-ext")
            by_key = {f.key: f for f in state.steps[0].fields}
            assert by_key["OPT_API_KEY"].configured is True
            assert by_key["OPT_API_KEY"].value is None  # secret never leaked
            assert by_key["OPT_ENV_FLAG"].value == "enabled"
            assert by_key["opt_mode"].value == "turbo"

            # Inactive probe runs without importing opt-ext plugin.py
            assert opt_pkg not in sys.modules
            probe_res = await wizard.run_probe("opt-ext")
            assert probe_res.ok is True and probe_res.summary == "opt probe ok"
            assert opt_pkg not in sys.modules
    finally:
        for mid in ("core-base", "opt-ext"):
            sys.modules.pop(module_package_name(mid), None)


async def test_web_app_auth_csrf_405_vault_redaction_and_testsim(tmp_path: Path) -> None:
    # Zero modules present! Whole FastAPI app + core must work 100% cleanly.
    root_prod = _setup_workspace(tmp_path / "prod", include_modules=False)
    prod_settings = CoreSettings.from_project_root(root_prod, environment="prod")
    app_prod = create_app(prod_settings, admin_token="prod-secret-tok")

    async with app_prod.router.lifespan_context(app_prod):
        container = app_prod.state.container
        session_cookie, csrf_token = container.auth.issue_dashboard_session()
        transport = httpx.ASGITransport(app=app_prod)

        async with httpx.AsyncClient(transport=transport, base_url="http://test") as anon:
            assert (await anon.get("/api/core/health")).status_code == 200
            assert (await anon.post("/api/core/health")).status_code == 405
            assert (await anon.get("/api/vault")).status_code == 401
            assert (await anon.get("/api/modules")).status_code == 401

        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://test",
            cookies={"alfred_session": session_cookie},
        ) as admin_client:
            # Missing CSRF -> 403
            no_csrf = await admin_client.post(
                "/api/vault",
                json={"keyId": "K1", "value": "top-secret-999"},
            )
            assert no_csrf.status_code == 403

            # Valid CSRF -> 200 and NO raw secret value returned anywhere
            ok_set = await admin_client.post(
                "/api/vault",
                headers={"X-CSRF-Token": csrf_token},
                json={"keyId": "K1", "value": "top-secret-999", "label": "Demo"},
            )
            assert ok_set.status_code == 200
            assert "top-secret-999" not in ok_set.text

            vault_list = await admin_client.get("/api/vault")
            assert vault_list.status_code == 200
            assert "top-secret-999" not in vault_list.text
            assert vault_list.json()["secrets"][0]["key_id"] == "K1"

            assert (await admin_client.get("/api/overview")).status_code == 200
            assert (await admin_client.get("/api/docs")).status_code == 200
            doc_ok = await admin_client.get("/api/docs/01-intro.md")
            assert doc_ok.status_code == 200 and "Alfred v2" in doc_ok.json()["content"]
            assert (await admin_client.get("/api/docs/../.env")).status_code in (403, 404)

            # TestSim MUST be 404 disabled in prod
            prod_sim = await admin_client.post(
                "/api/testsim/send",
                headers={"X-CSRF-Token": csrf_token},
                json={"agentId": "alfred-architect", "message": "hi"},
            )
            assert prod_sim.status_code == 404
            assert prod_sim.json()["error"] == "TESTSIM_DISABLED"

    # Staging ALFRED_ENV=test enables isolated #testsim without touching Discord
    root_test = _setup_workspace(tmp_path / "staging", include_modules=False)
    test_settings = CoreSettings.from_project_root(root_test, environment="test")

    def _mock_llm(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "staging simulated reply"}}],
                "usage": {"prompt_tokens": 12, "completion_tokens": 8},
            },
        )

    async with httpx.AsyncClient(transport=httpx.MockTransport(_mock_llm)) as mock_http:
        app_test = create_app(test_settings, admin_token="stg-tok", http_client=mock_http)
        async with app_test.router.lifespan_context(app_test):
            await app_test.state.container.vault.set_secret("DEEPSEEK_API_KEY", "ds-test-key")
            transport_t = httpx.ASGITransport(app=app_test)
            async with httpx.AsyncClient(
                transport=transport_t,
                base_url="http://test",
                headers={"Authorization": "Bearer stg-tok"},
            ) as bearer_client:
                sim_res = await bearer_client.post(
                    "/api/testsim/send",
                    json={"agentId": "alfred-architect", "message": "ping simulator"},
                )
                assert sim_res.status_code == 200
                body = sim_res.json()
                assert body["reply"] == "staging simulated reply"
                assert body["inputTokens"] == 12
                assert body["outputTokens"] == 8


async def test_daemon_startup_heartbeat_and_shutdown(tmp_path: Path) -> None:
    root = _setup_workspace(tmp_path / "daemon", include_modules=True)
    settings = CoreSettings.from_project_root(root, environment="test")
    try:
        container = build_core_container(settings, admin_token="d-tok")
        daemon = AlfredDaemon(container, heartbeat_interval_sec=60.0)
        await daemon.start()
        ctx = container.registry.get_context("core-base")
        assert ctx is not None and ctx.extra.get("started") is True

        hb_results: dict[str, Any] = await daemon.run_heartbeat_tick(now_ms=1234567)
        assert hb_results == {"core-base": {"hb": 1234567}}
        await daemon.shutdown()
        assert not container.registry.is_active("core-base")
    finally:
        for mid in ("core-base", "opt-ext"):
            sys.modules.pop(module_package_name(mid), None)


async def test_wizard_forbidden_variants_regex_and_route_secret_redaction_and_errors(
    tmp_path: Path,
) -> None:
    root = _setup_workspace(tmp_path / "wizweb", include_modules=True)
    settings = CoreSettings.from_project_root(root, environment="test")
    app = create_app(settings, admin_token="wiz-tok")
    try:
        async with app.router.lifespan_context(app):
            container = app.state.container
            # Forbidden key case/whitespace and prefix variants
            for bad_key in (" pythonstartup ", "ALFRED_ENV", "path", "PYTHON_CUSTOM"):
                with pytest.raises(ModuleSecurityError):
                    await container.module_wizard.save_wizard_values(
                        "opt-ext",
                        WizardSaveRequest(values={bad_key: "evil"}),
                    )

            # Regex validation error -> 400 WIZARD_VALIDATION_ERROR
            with pytest.raises(ModuleError) as regex_err:
                await container.module_wizard.save_wizard_values(
                    "opt-ext",
                    WizardSaveRequest(values={"OPT_PORT": "not-digits"}),
                )
            assert regex_err.value.status_code == 400
            assert regex_err.value.code == "WIZARD_VALIDATION_ERROR"

            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
                headers={"Authorization": "Bearer wiz-tok"},
            ) as client:
                # Vault ValidationError MUST NOT echo input secret value
                vault_bad = await client.post(
                    "/api/vault",
                    json={"keyId": "", "value": "TOP-SECRET-VAULT-INPUT-777"},
                )
                assert vault_bad.status_code == 400
                assert "TOP-SECRET-VAULT-INPUT-777" not in vault_bad.text

                # Wizard ValidationError MUST NOT echo input secret value
                wiz_bad = await client.post(
                    "/api/modules/opt-ext/wizard",
                    json={"values": {"OPT_API_KEY": ["TOP-SECRET-WIZARD-999"]}},
                )
                assert wiz_bad.status_code == 400
                assert "TOP-SECRET-WIZARD-999" not in wiz_bad.text

                # Missing agents.json returns clean 404 instead of unhandled 500
                settings.agents_config_path.unlink()
                assert (await client.get("/api/agents")).status_code == 404
                assert (await client.get("/api/overview")).status_code == 404
    finally:
        for mid in ("core-base", "opt-ext"):
            sys.modules.pop(module_package_name(mid), None)


async def test_testsim_maps_gdpr_budget_and_provider_errors_to_http_codes(tmp_path: Path) -> None:
    root = _setup_workspace(tmp_path / "simerr", include_modules=False)
    (root / "config" / "agents.json").write_text(
        json.dumps(
            {
                "version": 1,
                "global": {
                    "defaultProvider": "deepseek",
                    "defaultModel": "deepseek-chat",
                    "dailyBudgetUsd": 10.0,
                },
                "roles": {
                    "planner": {
                        "label": "Planner",
                        "description": "Planning",
                        "provider": "deepseek",
                        "model": "deepseek-chat",
                    }
                },
                "agents": [
                    {
                        "id": "eu-blocked",
                        "displayName": "EU Blocked",
                        "role": "planner",
                        "provider": "deepseek",
                        "euOnly": True,
                        "dailyBudgetUsd": 5.0,
                    },
                    {
                        "id": "budget-zero",
                        "displayName": "Budget Zero",
                        "role": "planner",
                        "provider": "deepseek",
                        "dailyBudgetUsd": 0.0,
                    },
                    {
                        "id": "missing-prov",
                        "displayName": "Missing Prov",
                        "role": "planner",
                        "provider": "nonexistent-provider",
                        "dailyBudgetUsd": 5.0,
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    settings = CoreSettings.from_project_root(root, environment="test")
    app = create_app(settings, admin_token="sim-tok")
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://test",
            headers={"Authorization": "Bearer sim-tok"},
        ) as client:
            r_gdpr = await client.post(
                "/api/testsim/send",
                json={"agentId": "eu-blocked", "message": "hi"},
            )
            assert r_gdpr.status_code == 403
            assert r_gdpr.json()["error"] == "GDPR_COMPLIANCE_ERROR"

            r_budget = await client.post(
                "/api/testsim/send",
                json={"agentId": "budget-zero", "message": "hi"},
            )
            assert r_budget.status_code == 429
            assert r_budget.json()["error"] == "BUDGET_EXCEEDED"

            r_prov = await client.post(
                "/api/testsim/send",
                json={"agentId": "missing-prov", "message": "hi"},
            )
            assert r_prov.status_code == 400
            assert r_prov.json()["error"] == "PROVIDER_NOT_FOUND"


async def test_module_manager_activate_rollback_on_load_failure(tmp_path: Path) -> None:
    root = _setup_workspace(tmp_path / "rollback", include_modules=True)
    broken_dir = root / "modules" / "broken-mod"
    broken_dir.mkdir(parents=True, exist_ok=True)
    (broken_dir / "module.json").write_text(
        json.dumps(
            {
                "id": "broken-mod",
                "name": "Broken Mod",
                "category": "ai",
                "version": "1.0.0",
                "builtIn": False,
                "defaultEnabled": False,
            }
        ),
        encoding="utf-8",
    )
    (broken_dir / "plugin.py").write_text(
        "from alfred.kernel.types import BaseModulePlugin\n"
        "class BrokenPlugin(BaseModulePlugin):\n"
        "    id = 'broken-mod'\n"
        "    async def on_load(self, ctx):\n"
        "        raise RuntimeError('plugin init boom')\n"
        "plugin = BrokenPlugin()\n",
        encoding="utf-8",
    )
    settings = CoreSettings.from_project_root(root)
    try:
        async with SqlitePool(settings.db_path) as db:
            vault = VaultManager(settings.vault_path, settings.vault_key_path)
            registry = ModuleRegistry()
            loader = ModuleLoader(
                modules_dir=settings.modules_dir,
                store_dir=settings.store_dir,
                db=db,
                vault=vault,
                registry=registry,
                heavy_job=HeavyJobHoldManager(settings.heavy_job_lock_path),
                project_root=settings.project_root,
            )
            mgr = ModuleManager(
                settings=settings,
                db=db,
                vault=vault,
                registry=registry,
                loader=loader,
            )
            with pytest.raises(ModuleLoadError):
                await mgr.activate_module("broken-mod")
            row = await db.get_module_row("broken-mod")
            assert row is not None and row.state == "available"
    finally:
        for mid in ("core-base", "opt-ext", "broken-mod"):
            sys.modules.pop(module_package_name(mid), None)


async def test_daemon_run_until_stopped_graceful_order_with_inflight_heartbeat(
    tmp_path: Path,
) -> None:
    root = _setup_workspace(tmp_path / "graceful", include_modules=True)
    hb_started = asyncio.Event()
    hb_db_ok = False
    (root / "modules" / "core-base" / "plugin.py").write_text(
        "from alfred.kernel.types import BaseModulePlugin\n"
        "class CoreBasePlugin(BaseModulePlugin):\n"
        "    id = 'core-base'\n"
        "plugin = CoreBasePlugin()\n",
        encoding="utf-8",
    )
    settings = CoreSettings.from_project_root(root, environment="test")
    try:
        container = build_core_container(settings, admin_token="g-tok")

        class _SlowHbDaemon(AlfredDaemon):
            async def run_heartbeat_tick(self, now_ms: int | None = None) -> dict[str, Any]:
                nonlocal hb_db_ok
                hb_started.set()
                try:
                    await asyncio.sleep(0.5)
                finally:
                    # DB must remain open while background tasks unwind before shutdown()
                    await self.container.db.list_module_rows()
                    hb_db_ok = True
                return await super().run_heartbeat_tick(now_ms=now_ms)

        daemon = _SlowHbDaemon(container, heartbeat_interval_sec=60.0)
        runner = asyncio.create_task(daemon.run_until_stopped())
        await asyncio.wait_for(hb_started.wait(), timeout=2.0)
        daemon.stop()
        await asyncio.wait_for(runner, timeout=2.0)
        assert hb_db_ok is True
    finally:
        for mid in ("core-base", "opt-ext"):
            sys.modules.pop(module_package_name(mid), None)


def test_create_app_prod_requires_admin_token(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ALFRED_DASHBOARD_TOKEN", raising=False)
    root = _setup_workspace(tmp_path / "prodtok", include_modules=False)
    prod_settings = CoreSettings.from_project_root(root, environment="prod")
    with pytest.raises(RuntimeError, match="ALFRED_DASHBOARD_TOKEN"):
        create_app(prod_settings)
