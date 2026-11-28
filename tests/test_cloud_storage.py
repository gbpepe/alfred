"""Comprehensive tests for `modules/cloud-storage` providers, security gates, OAuth, tools & UI."""

from __future__ import annotations

import ast
import json
import os
import re
import shutil
import sqlite3
import sys
import time
from collections import namedtuple
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi import FastAPI

from alfred.core.config import AgentConfig, CoreSettings
from alfred.core.db import SqlitePool
from alfred.core.routes import create_core_router
from alfred.core.security.heavy_job_hold import HeavyJobHoldManager
from alfred.core.vault import VaultManager
from alfred.core.web_app import CoreAppContainer, build_core_container
from alfred.kernel import (
    ModuleContext,
    ModuleLoader,
    ModuleManifest,
    ModuleRegistry,
    module_package_name,
)
from alfred.kernel.http_bridge import mount_module_dispatcher, mount_module_ui_routes
from alfred.kernel.loader import apply_module_migrations

REPO_ROOT = Path(__file__).resolve().parent.parent
CLOUD_MODULE_DIR = REPO_ROOT / "modules" / "cloud-storage"
CLOUD_PKG_ROOT = CLOUD_MODULE_DIR / "cloud_storage"
TYPE_IGNORE_RE = re.compile(r"#\s*type:\s*ignore")

_DiskUsage = namedtuple("_DiskUsage", ["total", "used", "free"])


def _cleanup_cloud_sys_modules() -> None:
    prefix = module_package_name("cloud-storage")
    for key in list(sys.modules.keys()):
        if (
            key == prefix
            or key.startswith(f"{prefix}.")
            or key.startswith("_alfred_probe_cloud_storage")
        ):
            sys.modules.pop(key, None)


@pytest.fixture(autouse=True)
def _clean_sys_modules() -> Iterator[None]:
    _cleanup_cloud_sys_modules()
    yield
    _cleanup_cloud_sys_modules()


def _make_cloud_settings(tmp_path: Path) -> CoreSettings:
    (tmp_path / "config").mkdir(parents=True, exist_ok=True)
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
                        "id": "cloud-agent",
                        "displayName": "Cloud Agent",
                        "role": "planner",
                        "dailyBudgetUsd": 5.0,
                        "tools": [
                            "cloud_list",
                            "cloud_mkdir",
                            "cloud_upload",
                            "cloud_download",
                            "cloud_share",
                        ],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    store_dir = tmp_path / "store"
    return CoreSettings(
        project_root=tmp_path,
        store_dir=store_dir,
        modules_dir=REPO_ROOT / "modules",
        config_dir=tmp_path / "config",
        agents_config_path=tmp_path / "config" / "agents.json",
        db_path=store_dir / "alfred.db",
        vault_path=store_dir / "vault.json",
        vault_key_path=store_dir / ".vault-key",
        env_path=tmp_path / ".env",
        heavy_job_lock_path=store_dir / ".heavy-job.lock",
        environment="test",
    )


async def _setup_active_cloud(
    tmp_path: Path,
    *,
    http_client: httpx.AsyncClient | None = None,
    retry_delays_sec: tuple[float, ...] = (0.0, 0.0),
) -> tuple[CoreAppContainer, ModuleContext, Any]:
    settings = _make_cloud_settings(tmp_path)
    container = build_core_container(settings, admin_token="cloud-test-admin-tok")
    await container.db.initialize()
    await container.vault.initialize()
    await container.loader.load_active_modules(active_ids={"cloud-storage"})
    ctx = container.registry.get_context("cloud-storage")
    engine = container.registry.get_service("cloud-storage")
    assert ctx is not None and engine is not None
    if http_client is not None:
        if getattr(engine, "_owns_http_client", False):
            await engine.http_client.aclose()
            engine._owns_http_client = False
        engine.http_client = http_client
    engine.retry_delays_sec = retry_delays_sec
    return container, ctx, engine


def test_layout_empty_inits_manifest_and_zero_type_ignore() -> None:
    """Verify package layout, empty `__init__.py`, manifest fields, and 0 type-ignores."""
    assert list(CLOUD_MODULE_DIR.glob("*.py")) == []
    assert (CLOUD_PKG_ROOT / "__init__.py").read_text(encoding="utf-8") == ""
    assert (CLOUD_PKG_ROOT / "providers" / "__init__.py").read_text(encoding="utf-8") == ""

    manifest = ModuleManifest.model_validate_json(
        (CLOUD_MODULE_DIR / "module.json").read_text(encoding="utf-8")
    )
    assert manifest.id == "cloud-storage"
    assert manifest.built_in is False
    assert manifest.default_enabled is False
    assert manifest.entry == "cloud_storage/plugin.py"
    assert manifest.probe_entry == "cloud_storage/probe.py"
    assert manifest.allowed_vault_prefixes == ["cloud_"]
    assert set(manifest.tools) == {
        "cloud_list",
        "cloud_mkdir",
        "cloud_upload",
        "cloud_download",
        "cloud_share",
    }
    assert manifest.ui_card_ids == ["vpsCloudStorageCard"]
    assert manifest.setup_wizard is not None

    for py_file in sorted(CLOUD_MODULE_DIR.rglob("*.py")):
        src = py_file.read_text(encoding="utf-8")
        assert TYPE_IGNORE_RE.search(src) is None
        tree = ast.parse(src, filename=str(py_file))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                assert not node.module.startswith("modules.")
                assert not node.module.startswith("_alfred_mod_")
    assert TYPE_IGNORE_RE.search(Path(__file__).read_text(encoding="utf-8")) is None

    ui_js = (CLOUD_MODULE_DIR / "ui" / "cloud-card.js").read_text(encoding="utf-8")
    assert re.search(r"\bexport\s+function\s+mount\s*\(", ui_js)
    assert re.search(r"\bexport\s+function\s+unmount\s*\(", ui_js)
    assert "innerHTML" not in ui_js
    assert "outerHTML" not in ui_js
    assert "insertAdjacentHTML" not in ui_js


async def test_inactive_probe_zero_token_and_plugin_unloaded(tmp_path: Path) -> None:
    """Verify `probe_inactive_module('cloud-storage')` never imports `plugin.py` or `engine.py`."""
    settings = _make_cloud_settings(tmp_path)
    async with SqlitePool(settings.db_path) as db:
        vault = VaultManager(settings.vault_path, settings.vault_key_path)
        await vault.initialize()
        registry = ModuleRegistry()
        loader = ModuleLoader(
            modules_dir=REPO_ROOT / "modules",
            store_dir=settings.store_dir,
            db=db,
            vault=vault,
            registry=registry,
            heavy_job=HeavyJobHoldManager(settings.heavy_job_lock_path),
            project_root=settings.project_root,
        )

        pkg_name = module_package_name("cloud-storage")
        assert pkg_name not in sys.modules

        res_unconfigured = await loader.probe_inactive_module("cloud-storage")
        assert res_unconfigured.ok is False
        assert pkg_name not in sys.modules
        assert not any(
            name.endswith((".plugin", ".engine")) for name in sys.modules if "cloud_storage" in name
        )

        await vault.set_secret("cloud_gdrive_client_id", "cid-1")
        await vault.set_secret("cloud_gdrive_client_secret", "csec-1")
        await vault.set_secret("cloud_onedrive__work_refresh_token", "rt-work")

        res_configured = await loader.probe_inactive_module("cloud-storage")
        assert res_configured.ok is True
        assert "2/3" in res_configured.summary
        assert pkg_name not in sys.modules
        assert not any(
            name.endswith((".plugin", ".engine")) for name in sys.modules if "cloud_storage" in name
        )


async def test_idempotent_migration_and_vault_key_convention(tmp_path: Path) -> None:
    """Verify idempotent migration v1 and `default` vs named account Vault keys."""
    mod_pkg = module_package_name("cloud-storage")
    container, ctx, _ = await _setup_active_cloud(tmp_path)
    try:
        plugin = container.registry.get_plugin("cloud-storage")
        assert plugin is not None
        assert "cloud_gdrive_client_secret" in plugin.cli_env_sanitize_keys
        assert "cloud_onedrive_refresh_token" in plugin.cli_env_sanitize_keys
        assert "cloud_dropbox_refresh_token" in plugin.cli_env_sanitize_keys

        # Running migrations a second time is strictly idempotent
        second_run = await apply_module_migrations(
            ctx.db,
            "cloud-storage",
            plugin.migrations(),
        )
        assert second_run == []

        def _inspect_schema(conn: sqlite3.Connection) -> tuple[list[str], list[str]]:
            cols = [
                str(r["name"])
                for r in conn.execute("PRAGMA table_info(cloud_activity_log)").fetchall()
            ]
            idxs = [
                str(r["name"])
                for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='index' "
                    "AND tbl_name='cloud_activity_log'"
                ).fetchall()
            ]
            return cols, idxs

        cols, idxs = await ctx.db.read(_inspect_schema)
        assert cols == [
            "id",
            "action",
            "provider",
            "account",
            "remote_ref",
            "byte_size",
            "status",
            "detail",
            "created_at",
        ]
        assert "idx_cloud_activity_log_created_at" in idxs

        mod_ns = sys.modules[mod_pkg]
        models_mod = sys.modules[f"{mod_pkg}.models"]
        assert mod_ns is not None
        assert models_mod.cloud_vault_key("gdrive", "client_id") == "cloud_gdrive_client_id"
        assert (
            models_mod.cloud_vault_key("gdrive", "refresh_token", "default")
            == "cloud_gdrive_refresh_token"
        )
        assert (
            models_mod.cloud_vault_key("onedrive", "refresh_token", "work")
            == "cloud_onedrive__work_refresh_token"
        )
        assert (
            models_mod.cloud_vault_key("dropbox", "root_ref", "archive")
            == "cloud_dropbox__archive_root_ref"
        )
    finally:
        await container.registry.unregister_module("cloud-storage", force=True)
        await container.db.close()


async def test_oauth_pkce_routes_single_use_state_and_zero_token_exposure(
    tmp_path: Path,
) -> None:
    """Verify OAuth2 PKCE S256 start/callback, single-use state, Vault write & redaction."""
    observed_token_posts: list[dict[str, str]] = []

    def _mock_oauth_handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == "https://oauth2.googleapis.com/token":
            parsed = parse_qs(request.content.decode("utf-8"))
            observed_token_posts.append({k: v[0] for k, v in parsed.items()})
            return httpx.Response(
                200,
                json={
                    "access_token": "SECRET-GDRIVE-ACCESS-TOKEN-XYZ",
                    "refresh_token": "SECRET-GDRIVE-REFRESH-TOKEN-ABC",
                    "expires_in": 3600,
                },
            )
        if url.startswith("https://www.googleapis.com/drive/v3/about"):
            return httpx.Response(
                200,
                json={
                    "user": {"displayName": "Work User", "emailAddress": "work@example.com"},
                    "storageQuota": {"limit": "10737418240", "usage": "1048576"},
                },
            )
        return httpx.Response(404, json={"error": "unexpected"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(_mock_oauth_handler)) as mock_http:
        container, ctx, _ = await _setup_active_cloud(tmp_path, http_client=mock_http)
        app = FastAPI()
        app.state.container = container
        mount_module_ui_routes(app, container.registry)
        app.include_router(create_core_router(container))
        mount_module_dispatcher(app, container.registry, container.auth)

        try:
            await ctx.security.vault.set_secret("cloud_gdrive_client_id", "gdrive-client-id")
            await ctx.security.vault.set_secret(
                "cloud_gdrive_client_secret",
                "SECRET-GDRIVE-CLIENT-SECRET",
            )

            admin_cookie, admin_csrf = container.auth.issue_dashboard_session(role="admin")
            dash_cookie, _ = container.auth.issue_dashboard_session(role="dashboard")
            transport = httpx.ASGITransport(app=app)

            async with httpx.AsyncClient(transport=transport, base_url="http://test") as anon:
                # Dashboard-protected & admin-protected routes reject anonymous callers
                assert (await anon.get("/api/cloud/status")).status_code == 401
                assert (await anon.get("/api/cloud/activity")).status_code == 401
                assert (await anon.get("/api/cloud/oauth/start?provider=gdrive")).status_code == 401

                # UI JS serves cleanly with ETag & 304
                ui_resp = await anon.get("/api/modules/cloud-storage/ui/cloud-card.js")
                assert ui_resp.status_code == 200
                etag = ui_resp.headers["etag"]
                assert (
                    await anon.get(
                        "/api/modules/cloud-storage/ui/cloud-card.js",
                        headers={"If-None-Match": etag},
                    )
                ).status_code == 304

            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
                cookies={"alfred_session": dash_cookie},
            ) as dash_client:
                assert (await dash_client.get("/api/cloud/status")).status_code == 200
                start_denied = await dash_client.get("/api/cloud/oauth/start?provider=gdrive")
                assert start_denied.status_code == 403

            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
                cookies={"alfred_session": admin_cookie},
            ) as admin_client:
                # ValidationError must not leak raw input secrets
                bad_cfg = await admin_client.post(
                    "/api/cloud/config",
                    headers={"X-CSRF-Token": admin_csrf},
                    json={"provider": "invalid-prov", "clientSecret": "SECRET-INPUT-NEVER-ECHO"},
                )
                assert bad_cfg.status_code == 400
                assert "SECRET-INPUT-NEVER-ECHO" not in bad_cfg.text

                start_resp = await admin_client.get(
                    "/api/cloud/oauth/start",
                    params={"provider": "gdrive", "account": "work"},
                )
                assert start_resp.status_code == 200
                start_data = start_resp.json()
                assert "SECRET-GDRIVE-CLIENT-SECRET" not in start_resp.text
                assert "code_verifier" not in start_resp.text

                parsed_auth = urlparse(start_data["authUrl"])
                auth_qs = parse_qs(parsed_auth.query)
                assert auth_qs["code_challenge_method"] == ["S256"]
                assert auth_qs["prompt"] == ["select_account consent"]
                assert auth_qs["access_type"] == ["offline"]
                state_token = auth_qs["state"][0]

            # Callback is public_oauth_callback (unauthenticated browser redirect)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as pub_client:
                cb_resp = await pub_client.get(
                    "/api/cloud/oauth/callback",
                    params={"code": "auth-code-123", "state": state_token},
                    headers={"Accept": "application/json"},
                )
                assert cb_resp.status_code == 200
                cb_json = cb_resp.json()
                assert cb_json["ok"] is True
                assert cb_json["provider"] == "gdrive"
                assert cb_json["account"] == "work"
                assert cb_json["accountEmail"] == "work@example.com"
                assert "SECRET-GDRIVE-REFRESH-TOKEN-ABC" not in cb_resp.text
                assert "SECRET-GDRIVE-ACCESS-TOKEN-XYZ" not in cb_resp.text
                assert "SECRET-GDRIVE-CLIENT-SECRET" not in cb_resp.text

                # Replay of same single-use state MUST fail!
                replay_resp = await pub_client.get(
                    "/api/cloud/oauth/callback",
                    params={"code": "auth-code-123", "state": state_token},
                    headers={"Accept": "application/json"},
                )
                assert replay_resp.status_code == 400
                assert replay_resp.json()["error"] == "CLOUD_OAUTH_STATE_INVALID"

                # Tampered state MUST fail!
                tampered_resp = await pub_client.get(
                    "/api/cloud/oauth/callback",
                    params={"code": "auth-code-123", "state": state_token + "x"},
                )
                assert tampered_resp.status_code == 400

            assert len(observed_token_posts) == 1
            assert observed_token_posts[0]["code"] == "auth-code-123"
            assert len(observed_token_posts[0]["code_verifier"]) >= 43

            # Token persisted under named Vault key convention
            stored_rt = await ctx.security.vault.get_secret("cloud_gdrive__work_refresh_token")
            stored_email = await ctx.security.vault.get_secret("cloud_gdrive__work_account_email")
            assert stored_rt == "SECRET-GDRIVE-REFRESH-TOKEN-ABC"
            assert stored_email == "work@example.com"

            # Status & activity routes reflect connection cleanly without exposing tokens
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
                cookies={"alfred_session": dash_cookie},
            ) as dash_client:
                status_resp = await dash_client.get("/api/cloud/status")
                assert status_resp.status_code == 200
                assert "SECRET-GDRIVE-REFRESH-TOKEN-ABC" not in status_resp.text
                gdrive_status = next(
                    p for p in status_resp.json()["providers"] if p["id"] == "gdrive"
                )
                assert gdrive_status["connectedCount"] == 1
                work_acc = next(a for a in gdrive_status["accounts"] if a["account"] == "work")
                assert work_acc["status"] == "connected"
                assert work_acc["accountEmail"] == "work@example.com"

                act_resp = await dash_client.get("/api/cloud/activity")
                assert act_resp.status_code == 200
                assert act_resp.json()["activity"][0]["action"] == "oauth_connect"
        finally:
            await container.registry.unregister_module("cloud-storage", force=True)
            await container.db.close()


async def test_gdrive_resumable_308_patch_in_place_and_native_export(tmp_path: Path) -> None:
    """Verify Google Drive 8 MiB resumable chunks, HTTP 308, PATCH update_in_place & export."""
    chunk_ranges: list[tuple[str, int]] = []
    init_calls: list[tuple[str, str]] = []
    export_urls: list[str] = []

    def _mock_gdrive(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == "https://oauth2.googleapis.com/token":
            return httpx.Response(
                200,
                json={"access_token": "gd-access-1", "expires_in": 3600},
            )
        if url.startswith("https://www.googleapis.com/drive/v3/files?q="):
            # Existing file match for update_in_place
            return httpx.Response(
                200,
                json={
                    "files": [
                        {
                            "id": "existing-doc-99",
                            "name": "report.txt",
                            "mimeType": "text/plain",
                            "size": "100",
                        }
                    ]
                },
            )
        if url.startswith("https://www.googleapis.com/upload/drive/v3/files/existing-doc-99"):
            init_calls.append((request.method, url))
            return httpx.Response(
                200,
                headers={"Location": "https://upload.example/resumable-session-1"},
            )
        if url == "https://upload.example/resumable-session-1":
            content_range = request.headers["Content-Range"]
            chunk_len = len(request.content)
            chunk_ranges.append((content_range, chunk_len))
            if content_range.startswith("bytes 0-262143/"):
                return httpx.Response(308)
            return httpx.Response(
                200,
                json={
                    "id": "existing-doc-99",
                    "name": "report.txt",
                    "mimeType": "text/plain",
                    "size": str(262_144 + chunk_len),
                },
            )
        if url.startswith("https://www.googleapis.com/drive/v3/files/gdoc-123?"):
            return httpx.Response(
                200,
                json={
                    "id": "gdoc-123",
                    "name": "Architecture Doc",
                    "mimeType": "application/vnd.google-apps.document",
                },
            )
        if url.startswith("https://www.googleapis.com/drive/v3/files/gdoc-123/export"):
            export_urls.append(url)
            return httpx.Response(200, content=b"# Exported Markdown\nClean body.\n")
        return httpx.Response(404, json={"error": "not found"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(_mock_gdrive)) as mock_http:
        container, ctx, engine = await _setup_active_cloud(tmp_path, http_client=mock_http)
        engine.skip_disk_space_check = True
        mod_pkg = module_package_name("cloud-storage")
        models_mod = sys.modules[f"{mod_pkg}.models"]
        assert models_mod.DEFAULT_CLOUD_CHUNK_BYTES == 8_388_608
        assert models_mod.ONEDRIVE_CHUNK_BYTES == 8_192_000
        try:
            await ctx.security.vault.set_secret("cloud_gdrive_client_id", "gd-cid")
            await ctx.security.vault.set_secret("cloud_gdrive_client_secret", "gd-csec")
            await ctx.security.vault.set_secret("cloud_gdrive_refresh_token", "gd-rt")

            ws_dir = tmp_path / "ws"
            ws_dir.mkdir(parents=True, exist_ok=True)
            upload_file = ws_dir / "report.txt"
            # 300 KiB clean UTF-8 file uploaded in 256 KiB aligned chunks (fast test)
            total_size = 262_144 + 45_056
            block = b"clean documentation line 0123456789abcdef0123456789abcdef01234\n"
            upload_file.write_bytes((block * ((total_size // len(block)) + 1))[:total_size])

            prov, acc, uploaded = await engine.upload_file(
                local_path="report.txt",
                workspace_dir=ws_dir,
                on_conflict="update_in_place",
                provider="gdrive",
                chunk_bytes=262_144,
            )
            assert prov == "gdrive" and acc == "default"
            assert uploaded.id == "existing-doc-99"
            assert init_calls[0][0] == "PATCH"
            assert "uploadType=resumable" in init_calls[0][1]
            assert chunk_ranges == [
                (f"bytes 0-262143/{total_size}", 262_144),
                (f"bytes 262144-{total_size - 1}/{total_size}", 45_056),
            ]

            _, _, dl_res = await engine.download_file(
                file_ref_or_path="gdoc-123",
                local_dest_path="out/doc.md",
                workspace_dir=ws_dir,
                provider="gdrive",
            )
            assert dl_res.exported_mime_type == "text/markdown"
            assert "mimeType=text%2Fmarkdown" in export_urls[0]
            assert (ws_dir / "out" / "doc.md").read_text(encoding="utf-8") == (
                "# Exported Markdown\nClean body.\n"
            )
        finally:
            await container.registry.unregister_module("cloud-storage", force=True)
            await container.db.close()


async def test_onedrive_strict_8192000_chunks_and_dropbox_confinement(tmp_path: Path) -> None:
    """Verify OneDrive 8_192_000 B chunk alignment and Dropbox path confinement + upload."""
    mod_pkg = module_package_name("cloud-storage")
    onedrive_chunks: list[tuple[str, int]] = []
    dropbox_offsets: list[int] = []
    dropbox_commit_paths: list[str] = []

    def _mock_providers(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == "https://login.microsoftonline.com/common/oauth2/v2.0/token":
            return httpx.Response(200, json={"access_token": "od-tok", "expires_in": 3600})
        if url.endswith("/createUploadSession"):
            return httpx.Response(200, json={"uploadUrl": "https://od-upload.example/sess-1"})
        if url == "https://od-upload.example/sess-1":
            cr = request.headers["Content-Range"]
            onedrive_chunks.append((cr, len(request.content)))
            if cr.startswith("bytes 0-327679/"):
                return httpx.Response(202, json={"nextExpectedRanges": ["327680-"]})
            return httpx.Response(
                201,
                json={
                    "id": "od-item-1",
                    "name": "video.txt",
                    "size": 327_680 + len(request.content),
                },
            )

        if url == "https://api.dropboxapi.com/oauth2/token":
            return httpx.Response(200, json={"access_token": "dbx-tok", "expires_in": 14400})
        if url == "https://content.dropboxapi.com/2/files/upload_session/start":
            return httpx.Response(200, json={"session_id": "dbx-sess-1"})
        if url == "https://content.dropboxapi.com/2/files/upload_session/append_v2":
            arg = json.loads(request.headers["Dropbox-API-Arg"])
            dropbox_offsets.append(int(arg["cursor"]["offset"]))
            return httpx.Response(200)
        if url == "https://content.dropboxapi.com/2/files/upload_session/finish":
            arg = json.loads(request.headers["Dropbox-API-Arg"])
            dropbox_commit_paths.append(str(arg["commit"]["path"]))
            return httpx.Response(
                200,
                json={
                    ".tag": "file",
                    "id": "id:dbx-1",
                    "name": "árvíz.txt",
                    "path_display": arg["commit"]["path"],
                    "size": int(arg["cursor"]["offset"]),
                },
            )
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(_mock_providers)) as mock_http:
        container, ctx, engine = await _setup_active_cloud(tmp_path, http_client=mock_http)
        try:
            dbx_mod = sys.modules[f"{mod_pkg}.providers.dropbox"]
            models_mod = sys.modules[f"{mod_pkg}.models"]

            # Dropbox normalization & path confinement rules
            assert dbx_mod.normalize_dropbox_confined_path(None, "") == ""
            assert dbx_mod.normalize_dropbox_confined_path("/", "/") == ""
            assert dbx_mod.normalize_dropbox_confined_path("/Alfred", None) == "/Alfred"
            assert (
                dbx_mod.normalize_dropbox_confined_path("/Alfred", "docs/notes.md")
                == "/Alfred/docs/notes.md"
            )
            assert (
                dbx_mod.normalize_dropbox_confined_path("/Alfred", "/Alfred/sub/a.txt")
                == "/Alfred/sub/a.txt"
            )
            for bad in ("../secret", "a/../b", r"dir\file", "bad\x00path"):
                with pytest.raises(models_mod.CloudStorageError) as err:
                    dbx_mod.normalize_dropbox_confined_path("/Alfred", bad)
                assert err.value.code == "CLOUD_PATH_TRAVERSAL"

            await ctx.security.vault.set_secret("cloud_onedrive_client_id", "od-cid")
            await ctx.security.vault.set_secret("cloud_onedrive_client_secret", "od-csec")
            await ctx.security.vault.set_secret("cloud_onedrive_refresh_token", "od-rt")

            await ctx.security.vault.set_secret("cloud_dropbox_client_id", "dbx-cid")
            await ctx.security.vault.set_secret("cloud_dropbox_client_secret", "dbx-csec")
            await ctx.security.vault.set_secret("cloud_dropbox_refresh_token", "dbx-rt")
            await engine.save_config(provider="dropbox", root_ref="/Alfred")

            ws_dir = tmp_path / "ws"
            ws_dir.mkdir(parents=True, exist_ok=True)
            # 400_000 bytes (tests OneDrive 320 KiB alignment & Dropbox chunking quickly)
            file_path = ws_dir / "payload.txt"
            total_size = 327_680 + 72_320
            block = b"Clean UTF8 text block 1234567890\n"
            file_path.write_bytes((block * ((total_size // len(block)) + 1))[:total_size])

            _, _, od_item = await engine.upload_file(
                local_path="payload.txt",
                workspace_dir=ws_dir,
                remote_path_or_name="video.txt",
                provider="onedrive",
                chunk_bytes=327_680,
            )
            assert od_item.id == "od-item-1"
            assert onedrive_chunks == [
                (f"bytes 0-327679/{total_size}", 327_680),
                (f"bytes 327680-{total_size - 1}/{total_size}", 72_320),
            ]
            assert onedrive_chunks[0][1] % (320 * 1024) == 0

            _, _, dbx_item = await engine.upload_file(
                local_path="payload.txt",
                workspace_dir=ws_dir,
                remote_path_or_name="árvíz.txt",
                provider="dropbox",
                chunk_bytes=262_144,
            )
            assert dbx_item.id == "id:dbx-1"
            assert dropbox_offsets == [0, 262_144]
            assert dropbox_commit_paths == ["/Alfred/árvíz.txt"]
        finally:
            await container.registry.unregister_module("cloud-storage", force=True)
            await container.db.close()


async def test_download_disk_check_limit_part_cleanup_and_upload_secret_gate_and_heavy_hold(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify disk space gate, .part cleanup on overflow/error, secret gate & heavy hold."""
    http_calls: list[str] = []
    hold_observed_during_upload = False
    engine_ref: list[Any] = []

    def _mock_transfer(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        http_calls.append(url)
        if url == "https://oauth2.googleapis.com/token":
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})
        if url.startswith("https://www.googleapis.com/drive/v3/files/big-dl"):
            if "alt=media" in url:
                # Stream 2 MiB with no Content-Length (triggers max_download_bytes=1 MiB)
                return httpx.Response(200, content=b"Z" * (2 * 1024 * 1024))
            return httpx.Response(
                200,
                json={"id": "big-dl", "name": "big.bin", "mimeType": "application/octet-stream"},
            )
        if url.startswith("https://www.googleapis.com/drive/v3/files/err-dl"):
            if "alt=media" in url:
                class _FailingStream(httpx.AsyncByteStream):
                    async def __aiter__(self) -> AsyncIterator[bytes]:
                        yield b"partial-data-"
                        raise httpx.ReadError("simulated mid-stream reset", request=request)

                return httpx.Response(200, stream=_FailingStream())
            return httpx.Response(
                200,
                json={"id": "err-dl", "name": "err.bin", "mimeType": "application/octet-stream"},
            )
        if url.startswith("https://www.googleapis.com/drive/v3/files?q="):
            return httpx.Response(200, json={"files": []})
        if url.startswith("https://www.googleapis.com/upload/drive/v3/files"):
            return httpx.Response(
                200,
                headers={"Location": "https://upload.example/heavy-hold"},
            )
        if url == "https://upload.example/heavy-hold":
            nonlocal hold_observed_during_upload
            holds_file = engine_ref[0].ctx.heavy_job.lock_path
            if holds_file.exists() and "cloud:upload:gdrive:big_clean.txt" in holds_file.read_text(
                encoding="utf-8"
            ):
                hold_observed_during_upload = True
            cr = request.headers["Content-Range"]
            if cr.startswith("bytes 0-262143/"):
                return httpx.Response(308)
            return httpx.Response(
                200,
                json={
                    "id": "heavy-id-1",
                    "name": "big_clean.txt",
                    "mimeType": "text/plain",
                    "size": str(262_144 + len(request.content)),
                },
            )
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(_mock_transfer)) as mock_http:
        container, ctx, engine = await _setup_active_cloud(tmp_path, http_client=mock_http)
        engine_ref.append(engine)
        mod_pkg = module_package_name("cloud-storage")
        models_mod = sys.modules[f"{mod_pkg}.models"]
        engine_mod = sys.modules[f"{mod_pkg}.engine"]
        try:
            await ctx.security.vault.set_secret("cloud_gdrive_client_id", "gd-cid")
            await ctx.security.vault.set_secret("cloud_gdrive_client_secret", "gd-csec")
            await ctx.security.vault.set_secret("cloud_gdrive_refresh_token", "gd-rt")

            ws_dir = tmp_path / "ws"
            ws_dir.mkdir(parents=True, exist_ok=True)
            (ws_dir / "dl").mkdir(parents=True, exist_ok=True)

            # 1) Disk space check (< 512 MiB) aborts BEFORE any HTTP call!
            monkeypatch.setattr(
                shutil,
                "disk_usage",
                lambda _p: _DiskUsage(1_000_000_000, 900_000_000, 100 * 1024 * 1024),
            )
            with pytest.raises(models_mod.CloudStorageError) as disk_err:
                await engine.download_file(
                    file_ref_or_path="big-dl",
                    local_dest_path="dl/out.bin",
                    workspace_dir=ws_dir,
                    provider="gdrive",
                )
            assert disk_err.value.code == "CLOUD_DISK_SPACE_INSUFFICIENT"
            assert not any("alt=media" in u for u in http_calls)

            # Restore sufficient free disk (>= 512 MiB)
            monkeypatch.setattr(
                shutil,
                "disk_usage",
                lambda _p: _DiskUsage(10_000_000_000, 1_000_000_000, 2 * 1024 * 1024 * 1024),
            )

            # 2) Exceeding ALFRED_CLOUD_MAX_DOWNLOAD_MB aborts & deletes .part file
            monkeypatch.setenv("ALFRED_CLOUD_MAX_DOWNLOAD_MB", "1")
            with pytest.raises(models_mod.CloudStorageError) as limit_err:
                await engine.download_file(
                    file_ref_or_path="big-dl",
                    local_dest_path="dl/too_big.bin",
                    workspace_dir=ws_dir,
                    provider="gdrive",
                )
            assert limit_err.value.code == "CLOUD_DOWNLOAD_LIMIT_EXCEEDED"
            assert not (ws_dir / "dl" / "too_big.bin").exists()
            assert list((ws_dir / "dl").glob("*.part")) == []

            # 3) Mid-stream transport error aborts & deletes .part file
            with pytest.raises(models_mod.CloudStorageError):
                await engine.download_file(
                    file_ref_or_path="err-dl",
                    local_dest_path="dl/errored.bin",
                    workspace_dir=ws_dir,
                    provider="gdrive",
                )
            assert not (ws_dir / "dl" / "errored.bin").exists()
            assert list((ws_dir / "dl").glob("*.part")) == []

            # 4) Secret gate & path confinement block uploads BEFORE any HTTP call!
            http_calls.clear()
            secret_file = ws_dir / "notes.txt"
            fake_stripe = "sk_live_" + "AbCdEfGhIjKlMnOpQrSt1234"
            secret_file.write_text(f"token = {fake_stripe}\n", encoding="utf-8")
            with pytest.raises(models_mod.CloudStorageError) as sec_err:
                await engine.upload_file(
                    local_path="notes.txt",
                    workspace_dir=ws_dir,
                    provider="gdrive",
                )
            assert sec_err.value.code == "CLOUD_SECRET_GATE_BLOCKED"
            assert http_calls == []

            # Unknown binary file (< 2 MiB) still fails closed via Tier 3 scan_file_for_secrets
            bin_file = ws_dir / "small.bin"
            bin_file.write_bytes(b"\x00\x01\x02\x03")
            with pytest.raises(models_mod.CloudStorageError) as bin_err:
                await engine.upload_file(
                    local_path="small.bin",
                    workspace_dir=ws_dir,
                    provider="gdrive",
                )
            assert bin_err.value.code == "CLOUD_SECRET_GATE_BLOCKED"
            assert http_calls == []

            # Path confinement blocks .. and NUL
            from alfred.kernel.errors import ModuleSecurityError

            for bad_path in ("../escape.txt", "sub/../../escape.txt", "bad\x00.txt"):
                with pytest.raises(ModuleSecurityError):
                    await engine.upload_file(
                        local_path=bad_path,
                        workspace_dir=ws_dir,
                        provider="gdrive",
                    )

            # 5) Heavy transfer hold & streaming upload without read_bytes() (256 KiB threshold)
            assert models_mod.HEAVY_TRANSFER_HOLD_MIN_BYTES == 16 * 1024 * 1024
            monkeypatch.setattr(engine_mod, "HEAVY_TRANSFER_HOLD_MIN_BYTES", 256 * 1024)
            monkeypatch.setattr(engine_mod, "_STREAM_SCAN_THRESHOLD_BYTES", 256 * 1024)
            monkeypatch.setattr(engine_mod, "_LARGE_SCAN_CHUNK_BYTES", 128 * 1024)
            big_clean = ws_dir / "big_clean.txt"
            target_bytes = 262_144 + 512
            line = b"Clean large payload line 0123456789abcdef0123456789abcdef0123456\n"
            big_clean.write_bytes((line * ((target_bytes // len(line)) + 1))[:target_bytes])

            orig_read_bytes = Path.read_bytes

            def _forbid_full_read_bytes(self_path: Path) -> bytes:
                if self_path.resolve() == big_clean.resolve():
                    raise AssertionError("Full-file read_bytes() must never be called on upload!")
                return orig_read_bytes(self_path)

            monkeypatch.setattr(Path, "read_bytes", _forbid_full_read_bytes)

            _, _, heavy_item = await engine.upload_file(
                local_path="big_clean.txt",
                workspace_dir=ws_dir,
                provider="gdrive",
                chunk_bytes=262_144,
            )
            assert heavy_item.id == "heavy-id-1"
            assert hold_observed_during_upload is True
            assert await ctx.heavy_job.active_holds() == []

            # Large streaming file containing a secret past chunk boundary MUST be blocked!
            http_calls.clear()
            big_secret = ws_dir / "big_over_limit.txt"
            base_len = 265_000
            prefix = (line * ((base_len // len(line)) + 1))[:base_len]
            big_secret.write_bytes(prefix + f"\nleaked={fake_stripe}\n".encode())
            with pytest.raises(models_mod.CloudStorageError) as big_sec_err:
                await engine.upload_file(
                    local_path="big_over_limit.txt",
                    workspace_dir=ws_dir,
                    provider="gdrive",
                )
            assert big_sec_err.value.code == "CLOUD_SECRET_GATE_BLOCKED"
            assert http_calls == []
        finally:
            await container.registry.unregister_module("cloud-storage", force=True)
            await container.db.close()


async def test_share_policy_all_providers_tools_and_housekeeping(tmp_path: Path) -> None:
    """Verify `cloud_allow_public_links` across all 3 providers, 5 tools & housekeeping."""
    share_calls: list[str] = []

    def _mock_share_and_ops(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url in (
            "https://oauth2.googleapis.com/token",
            "https://login.microsoftonline.com/common/oauth2/v2.0/token",
            "https://api.dropboxapi.com/oauth2/token",
        ):
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})
        if "/permissions" in url:
            share_calls.append("gdrive")
            return httpx.Response(200, json={"id": "perm-1"})
        if url.startswith("https://www.googleapis.com/drive/v3/files/gd-1"):
            return httpx.Response(
                200,
                json={"id": "gd-1", "name": "a.txt", "webViewLink": "https://drive/gd-1"},
            )
        if url.endswith("/createLink") or url.endswith("/invite"):
            share_calls.append("onedrive")
            return httpx.Response(200, json={"link": {"webUrl": "https://1drv.ms/od-1"}})
        if "/sharing/create_shared_link_with_settings" in url or "/sharing/add_file_member" in url:
            share_calls.append("dropbox")
            return httpx.Response(200, json={"url": "https://dropbox.com/s/dbx-1"})
        if url == "https://api.dropboxapi.com/2/sharing/get_file_metadata":
            return httpx.Response(200, json={"preview_url": "https://dropbox.com/p/dbx-1"})
        if url == "https://api.dropboxapi.com/2/files/list_folder":
            return httpx.Response(
                200,
                json={"entries": [{".tag": "file", "id": "id:f1", "name": "f1.txt", "size": 5}]},
            )
        if url == "https://api.dropboxapi.com/2/files/create_folder_v2":
            return httpx.Response(
                200,
                json={
                    "metadata": {
                        ".tag": "folder",
                        "id": "id:dir1",
                        "name": "reports",
                        "path_display": "/reports",
                    }
                },
            )
        if url == "https://content.dropboxapi.com/2/files/upload_session/start":
            return httpx.Response(200, json={"session_id": "dbx-tool-sess"})
        if url == "https://content.dropboxapi.com/2/files/upload_session/append_v2":
            return httpx.Response(200)
        if url == "https://content.dropboxapi.com/2/files/upload_session/finish":
            return httpx.Response(
                200,
                json={
                    ".tag": "file",
                    "id": "id:tool-up",
                    "name": "tool_note.txt",
                    "path_display": "/tool_note.txt",
                    "size": 12,
                },
            )
        if url == "https://content.dropboxapi.com/2/files/download":
            meta = json.dumps(
                {
                    ".tag": "file",
                    "id": "id:tool-up",
                    "name": "tool_note.txt",
                    "path_display": "/tool_note.txt",
                    "size": 12,
                }
            )
            return httpx.Response(
                200,
                headers={"Dropbox-API-Result": meta},
                content=b"hello world!",
            )
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(_mock_share_and_ops)) as mock_http:
        container, ctx, engine = await _setup_active_cloud(tmp_path, http_client=mock_http)
        mod_pkg = module_package_name("cloud-storage")
        models_mod = sys.modules[f"{mod_pkg}.models"]
        try:
            for prov in ("gdrive", "onedrive", "dropbox"):
                await ctx.security.vault.set_secret(f"cloud_{prov}_client_id", f"{prov}-cid")
                await ctx.security.vault.set_secret(f"cloud_{prov}_client_secret", f"{prov}-csec")
                await ctx.security.vault.set_secret(f"cloud_{prov}_refresh_token", f"{prov}-rt")

            # Default policy blocks public_link=True across all 3 providers!
            for prov, ref in (("gdrive", "gd-1"), ("onedrive", "od-1"), ("dropbox", "/a.txt")):
                with pytest.raises(models_mod.CloudStorageError) as pub_err:
                    await engine.share_file(
                        file_ref_or_path=ref,
                        public_link=True,
                        provider=prov,
                    )
                assert pub_err.value.code == "CLOUD_PUBLIC_LINK_FORBIDDEN"
            assert share_calls == []

            # Enabling cloud_allow_public_links allows public links across all 3 providers
            await engine.save_config(allow_public_links=True)
            for prov, ref in (("gdrive", "gd-1"), ("onedrive", "od-1"), ("dropbox", "/a.txt")):
                res = await engine.share_file(
                    file_ref_or_path=ref,
                    public_link=True,
                    provider=prov,
                )
                assert res.share.mode == "public_link"
                assert res.share.shared_with == "anyone"
            assert share_calls == ["gdrive", "onedrive", "dropbox"]

            # Invoke tools via ToolExecutor
            agent = AgentConfig(
                id="cloud-agent",
                displayName="Cloud Agent",
                role="planner",
                tools=[
                    "cloud_list",
                    "cloud_mkdir",
                    "cloud_upload",
                    "cloud_download",
                    "cloud_share",
                ],
            )
            ws_dir = tmp_path / "ws"
            ws_dir.mkdir(parents=True, exist_ok=True)
            (ws_dir / "tool_note.txt").write_bytes(b"hello world!")
            engine.skip_disk_space_check = True

            list_res = await container.tool_executor.execute_tool(
                agent=agent,
                tool_name="cloud_list",
                raw_args={"provider": "dropbox"},
                session_id="s1",
                workspace_dir=ws_dir,
            )
            assert list_res.ok is True and len(list_res.output["items"]) == 1

            mkdir_res = await container.tool_executor.execute_tool(
                agent=agent,
                tool_name="cloud_mkdir",
                raw_args={"provider": "dropbox", "path_or_name": "reports"},
                session_id="s1",
                workspace_dir=ws_dir,
            )
            assert mkdir_res.ok is True and mkdir_res.output["folder"]["name"] == "reports"

            up_res = await container.tool_executor.execute_tool(
                agent=agent,
                tool_name="cloud_upload",
                raw_args={"provider": "dropbox", "local_path": "tool_note.txt"},
                session_id="s1",
                workspace_dir=ws_dir,
            )
            assert up_res.ok is True and up_res.output["item"]["id"] == "id:tool-up"

            dl_res = await container.tool_executor.execute_tool(
                agent=agent,
                tool_name="cloud_download",
                raw_args={
                    "provider": "dropbox",
                    "file_ref_or_path": "/tool_note.txt",
                    "local_dest_path": "downloaded/note.txt",
                },
                session_id="s1",
                workspace_dir=ws_dir,
            )
            assert dl_res.ok is True and dl_res.output["result"]["bytes_written"] == 12
            assert (ws_dir / "downloaded" / "note.txt").read_bytes() == b"hello world!"

            share_res = await container.tool_executor.execute_tool(
                agent=agent,
                tool_name="cloud_share",
                raw_args={
                    "provider": "dropbox",
                    "file_ref_or_path": "/a.txt",
                    "email": "owner@example.com",
                },
                session_id="s1",
                workspace_dir=ws_dir,
            )
            assert share_res.ok is True and share_res.output["share"]["mode"] == "email"

            # read_only account rejects write/mkdir/share fail-closed
            await engine.save_config(
                provider="dropbox",
                account="readonly",
                access_mode="read_only",
            )
            await ctx.security.vault.set_secret("cloud_dropbox__readonly_refresh_token", "ro-rt")
            ro_mkdir = await container.tool_executor.execute_tool(
                agent=agent,
                tool_name="cloud_mkdir",
                raw_args={"provider": "dropbox", "account": "readonly", "path_or_name": "blocked"},
                session_id="s1",
                workspace_dir=ws_dir,
            )
            assert ro_mkdir.ok is False and ro_mkdir.error_code == "CLOUD_ACCOUNT_READONLY"

            # Explicit unknown account fails closed (never falls back to default)
            missing_acc = await container.tool_executor.execute_tool(
                agent=agent,
                tool_name="cloud_list",
                raw_args={"provider": "dropbox", "account": "nonexistent"},
                session_id="s1",
                workspace_dir=ws_dir,
            )
            assert missing_acc.ok is False and missing_acc.error_code == "CLOUD_ACCOUNT_NOT_FOUND"

            # Housekeeping: prunes stale .part files & old cloud_activity_log rows
            data_dir = ctx.security.data_dir.ensure_exists()
            stale_part = data_dir / "old_transfer.part"
            fresh_part = data_dir / "active_transfer.part"
            stale_part.write_bytes(b"12345")
            fresh_part.write_bytes(b"67890")
            old_mtime = time.time() - 7200
            os.utime(stale_part, (old_mtime, old_mtime))

            old_iso = (datetime.now(tz=UTC) - timedelta(days=45)).isoformat()
            await ctx.db.write(
                lambda conn: conn.execute(
                    "INSERT INTO cloud_activity_log "
                    "(action, provider, account, remote_ref, byte_size, "
                    "status, detail, created_at) "
                    "VALUES ('list', 'dropbox', 'default', '/', 0, 'ok', NULL, ?)",
                    (old_iso,),
                )
            )

            plugin = container.registry.get_plugin("cloud-storage")
            assert plugin is not None
            hk_stats = await plugin.on_housekeeping(ctx, retention_days=30, disk_used_pct=40.0)
            assert hk_stats.deleted_rows == 1
            assert hk_stats.freed_bytes == 5
            assert not stale_part.exists()
            assert fresh_part.exists()
        finally:
            await container.registry.unregister_module("cloud-storage", force=True)
            await container.db.close()


async def test_binary_uploads_disguised_secrets_and_dropbox_integrity_before_rename(
    tmp_path: Path,
) -> None:
    """Verify real binary PDF/PNG/MP4/ZIP upload while disguised files & DBX mismatch fail."""
    uploaded_names: list[str] = []

    def _mock_bin_handler(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == "https://api.dropboxapi.com/oauth2/token":
            return httpx.Response(200, json={"access_token": "dbx-bin-tok", "expires_in": 14400})
        if url == "https://content.dropboxapi.com/2/files/upload_session/start":
            return httpx.Response(200, json={"session_id": "dbx-bin-sess"})
        if url == "https://content.dropboxapi.com/2/files/upload_session/append_v2":
            return httpx.Response(200)
        if url == "https://content.dropboxapi.com/2/files/upload_session/finish":
            arg = json.loads(request.headers["Dropbox-API-Arg"])
            commit_path = str(arg["commit"]["path"])
            name = commit_path.rsplit("/", 1)[-1]
            uploaded_names.append(name)
            return httpx.Response(
                200,
                json={
                    ".tag": "file",
                    "id": f"id:{name}",
                    "name": name,
                    "path_display": commit_path,
                    "size": int(arg["cursor"]["offset"]),
                },
            )
        if url == "https://content.dropboxapi.com/2/files/download":
            meta = json.dumps(
                {".tag": "file", "id": "id:bad", "name": "target.txt", "size": 999}
            )
            return httpx.Response(
                200,
                headers={"Dropbox-API-Result": meta},
                content=b"truncated",
            )
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(_mock_bin_handler)) as mock_http:
        container, ctx, engine = await _setup_active_cloud(tmp_path, http_client=mock_http)
        engine.skip_disk_space_check = True
        mod_pkg = module_package_name("cloud-storage")
        models_mod = sys.modules[f"{mod_pkg}.models"]
        try:
            await ctx.security.vault.set_secret("cloud_dropbox_client_id", "dbx-cid")
            await ctx.security.vault.set_secret("cloud_dropbox_client_secret", "dbx-csec")
            await ctx.security.vault.set_secret("cloud_dropbox_refresh_token", "dbx-rt")

            ws_dir = tmp_path / "ws"
            ws_dir.mkdir(parents=True, exist_ok=True)

            # 1. Valid magic-header binaries (with NUL/non-UTF-8 bytes) upload cleanly
            binaries: list[tuple[str, bytes]] = [
                ("doc.pdf", b"%PDF-1.7\n1 0 obj\n<<>>\x00\xff\xfe%%EOF"),
                ("img.png", b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\xff\xfe"),
                ("clip.mp4", b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00mp42\xff"),
                ("bundle.zip", b"PK\x03\x04\x14\x00\x00\x00\x08\x00\x00\xff\xfe"),
            ]
            for fname, data in binaries:
                (ws_dir / fname).write_bytes(data)
                _, _, item = await engine.upload_file(
                    local_path=fname,
                    workspace_dir=ws_dir,
                    provider="dropbox",
                )
                assert item.name == fname
            assert uploaded_names == ["doc.pdf", "img.png", "clip.mp4", "bundle.zip"]

            # 2. Disguised secret key renamed to .png (fails magic header -> Tier 3 blocks!)
            fake_stripe = "sk_live_" + "AbCdEfGhIjKlMnOpQrSt1234"
            (ws_dir / "leak.png").write_text(
                f"OPENAI_OR_STRIPE={fake_stripe}\n",
                encoding="utf-8",
            )
            with pytest.raises(models_mod.CloudStorageError) as dis_err:
                await engine.upload_file(
                    local_path="leak.png",
                    workspace_dir=ws_dir,
                    provider="dropbox",
                )
            assert dis_err.value.code == "CLOUD_SECRET_GATE_BLOCKED"

            # Real PNG magic header with embedded secret literal -> Tier 2 ASCII scan blocks!
            (ws_dir / "secret_inside.png").write_bytes(
                b"\x89PNG\r\n\x1a\n\x00\x00" + fake_stripe.encode("ascii") + b"\x00\xff"
            )
            # Name matches `_SENSITIVE_BASENAME_RE` (`secret`) AND embedded literal in Tier 2
            with pytest.raises(models_mod.CloudStorageError) as inside_err:
                await engine.upload_file(
                    local_path="secret_inside.png",
                    workspace_dir=ws_dir,
                    provider="dropbox",
                )
            assert inside_err.value.code == "CLOUD_SECRET_GATE_BLOCKED"

            (ws_dir / "real_img_embedded.png").write_bytes(
                b"\x89PNG\r\n\x1a\n\x00\x00" + fake_stripe.encode("ascii") + b"\x00\xff"
            )
            with pytest.raises(models_mod.CloudStorageError) as emb_err:
                await engine.upload_file(
                    local_path="real_img_embedded.png",
                    workspace_dir=ws_dir,
                    provider="dropbox",
                )
            assert emb_err.value.code == "CLOUD_SECRET_GATE_BLOCKED"

            # Tier 1 blocked file categories (.pem, .sqlite3, my_secret.pdf) even with valid headers
            from alfred.kernel.errors import ModuleError

            (ws_dir / "priv.pem").write_text("clean-text", encoding="utf-8")
            (ws_dir / "data.sqlite3").write_bytes(b"SQLite format 3\x00")
            (ws_dir / "my_secret.pdf").write_bytes(b"%PDF-1.7\n\x00")
            for blocked_name in ("priv.pem", "data.sqlite3", "my_secret.pdf"):
                with pytest.raises(ModuleError) as blk:
                    await engine.upload_file(
                        local_path=blocked_name,
                        workspace_dir=ws_dir,
                        provider="dropbox",
                    )
                assert blk.value.status_code == 403

            # 3. Dropbox integrity mismatch leaves pre-existing dest_path intact and cleans .part
            dest = ws_dir / "existing.txt"
            dest.write_text("good-existing-data", encoding="utf-8")
            with pytest.raises(models_mod.CloudStorageError) as integ_err:
                await engine.download_file(
                    file_ref_or_path="/target.txt",
                    local_dest_path="existing.txt",
                    workspace_dir=ws_dir,
                    provider="dropbox",
                )
            assert integ_err.value.code == "CLOUD_INTEGRITY_MISMATCH"
            assert dest.read_text(encoding="utf-8") == "good-existing-data"
            assert list(ws_dir.glob("*.part")) == []
        finally:
            await container.registry.unregister_module("cloud-storage", force=True)
            await container.db.close()


async def test_mint_short_lived_token_and_zero_trust_manual_oauth_routes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify `mint_short_lived_token()`, `POST /api/admin/cloud/oauth/callback` & HTML."""
    refresh_calls = 0

    def _mock_oauth(request: httpx.Request) -> httpx.Response:
        nonlocal refresh_calls
        url = str(request.url)
        if url == "https://oauth2.googleapis.com/token":
            parsed = parse_qs(request.content.decode("utf-8"))
            grant = parsed.get("grant_type", [""])[0]
            if grant == "authorization_code":
                return httpx.Response(
                    200,
                    json={
                        "access_token": "FRESH-OAUTH-ACCESS-1",
                        "refresh_token": "SECRET-GDRIVE-RT-1",
                        "expires_in": 3600,
                    },
                )
            if grant == "refresh_token":
                refresh_calls += 1
                return httpx.Response(
                    200,
                    json={"access_token": "MINTED-ACCESS-2", "expires_in": 3600},
                )
        if url.startswith("https://www.googleapis.com/drive/v3/about"):
            return httpx.Response(
                200,
                json={"user": {"emailAddress": "zt@example.com"}},
            )
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(_mock_oauth)) as mock_http:
        container, ctx, engine = await _setup_active_cloud(tmp_path, http_client=mock_http)
        app = FastAPI()
        app.state.container = container
        mount_module_ui_routes(app, container.registry)
        app.include_router(create_core_router(container))
        mount_module_dispatcher(app, container.registry, container.auth)

        try:
            await ctx.security.vault.set_secret("cloud_gdrive_client_id", "gd-cid")
            await ctx.security.vault.set_secret(
                "cloud_gdrive_client_secret",
                "SECRET-GDRIVE-CLIENT-SEC",
            )
            await engine.save_config(
                provider="gdrive",
                account="work",
                root_ref="folder-root-1",
                access_mode="read_only",
            )

            admin_cookie, admin_csrf = container.auth.issue_dashboard_session(role="admin")
            dash_cookie, dash_csrf = container.auth.issue_dashboard_session(role="dashboard")
            transport = httpx.ASGITransport(app=app)

            # 1. GET /oauth-cloud-callback.html renders safe postMessage HTML without reflecting XSS
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as pub:
                xss_probe = "<script>alert(1)</script>"
                html_res = await pub.get(
                    "/oauth-cloud-callback.html",
                    params={"code": xss_probe, "state": "s1"},
                )
                assert html_res.status_code == 200
                assert "alfred:cloud-oauth-callback" in html_res.text
                assert xss_probe not in html_res.text

                # Anonymous POST to admin OAuth callback rejected (401)
                anon_cb = await pub.post(
                    "/api/admin/cloud/oauth/callback",
                    json={"code": "c1", "state": "s1"},
                )
                assert anon_cb.status_code == 401

            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
                cookies={"alfred_session": dash_cookie},
            ) as dash:
                deny_cb = await dash.post(
                    "/api/admin/cloud/oauth/callback",
                    headers={"X-CSRF-Token": dash_csrf},
                    json={"code": "c1", "state": "s1"},
                )
                assert deny_cb.status_code == 403

            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
                cookies={"alfred_session": admin_cookie},
            ) as admin:
                # Flow A: manual callbackUrl paste (Zero Trust / SSH tunnel)
                start1 = await admin.get(
                    "/api/cloud/oauth/start",
                    params={"provider": "gdrive", "account": "work", "accessMode": "read_only"},
                )
                assert start1.status_code == 200
                state1 = start1.json()["state"]

                no_csrf = await admin.post(
                    "/api/admin/cloud/oauth/callback",
                    json={"callbackUrl": f"https://alfred.test/oauth-cloud-callback.html?code=c1&state={state1}"},
                )
                assert no_csrf.status_code == 403

                ok_url_cb = await admin.post(
                    "/api/admin/cloud/oauth/callback",
                    headers={"X-CSRF-Token": admin_csrf},
                    json={"callbackUrl": f"https://alfred.test/oauth-cloud-callback.html?code=c1&state={state1}"},
                )
                assert ok_url_cb.status_code == 200
                assert ok_url_cb.json()["account"] == "work"
                assert "SECRET-GDRIVE-RT-1" not in ok_url_cb.text
                assert "FRESH-OAUTH-ACCESS-1" not in ok_url_cb.text

                # Replay of same state fails
                replay_cb = await admin.post(
                    "/api/admin/cloud/oauth/callback",
                    headers={"X-CSRF-Token": admin_csrf},
                    json={"code": "c1", "state": state1},
                )
                assert replay_cb.status_code == 400

                # Flow B: direct {code, state} JSON body
                start2 = await admin.get(
                    "/api/cloud/oauth/start",
                    params={"provider": "gdrive", "account": "work"},
                )
                state2 = start2.json()["state"]
                ok_code_cb = await admin.post(
                    "/api/admin/cloud/oauth/callback",
                    headers={"X-CSRF-Token": admin_csrf},
                    json={"code": "c2", "state": state2},
                )
                assert ok_code_cb.status_code == 200

            # 2. mint_short_lived_token() via Service Bus (cached -> 0 Vault decrypts on cache hit!)
            svc = container.registry.get_service("cloud-storage")
            assert svc is engine
            get_secret_calls = 0
            orig_get_secret = ctx.security.vault.get_secret

            async def _spy_get_secret(key_id: str) -> str | None:
                nonlocal get_secret_calls
                get_secret_calls += 1
                return await orig_get_secret(key_id)

            monkeypatch.setattr(ctx.security.vault, "get_secret", _spy_get_secret)

            tok1 = await svc.mint_short_lived_token(provider="gdrive", account="work")
            assert tok1.provider == "gdrive"
            assert tok1.account == "work"
            assert tok1.access_token == "FRESH-OAUTH-ACCESS-1"
            assert tok1.expires_in_sec >= 1
            assert tok1.root_ref == "folder-root-1"
            assert "refresh_token" not in tok1.model_dump()
            assert "SECRET-GDRIVE-RT-1" not in tok1.model_dump_json()
            assert get_secret_calls == 0

            # Cold cache mints fresh token via Vault + refresh_token grant
            engine._access_token_cache.clear()
            tok2 = await svc.mint_short_lived_token(provider="gdrive", account="work")
            assert tok2.access_token == "MINTED-ACCESS-2"
            assert refresh_calls == 1
            assert get_secret_calls > 0
        finally:
            await container.registry.unregister_module("cloud-storage", force=True)
            await container.db.close()
