"""Tests for `modules/core-memory`: schema, FTS5 sanitization, isolation, tool, routes & UI."""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest

from alfred.core.config import AgentConfig, CoreSettings
from alfred.core.db import SqlitePool
from alfred.core.security.heavy_job_hold import HeavyJobHoldManager
from alfred.core.tool_executor import ToolExecutor
from alfred.core.vault import VaultManager
from alfred.core.web_app import create_app
from alfred.kernel import (
    AlfredModulePlugin,
    ModuleLoader,
    ModuleManifest,
    ModuleRegistry,
    ToolExecutionContext,
    apply_module_migrations,
    module_package_name,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
CORE_MEMORY_DIR = REPO_ROOT / "modules" / "core-memory"
CORE_MEMORY_PKG_PARENT = CORE_MEMORY_DIR

if str(CORE_MEMORY_PKG_PARENT) not in sys.path:
    sys.path.insert(0, str(CORE_MEMORY_PKG_PARENT))

from core_memory.engine import (  # noqa: E402
    MemoryEngine,
    MemoryNamespaceError,
    MemoryNotFoundError,
    MemorySaveInput,
    MemoryUpdateInput,
    sanitize_fts5_query,
)
from core_memory.migrations import CORE_MEMORY_MIGRATIONS  # noqa: E402
from core_memory.plugin import CoreMemoryPlugin  # noqa: E402


def _setup_workspace(tmp_path: Path, *, copy_core_memory: bool = True) -> Path:
    (tmp_path / "config").mkdir(parents=True, exist_ok=True)
    (tmp_path / "docs").mkdir(parents=True, exist_ok=True)
    (tmp_path / "modules").mkdir(parents=True, exist_ok=True)
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
                        "id": "agent-a",
                        "displayName": "Agent A",
                        "role": "planner",
                        "memoryNamespace": "ns-alpha",
                        "dailyBudgetUsd": 5.0,
                        "tools": ["memory"],
                    },
                    {
                        "id": "agent-b",
                        "displayName": "Agent B",
                        "role": "planner",
                        "dailyBudgetUsd": 5.0,
                        "tools": ["memory"],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    if copy_core_memory:
        dst = tmp_path / "modules" / "core-memory"
        shutil.copytree(
            CORE_MEMORY_DIR,
            dst,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
    return tmp_path


def test_manifest_layout_and_ui_safety() -> None:
    manifest_path = CORE_MEMORY_DIR / "module.json"
    manifest = ModuleManifest.model_validate_json(manifest_path.read_text(encoding="utf-8"))
    assert manifest.id == "core-memory"
    assert manifest.built_in is True
    assert manifest.default_enabled is True
    assert manifest.entry == "core_memory/plugin.py"
    assert manifest.tools == ["memory"]
    assert manifest.ui_card_ids == ["memories"]

    # Mandatory package layout: zero .py files directly in modules/core-memory/
    direct_py = list(CORE_MEMORY_DIR.glob("*.py"))
    assert direct_py == []

    ui_js = (CORE_MEMORY_DIR / "ui" / "memories-page.js").read_text(encoding="utf-8")
    assert "export function mount(" in ui_js
    assert "export function unmount(" in ui_js
    assert "innerHTML" not in ui_js
    assert "outerHTML" not in ui_js
    assert "insertAdjacentHTML" not in ui_js


async def test_migrations_idempotency_fts_triggers_and_cascade(tmp_path: Path) -> None:
    settings = CoreSettings.from_project_root(tmp_path)
    async with SqlitePool(settings.db_path) as db:
        first = await apply_module_migrations(db, "core-memory", CORE_MEMORY_MIGRATIONS)
        second = await apply_module_migrations(db, "core-memory", CORE_MEMORY_MIGRATIONS)
        assert first == [1]
        assert second == []

        tables = await db.read(
            lambda c: {
                str(r["name"])
                for r in c.execute(
                    "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')"
                ).fetchall()
            }
        )
        assert {"memories", "memories_fts", "memory_versions", "memory_uses"} <= tables

        triggers = await db.read(
            lambda c: {
                str(r["name"])
                for r in c.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'trigger'"
                ).fetchall()
            }
        )
        assert {
            "trg_memories_fts_ai",
            "trg_memories_fts_ad",
            "trg_memories_fts_au",
        } <= triggers

        engine = MemoryEngine(db)
        saved = await engine.save_memory(
            MemorySaveInput(
                namespace="ns-1",
                title="Trigger sync test",
                content="alpha_keyword_initial telemetry",
                keywords="fts,sqlite",
            )
        )
        # Verify FTS5 sees insert
        hits_before = await engine.search_memories(
            namespace="ns-1",
            query="alpha_keyword_initial",
        )
        assert len(hits_before.memories) == 1

        # Update content & keywords -> verify FTS5 removes old token and indexes new token
        await engine.update_memory(
            saved.id,
            namespace="ns-1",
            patch=MemoryUpdateInput(
                content="beta_keyword_updated telemetry",
                keywords="updated",
            ),
        )
        old_hits = await engine.search_memories(
            namespace="ns-1",
            query="alpha_keyword_initial",
        )
        new_hits = await engine.search_memories(
            namespace="ns-1",
            query="beta_keyword_updated",
        )
        assert old_hits.memories == []
        assert len(new_hits.memories) == 1

        # Delete -> verify FTS5 delete trigger + ON DELETE CASCADE on versions & uses
        assert await engine.delete_memory(saved.id, namespace="ns-1") is True
        after_del = await engine.search_memories(namespace="ns-1", query="beta_keyword_updated")
        assert after_del.memories == []

        # FTS5 external-content integrity check must succeed cleanly after insert/update/use/delete
        await db.write(
            lambda c: c.execute("INSERT INTO memories_fts(memories_fts) VALUES('integrity-check')")
        )

        ver_count = await db.read(
            lambda c: int(
                c.execute(
                    "SELECT COUNT(*) FROM memory_versions WHERE memory_id = ?", (saved.id,)
                ).fetchone()[0]
            )
        )
        use_count = await db.read(
            lambda c: int(
                c.execute(
                    "SELECT COUNT(*) FROM memory_uses WHERE memory_id = ?", (saved.id,)
                ).fetchone()[0]
            )
        )
        assert ver_count == 0
        assert use_count == 0


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("", ""),
        ("   ", ""),
        ("'\"\"", ""),
        ("???", ""),
        ("___", ""),
        ("+++---***", ""),
        ("C++", '"C"'),
        ("foo:bar", '"foo" "bar"'),
        ("a-b*", '"a" "b"'),
        ("AND", '"AND"'),
        ("OR", '"OR"'),
        ("NOT", '"NOT"'),
        ("NEAR", '"NEAR"'),
        ("foo AND bar OR NOT baz NEAR qux", '"foo" "AND" "bar" "OR" "NOT" "baz" "NEAR" "qux"'),
        (
            "SELECT * FROM memories; DROP TABLE memories;--",
            '"SELECT" "FROM" "memories" "DROP" "TABLE"',
        ),
        ("árvíztűrő tükörfúrógép", '"árvíztűrő" "tükörfúrógép"'),
    ],
)
def test_sanitize_fts5_query_cases(raw: str, expected: str) -> None:
    assert sanitize_fts5_query(raw) == expected


async def test_engine_tricky_fts_queries_fallbacks_versions_and_usage(tmp_path: Path) -> None:
    settings = CoreSettings.from_project_root(tmp_path)
    async with SqlitePool(settings.db_path) as db:
        await apply_module_migrations(db, "core-memory", CORE_MEMORY_MIGRATIONS)
        engine = MemoryEngine(db)

        m1 = await engine.save_memory(
            MemorySaveInput(
                namespace="agent-x",
                title="Compiler Guide",
                content="We compile C++ services with foo:bar flags and +++ markers.",
                keywords="cpp,compiler,AND",
                category="hot",
                importance=9,
            )
        )
        m2 = await engine.save_memory(
            MemorySaveInput(
                namespace="agent-x",
                title="SpecialTitleOnly",
                content="Unrelated body text about staging.",
                keywords="deploy",
                category="warm",
                importance=4,
            )
        )
        assert m1.version == 1
        assert m1.use_count == 0
        assert m1.last_used_at is None

        # Listing must NOT increment use_count
        listed = await engine.list_memories(namespace="agent-x")
        assert listed.total == 2
        assert listed.memories[0].id == m1.id
        assert listed.memories[0].use_count == 0

        # Tricky queries must NEVER raise sqlite3.OperationalError
        tricky_queries = [
            "C++",
            "foo:bar",
            "a-b*",
            "'\"\"",
            '"',
            "'",
            "AND",
            "OR",
            "NOT",
            "NEAR",
            "SELECT * FROM memories; DROP TABLE memories;--",
            "()[]{}:^+-*",
            "+++",
            "???",
            "",
        ]
        for q in tricky_queries:
            res = await engine.search_memories(namespace="agent-x", query=q)
            assert res.namespace == "agent-x"

        # Non-alphanumeric query falls back to LIKE and finds "+++"
        plus_res = await engine.search_memories(namespace="agent-x", query="+++")
        assert plus_res.search_mode == "like_fallback"
        assert [item.id for item in plus_res.memories] == [m1.id]

        # Title-only match falls back cleanly to LIKE
        title_res = await engine.search_memories(namespace="agent-x", query="SpecialTitleOnly")
        assert title_res.search_mode == "like_fallback"
        assert [item.id for item in title_res.memories] == [m2.id]

        # Direct read increments use_count & logs memory_uses
        before_read = await engine.get_memory(m1.id, namespace="agent-x", track_use=False)
        after_read = await engine.get_memory(
            m1.id,
            namespace="agent-x",
            track_use=True,
            agent_id="agent-x",
            session_id="sess-42",
        )
        assert after_read.use_count == before_read.use_count + 1
        assert after_read.last_used_at is not None

        uses = await engine.list_uses(m1.id, namespace="agent-x")
        assert len(uses) == after_read.use_count
        assert any(u.session_id == "sess-42" and u.agent_id == "agent-x" for u in uses)

        # Update creates new version in memory_versions
        v2 = await engine.update_memory(
            m1.id,
            namespace="agent-x",
            patch=MemoryUpdateInput(title="Compiler Guide v2", importance=10),
        )
        assert v2.version == 2
        assert v2.importance == 10
        versions = await engine.list_versions(m1.id, namespace="agent-x")
        assert [v.version for v in versions] == [2, 1]
        assert versions[0].title == "Compiler Guide v2"
        assert versions[1].title == "Compiler Guide"


async def test_engine_namespace_isolation(tmp_path: Path) -> None:
    settings = CoreSettings.from_project_root(tmp_path)
    async with SqlitePool(settings.db_path) as db:
        await apply_module_migrations(db, "core-memory", CORE_MEMORY_MIGRATIONS)
        engine = MemoryEngine(db)

        rec_a = await engine.save_memory(
            MemorySaveInput(
                id="shared-attempt-id",
                namespace="ns-a",
                title="Secret Alpha",
                content="Alpha launch code alpha99",
            )
        )
        await engine.save_memory(
            MemorySaveInput(
                namespace="ns-b",
                title="Beta Note",
                content="Beta public note",
            )
        )

        # ns-b cannot see ns-a in list or search
        b_list = await engine.list_memories(namespace="ns-b")
        assert all(item.namespace == "ns-b" for item in b_list.memories)
        b_search = await engine.search_memories(namespace="ns-b", query="alpha99")
        assert b_search.memories == []

        # ns-b cannot read, update, inspect versions, overwrite id, or delete ns-a's memory
        with pytest.raises(MemoryNotFoundError):
            await engine.get_memory(rec_a.id, namespace="ns-b")
        with pytest.raises(MemoryNotFoundError):
            await engine.update_memory(
                rec_a.id,
                namespace="ns-b",
                patch=MemoryUpdateInput(content="hijacked"),
            )
        with pytest.raises(MemoryNotFoundError):
            await engine.list_versions(rec_a.id, namespace="ns-b")
        with pytest.raises(MemoryNamespaceError):
            await engine.save_memory(
                MemorySaveInput(
                    id=rec_a.id,
                    namespace="ns-b",
                    content="cross-namespace overwrite",
                )
            )
        assert await engine.delete_memory(rec_a.id, namespace="ns-b") is False

        # Verify ns-a memory remained untouched and unused
        still_a = await engine.get_memory(rec_a.id, namespace="ns-a", track_use=False)
        assert still_a.content == "Alpha launch code alpha99"
        assert still_a.use_count == 0
        assert still_a.version == 1


async def test_memory_tool_actions_and_namespace_enforcement(tmp_path: Path) -> None:
    root = _setup_workspace(tmp_path)
    settings = CoreSettings.from_project_root(root)
    mod_pkg = module_package_name("core-memory")
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
            loaded = await loader.load_active_modules()
            assert loaded == ["core-memory"]

            plugin = registry.get_plugin("core-memory")
            assert isinstance(plugin, AlfredModulePlugin)
            assert isinstance(plugin, CoreMemoryPlugin) or plugin.id == "core-memory"

            executor = ToolExecutor(registry=registry)
            agent_a = AgentConfig(
                id="agent-a",
                displayName="Agent A",
                role="planner",
                memoryNamespace="ns-alpha",
                tools=["memory"],
            )
            agent_b = AgentConfig(
                id="agent-b",
                displayName="Agent B",
                role="planner",
                memoryNamespace=None,
                tools=["memory"],
            )

            schemas = executor.get_schemas_for_agent(agent_a)
            assert [s.name for s in schemas] == ["memory"]

            # Agent A saves -> defaults to ctx.memory_namespace ("ns-alpha")
            save_a = await executor.execute_tool(
                agent=agent_a,
                tool_name="memory",
                raw_args={
                    "action": "save",
                    "title": "Alpha Design",
                    "content": "Architecture note alpha-token-1",
                    "keywords": "arch,alpha",
                    "importance": 8,
                },
                session_id="sess-a",
                workspace_dir=root,
            )
            assert save_a.ok is True
            assert isinstance(save_a.output, dict)
            assert save_a.output["namespace"] == "ns-alpha"
            mem_a_id = str(save_a.output["id"])

            # Agent B defaults to agent_id ("agent-b")
            save_b = await executor.execute_tool(
                agent=agent_b,
                tool_name="memory",
                raw_args={"action": "save", "content": "Beta private memory"},
                session_id="sess-b",
                workspace_dir=root,
            )
            assert save_b.ok is True
            assert isinstance(save_b.output, dict)
            assert save_b.output["namespace"] == "agent-b"

            # Agent B cannot override namespace to "ns-alpha"
            forbid = await executor.execute_tool(
                agent=agent_b,
                tool_name="memory",
                raw_args={"action": "search", "namespace": "ns-alpha", "query": "alpha"},
                session_id="sess-b",
                workspace_dir=root,
            )
            assert forbid.ok is False
            assert forbid.error_code == "NAMESPACE_FORBIDDEN"

            # Agent B cannot delete Agent A's memory id
            del_forbid = await executor.execute_tool(
                agent=agent_b,
                tool_name="memory",
                raw_args={"action": "delete", "memory_id": mem_a_id},
                session_id="sess-b",
                workspace_dir=root,
            )
            assert del_forbid.ok is False
            assert del_forbid.error_code == "MEMORY_NOT_FOUND"

            # Agent A searches & increments use_count
            search_a = await executor.execute_tool(
                agent=agent_a,
                tool_name="memory",
                raw_args={"action": "search", "query": "alpha-token-1"},
                session_id="sess-a",
                workspace_dir=root,
            )
            assert search_a.ok is True
            assert isinstance(search_a.output, dict)
            hits = search_a.output["memories"]
            assert len(hits) == 1
            assert hits[0]["id"] == mem_a_id
            assert hits[0]["use_count"] == 1

            # List & delete by Agent A
            list_a = await executor.execute_tool(
                agent=agent_a,
                tool_name="memory",
                raw_args={"action": "list"},
                session_id="sess-a",
                workspace_dir=root,
            )
            assert list_a.ok is True
            assert isinstance(list_a.output, dict)
            assert list_a.output["total"] == 1

            del_a = await executor.execute_tool(
                agent=agent_a,
                tool_name="memory",
                raw_args={"action": "delete", "memory_id": mem_a_id},
                session_id="sess-a",
                workspace_dir=root,
            )
            assert del_a.ok is True
            assert isinstance(del_a.output, dict)
            assert del_a.output["deleted"] is True

            # Validation errors handled cleanly
            bad_action = await executor.execute_tool(
                agent=agent_a,
                tool_name="memory",
                raw_args={"action": "drop_all"},
                session_id="sess-a",
                workspace_dir=root,
            )
            assert bad_action.ok is False
            assert bad_action.error_code == "TOOL_VALIDATION_ERROR"

            # Direct ToolExecutionContext check for probe and housekeeping
            mod_ctx = registry.get_context("core-memory")
            assert mod_ctx is not None
            probe_res = await plugin.wizard_probe(mod_ctx)
            assert probe_res.ok is True
            hk = await plugin.on_housekeeping(mod_ctx, retention_days=30, disk_used_pct=40.0)
            assert hk.module_id == "core-memory"

            # Verify fallback ToolExecutionContext without registered service
            tool_def = registry.get_tool("memory")
            assert tool_def is not None
            direct_ctx = ToolExecutionContext(
                agent_id="direct-agent",
                session_id="s-direct",
                workspace_dir=root,
                module_ctx=mod_ctx,
            )
            missing_content = await tool_def.invoke({"action": "save"}, direct_ctx)
            assert missing_content.ok is False
            assert missing_content.error_code == "TOOL_VALIDATION_ERROR"
    finally:
        for key in list(sys.modules.keys()):
            if key == mod_pkg or key.startswith(f"{mod_pkg}."):
                sys.modules.pop(key, None)


async def test_http_routes_auth_crud_versions_isolation_and_ui(tmp_path: Path) -> None:
    root = _setup_workspace(tmp_path)
    settings = CoreSettings.from_project_root(root, environment="test")
    app = create_app(settings, admin_token="mem-admin-tok")
    mod_pkg = module_package_name("core-memory")

    try:
        async with app.router.lifespan_context(app):
            container = app.state.container
            ui_contribs = container.registry.list_ui_contributions(slot="sidebar-page")
            assert any(
                c.id == "memories"
                and c.module_id == "core-memory"
                and c.route_hash == "#memories"
                and c.order == 30
                for c in ui_contribs
            )

            admin_cookie, admin_csrf = container.auth.issue_dashboard_session(role="admin")
            dash_cookie, _dash_csrf = container.auth.issue_dashboard_session(role="dashboard")
            transport = httpx.ASGITransport(app=app)

            # Unauthenticated -> 401; UI asset -> 200 + ETag/304
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as anon:
                assert (await anon.get("/api/memories?namespace=ns-a")).status_code == 401
                ui_res = await anon.get("/api/modules/core-memory/ui/memories-page.js")
                assert ui_res.status_code == 200
                assert "export function mount" in ui_res.text
                ui_304 = await anon.get(
                    "/api/modules/core-memory/ui/memories-page.js",
                    headers={"If-None-Match": ui_res.headers["etag"]},
                )
                assert ui_304.status_code == 304

            # Dashboard role can read (GET), blocked on mutations (403)
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
                cookies={"alfred_session": dash_cookie},
            ) as dash_client:
                assert (await dash_client.get("/api/memories?namespace=ns-a")).status_code == 200
                forbidden_post = await dash_client.post(
                    "/api/memories",
                    json={"namespace": "ns-a", "content": "nope"},
                )
                assert forbidden_post.status_code == 403

            # Admin session without CSRF -> 403
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
                cookies={"alfred_session": admin_cookie},
            ) as cookie_client:
                no_csrf = await cookie_client.post(
                    "/api/memories",
                    json={"namespace": "ns-a", "content": "needs csrf"},
                )
                assert no_csrf.status_code == 403
                with_csrf = await cookie_client.post(
                    "/api/memories",
                    headers={"X-CSRF-Token": admin_csrf},
                    json={"namespace": "ns-a", "content": "csrf ok"},
                )
                assert with_csrf.status_code == 200

            # Full CRUD & edge cases via Bearer token
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
                headers={"Authorization": "Bearer mem-admin-tok"},
            ) as client:
                # Create memory in ns-a
                created_resp = await client.post(
                    "/api/memories",
                    json={
                        "namespace": "ns-a",
                        "title": "Runbook",
                        "content": "Always run pytest and mypy before deploy",
                        "keywords": "pytest,mypy,deploy",
                        "category": "hot",
                        "importance": 8,
                    },
                )
                assert created_resp.status_code == 200
                created: dict[str, Any] = created_resp.json()
                mem_id = str(created["id"])
                assert created["version"] == 1
                assert created["use_count"] == 0

                # Create memory in ns-b
                await client.post(
                    "/api/memories",
                    json={
                        "namespace": "ns-b",
                        "title": "Other",
                        "content": "Completely separate namespace",
                    },
                )

                # Default namespace listing cannot see ns-a or ns-b memories
                default_list = await client.get("/api/memories")
                assert default_list.status_code == 200
                assert default_list.json()["namespace"] == "default"
                assert all(
                    m["namespace"] == "default" for m in default_list.json()["memories"]
                )

                # Invalid query params -> 400
                assert (await client.get("/api/memories?namespace=")).status_code == 400
                assert (await client.get("/api/memories?limit=abc")).status_code == 400
                assert (await client.get("/api/memories?limit=0")).status_code == 400

                # POST with same id in ns-b is blocked (403); same namespace updates in-place (v2)
                cross_upsert = await client.post(
                    "/api/memories",
                    json={
                        "id": mem_id,
                        "namespace": "ns-b",
                        "content": "hijack via POST",
                    },
                )
                assert cross_upsert.status_code == 403

                post_update = await client.post(
                    "/api/memories",
                    json={
                        "id": mem_id,
                        "namespace": "ns-a",
                        "title": "Runbook",
                        "content": "Always run pytest and mypy before deploy",
                        "keywords": "pytest,mypy,deploy",
                        "category": "hot",
                        "importance": 8,
                    },
                )
                assert post_update.status_code == 200
                assert post_update.json()["version"] == 2

                # ValidationError must return 400 and NEVER leak input values
                bad_val = await client.post(
                    "/api/memories",
                    json={
                        "namespace": "ns-a",
                        "content": "valid",
                        "importance": "SECRET-INPUT-VALUE-999",
                    },
                )
                assert bad_val.status_code == 400
                assert "SECRET-INPUT-VALUE-999" not in bad_val.text

                bad_json = await client.post(
                    "/api/memories",
                    content=b"{broken-json",
                    headers={"Content-Type": "application/json"},
                )
                assert bad_json.status_code == 400

                # Search via GET /api/memories?namespace=ns-a&q=...&category=hot&limit=5 (read-only)
                search_res = await client.get(
                    "/api/memories",
                    params={
                        "namespace": "ns-a",
                        "q": "mypy",
                        "category": "hot",
                        "limit": "5",
                    },
                )
                assert search_res.status_code == 200
                search_body = search_res.json()
                assert search_body["total"] == 1
                assert search_body["memories"][0]["id"] == mem_id
                assert search_body["memories"][0]["use_count"] == 0

                # Tricky FTS query via HTTP
                tricky_http = await client.get(
                    "/api/memories",
                    params={"namespace": "ns-a", "q": "foo:bar AND ' \"\" *"},
                )
                assert tricky_http.status_code == 200

                # Single GET requires matching namespace & remains read-only (use_count stays 0)
                assert (await client.get(f"/api/memories/{mem_id}")).status_code == 400
                assert (
                    await client.get(f"/api/memories/{mem_id}", params={"namespace": "ns-b"})
                ).status_code == 404
                single_ok = await client.get(
                    f"/api/memories/{mem_id}",
                    params={"namespace": "ns-a"},
                )
                assert single_ok.status_code == 200
                assert single_ok.json()["use_count"] == 0

                # PATCH creates version 2; cross-namespace PATCH -> 404; empty PATCH -> 400
                assert (
                    await client.patch(
                        f"/api/memories/{mem_id}",
                        params={"namespace": "ns-b"},
                        json={"content": "cross-ns tamper"},
                    )
                ).status_code == 404
                assert (
                    await client.patch(
                        f"/api/memories/{mem_id}",
                        params={"namespace": "ns-a"},
                        json={},
                    )
                ).status_code == 400

                patched = await client.patch(
                    f"/api/memories/{mem_id}",
                    params={"namespace": "ns-a"},
                    json={
                        "title": "Runbook v2",
                        "content": "Always run ruff, mypy --strict, and pytest",
                        "keywords": "ruff,mypy,pytest",
                        "importance": 10,
                    },
                )
                assert patched.status_code == 200
                assert patched.json()["version"] == 3
                assert patched.json()["importance"] == 10

                # Version history
                assert (
                    await client.get(
                        f"/api/memories/{mem_id}/versions",
                        params={"namespace": "ns-b"},
                    )
                ).status_code == 404
                vers = await client.get(
                    f"/api/memories/{mem_id}/versions",
                    params={"namespace": "ns-a"},
                )
                assert vers.status_code == 200
                assert [v["version"] for v in vers.json()["versions"]] == [3, 2, 1]

                # DELETE enforces namespace & removes memory
                assert (
                    await client.delete(f"/api/memories/{mem_id}", params={"namespace": "ns-b"})
                ).status_code == 404
                del_ok = await client.delete(
                    f"/api/memories/{mem_id}",
                    params={"namespace": "ns-a"},
                )
                assert del_ok.status_code == 200
                assert del_ok.json()["deleted"] is True
                assert (
                    await client.get(f"/api/memories/{mem_id}", params={"namespace": "ns-a"})
                ).status_code == 404
    finally:
        for key in list(sys.modules.keys()):
            if key == mod_pkg or key.startswith(f"{mod_pkg}."):
                sys.modules.pop(key, None)
