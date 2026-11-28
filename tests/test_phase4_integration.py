"""Phase 4 integration tests covering lazy modules `batch-api` and `cloud-storage`."""

from __future__ import annotations

import ast
import re
import shutil
import sqlite3
import sys
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from alfred.core.agents_config import AgentsConfigManager
from alfred.core.config import CoreSettings
from alfred.core.db import SqlitePool
from alfred.core.routes import create_core_router
from alfred.core.security.heavy_job_hold import HeavyJobHoldManager
from alfred.core.vault import VaultManager
from alfred.core.web_app import CoreAppContainer, build_core_container, create_app
from alfred.kernel import (
    AlfredModulePlugin,
    MissingDependencyError,
    ModuleDisabledError,
    ModuleError,
    ModuleLoader,
    ModuleManifest,
    ModuleRegistry,
    module_package_name,
)
from alfred.kernel.http_bridge import mount_module_dispatcher, mount_module_ui_routes
from alfred.kernel.loader import apply_module_migrations

REPO_ROOT = Path(__file__).resolve().parent.parent
MODULES_DIR = REPO_ROOT / "modules"
AGENTS_CONFIG_PATH = REPO_ROOT / "config" / "agents.json"

BUILTIN_MODULE_IDS: tuple[str, ...] = (
    "core-cli",
    "core-ops",
    "core-memory",
    "core-kanban",
)
OPTIONAL_MODULE_IDS: tuple[str, ...] = (
    "batch-api",
    "cloud-storage",
)
ALL_MODULE_IDS: tuple[str, ...] = BUILTIN_MODULE_IDS + OPTIONAL_MODULE_IDS

BUILTIN_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "fs_read",
        "fs_write",
        "bash",
        "git",
        "cli_manage",
        "system_storage",
        "module_manage",
        "memory",
    }
)
BATCH_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "batch_submit",
        "batch_status",
        "batch_list",
        "batch_cancel",
    }
)
CLOUD_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "cloud_list",
        "cloud_mkdir",
        "cloud_upload",
        "cloud_download",
        "cloud_share",
    }
)
CLOUD_ONLY_SANITIZE_KEYS: frozenset[str] = frozenset(
    {
        "cloud_gdrive_client_id",
        "cloud_gdrive_client_secret",
        "cloud_gdrive_refresh_token",
        "cloud_onedrive_client_id",
        "cloud_onedrive_client_secret",
        "cloud_onedrive_refresh_token",
        "cloud_dropbox_client_id",
        "cloud_dropbox_client_secret",
        "cloud_dropbox_refresh_token",
        "CLOUD_GDRIVE_REFRESH_TOKEN",
        "CLOUD_ONEDRIVE_REFRESH_TOKEN",
        "CLOUD_DROPBOX_REFRESH_TOKEN",
        "ALFRED_CLOUD_SHARE_EMAIL",
    }
)

TYPE_IGNORE_PATTERN = re.compile(r"#\s*type:\s*ignore")


def _purge_alfred_dynamic_sys_modules() -> None:
    """Remove `_alfred_mod_*` and `_alfred_probe_*` dynamic namespaces cleanly."""
    for key in list(sys.modules.keys()):
        if key.startswith("_alfred_mod_") or key.startswith("_alfred_probe_"):
            sys.modules.pop(key, None)


def _has_module_sys_entries(module_id: str) -> list[str]:
    prefix = module_package_name(module_id)
    return [
        key
        for key in sys.modules
        if key == prefix or key.startswith(f"{prefix}.")
    ]


@pytest.fixture(autouse=True)
def _isolate_phase4_env_and_sys_modules(
    monkeypatch: pytest.MonkeyPatch,
) -> Iterator[None]:
    for env_key in (
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "OPENAI_API_KEY",
        "VERTEX_EU_BATCH_BUCKET",
        "VERTEX_EU_BATCH_LOCATION",
        "VERTEX_EU_LOCATION",
        "VERTEX_LOCATION",
        "VERTEX_EU_ACCESS_TOKEN",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "ALFRED_CLOUD_SHARE_EMAIL",
        "ALFRED_CLOUD_MAX_DOWNLOAD_MB",
    ):
        monkeypatch.delenv(env_key, raising=False)
    _purge_alfred_dynamic_sys_modules()
    yield
    _purge_alfred_dynamic_sys_modules()


def _make_repo_backed_settings(tmp_path: Path) -> CoreSettings:
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


def _extract_module_import_targets(tree: ast.AST) -> list[str]:
    targets: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            targets.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module is not None:
            targets.append(node.module)
        elif isinstance(node, ast.Call):
            fn = node.func
            is_dynamic_import = (
                (isinstance(fn, ast.Name) and fn.id in ("__import__", "import_module"))
                or (isinstance(fn, ast.Attribute) and fn.attr == "import_module")
            )
            if is_dynamic_import and node.args:
                arg0 = node.args[0]
                if isinstance(arg0, ast.Constant) and isinstance(arg0.value, str):
                    targets.append(arg0.value)
    return targets


def _extract_relative_import_modules(tree: ast.AST) -> list[str]:
    rel_targets: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.level > 0 and node.module is not None:
            rel_targets.append(node.module)
    return rel_targets


def test_ast_and_source_audit_all_modules() -> None:
    """Audit ALL `modules/*` for zero cross-module imports, probe isolation, JS safety & ignores."""
    module_dirs = [
        child
        for child in sorted(MODULES_DIR.iterdir(), key=lambda p: p.name)
        if child.is_dir() and not child.name.startswith((".", "__"))
    ]
    assert {d.name for d in module_dirs} >= set(ALL_MODULE_IDS)

    package_owner: dict[str, str] = {
        d.name.replace("-", "_"): d.name for d in module_dirs
    }
    py_files = sorted(MODULES_DIR.rglob("*.py"))
    assert len(py_files) >= 35

    for mod_dir in module_dirs:
        top_level_py = list(mod_dir.glob("*.py"))
        assert top_level_py == [], (
            f"Module '{mod_dir.name}' must not contain top-level .py files: {top_level_py}"
        )

    for py_file in py_files:
        source = py_file.read_text(encoding="utf-8")
        assert TYPE_IGNORE_PATTERN.search(source) is None, (
            f"Forbidden type ignore comment found in {py_file}"
        )

        rel_parts = py_file.relative_to(MODULES_DIR).parts
        tree = ast.parse(source, filename=str(py_file))
        if len(rel_parts) == 1:
            assert _extract_module_import_targets(tree) == []
            continue

        current_mod = rel_parts[0]
        for target in _extract_module_import_targets(tree):
            top = target.split(".", 1)[0]
            assert target != "modules" and not target.startswith("modules."), (
                f"Module '{current_mod}' ({py_file.name}) imports '{target}' via modules.*"
            )
            assert not target.startswith("_alfred_mod_") and not target.startswith(
                "_alfred_probe_"
            ), f"Module '{current_mod}' ({py_file.name}) imports internal kernel pkg '{target}'"
            if top in package_owner and package_owner[top] != current_mod:
                raise AssertionError(
                    f"Cross-module import detected in {py_file}: "
                    f"'{target}' belongs to '{package_owner[top]}'"
                )

    for opt_mod, heavy_siblings in (
        ("batch-api", {"plugin", "runner", "routes", "tools"}),
        ("cloud-storage", {"plugin", "engine", "routes", "tools"}),
    ):
        pkg_name = opt_mod.replace("-", "_")
        probe_path = MODULES_DIR / opt_mod / pkg_name / "probe.py"
        probe_tree = ast.parse(probe_path.read_text(encoding="utf-8"), filename=str(probe_path))
        for rel_target in _extract_relative_import_modules(probe_tree):
            root_part = rel_target.split(".", 1)[0]
            assert root_part not in heavy_siblings, (
                f"{opt_mod}/probe.py must stay lightweight and not import '{rel_target}'"
            )

    for root_dir in (REPO_ROOT / "alfred", REPO_ROOT / "modules", REPO_ROOT / "tests"):
        for py_file in sorted(root_dir.rglob("*.py")):
            text = py_file.read_text(encoding="utf-8")
            assert TYPE_IGNORE_PATTERN.search(text) is None, (
                f"Forbidden type ignore comment found in {py_file}"
            )

    js_files = sorted(MODULES_DIR.glob("*/ui/*.js"))
    assert len(js_files) >= 6
    for js_file in js_files:
        js_src = js_file.read_text(encoding="utf-8")
        assert re.search(r"\bexport\s+function\s+mount\s*\(", js_src), (
            f"Missing ES6 export mount() in {js_file}"
        )
        assert re.search(r"\bexport\s+function\s+unmount\s*\(", js_src), (
            f"Missing ES6 export unmount() in {js_file}"
        )
        for forbidden_sink in ("innerHTML", "outerHTML", "insertAdjacentHTML"):
            assert forbidden_sink not in js_src, (
                f"Unsafe DOM sink '{forbidden_sink}' found in {js_file}"
            )


def test_agents_config_validates_against_full_repo_modules() -> None:
    """Verify `AgentsConfigManager` passes against repo `config/agents.json` & all 6 modules."""
    mgr = AgentsConfigManager(AGENTS_CONFIG_PATH, modules_dir=MODULES_DIR)
    cfg = mgr.load(validate_manifests=True)
    resolved = {item.config.id: item for item in mgr.list_resolved_agents()}
    assert "alfred-batch" in resolved
    assert "alfred-architect" in resolved
    assert "alfred-ops" in resolved

    batch_agent = cfg.get_agent("alfred-batch")
    assert batch_agent is not None
    assert BATCH_TOOL_NAMES.issubset(set(batch_agent.tools))
    assert resolved["alfred-batch"].effective_provider == "vertex-eu"
    assert resolved["alfred-batch"].effective_model == "gemini-2.5-flash"

    arch_agent = cfg.get_agent("alfred-architect")
    assert arch_agent is not None
    assert {"batch_status", "batch_list"}.issubset(set(arch_agent.tools))


async def test_default_boot_lazy_gate_and_404_ui_while_inactive(tmp_path: Path) -> None:
    """Default repo boot loads ONLY the 4 built-ins, imports 0 optional code & serves 404 UI."""
    # 1) Direct `ModuleLoader.load_active_modules()` on full repo `modules/`
    loader_root = tmp_path / "direct-loader"
    loader_settings = _make_repo_backed_settings(loader_root)
    async with SqlitePool(loader_settings.db_path) as db:
        vault = VaultManager(loader_settings.vault_path, loader_settings.vault_key_path)
        await vault.initialize()
        registry = ModuleRegistry()
        loader = ModuleLoader(
            modules_dir=MODULES_DIR,
            store_dir=loader_settings.store_dir,
            db=db,
            vault=vault,
            registry=registry,
            heavy_job=HeavyJobHoldManager(loader_settings.heavy_job_lock_path),
            project_root=loader_settings.project_root,
        )
        discovered = loader.discover()
        assert set(ALL_MODULE_IDS).issubset(set(discovered.keys()))
        for opt_id in OPTIONAL_MODULE_IDS:
            _, manifest = discovered[opt_id]
            assert isinstance(manifest, ModuleManifest)
            assert manifest.built_in is False
            assert manifest.default_enabled is False

        loaded = await loader.load_active_modules()
        assert set(loaded) == set(BUILTIN_MODULE_IDS)
        assert loaded.index("core-cli") < loaded.index("core-ops")
        assert _has_module_sys_entries("batch-api") == []
        assert _has_module_sys_entries("cloud-storage") == []

        rows = {row.module_id: row.state for row in await db.list_module_rows()}
        for bid in BUILTIN_MODULE_IDS:
            assert rows.get(bid) == "active"
        for opt_id in OPTIONAL_MODULE_IDS:
            assert rows.get(opt_id) == "available"
            assert registry.is_active(opt_id) is False

    _purge_alfred_dynamic_sys_modules()

    # 2) Full `create_app()` lifespan against repo `modules/`
    app_settings = _make_repo_backed_settings(tmp_path / "full-app")
    app = create_app(app_settings, admin_token="phase4-lazy-token")
    async with app.router.lifespan_context(app):
        container: CoreAppContainer = app.state.container
        admin_cookie, _ = container.auth.issue_dashboard_session(role="admin")
        transport = httpx.ASGITransport(app=app)

        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://test",
            cookies={"alfred_session": admin_cookie},
        ) as client:
            health = await client.get("/api/core/health")
            assert health.status_code == 200
            assert set(health.json()["activeModules"]) == set(BUILTIN_MODULE_IDS)

            assert _has_module_sys_entries("batch-api") == []
            assert _has_module_sys_entries("cloud-storage") == []

            for ui_path in (
                "/api/modules/batch-api/ui/batch-card.js",
                "/api/modules/cloud-storage/ui/cloud-card.js",
            ):
                get_resp = await client.get(ui_path)
                assert get_resp.status_code == 404
                assert get_resp.json()["error"] == "MODULE_DISABLED"
                head_resp = await client.head(ui_path)
                assert head_resp.status_code == 404

            assert (await client.get("/api/batch/jobs")).status_code == 404
            assert (await client.get("/api/cloud/status")).status_code == 404

            mods_resp = await client.get("/api/modules")
            assert mods_resp.status_code == 200
            mods_payload = mods_resp.json()
            by_id = {m["id"]: m for m in mods_payload["modules"]}
            assert by_id["batch-api"]["state"] == "available"
            assert by_id["batch-api"]["builtIn"] is False
            assert by_id["cloud-storage"]["state"] == "available"
            assert by_id["cloud-storage"]["builtIn"] is False

            ui_ids = {c["id"] for c in mods_payload["uiContributions"]}
            assert "vpsBatchCard" not in ui_ids
            assert "vpsCloudStorageCard" not in ui_ids

            assert _has_module_sys_entries("batch-api") == []
            assert _has_module_sys_entries("cloud-storage") == []


async def test_inactive_probes_run_without_importing_plugin_py(tmp_path: Path) -> None:
    """Inactive probes for `batch-api` and `cloud-storage` never import `plugin.py`."""
    settings = _make_repo_backed_settings(tmp_path)
    container = build_core_container(settings, admin_token="phase4-probe-token")
    await container.db.initialize()
    await container.vault.initialize()

    app = FastAPI(title="Alfred v2 Phase4 Probe Test")
    app.state.container = container
    mount_module_ui_routes(app, container.registry)
    app.include_router(create_core_router(container))
    mount_module_dispatcher(app, container.registry, container.auth)

    try:
        loaded = await container.loader.load_active_modules()
        assert set(loaded) == set(BUILTIN_MODULE_IDS)
        assert _has_module_sys_entries("batch-api") == []
        assert _has_module_sys_entries("cloud-storage") == []

        # 1) Unconfigured inactive probes return structured `ok=False` without loading `plugin.py`
        batch_probe_cold = await container.loader.probe_inactive_module("batch-api")
        assert batch_probe_cold.module_id == "batch-api"
        assert batch_probe_cold.ok is False
        assert len(batch_probe_cold.checks) >= 4
        assert _has_module_sys_entries("batch-api") == []

        cloud_probe_cold = await container.loader.probe_inactive_module("cloud-storage")
        assert cloud_probe_cold.module_id == "cloud-storage"
        assert cloud_probe_cold.ok is False
        assert len(cloud_probe_cold.checks) >= 4
        assert _has_module_sys_entries("cloud-storage") == []

        # 2) Configure via Setup Wizard HTTP endpoints & run HTTP probes while still inactive
        admin_cookie, admin_csrf = container.auth.issue_dashboard_session(role="admin")
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://test",
            cookies={"alfred_session": admin_cookie},
        ) as client:
            save_batch = await client.post(
                "/api/modules/batch-api/wizard",
                headers={"X-CSRF-Token": admin_csrf},
                json={"values": {"GEMINI_API_KEY": "AIza-phase4-probe-test-key"}},
            )
            assert save_batch.status_code == 200
            assert save_batch.json()["savedKeys"] == ["GEMINI_API_KEY"]

            save_cloud = await client.post(
                "/api/modules/cloud-storage/wizard",
                headers={"X-CSRF-Token": admin_csrf},
                json={
                    "values": {
                        "cloud_gdrive_client_id": "12345.apps.googleusercontent.com",
                        "cloud_gdrive_client_secret": "GOCSPX-phase4-probe-secret",
                    }
                },
            )
            assert save_cloud.status_code == 200
            assert set(save_cloud.json()["savedKeys"]) == {
                "cloud_gdrive_client_id",
                "cloud_gdrive_client_secret",
            }

            # Wizard GET must never echo Vault secrets
            wiz_batch = await client.get("/api/modules/batch-api/wizard")
            assert wiz_batch.status_code == 200
            assert "AIza-phase4-probe-test-key" not in wiz_batch.text
            wiz_cloud = await client.get("/api/modules/cloud-storage/wizard")
            assert wiz_cloud.status_code == 200
            assert "GOCSPX-phase4-probe-secret" not in wiz_cloud.text

            probe_batch_http = await client.post(
                "/api/modules/batch-api/probe",
                headers={"X-CSRF-Token": admin_csrf},
            )
            assert probe_batch_http.status_code == 200
            assert probe_batch_http.json()["ok"] is True

            probe_cloud_http = await client.post(
                "/api/modules/cloud-storage/probe",
                headers={"X-CSRF-Token": admin_csrf},
            )
            assert probe_cloud_http.status_code == 200
            assert probe_cloud_http.json()["ok"] is True

        # Still inactive and `plugin.py` remains completely unloaded; `_alfred_probe_*` purged
        assert container.registry.is_active("batch-api") is False
        assert container.registry.is_active("cloud-storage") is False
        assert _has_module_sys_entries("batch-api") == []
        assert _has_module_sys_entries("cloud-storage") == []
        assert not [k for k in sys.modules if k.startswith("_alfred_probe_")]
    finally:
        await container.db.close()


async def test_live_activation_migrations_tools_routes_sanitize_ui_and_deactivation(
    tmp_path: Path,
) -> None:
    """Activate both optional modules, verify wiring/UI/migrations, then deactivate cleanly."""
    settings = _make_repo_backed_settings(tmp_path)
    container = build_core_container(settings, admin_token="phase4-lifecycle-token")
    await container.db.initialize()
    await container.vault.initialize()

    app = FastAPI(title="Alfred v2 Phase4 Lifecycle Test")
    app.state.container = container
    mount_module_ui_routes(app, container.registry)
    app.include_router(create_core_router(container))
    mount_module_dispatcher(app, container.registry, container.auth)

    try:
        loaded = await container.loader.load_active_modules()
        assert set(loaded) == set(BUILTIN_MODULE_IDS)

        # Before activation: optional tools/sanitize keys/tables do not exist
        assert {t.name for t in container.registry.list_tools()} == BUILTIN_TOOL_NAMES
        initial_sanitize = set(container.registry.list_cli_env_sanitize_keys())
        assert not (CLOUD_ONLY_SANITIZE_KEYS & initial_sanitize)

        agents_cfg = container.agents.load(validate_manifests=True)
        batch_agent = agents_cfg.get_agent("alfred-batch")
        assert batch_agent is not None
        assert not (
            BATCH_TOOL_NAMES
            & {s.name for s in container.tool_executor.get_schemas_for_agent(batch_agent)}
        )
        with pytest.raises(ModuleDisabledError):
            await container.tool_executor.execute_tool(
                agent=batch_agent,
                tool_name="batch_list",
                raw_args={},
                session_id="p4-before-activate",
                workspace_dir=tmp_path,
            )

        def _list_tables(conn: sqlite3.Connection) -> set[str]:
            rows = conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
            return {str(r["name"]) for r in rows}

        tables_before = await container.db.read(_list_tables)
        assert "batch_jobs" not in tables_before
        assert "cloud_activity_log" not in tables_before

        # Activate both optional modules via ModuleManager.activate_module(...)
        batch_act = await container.module_manager.activate_module("batch-api")
        cloud_act = await container.module_manager.activate_module("cloud-storage")
        assert batch_act.state == "active"
        assert batch_act.loaded_modules == ["batch-api"]
        assert cloud_act.state == "active"
        assert cloud_act.loaded_modules == ["cloud-storage"]
        assert set(container.registry.active_module_ids()) == set(ALL_MODULE_IDS)
        assert settings.modules_generation_path.is_file()

        # Plugins & Service Bus dependency isolation
        batch_plugin = container.registry.get_plugin("batch-api")
        cloud_plugin = container.registry.get_plugin("cloud-storage")
        assert isinstance(batch_plugin, AlfredModulePlugin)
        assert isinstance(cloud_plugin, AlfredModulePlugin)

        batch_ctx = container.registry.get_context("batch-api")
        cloud_ctx = container.registry.get_context("cloud-storage")
        assert batch_ctx is not None and cloud_ctx is not None
        assert batch_ctx.modules.require_service("core-cli") is container.registry.get_service(
            "core-cli"
        )
        with pytest.raises(MissingDependencyError) as dep_err:
            cloud_ctx.modules.require_service("core-cli")
        assert dep_err.value.status_code == 409

        # Idempotent migrations verified
        tables_after = await container.db.read(_list_tables)
        assert {"batch_jobs", "cloud_activity_log"}.issubset(tables_after)

        mig_rows = await container.db.read(
            lambda c: {
                (str(r["module_id"]), int(r["version"]))
                for r in c.execute("SELECT module_id, version FROM module_migrations").fetchall()
            }
        )
        assert ("batch-api", 1) in mig_rows
        assert ("cloud-storage", 1) in mig_rows
        assert (
            await apply_module_migrations(container.db, "batch-api", batch_plugin.migrations())
            == []
        )
        assert (
            await apply_module_migrations(
                container.db, "cloud-storage", cloud_plugin.migrations()
            )
            == []
        )

        # Tools & ToolExecutor wiring
        expected_all_tools = BUILTIN_TOOL_NAMES | BATCH_TOOL_NAMES | CLOUD_TOOL_NAMES
        assert {t.name for t in container.registry.list_tools()} == expected_all_tools

        assert BATCH_TOOL_NAMES.issubset(
            {s.name for s in container.tool_executor.get_schemas_for_agent(batch_agent)}
        )
        list_tool_res = await container.tool_executor.execute_tool(
            agent=batch_agent,
            tool_name="batch_list",
            raw_args={},
            session_id="p4-tool-check",
            workspace_dir=tmp_path,
        )
        assert list_tool_res.ok is True
        assert list_tool_res.output["summary"]["total_batches"] == 0

        cloud_enabled_agent = batch_agent.model_copy(
            update={"tools": [*batch_agent.tools, "cloud_list"]}
        )
        assert "cloud_list" in {
            s.name for s in container.tool_executor.get_schemas_for_agent(cloud_enabled_agent)
        }
        cloud_tool_res = await container.tool_executor.execute_tool(
            agent=cloud_enabled_agent,
            tool_name="cloud_list",
            raw_args={},
            session_id="p4-cloud-tool-check",
            workspace_dir=tmp_path,
        )
        assert cloud_tool_res.ok is False
        assert cloud_tool_res.error_code is not None

        # cli_env_sanitize_keys propagation across active modules + core-cli ServiceBus view
        active_sanitize = set(container.registry.list_cli_env_sanitize_keys())
        assert {"ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY"}.issubset(active_sanitize)
        assert CLOUD_ONLY_SANITIZE_KEYS.issubset(active_sanitize)
        cli_ctx = container.registry.get_context("core-cli")
        assert cli_ctx is not None
        assert set(cli_ctx.modules.list_cli_env_sanitize_keys()) == active_sanitize

        # HTTP routes (Auth/CSRF-gated) & UI assets (200 + HEAD + ETag + 304)
        transport = httpx.ASGITransport(app=app)
        admin_cookie, admin_csrf = container.auth.issue_dashboard_session(role="admin")

        async with httpx.AsyncClient(transport=transport, base_url="http://test") as anon:
            assert (await anon.get("/api/batch/jobs")).status_code == 401
            assert (await anon.get("/api/cloud/status")).status_code == 401

            for mod_id, entry_file in (
                ("batch-api", "batch-card.js"),
                ("cloud-storage", "cloud-card.js"),
            ):
                ui_url = f"/api/modules/{mod_id}/ui/{entry_file}"
                ui_get = await anon.get(ui_url)
                assert ui_get.status_code == 200
                assert "application/javascript" in ui_get.headers.get("content-type", "")
                etag = ui_get.headers.get("etag")
                assert etag
                assert ui_get.headers.get("cache-control") == "no-cache"

                ui_head = await anon.head(ui_url)
                assert ui_head.status_code == 200
                assert ui_head.content == b""
                assert ui_head.headers.get("etag") == etag

                ui_304 = await anon.get(ui_url, headers={"If-None-Match": etag})
                assert ui_304.status_code == 304
                assert ui_304.content == b""
                assert ui_304.headers.get("etag") == etag

        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://test",
            cookies={"alfred_session": admin_cookie},
        ) as admin_client:
            mods_resp = await admin_client.get("/api/modules")
            assert mods_resp.status_code == 200
            contribs = {c["id"]: c for c in mods_resp.json()["uiContributions"]}
            assert contribs["vpsBatchCard"]["moduleId"] == "batch-api"
            assert contribs["vpsBatchCard"]["slot"] == "vps-card"
            assert contribs["vpsBatchCard"]["entryFile"] == "batch-card.js"
            assert contribs["vpsBatchCard"]["order"] == 50
            assert contribs["vpsCloudStorageCard"]["moduleId"] == "cloud-storage"
            assert contribs["vpsCloudStorageCard"]["slot"] == "vps-card"
            assert contribs["vpsCloudStorageCard"]["entryFile"] == "cloud-card.js"
            assert contribs["vpsCloudStorageCard"]["order"] == 60

            batch_jobs = await admin_client.get("/api/batch/jobs")
            assert batch_jobs.status_code == 200
            assert {p["provider"] for p in batch_jobs.json()["by_provider"]} == {
                "anthropic",
                "gemini",
                "vertex-eu",
                "openai",
            }

            cloud_status = await admin_client.get("/api/cloud/status")
            assert cloud_status.status_code == 200
            assert {p["id"] for p in cloud_status.json()["providers"]} == {
                "gdrive",
                "onedrive",
                "dropbox",
            }
            cloud_activity = await admin_client.get("/api/cloud/activity")
            assert cloud_activity.status_code == 200
            assert cloud_activity.json()["activity"] == []

            # CSRF & ValidationError safety
            no_csrf = await admin_client.post("/api/batch/jobs", json={})
            assert no_csrf.status_code == 403
            bad_batch = await admin_client.post(
                "/api/batch/jobs",
                headers={"X-CSRF-Token": admin_csrf},
                json={"provider": "invalid-prov"},
            )
            assert bad_batch.status_code == 400
            assert bad_batch.json()["error"] == "VALIDATION_ERROR"

            bad_cloud = await admin_client.post(
                "/api/cloud/config",
                headers={"X-CSRF-Token": admin_csrf},
                json={"defaultProvider": "unknown-cloud"},
            )
            assert bad_cloud.status_code == 400
            assert bad_cloud.json()["error"] == "VALIDATION_ERROR"

        # Seed rows to verify DB preservation across deactivation, plus run housekeeping sweep
        now_iso = datetime.now(tz=UTC).isoformat()

        def _seed_rows(conn: sqlite3.Connection) -> None:
            conn.execute(
                "INSERT INTO batch_jobs (id, provider, model, status, input_ref, "
                "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    "p4-persist-job",
                    "gemini",
                    "gemini-3.8-flash",
                    "completed",
                    "inline:0",
                    now_iso,
                    now_iso,
                ),
            )
            conn.execute(
                "INSERT INTO cloud_activity_log (action, provider, account, remote_ref, "
                "byte_size, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "list",
                    "gdrive",
                    "default",
                    "root",
                    0,
                    "ok",
                    "phase4 integration marker",
                    now_iso,
                ),
            )

        await container.db.write(_seed_rows)

        hk_stats = await cli_ctx.modules.run_all_housekeeping(
            retention_days=30,
            disk_used_pct=40.0,
        )
        assert {item.module_id for item in hk_stats} == set(ALL_MODULE_IDS)

        # Built-in protection still enforced
        with pytest.raises(ModuleError) as builtin_err:
            await container.module_manager.deactivate_module("core-cli")
        assert builtin_err.value.code == "BUILTIN_MODULE_PROTECTED"
        assert builtin_err.value.status_code == 403

        # Deactivate both optional modules & verify clean runtime teardown + DB preservation
        batch_deact = await container.module_manager.deactivate_module("batch-api")
        cloud_deact = await container.module_manager.deactivate_module("cloud-storage")
        assert batch_deact.state == "installed_disabled"
        assert cloud_deact.state == "installed_disabled"
        assert set(cloud_deact.loaded_modules) == set(BUILTIN_MODULE_IDS)

        assert container.registry.is_active("batch-api") is False
        assert container.registry.is_active("cloud-storage") is False
        assert container.registry.get_service("batch-api") is None
        assert container.registry.get_service("cloud-storage") is None
        assert {t.name for t in container.registry.list_tools()} == BUILTIN_TOOL_NAMES
        with pytest.raises(ModuleDisabledError):
            await container.tool_executor.execute_tool(
                agent=batch_agent,
                tool_name="batch_list",
                raw_args={},
                session_id="p4-after-deactivate",
                workspace_dir=tmp_path,
            )
        with pytest.raises(ModuleDisabledError):
            await container.tool_executor.execute_tool(
                agent=cloud_enabled_agent,
                tool_name="cloud_list",
                raw_args={},
                session_id="p4-after-deactivate-cloud",
                workspace_dir=tmp_path,
            )

        after_deact_sanitize = set(container.registry.list_cli_env_sanitize_keys())
        assert not (CLOUD_ONLY_SANITIZE_KEYS & after_deact_sanitize)

        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://test",
            cookies={"alfred_session": admin_cookie},
        ) as admin_client:
            for ui_url in (
                "/api/modules/batch-api/ui/batch-card.js",
                "/api/modules/cloud-storage/ui/cloud-card.js",
            ):
                disabled_ui = await admin_client.get(ui_url)
                assert disabled_ui.status_code == 404
                assert disabled_ui.json()["error"] == "MODULE_DISABLED"

            assert (await admin_client.get("/api/batch/jobs")).status_code == 404
            assert (await admin_client.get("/api/cloud/status")).status_code == 404

            mods_after = await admin_client.get("/api/modules")
            assert mods_after.status_code == 200
            ui_ids_after = {c["id"] for c in mods_after.json()["uiContributions"]}
            assert ui_ids_after == {"vpsCliProvidersCard", "vpsStorageCard", "memories", "kanban"}

        # Persistent DB tables & rows MUST survive deactivation intact
        tables_post_deact = await container.db.read(_list_tables)
        assert {"batch_jobs", "cloud_activity_log"}.issubset(tables_post_deact)
        preserved_batch_ids = await container.db.read(
            lambda c: [str(r["id"]) for r in c.execute("SELECT id FROM batch_jobs").fetchall()]
        )
        preserved_cloud_details = await container.db.read(
            lambda c: [
                str(r["detail"])
                for r in c.execute("SELECT detail FROM cloud_activity_log").fetchall()
            ]
        )
        assert preserved_batch_ids == ["p4-persist-job"]
        assert preserved_cloud_details == ["phase4 integration marker"]

        # Re-activating works cleanly without migration conflicts and surfaces preserved data
        await container.module_manager.activate_module("batch-api")
        await container.module_manager.activate_module("cloud-storage")
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://test",
            cookies={"alfred_session": admin_cookie},
        ) as admin_client:
            re_batch = await admin_client.get("/api/batch/jobs")
            assert re_batch.status_code == 200
            assert [j["id"] for j in re_batch.json()["jobs"]] == ["p4-persist-job"]

            re_cloud = await admin_client.get("/api/cloud/activity")
            assert re_cloud.status_code == 200
            assert [e["detail"] for e in re_cloud.json()["activity"]] == [
                "phase4 integration marker"
            ]

            re_ui = await admin_client.get("/api/modules/batch-api/ui/batch-card.js")
            assert re_ui.status_code == 200
    finally:
        await container.db.close()


async def test_delete_optional_modules_physical_isolation_gate(tmp_path: Path) -> None:
    """Physically delete `batch-api` and `cloud-storage` dirs: app & config still boot cleanly."""
    import ctypes
    import os
    import stat
    import time as _time
    from collections.abc import Callable

    def _clear_readonly(p: str | os.PathLike[str]) -> None:
        if os.name == "nt":
            try:
                ctypes.windll.kernel32.SetFileAttributesW(str(p), 0x80)
            except OSError:
                pass
        try:
            os.chmod(p, stat.S_IWRITE | stat.S_IREAD | stat.S_IEXEC)
        except OSError:
            pass

    def _onexc(func: Callable[[str], object], path: str, exc: BaseException) -> None:
        if isinstance(exc, PermissionError):
            _clear_readonly(path)
            func(path)
        else:
            raise exc

    def _rmtree_win_safe(target: Path) -> None:
        _clear_readonly(target)
        for attempt in range(10):
            try:
                shutil.rmtree(target, onexc=_onexc)
                return
            except PermissionError:
                _clear_readonly(target)
                for root_p, dirs_p, files_p in os.walk(target, topdown=False):
                    for fname in files_p:
                        _clear_readonly(os.path.join(root_p, fname))
                    for dname in dirs_p:
                        _clear_readonly(os.path.join(root_p, dname))
                if attempt == 9:
                    raise
                _time.sleep(0.05)

    iso_root = tmp_path / "isolated-app"
    shutil.copytree(REPO_ROOT / "config", iso_root / "config")
    shutil.copytree(
        MODULES_DIR,
        iso_root / "modules",
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )
    _rmtree_win_safe(iso_root / "modules" / "batch-api")
    _rmtree_win_safe(iso_root / "modules" / "cloud-storage")

    settings = CoreSettings.from_project_root(iso_root, environment="test")
    app = create_app(settings, admin_token="delete-gate-token")
    async with app.router.lifespan_context(app):
        container: CoreAppContainer = app.state.container
        agents_cfg = container.agents.load(validate_manifests=True)
        batch_agent = agents_cfg.get_agent("alfred-batch")
        assert batch_agent is not None

        # Runtime execution of missing optional module tools remains strictly fail-closed
        with pytest.raises(ModuleDisabledError):
            await container.tool_executor.execute_tool(
                agent=batch_agent,
                tool_name="batch_list",
                raw_args={},
                session_id="iso-gate-check",
                workspace_dir=iso_root,
            )

        transport = httpx.ASGITransport(app=app)
        admin_cookie, _ = container.auth.issue_dashboard_session(role="admin")
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://test",
            cookies={"alfred_session": admin_cookie},
        ) as client:
            health = await client.get("/api/core/health")
            assert health.status_code == 200
            assert set(health.json()["activeModules"]) == set(BUILTIN_MODULE_IDS)

            assert (
                await client.get("/api/modules/batch-api/ui/batch-card.js")
            ).status_code == 404
            assert (
                await client.get("/api/modules/cloud-storage/ui/cloud-card.js")
            ).status_code == 404
            assert (await client.get("/api/batch/jobs")).status_code == 404
            assert (await client.get("/api/cloud/status")).status_code == 404
