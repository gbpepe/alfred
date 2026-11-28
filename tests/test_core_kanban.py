"""Comprehensive tests for built-in `core-kanban` module."""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path
from typing import Any

import httpx
import pytest

from alfred.core.config import CoreSettings
from alfred.core.db import SqlitePool
from alfred.core.security.heavy_job_hold import HeavyJobHoldManager
from alfred.core.vault import VaultManager
from alfred.core.web_app import create_app
from alfred.kernel import (
    AlfredModulePlugin,
    ModuleLoader,
    ModuleManifest,
    ModuleRegistry,
    apply_module_migrations,
    module_package_name,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
KANBAN_DIR = REPO_ROOT / "modules" / "core-kanban"


def _setup_workspace(tmp_path: Path) -> Path:
    (tmp_path / "config").mkdir(parents=True, exist_ok=True)
    (tmp_path / "docs").mkdir(parents=True, exist_ok=True)
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
                        "role": "planner",
                        "dailyBudgetUsd": 5.0,
                        "tools": [],
                        "systemPrompt": "Plan cleanly.",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    mod_dest = tmp_path / "modules" / "core-kanban"
    mod_dest.mkdir(parents=True, exist_ok=True)
    for rel in (
        "module.json",
        "core_kanban/__init__.py",
        "core_kanban/migrations.py",
        "core_kanban/routes.py",
        "core_kanban/plugin.py",
        "ui/kanban-page.js",
    ):
        src = KANBAN_DIR / rel
        dst = mod_dest / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(src.read_bytes())
    return tmp_path


def test_core_kanban_layout_manifest_and_ui_static_safety() -> None:
    top_py_files = list(KANBAN_DIR.glob("*.py"))
    assert top_py_files == []

    manifest = ModuleManifest.model_validate_json(
        (KANBAN_DIR / "module.json").read_text(encoding="utf-8")
    )
    assert manifest.id == "core-kanban"
    assert manifest.built_in is True
    assert manifest.default_enabled is True
    assert manifest.entry == "core_kanban/plugin.py"
    assert manifest.tools == []
    assert manifest.ui_card_ids == ["kanban"]

    ui_source = (KANBAN_DIR / "ui" / "kanban-page.js").read_text(encoding="utf-8")
    assert "export function mount(" in ui_source
    assert "export function unmount(" in ui_source
    assert "innerHTML" not in ui_source
    assert "outerHTML" not in ui_source
    assert "insertAdjacentHTML" not in ui_source
    for col in ("backlog", "todo", "in_progress", "review", "done"):
        assert col in ui_source


async def test_core_kanban_migrations_idempotent_and_schema_constraints(tmp_path: Path) -> None:
    root = _setup_workspace(tmp_path)
    settings = CoreSettings.from_project_root(root, environment="test")
    pkg = module_package_name("core-kanban")
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
            loaded = await loader.load_active_modules(active_ids={"core-kanban"})
            assert loaded == ["core-kanban"]

            plugin = registry.get_plugin("core-kanban")
            assert plugin is not None
            assert isinstance(plugin, AlfredModulePlugin)
            assert plugin.id == "core-kanban"

            # Second migration run must be a no-op (idempotent)
            second_run = await apply_module_migrations(db, "core-kanban", plugin.migrations())
            assert second_run == []

            tables = await db.read(
                lambda c: {
                    str(r["name"])
                    for r in c.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'table'"
                    ).fetchall()
                }
            )
            assert {"kanban_projects", "labels", "kanban_cards", "kanban_comments"}.issubset(
                tables
            )

            indexes = await db.read(
                lambda c: {
                    str(r["name"])
                    for r in c.execute(
                        "SELECT name FROM sqlite_master WHERE type = 'index'"
                    ).fetchall()
                }
            )
            assert {
                "idx_kanban_cards_proj_col",
                "idx_kanban_comments_card",
                "idx_kanban_labels_proj",
            }.issubset(indexes)

            probe = await loader.probe_inactive_module("core-kanban")
            assert probe.ok is True
            assert probe.module_id == "core-kanban"

            # Verify SQLite CHECK constraints reject invalid column_name / priority
            await db.write(
                lambda c: c.execute(
                    "INSERT INTO kanban_projects (id, name, description, created_at, updated_at) "
                    "VALUES ('p1', 'Proj', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
                )
            )
            with pytest.raises(sqlite3.IntegrityError):
                await db.write(
                    lambda c: c.execute(
                        "INSERT INTO kanban_cards "
                        "(id, project_id, title, column_name, created_at, updated_at) "
                        "VALUES ('c1', 'p1', 'Bad Col', 'archived', "
                        "'2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
                    )
                )
            with pytest.raises(sqlite3.IntegrityError):
                await db.write(
                    lambda c: c.execute(
                        "INSERT INTO kanban_cards "
                        "(id, project_id, title, priority, created_at, updated_at) "
                        "VALUES ('c2', 'p1', 'Bad Prio', 'critical', "
                        "'2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
                    )
                )

            ui_contribs = registry.list_ui_contributions(slot="sidebar-page")
            assert len(ui_contribs) == 1
            assert ui_contribs[0].id == "kanban"
            assert ui_contribs[0].module_id == "core-kanban"
            assert ui_contribs[0].entry_file == "kanban-page.js"
            assert ui_contribs[0].route_hash == "#kanban"
            assert ui_contribs[0].order == 40
    finally:
        for key in list(sys.modules.keys()):
            if key == pkg or key.startswith(f"{pkg}."):
                sys.modules.pop(key, None)


async def test_core_kanban_http_auth_csrf_crud_cascades_and_ui_serving(tmp_path: Path) -> None:
    root = _setup_workspace(tmp_path)
    settings = CoreSettings.from_project_root(root, environment="test")
    pkg = module_package_name("core-kanban")
    try:
        app = create_app(settings, admin_token="kanban-admin-secret")
        async with app.router.lifespan_context(app):
            container = app.state.container
            admin_cookie, admin_csrf = container.auth.issue_dashboard_session(role="admin")
            dash_cookie, dash_csrf = container.auth.issue_dashboard_session(role="dashboard")
            transport = httpx.ASGITransport(app=app)

            # 1. Anonymous requests fail with 401; wrong method yields 405
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as anon:
                assert (await anon.get("/api/kanban/projects")).status_code == 401
                anon_post = await anon.post("/api/kanban/projects", json={"name": "X"})
                assert anon_post.status_code == 401
                m405 = await anon.delete("/api/kanban/projects")
                assert m405.status_code == 405
                assert "GET" in m405.headers.get("allow", "")

                # UI asset serving + HEAD + ETag 304
                ui_resp = await anon.get("/api/modules/core-kanban/ui/kanban-page.js")
                assert ui_resp.status_code == 200
                assert "export function mount" in ui_resp.text
                etag = ui_resp.headers["etag"]

                head_resp = await anon.head("/api/modules/core-kanban/ui/kanban-page.js")
                assert head_resp.status_code == 200
                assert head_resp.content == b""
                assert head_resp.headers["etag"] == etag

                ui_304 = await anon.get(
                    "/api/modules/core-kanban/ui/kanban-page.js",
                    headers={"If-None-Match": etag},
                )
                assert ui_304.status_code == 304

            # 2. Dashboard-only session can read (200) but cannot mutate (403)
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
                cookies={"alfred_session": dash_cookie},
            ) as dash_client:
                assert (await dash_client.get("/api/kanban/projects")).status_code == 200
                denied_post = await dash_client.post(
                    "/api/kanban/projects",
                    headers={"X-CSRF-Token": dash_csrf},
                    json={"name": "Forbidden"},
                )
                assert denied_post.status_code == 403

            # 3. Admin session missing CSRF -> 403
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
                cookies={"alfred_session": admin_cookie},
            ) as no_csrf_client:
                csrf_fail = await no_csrf_client.post(
                    "/api/kanban/projects",
                    json={"name": "NoCsrf"},
                )
                assert csrf_fail.status_code == 403
                assert csrf_fail.json()["error"] == "CSRF_FAILED"

            # 4. Full authenticated CRUD lifecycle with CSRF
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
                cookies={"alfred_session": admin_cookie},
                headers={"X-CSRF-Token": admin_csrf},
            ) as client:
                # Create two projects
                p1_resp = await client.post(
                    "/api/kanban/projects",
                    json={"name": "Alpha Board", "description": "Primary sprint"},
                )
                assert p1_resp.status_code == 201
                p1 = p1_resp.json()
                p1_id = p1["id"]
                assert p1["name"] == "Alpha Board"

                p2_resp = await client.post("/api/kanban/projects", json={"name": "Beta Board"})
                assert p2_resp.status_code == 201
                p2_id = p2_resp.json()["id"]

                projects_list = (await client.get("/api/kanban/projects")).json()["projects"]
                assert [p["id"] for p in projects_list] == [p1_id, p2_id]

                p1_patch = await client.patch(
                    f"/api/kanban/projects/{p1_id}",
                    json={"description": "Updated sprint"},
                )
                assert p1_patch.status_code == 200
                assert p1_patch.json()["name"] == "Alpha Board"
                assert p1_patch.json()["description"] == "Updated sprint"

                # Labels CRUD + duplicate label 400 + cross-project reuse allowed
                lbl1_resp = await client.post(
                    f"/api/kanban/projects/{p1_id}/labels",
                    json={"name": "backend", "color": "#2563EB"},
                )
                assert lbl1_resp.status_code == 201
                lbl1 = lbl1_resp.json()
                assert lbl1["color"] == "#2563eb"

                dup_lbl = await client.post(
                    f"/api/kanban/projects/{p1_id}/labels",
                    json={"name": "backend", "color": "#111111"},
                )
                assert dup_lbl.status_code == 400
                assert dup_lbl.json()["error"] == "DUPLICATE_LABEL"

                lbl_p2 = await client.post(
                    f"/api/kanban/projects/{p2_id}/labels",
                    json={"name": "backend", "color": "#111111"},
                )
                assert lbl_p2.status_code == 201

                labels_p1 = (
                    await client.get(f"/api/kanban/projects/{p1_id}/labels")
                ).json()["labels"]
                assert len(labels_p1) == 1

                # Cards CRUD + column move + labels/assignee/priority/position
                c1_resp = await client.post(
                    f"/api/kanban/projects/{p1_id}/cards",
                    json={
                        "title": "Implement SQLite schema",
                        "description": "4 tables + indexes",
                        "column_name": "backlog",
                        "priority": "high",
                        "assignee": "alfred-architect",
                        "labels": [lbl1["id"]],
                    },
                )
                assert c1_resp.status_code == 201
                c1 = c1_resp.json()
                c1_id = c1["id"]
                assert c1["position"] == 0
                assert c1["labels"] == [lbl1["id"]]

                c2_resp = await client.post(
                    f"/api/kanban/projects/{p1_id}/cards",
                    json={"title": "Second backlog task", "priority": "low"},
                )
                assert c2_resp.status_code == 201
                assert c2_resp.json()["position"] == 1
                c2_id = c2_resp.json()["id"]

                # Move c1 through columns, clear assignee with None, update fields
                move_resp = await client.patch(
                    f"/api/kanban/cards/{c1_id}",
                    json={
                        "column_name": "in_progress",
                        "priority": "urgent",
                        "position": 3,
                        "assignee": None,
                        "title": "Implement SQLite schema v1",
                    },
                )
                assert move_resp.status_code == 200
                moved = move_resp.json()
                assert moved["column_name"] == "in_progress"
                assert moved["priority"] == "urgent"
                assert moved["position"] == 3
                assert moved["assignee"] is None
                assert moved["title"] == "Implement SQLite schema v1"

                got_c1 = await client.get(f"/api/kanban/cards/{c1_id}")
                assert got_c1.status_code == 200
                assert got_c1.json()["column_name"] == "in_progress"

                filtered_cards = (
                    await client.get(
                        f"/api/kanban/projects/{p1_id}/cards",
                        params={"column_name": "in_progress", "priority": "urgent"},
                    )
                ).json()["cards"]
                assert [c["id"] for c in filtered_cards] == [c1_id]

                # Move c2 without explicit position -> auto-placed at end of target column
                c2_move = await client.patch(
                    f"/api/kanban/cards/{c2_id}",
                    json={"column_name": "in_progress", "labels": [lbl1["id"]]},
                )
                assert c2_move.status_code == 200
                assert c2_move.json()["column_name"] == "in_progress"
                assert c2_move.json()["position"] == 4

                # Deleting label cleans label id from card's labels list
                del_lbl = await client.delete(f"/api/kanban/labels/{lbl1['id']}")
                assert del_lbl.status_code == 200
                refetched_c1 = (await client.get(f"/api/kanban/cards/{c1_id}")).json()
                assert refetched_c1["labels"] == []
                refetched_c2 = (await client.get(f"/api/kanban/cards/{c2_id}")).json()
                assert refetched_c2["labels"] == []

                # Comments CRUD
                cm1_resp = await client.post(
                    f"/api/kanban/cards/{c1_id}/comments",
                    json={"author": "alfred-qa", "body": "Looks solid"},
                )
                assert cm1_resp.status_code == 201
                cm1_id = cm1_resp.json()["id"]

                cm2_resp = await client.post(
                    f"/api/kanban/cards/{c1_id}/comments",
                    json={"author": "owner", "body": "Ship it"},
                )
                assert cm2_resp.status_code == 201
                cm2_id = cm2_resp.json()["id"]

                comments_list = (
                    await client.get(f"/api/kanban/cards/{c1_id}/comments")
                ).json()["comments"]
                assert [cm["id"] for cm in comments_list] == [cm1_id, cm2_id]

                assert (await client.delete(f"/api/kanban/comments/{cm1_id}")).status_code == 200
                remaining_comments = (
                    await client.get(f"/api/kanban/cards/{c1_id}/comments")
                ).json()["comments"]
                assert [cm["id"] for cm in remaining_comments] == [cm2_id]

                # Delete card cascades remaining comment
                assert (await client.delete(f"/api/kanban/cards/{c1_id}")).status_code == 200
                assert (await client.get(f"/api/kanban/cards/{c1_id}/comments")).status_code == 404

                # Delete project cascades cards, labels, and comments
                c2_comment = await client.post(
                    f"/api/kanban/cards/{c2_id}/comments",
                    json={"author": "alfred-qa", "body": "Cascade check"},
                )
                assert c2_comment.status_code == 201
                assert (await client.delete(f"/api/kanban/projects/{p1_id}")).status_code == 200
                assert (await client.get(f"/api/kanban/cards/{c2_id}")).status_code == 404
                assert (await client.get(f"/api/kanban/projects/{p1_id}/labels")).status_code == 404
                assert (await client.get(f"/api/kanban/projects/{p1_id}/cards")).status_code == 404

                # Verify /api/modules exposes core-kanban and its sidebar-page UI contribution
                mods_res = await client.get("/api/modules")
                assert mods_res.status_code == 200
                mods_payload = mods_res.json()
                assert any(m["id"] == "core-kanban" for m in mods_payload["modules"])
                assert any(
                    u["moduleId"] == "core-kanban"
                    and u["id"] == "kanban"
                    and u["slot"] == "sidebar-page"
                    and u["entryFile"] == "kanban-page.js"
                    and u["routeHash"] == "#kanban"
                    and u["order"] == 40
                    for u in mods_payload["uiContributions"]
                )

        # 5. Restart app against same SQLite DB -> state persisted (ProtectSystem=strict safe)
        app2 = create_app(settings, admin_token="kanban-admin-secret")
        async with app2.router.lifespan_context(app2):
            transport2 = httpx.ASGITransport(app=app2)
            async with httpx.AsyncClient(
                transport=transport2,
                base_url="http://test",
                headers={"Authorization": "Bearer kanban-admin-secret"},
            ) as bearer_client:
                projs = (await bearer_client.get("/api/kanban/projects")).json()["projects"]
                assert [p["name"] for p in projs] == ["Beta Board"]
                beta_id = projs[0]["id"]
                beta_labels = (
                    await bearer_client.get(f"/api/kanban/projects/{beta_id}/labels")
                ).json()["labels"]
                assert len(beta_labels) == 1
    finally:
        for key in list(sys.modules.keys()):
            if key == pkg or key.startswith(f"{pkg}."):
                sys.modules.pop(key, None)


async def test_core_kanban_validation_400_and_not_found_404(tmp_path: Path) -> None:
    root = _setup_workspace(tmp_path)
    settings = CoreSettings.from_project_root(root, environment="test")
    pkg = module_package_name("core-kanban")
    try:
        app = create_app(settings, admin_token="kanban-val-tok")
        async with app.router.lifespan_context(app):
            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
                headers={"Authorization": "Bearer kanban-val-tok"},
            ) as client:
                # 404 on every missing resource endpoint
                assert (
                    await client.patch("/api/kanban/projects/nope", json={"name": "A"})
                ).status_code == 404
                assert (await client.delete("/api/kanban/projects/nope")).status_code == 404
                assert (await client.get("/api/kanban/projects/nope/labels")).status_code == 404
                assert (
                    await client.post("/api/kanban/projects/nope/labels", json={"name": "tag"})
                ).status_code == 404
                assert (await client.delete("/api/kanban/labels/nope")).status_code == 404
                assert (await client.get("/api/kanban/projects/nope/cards")).status_code == 404
                assert (
                    await client.post("/api/kanban/projects/nope/cards", json={"title": "Task"})
                ).status_code == 404
                assert (await client.get("/api/kanban/cards/nope")).status_code == 404
                assert (
                    await client.patch("/api/kanban/cards/nope", json={"title": "X"})
                ).status_code == 404
                assert (await client.delete("/api/kanban/cards/nope")).status_code == 404
                assert (await client.get("/api/kanban/cards/nope/comments")).status_code == 404
                assert (
                    await client.post(
                        "/api/kanban/cards/nope/comments",
                        json={"author": "u", "body": "b"},
                    )
                ).status_code == 404
                assert (await client.delete("/api/kanban/comments/nope")).status_code == 404

                # 400 for empty / malformed JSON
                empty_res = await client.post("/api/kanban/projects", content=b"")
                assert empty_res.status_code == 400
                assert empty_res.json()["error"] == "INVALID_JSON"

                bad_json = await client.post("/api/kanban/projects", content=b"{bad-json")
                assert bad_json.status_code == 400
                assert bad_json.json()["error"] == "INVALID_JSON"

                # Create real project + card to exercise card/comment/label validation errors
                proj_id = (
                    await client.post("/api/kanban/projects", json={"name": "Valid Proj"})
                ).json()["id"]
                card_id = (
                    await client.post(
                        f"/api/kanban/projects/{proj_id}/cards",
                        json={"title": "Valid Card"},
                    )
                ).json()["id"]

                # Extra field (extra="forbid") + must NOT echo raw input value
                extra_res = await client.post(
                    "/api/kanban/projects",
                    json={"name": "Ok", "unexpected": "SECRET_INPUT_LEAK_CHECK"},
                )
                assert extra_res.status_code == 400
                assert "SECRET_INPUT_LEAK_CHECK" not in extra_res.text

                # Blank title / invalid column_name / invalid priority / negative pos / null field
                bad_payloads: list[tuple[str, str, dict[str, Any]]] = [
                    (
                        "POST",
                        f"/api/kanban/projects/{proj_id}/labels",
                        {"name": "tag", "color": "red"},
                    ),
                    ("POST", f"/api/kanban/projects/{proj_id}/cards", {"title": "   "}),
                    (
                        "POST",
                        f"/api/kanban/projects/{proj_id}/cards",
                        {"title": "Bad col", "column_name": "SENSITIVE_BAD_COL"},
                    ),
                    (
                        "POST",
                        f"/api/kanban/projects/{proj_id}/cards",
                        {"title": "Bad prio", "priority": "critical"},
                    ),
                    (
                        "POST",
                        f"/api/kanban/projects/{proj_id}/cards",
                        {"title": "Neg pos", "position": -1},
                    ),
                    ("PATCH", f"/api/kanban/projects/{proj_id}", {"name": None}),
                    ("PATCH", f"/api/kanban/cards/{card_id}", {"column_name": None}),
                    (
                        "POST",
                        f"/api/kanban/cards/{card_id}/comments",
                        {"author": "a", "body": "   "},
                    ),
                ]
                for method, path, payload in bad_payloads:
                    res = await client.request(method, path, json=payload)
                    assert res.status_code == 400, f"Expected 400 for {method} {path} {payload}"
                    assert res.json()["error"] == "VALIDATION_ERROR"
                    assert "SENSITIVE_BAD_COL" not in res.text

                # Invalid query param filter -> 400
                bad_filter = await client.get(
                    f"/api/kanban/projects/{proj_id}/cards",
                    params={"column_name": "unknown"},
                )
                assert bad_filter.status_code == 400
    finally:
        for key in list(sys.modules.keys()):
            if key == pkg or key.startswith(f"{pkg}."):
                sys.modules.pop(key, None)
