"""Tests for `modules/core-ops`: 2 GB VPS telemetry, housekeeping, tools, routes & UI."""

from __future__ import annotations

import ast
import json
import os
import sys
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict

from alfred.core.auth import AuthService
from alfred.core.config import AgentConfig
from alfred.core.db import SqlitePool
from alfred.core.security.heavy_job_hold import HeavyJobHoldManager
from alfred.core.tool_executor import ToolExecutor
from alfred.core.vault import VaultManager
from alfred.kernel import (
    BaseModulePlugin,
    HousekeepingStats,
    ModuleContext,
    ModuleManifest,
    ModuleRegistry,
    ModuleSecurityError,
    ScopedServiceBus,
    attach_module_bridge,
    load_module_entrypoint,
    module_package_name,
)
from alfred.kernel.loader import discover_manifests
from alfred.kernel.security import (
    ModuleDataDir,
    ModuleSecurityProxy,
    ScopedConfigProxy,
    ScopedVaultProxy,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
CORE_OPS_DIR = REPO_ROOT / "modules" / "core-ops"
CORE_OPS_PKG = CORE_OPS_DIR / "core_ops"


def _load_core_ops_symbols() -> tuple[Any, ...]:
    """Load `core_ops` submodules cleanly via package path without cross-importing core-cli."""
    plugin_mod_name = module_package_name("core-ops")
    plugin_obj = load_module_entrypoint("core-ops", CORE_OPS_DIR, entry_file="core_ops/plugin.py")
    sys_mon = sys.modules[f"{plugin_mod_name}.system_monitor"]
    hk_mod = sys.modules[f"{plugin_mod_name}.housekeeper"]
    return (plugin_obj, sys_mon, hk_mod)


@pytest.fixture(autouse=True)
def _cleanup_core_ops_sys_modules() -> Iterator[None]:
    yield
    prefix = module_package_name("core-ops")
    for key in list(sys.modules.keys()):
        if key == prefix or key.startswith(f"{prefix}."):
            sys.modules.pop(key, None)


class _FakeCliProviderStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider_id: str
    binary: str
    available: bool
    active_profile: str | None = None
    quota_limited: bool = False
    cooldown_until: int | None = None
    detail: str = ""


class _FakeCliStatusReport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    providers: list[_FakeCliProviderStatus]
    total_invocations: int = 0


class _FakeCliProfileSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")
    provider_id: str
    profile_id: str
    label: str
    active: bool = False
    email_hint: str | None = None


class _FakeCliProfilesResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    profiles: list[_FakeCliProfileSummary]


class _FakeCliSwitchResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ok: bool
    provider_id: str
    active_profile: str
    message: str = ""


class _FakeMcpSkillSyncResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ok: bool
    synced_skills: list[str]
    blocked_skills: list[dict[str, Any]]
    synced_mcp_servers: int = 0


class _FakeCoreCliService:
    """In-test structural match for `CoreCliService` without importing `modules/core-cli`."""

    def __init__(self) -> None:
        self.active_profiles: dict[str, str] = {"claude-cli": "default", "gemini-cli": "personal"}
        self.sync_calls: list[tuple[Path | None, dict[str, Any] | None]] = []

    async def get_cli_status(self) -> _FakeCliStatusReport:
        return _FakeCliStatusReport(
            providers=[
                _FakeCliProviderStatus(
                    provider_id="claude-cli",
                    binary="claude",
                    available=True,
                    active_profile=self.active_profiles["claude-cli"],
                ),
                _FakeCliProviderStatus(
                    provider_id="gemini-cli",
                    binary="gemini",
                    available=True,
                    active_profile=self.active_profiles["gemini-cli"],
                ),
            ],
            total_invocations=7,
        )

    async def list_profiles(self, provider_id: str | None = None) -> _FakeCliProfilesResponse:
        all_profiles = [
            _FakeCliProfileSummary(
                provider_id="claude-cli",
                profile_id="default",
                label="Default",
                active=self.active_profiles["claude-cli"] == "default",
            ),
            _FakeCliProfileSummary(
                provider_id="claude-cli",
                profile_id="work",
                label="Work",
                active=self.active_profiles["claude-cli"] == "work",
            ),
            _FakeCliProfileSummary(
                provider_id="gemini-cli",
                profile_id="personal",
                label="Personal",
                active=self.active_profiles["gemini-cli"] == "personal",
            ),
        ]
        filtered = (
            [p for p in all_profiles if p.provider_id == provider_id]
            if provider_id is not None
            else all_profiles
        )
        return _FakeCliProfilesResponse(profiles=filtered)

    async def switch_profile(self, provider_id: str, profile_id: str) -> _FakeCliSwitchResult:
        if provider_id not in self.active_profiles:
            return _FakeCliSwitchResult(
                ok=False,
                provider_id=provider_id,
                active_profile="",
                message=f"Unknown provider '{provider_id}'",
            )
        self.active_profiles[provider_id] = profile_id
        return _FakeCliSwitchResult(
            ok=True,
            provider_id=provider_id,
            active_profile=profile_id,
            message="Switched profile",
        )

    async def sync_mcp_and_skills(
        self,
        *,
        skills_source_dir: Path | None = None,
        mcp_config: dict[str, Any] | None = None,
    ) -> _FakeMcpSkillSyncResult:
        self.sync_calls.append((skills_source_dir, mcp_config))
        return _FakeMcpSkillSyncResult(
            ok=True,
            synced_skills=["incident-triage"],
            blocked_skills=[],
            synced_mcp_servers=len(mcp_config or {}),
        )


class _FakeCoreCliPlugin(BaseModulePlugin):
    id = "core-cli"

    def __init__(self, service: _FakeCoreCliService) -> None:
        self._service = service

    def create_service(self, ctx: ModuleContext) -> Any:
        return self._service


class _CompanionModulePlugin(BaseModulePlugin):
    id = "companion-mod"

    def __init__(self) -> None:
        self.calls: list[tuple[int, float]] = []

    async def on_housekeeping(
        self,
        ctx: ModuleContext,
        retention_days: int,
        disk_used_pct: float,
    ) -> HousekeepingStats:
        self.calls.append((retention_days, disk_used_pct))
        return HousekeepingStats(
            module_id=self.id,
            deleted_rows=3,
            freed_bytes=2048,
            notes="companion pruned",
        )


def _make_context(
    *,
    module_id: str,
    manifest: ModuleManifest,
    module_dir: Path,
    project_root: Path,
    store_dir: Path,
    db: SqlitePool,
    vault: VaultManager,
    registry: ModuleRegistry,
    heavy_job: HeavyJobHoldManager,
) -> ModuleContext:
    import logging

    sec = ModuleSecurityProxy(
        module_id=module_id,
        vault=ScopedVaultProxy(
            module_id=module_id,
            vault=vault,
            allowed_keys=manifest.effective_vault_keys(),
            allowed_prefixes=tuple(manifest.allowed_vault_prefixes),
        ),
        config=ScopedConfigProxy(module_id=module_id, db=db),
        data_dir=ModuleDataDir(
            module_id=module_id,
            base_dir=store_dir / "modules" / module_id,
        ),
    )
    bus = ScopedServiceBus(
        caller_id=module_id,
        declared_depends=frozenset(manifest.depends),
        registry=registry,
    )
    return ModuleContext(
        module_id=module_id,
        manifest=manifest,
        module_dir=module_dir,
        project_root=project_root,
        db=db,
        security=sec,
        modules=bus,
        heavy_job=heavy_job,
        logger=logging.getLogger(f"test.{module_id}"),
    )


def test_package_layout_manifest_and_zero_cross_imports() -> None:
    # No .py files directly inside modules/core-ops/
    top_py_files = list(CORE_OPS_DIR.glob("*.py"))
    assert top_py_files == []

    expected_py = {
        "__init__.py",
        "plugin.py",
        "system_monitor.py",
        "housekeeper.py",
        "tools.py",
        "routes.py",
    }
    actual_py = {p.name for p in CORE_OPS_PKG.glob("*.py")}
    assert expected_py.issubset(actual_py)

    forbidden_modules = ("modules.core_cli", "core_cli", "_alfred_mod_core_cli")
    for py_file in sorted(CORE_OPS_PKG.glob("*.py")):
        src = py_file.read_text(encoding="utf-8")
        assert "type: ignore" not in src, f"Found forbidden type: ignore in {py_file.name}"
        tree = ast.parse(src, filename=str(py_file))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert not any(
                        alias.name == f or alias.name.startswith(f"{f}.") for f in forbidden_modules
                    ), f"Forbidden cross-import {alias.name} in {py_file.name}"
            elif isinstance(node, ast.ImportFrom) and node.module is not None:
                assert not any(
                    node.module == f or node.module.startswith(f"{f}.")
                    for f in forbidden_modules
                ), f"Forbidden cross-import {node.module} in {py_file.name}"

    manifests = discover_manifests(REPO_ROOT / "modules")
    assert "core-ops" in manifests
    _, manifest = manifests["core-ops"]
    assert manifest.entry == "core_ops/plugin.py"
    assert manifest.depends == ["core-cli"]
    assert manifest.tools == ["cli_manage", "system_storage", "module_manage"]
    assert manifest.ui_card_ids == ["vpsStorageCard"]
    assert manifest.built_in is True
    assert manifest.default_enabled is True


async def test_system_monitor_linux_proc_parsing_fallback_and_heavy_holds(tmp_path: Path) -> None:
    plugin_obj, sys_mon, _ = _load_core_ops_symbols()
    assert plugin_obj.id == "core-ops"

    # 1) Linux /proc/meminfo + fallback without MemAvailable
    meminfo_full = (
        "MemTotal:        2097152 kB\n"
        "MemFree:          262144 kB\n"
        "MemAvailable:    1048576 kB\n"
        "Buffers:           65536 kB\n"
        "Cached:           524288 kB\n"
        "SwapTotal:       1048576 kB\n"
        "SwapFree:         786432 kB\n"
    )
    parsed = sys_mon.parse_proc_meminfo(meminfo_full)
    assert parsed is not None
    assert parsed.total_bytes == 2097152 * 1024
    assert parsed.available_bytes == 1048576 * 1024
    assert parsed.swap_total_bytes == 1048576 * 1024
    assert parsed.swap_free_bytes == 786432 * 1024

    meminfo_no_avail = (
        "MemTotal:        1000000 kB\n"
        "MemFree:          100000 kB\n"
        "Buffers:           50000 kB\n"
        "Cached:           150000 kB\n"
    )
    parsed_fb = sys_mon.parse_proc_meminfo(meminfo_no_avail)
    assert parsed_fb is not None
    assert parsed_fb.available_bytes == 300000 * 1024
    assert sys_mon.parse_proc_meminfo("Garbage: 1 kB\n") is None

    # 2) Linux PSI parsing
    psi_cpu = sys_mon.parse_proc_pressure("some avg10=1.25 avg60=0.50 avg300=0.10 total=998877\n")
    assert psi_cpu.available is True
    assert psi_cpu.some_avg10 == 1.25
    assert psi_cpu.some_total_us == 998877
    assert psi_cpu.full_avg10 is None

    psi_mem = sys_mon.parse_proc_pressure(
        "some avg10=2.50 avg60=1.10 avg300=0.40 total=5000\n"
        "full avg10=0.75 avg60=0.20 avg300=0.05 total=1200\n"
    )
    assert psi_mem.available is True
    assert psi_mem.full_avg10 == 0.75
    assert psi_mem.full_total_us == 1200
    assert sys_mon.parse_proc_pressure("").available is False

    # 3) Full collect_telemetry with fake /proc, workspace/store/db/logs & active heavy hold
    proc_root = tmp_path / "proc"
    (proc_root / "pressure").mkdir(parents=True)
    (proc_root / "self").mkdir(parents=True)
    (proc_root / "meminfo").write_text(meminfo_full, encoding="utf-8")
    (proc_root / "self" / "status").write_text(
        "Name:\tpython\nVmRSS:\t65536 kB\n",
        encoding="utf-8",
    )
    (proc_root / "pressure" / "cpu").write_text(
        "some avg10=0.55 avg60=0.20 avg300=0.05 total=100\n",
        encoding="utf-8",
    )
    (proc_root / "pressure" / "memory").write_text(
        "some avg10=0.10 avg60=0.05 avg300=0.01 total=20\n"
        "full avg10=0.02 avg60=0.01 avg300=0.00 total=5\n",
        encoding="utf-8",
    )
    (proc_root / "pressure" / "io").write_text(
        "some avg10=0.33 avg60=0.11 avg300=0.02 total=40\n",
        encoding="utf-8",
    )

    project_root = tmp_path / "proj"
    store_dir = project_root / "store"
    logs_dir = project_root / "logs"
    ws_dir = project_root / "workspaces"
    logs_dir.mkdir(parents=True)
    ws_dir.mkdir(parents=True)
    (ws_dir / "artifact.bin").write_bytes(b"w" * 1024)
    (logs_dir / "app.log").write_bytes(b"l" * 512)

    async with SqlitePool(store_dir / "alfred.db") as db:
        vault = VaultManager(store_dir / "vault.json", store_dir / ".vault-key")
        heavy_job = HeavyJobHoldManager(store_dir / ".heavy-job.lock")
        registry = ModuleRegistry()
        manifest = ModuleManifest.model_validate_json(
            (CORE_OPS_DIR / "module.json").read_text(encoding="utf-8")
        )
        ctx = _make_context(
            module_id="core-ops",
            manifest=manifest,
            module_dir=CORE_OPS_DIR,
            project_root=project_root,
            store_dir=store_dir,
            db=db,
            vault=vault,
            registry=registry,
            heavy_job=heavy_job,
        )

        async with heavy_job.hold("video-upload"):
            report = await sys_mon.collect_telemetry(ctx, proc_root=proc_root)
            assert report.memory.source == "proc_meminfo"
            assert report.memory.used_pct == 50.0
            assert report.memory.process_rss_bytes == 65536 * 1024
            assert report.psi.cpu.some_avg10 == 0.55
            assert report.psi.memory.full_avg10 == 0.02
            assert report.psi.io.some_avg10 == 0.33
            assert report.disk.total_bytes > 0
            assert report.storage.workspace_bytes == 1024
            assert report.storage.logs_bytes == 512
            assert report.storage.db_bytes > 0
            assert report.storage.store_bytes >= report.storage.db_bytes
            assert report.active_heavy_holds == 1
            assert report.heavy_hold_labels == ["video-upload"]

        # 4) Non-Linux / missing /proc fallback must not crash
        fb_report = await sys_mon.collect_telemetry(ctx, proc_root=tmp_path / "missing-proc")
        assert fb_report.memory.source in (
            "windows_global_memory",
            "posix_sysconf",
            "fallback",
        )
        assert fb_report.psi.cpu.available is False
        assert fb_report.active_heavy_holds == 0


async def test_housekeeper_gentle_mode_normal_pruning_and_module_aggregation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plugin_obj, _, hk_mod = _load_core_ops_symbols()
    project_root = tmp_path / "hk"
    store_dir = project_root / "store"
    logs_dir = project_root / "logs"
    logs_dir.mkdir(parents=True)

    async with SqlitePool(store_dir / "alfred.db") as db:
        vault = VaultManager(store_dir / "vault.json", store_dir / ".vault-key")
        await vault.set_secret("KEEP_SECRET", "safe")
        heavy_job = HeavyJobHoldManager(store_dir / ".heavy-job.lock")
        registry = ModuleRegistry()

        # Register fake core-cli, companion-mod, and core-ops
        cli_manifest = ModuleManifest(
            id="core-cli",
            name="Core CLI",
            category="core",
            version="1.0.0",
            built_in=True,
            default_enabled=True,
        )
        cli_ctx = _make_context(
            module_id="core-cli",
            manifest=cli_manifest,
            module_dir=tmp_path / "m_cli",
            project_root=project_root,
            store_dir=store_dir,
            db=db,
            vault=vault,
            registry=registry,
            heavy_job=heavy_job,
        )
        registry.register_module(
            plugin=_FakeCoreCliPlugin(_FakeCoreCliService()),
            manifest=cli_manifest,
            module_dir=tmp_path / "m_cli",
            ctx=cli_ctx,
        )

        companion = _CompanionModulePlugin()
        comp_manifest = ModuleManifest(
            id="companion-mod",
            name="Companion",
            category="ai",
            version="1.0.0",
            built_in=False,
            default_enabled=True,
        )
        comp_ctx = _make_context(
            module_id="companion-mod",
            manifest=comp_manifest,
            module_dir=tmp_path / "m_comp",
            project_root=project_root,
            store_dir=store_dir,
            db=db,
            vault=vault,
            registry=registry,
            heavy_job=heavy_job,
        )
        registry.register_module(
            plugin=companion,
            manifest=comp_manifest,
            module_dir=tmp_path / "m_comp",
            ctx=comp_ctx,
        )

        ops_manifest = ModuleManifest.model_validate_json(
            (CORE_OPS_DIR / "module.json").read_text(encoding="utf-8")
        )
        ops_ctx = _make_context(
            module_id="core-ops",
            manifest=ops_manifest,
            module_dir=CORE_OPS_DIR,
            project_root=project_root,
            store_dir=store_dir,
            db=db,
            vault=vault,
            registry=registry,
            heavy_job=heavy_job,
        )
        registry.register_module(
            plugin=plugin_obj,
            manifest=ops_manifest,
            module_dir=CORE_OPS_DIR,
            ctx=ops_ctx,
        )
        await plugin_obj.on_load(ops_ctx)

        # Seed old (45d) & recent (1h) rows across telemetry/log tables
        now_sec = int(time.time())
        old_ts = now_sec - (45 * 86_400)
        recent_ts = now_sec - 3600
        await db.log_conversation_message(
            agent_id="alfred-ops",
            chat_id="c1",
            direction="in",
            message_id="old-msg",
            author_id="u1",
            author_name="User",
            content="old message",
            timestamp_sec=old_ts,
        )
        await db.log_conversation_message(
            agent_id="alfred-ops",
            chat_id="c1",
            direction="in",
            message_id="new-msg",
            author_id="u1",
            author_name="User",
            content="recent message",
            timestamp_sec=recent_ts,
        )
        await db.record_compute_usage(
            module_id="batch-api",
            agent="alfred-batch",
            session_id="s1",
            resource_label="old-job",
            duration_sec=10.0,
            cost_usd=0.1,
            timestamp_sec=old_ts,
        )
        await db.record_token_usage(
            agent="alfred-ops",
            session_id="s1",
            timestamp_sec=recent_ts,
            input_tokens=10,
            output_tokens=5,
            cache_read_tokens=0,
            cache_creation_tokens=0,
            thinking_tokens=0,
            model="deepseek-chat",
            cost_usd=0.001,
        )

        # Seed old log, recent log, old .tmp, and protected store files
        old_log = logs_dir / "old.log"
        old_log.write_text("old log payload\n", encoding="utf-8")
        os.utime(old_log, (old_ts, old_ts))

        new_log = logs_dir / "current.log"
        new_log.write_text("fresh log\n", encoding="utf-8")

        stale_tmp = store_dir / "upload-part.tmp"
        stale_tmp.write_bytes(b"x" * 256)
        os.utime(stale_tmp, (now_sec - 90_000, now_sec - 90_000))

        # Spy on wal_checkpoint
        checkpoint_calls: list[str] = []
        orig_checkpoint = db.wal_checkpoint

        async def _spy_checkpoint(mode: Any = "TRUNCATE") -> tuple[int, int, int]:
            checkpoint_calls.append(str(mode))
            return await orig_checkpoint(mode)

        monkeypatch.setattr(db, "wal_checkpoint", _spy_checkpoint)

        # 1) Active heavy hold -> GENTLE MODE (no TRUNCATE checkpoint, no destructive prune)
        housekeeper = hk_mod.Housekeeper()
        async with heavy_job.hold("cloud-stream-upload"):
            gentle_report = await housekeeper.run(ops_ctx, retention_days=30)
            assert gentle_report.gentle_mode is True
            assert gentle_report.active_hold_count == 1
            assert gentle_report.active_hold_labels == ["cloud-stream-upload"]
            assert gentle_report.wal_checkpoint.executed is False
            assert gentle_report.wal_checkpoint.mode == "skipped"
            assert checkpoint_calls == []
            assert gentle_report.pruned_db_rows == 0
            assert old_log.exists()
            assert stale_tmp.exists()
            assert [m.module_id for m in gentle_report.module_results] == [
                "core-cli",
                "companion-mod",
            ]

        # 2) No holds -> FULL housekeeping (TRUNCATE checkpoint, DB/file prune, module aggregation)
        full_report = await housekeeper.run(ops_ctx, retention_days=30)
        assert full_report.gentle_mode is False
        assert full_report.active_hold_count == 0
        assert full_report.wal_checkpoint.executed is True
        assert full_report.wal_checkpoint.mode == "TRUNCATE"
        assert checkpoint_calls == ["TRUNCATE"]
        assert full_report.pruned_db_rows == 2  # old conversation_log + old compute_usage
        assert full_report.pruned_log_files == ["old.log"]
        assert full_report.pruned_temp_files == ["upload-part.tmp"]
        assert not old_log.exists()
        assert new_log.exists()
        assert not stale_tmp.exists()
        assert (store_dir / "vault.json").exists()
        assert (store_dir / ".vault-key").exists()

        remaining_conv = await db.read(
            lambda c: int(c.execute("SELECT COUNT(*) FROM conversation_log").fetchone()[0])
        )
        remaining_tok = await db.read(
            lambda c: int(c.execute("SELECT COUNT(*) FROM token_usage").fetchone()[0])
        )
        assert remaining_conv == 1
        assert remaining_tok == 1

        # Verify excluded core-ops from run_all_housekeeping, companion-mod ran twice
        assert [m.module_id for m in full_report.module_results] == [
            "core-cli",
            "companion-mod",
        ]
        assert len(companion.calls) == 2

        # Direct plugin.on_housekeeping does not recurse
        direct_stats = await plugin_obj.on_housekeeping(ops_ctx, 30, 42.0)
        assert direct_stats.module_id == "core-ops"
        assert len(companion.calls) == 2

        # Wizard probe succeeds cleanly
        probe_res = await plugin_obj.wizard_probe(ops_ctx)
        assert probe_res.ok is True
        assert probe_res.module_id == "core-ops"


async def test_tools_authorization_and_service_bus_delegation(tmp_path: Path) -> None:
    plugin_obj, _, _ = _load_core_ops_symbols()
    project_root = tmp_path / "tools"
    store_dir = project_root / "store"
    ws_dir = project_root / "workspaces" / "alfred-ops"
    skills_dir = ws_dir / "skills"
    skills_dir.mkdir(parents=True)

    async with SqlitePool(store_dir / "alfred.db") as db:
        vault = VaultManager(store_dir / "vault.json", store_dir / ".vault-key")
        heavy_job = HeavyJobHoldManager(store_dir / ".heavy-job.lock")
        registry = ModuleRegistry()

        cli_svc = _FakeCoreCliService()
        cli_manifest = ModuleManifest(
            id="core-cli",
            name="Core CLI",
            category="core",
            version="1.0.0",
            built_in=True,
            default_enabled=True,
        )
        cli_ctx = _make_context(
            module_id="core-cli",
            manifest=cli_manifest,
            module_dir=tmp_path / "m_cli",
            project_root=project_root,
            store_dir=store_dir,
            db=db,
            vault=vault,
            registry=registry,
            heavy_job=heavy_job,
        )
        registry.register_module(
            plugin=_FakeCoreCliPlugin(cli_svc),
            manifest=cli_manifest,
            module_dir=tmp_path / "m_cli",
            ctx=cli_ctx,
        )

        ops_manifest = ModuleManifest.model_validate_json(
            (CORE_OPS_DIR / "module.json").read_text(encoding="utf-8")
        )
        ops_ctx = _make_context(
            module_id="core-ops",
            manifest=ops_manifest,
            module_dir=CORE_OPS_DIR,
            project_root=project_root,
            store_dir=store_dir,
            db=db,
            vault=vault,
            registry=registry,
            heavy_job=heavy_job,
        )
        registry.register_module(
            plugin=plugin_obj,
            manifest=ops_manifest,
            module_dir=CORE_OPS_DIR,
            ctx=ops_ctx,
        )
        await plugin_obj.on_load(ops_ctx)

        for name in ("cli_manage", "system_storage", "module_manage"):
            tdef = registry.get_tool(name)
            assert tdef is not None
            assert tdef.authorized_agent_ids == ("alfred-ops", "alfred", "alfred-core")

        executor = ToolExecutor(registry=registry)
        ops_agent = AgentConfig(
            id="alfred-ops",
            display_name="Ops",
            role="technikus",
            tools=["cli_manage", "system_storage", "module_manage"],
        )
        qa_agent = AgentConfig(
            id="alfred-qa",
            display_name="QA",
            role="technikus",
            tools=["cli_manage", "system_storage", "module_manage"],
        )

        # Unauthorized agent gets zero schemas and ModuleSecurityError on execution
        assert executor.get_schemas_for_agent(qa_agent) == []
        with pytest.raises(ModuleSecurityError):
            await executor.execute_tool(
                agent=qa_agent,
                tool_name="system_storage",
                raw_args={},
                session_id="s-qa",
                workspace_dir=ws_dir,
            )

        assert len(executor.get_schemas_for_agent(ops_agent)) == 3

        # cli_manage -> status, list_profiles, switch_profile, sync_skills
        res_status = await executor.execute_tool(
            agent=ops_agent,
            tool_name="cli_manage",
            raw_args={"action": "status"},
            session_id="s-ops",
            workspace_dir=ws_dir,
        )
        assert res_status.ok is True
        assert res_status.output["total_invocations"] == 7

        res_profiles = await executor.execute_tool(
            agent=ops_agent,
            tool_name="cli_manage",
            raw_args={"action": "list_profiles", "provider_id": "claude-cli"},
            session_id="s-ops",
            workspace_dir=ws_dir,
        )
        assert res_profiles.ok is True
        assert len(res_profiles.output["profiles"]) == 2

        res_switch = await executor.execute_tool(
            agent=ops_agent,
            tool_name="cli_manage",
            raw_args={
                "action": "switch_profile",
                "provider_id": "claude-cli",
                "profile_id": "work",
            },
            session_id="s-ops",
            workspace_dir=ws_dir,
        )
        assert res_switch.ok is True
        assert res_switch.output["active_profile"] == "work"

        # Missing profile_id on switch_profile returns LLM validation error
        res_bad_switch = await executor.execute_tool(
            agent=ops_agent,
            tool_name="cli_manage",
            raw_args={"action": "switch_profile", "provider_id": "claude-cli"},
            session_id="s-ops",
            workspace_dir=ws_dir,
        )
        assert res_bad_switch.ok is False
        assert res_bad_switch.error_code == "TOOL_VALIDATION_ERROR"

        # Path traversal blocked in sync_skills
        res_escape = await executor.execute_tool(
            agent=ops_agent,
            tool_name="cli_manage",
            raw_args={"action": "sync_skills", "skills_source_dir": "../../../etc"},
            session_id="s-ops",
            workspace_dir=ws_dir,
        )
        assert res_escape.ok is False
        assert res_escape.error_code == "PATH_OUTSIDE_WORKSPACE"

        res_sync = await executor.execute_tool(
            agent=ops_agent,
            tool_name="cli_manage",
            raw_args={
                "action": "sync_skills",
                "skills_source_dir": "skills",
                "mcp_config": {"github": {"command": "npx"}},
            },
            session_id="s-ops",
            workspace_dir=ws_dir,
        )
        assert res_sync.ok is True
        assert res_sync.output["synced_skills"] == ["incident-triage"]
        assert res_sync.output["synced_mcp_servers"] == 1
        assert cli_svc.sync_calls[-1][0] == skills_dir.resolve()

        # system_storage (full and filtered flags + authorized alfred / alfred-core)
        res_storage = await executor.execute_tool(
            agent=ops_agent,
            tool_name="system_storage",
            raw_args={},
            session_id="s-ops",
            workspace_dir=ws_dir,
        )
        assert res_storage.ok is True
        assert "memory" in res_storage.output
        assert "storage" in res_storage.output
        assert "psi" in res_storage.output

        for extra_agent_id in ("alfred", "alfred-core"):
            extra_agent = AgentConfig(
                id=extra_agent_id,
                display_name=extra_agent_id,
                role="technikus",
                tools=["system_storage"],
            )
            extra_res = await executor.execute_tool(
                agent=extra_agent,
                tool_name="system_storage",
                raw_args={"include_psi": False, "include_heavy_holds": False},
                session_id="s-extra",
                workspace_dir=ws_dir,
            )
            assert extra_res.ok is True
            assert "psi" not in extra_res.output
            assert "active_heavy_holds" not in extra_res.output

        # module_manage -> list & housekeeping
        res_mods = await executor.execute_tool(
            agent=ops_agent,
            tool_name="module_manage",
            raw_args={"action": "list"},
            session_id="s-ops",
            workspace_dir=ws_dir,
        )
        assert res_mods.ok is True
        assert set(res_mods.output["active_module_ids"]) == {"core-cli", "core-ops"}

        res_hk = await executor.execute_tool(
            agent=ops_agent,
            tool_name="module_manage",
            raw_args={"action": "housekeeping", "retention_days": 14},
            session_id="s-ops",
            workspace_dir=ws_dir,
        )
        assert res_hk.ok is True
        assert res_hk.output["retention_days"] == 14
        assert res_hk.output["wal_checkpoint"]["executed"] is True

        # Unload core-cli -> cli_manage returns structured MISSING_DEPENDENCY
        await registry.unregister_module("core-cli", force=True)
        res_missing = await executor.execute_tool(
            agent=ops_agent,
            tool_name="cli_manage",
            raw_args={"action": "status"},
            session_id="s-ops",
            workspace_dir=ws_dir,
        )
        assert res_missing.ok is False
        assert res_missing.error_code == "MISSING_DEPENDENCY"


async def test_http_routes_auth_csrf_validation_redaction_and_ui_card(tmp_path: Path) -> None:
    plugin_obj, _, _ = _load_core_ops_symbols()
    project_root = tmp_path / "http"
    store_dir = project_root / "store"
    project_root.mkdir(parents=True)

    async with SqlitePool(store_dir / "alfred.db") as db:
        vault = VaultManager(store_dir / "vault.json", store_dir / ".vault-key")
        heavy_job = HeavyJobHoldManager(store_dir / ".heavy-job.lock")
        registry = ModuleRegistry()

        cli_svc = _FakeCoreCliService()
        cli_manifest = ModuleManifest(
            id="core-cli",
            name="Core CLI",
            category="core",
            version="1.0.0",
            built_in=True,
            default_enabled=True,
        )
        cli_ctx = _make_context(
            module_id="core-cli",
            manifest=cli_manifest,
            module_dir=tmp_path / "m_cli",
            project_root=project_root,
            store_dir=store_dir,
            db=db,
            vault=vault,
            registry=registry,
            heavy_job=heavy_job,
        )
        registry.register_module(
            plugin=_FakeCoreCliPlugin(cli_svc),
            manifest=cli_manifest,
            module_dir=tmp_path / "m_cli",
            ctx=cli_ctx,
        )

        ops_manifest = ModuleManifest.model_validate_json(
            (CORE_OPS_DIR / "module.json").read_text(encoding="utf-8")
        )
        ops_ctx = _make_context(
            module_id="core-ops",
            manifest=ops_manifest,
            module_dir=CORE_OPS_DIR,
            project_root=project_root,
            store_dir=store_dir,
            db=db,
            vault=vault,
            registry=registry,
            heavy_job=heavy_job,
        )
        registry.register_module(
            plugin=plugin_obj,
            manifest=ops_manifest,
            module_dir=CORE_OPS_DIR,
            ctx=ops_ctx,
        )
        await plugin_obj.on_load(ops_ctx)

        ui_contribs = registry.list_ui_contributions(slot="vps-card")
        assert len(ui_contribs) == 1
        contrib = ui_contribs[0]
        assert contrib.id == "vpsStorageCard"
        assert contrib.module_id == "core-ops"
        assert contrib.title == "VPS Storage & Telemetry"
        assert contrib.entry_file == "storage-card.js"
        assert contrib.order == 20

        app = FastAPI()
        auth = AuthService(admin_token="ops-admin-token-123")
        attach_module_bridge(app, registry, auth)

        dash_cookie, _ = auth.issue_dashboard_session(role="dashboard")
        admin_cookie, admin_csrf = auth.issue_dashboard_session(role="admin")

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as anon:
            for path in (
                "/api/ops/telemetry",
                "/api/ops/storage",
                "/api/ops/cli/status",
            ):
                assert (await anon.get(path)).status_code == 401
            assert (await anon.post("/api/ops/housekeeping", json={})).status_code == 401
            assert (await anon.post("/api/ops/cli/switch", json={})).status_code == 401

            # UI static ES6 module served cleanly + traversal blocked
            ui_resp = await anon.get("/api/modules/core-ops/ui/storage-card.js")
            assert ui_resp.status_code == 200
            assert "export function mount" in ui_resp.text
            assert "export function unmount" in ui_resp.text
            assert "textContent" in ui_resp.text
            assert "innerHTML" not in ui_resp.text

            assert (
                await anon.get("/api/modules/core-ops/ui/../core_ops/plugin.py")
            ).status_code in (403, 404)

        # Dashboard role can GET telemetry/storage/cli status, forbidden on POST admin routes
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://test",
            cookies={"alfred_session": dash_cookie},
        ) as dash_client:
            tel_resp = await dash_client.get("/api/ops/telemetry")
            assert tel_resp.status_code == 200
            tel_json = tel_resp.json()
            assert "memory" in tel_json and "disk" in tel_json and "storage" in tel_json

            stor_resp = await dash_client.get("/api/ops/storage")
            assert stor_resp.status_code == 200
            assert "storage" in stor_resp.json()

            cli_resp = await dash_client.get("/api/ops/cli/status")
            assert cli_resp.status_code == 200
            assert cli_resp.json()["total_invocations"] == 7

            assert (await dash_client.delete("/api/ops/telemetry")).status_code == 405
            assert (
                await dash_client.post("/api/ops/housekeeping", json={})
            ).status_code == 403
            assert (
                await dash_client.post(
                    "/api/ops/cli/switch",
                    json={"providerId": "claude-cli", "profileId": "work"},
                )
            ).status_code == 403

        # Admin session: CSRF enforcement, housekeeping, switch, and include_input=False redaction
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://test",
            cookies={"alfred_session": admin_cookie},
        ) as admin_client:
            assert (
                await admin_client.post("/api/ops/housekeeping", json={})
            ).status_code == 403

            hk_ok = await admin_client.post(
                "/api/ops/housekeeping",
                headers={"X-CSRF-Token": admin_csrf},
                json={},
            )
            assert hk_ok.status_code == 200
            assert hk_ok.json()["wal_checkpoint"]["executed"] is True

            sw_ok = await admin_client.post(
                "/api/ops/cli/switch",
                headers={"X-CSRF-Token": admin_csrf},
                json={"providerId": "claude-cli", "profileId": "work"},
            )
            assert sw_ok.status_code == 200
            assert sw_ok.json()["ok"] is True
            assert sw_ok.json()["active_profile"] == "work"

            # ValidationError must use include_input=False (never echo raw payload secrets)
            bad_switch = await admin_client.post(
                "/api/ops/cli/switch",
                headers={"X-CSRF-Token": admin_csrf},
                json={"providerId": ["SECRET-SWITCH-INPUT-777"], "profileId": "work"},
            )
            assert bad_switch.status_code == 400
            assert "SECRET-SWITCH-INPUT-777" not in bad_switch.text

            bad_hk = await admin_client.post(
                "/api/ops/housekeeping",
                headers={"X-CSRF-Token": admin_csrf},
                json={"retentionDays": "SECRET-HK-INPUT-888"},
            )
            assert bad_hk.status_code == 400
            assert "SECRET-HK-INPUT-888" not in bad_hk.text

            malformed = await admin_client.post(
                "/api/ops/cli/switch",
                headers={"X-CSRF-Token": admin_csrf},
                content=b"{not-json",
            )
            assert malformed.status_code == 400
            assert json.loads(malformed.text)["error"] == "INVALID_REQUEST"

            empty_switch = await admin_client.post(
                "/api/ops/cli/switch",
                headers={"X-CSRF-Token": admin_csrf},
                content=b"",
            )
            assert empty_switch.status_code == 400
            assert empty_switch.json()["error"] == "INVALID_REQUEST"

            unknown_switch = await admin_client.post(
                "/api/ops/cli/switch",
                headers={"X-CSRF-Token": admin_csrf},
                json={"providerId": "unknown-cli", "profileId": "default"},
            )
            assert unknown_switch.status_code == 200
            assert unknown_switch.json()["ok"] is False

        # Unload core-cli -> core-ops CLI route returns 409 MISSING_DEPENDENCY
        await registry.unregister_module("core-cli", force=True)
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://test",
            headers={"Authorization": "Bearer ops-admin-token-123"},
        ) as bearer_client:
            missing_dep_resp = await bearer_client.get("/api/ops/cli/status")
            assert missing_dep_resp.status_code == 409
            assert missing_dep_resp.json()["error"] == "MISSING_DEPENDENCY"
