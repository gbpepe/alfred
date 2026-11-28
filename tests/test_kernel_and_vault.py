"""Phase 1 tests: Microkernel DAG, Lazy Gate, Vault AAD/Locks, SQLite WAL, Symlinks & Bridge."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import sqlite3
import sys
from collections.abc import AsyncIterator, Mapping, Sequence
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from pydantic import BaseModel, Field
from starlette.responses import JSONResponse

from alfred.core.auth import AuthService
from alfred.core.config import AgentsConfig
from alfred.core.db import SqlitePool
from alfred.core.security.heavy_job_hold import HeavyJobHoldManager
from alfred.core.vault import VaultKeyError, VaultManager
from alfred.kernel import (
    CircularDependencyError,
    ComputeUsageRecord,
    ForbiddenVaultAccessError,
    MissingDependencyError,
    ModelProviderRequest,
    ModelProviderResponse,
    ModuleError,
    ModuleLoader,
    ModuleManifest,
    ModuleMigration,
    ModuleModelProvider,
    ModuleRegistry,
    ModuleSecurityError,
    ModuleToolDefinition,
    ToolExecutionContext,
    ToolExecutionResult,
    apply_module_migrations,
    attach_module_bridge,
    module_package_name,
    resolve_load_order,
)


def _write_module(
    modules_dir: Path,
    module_id: str,
    *,
    depends: list[str] | None = None,
    built_in: bool = False,
    required_secrets: list[str] | None = None,
    allowed_vault_prefixes: list[str] | None = None,
    plugin_code: str | None = None,
    probe_code: str | None = None,
    extra_files: Mapping[str, str] | None = None,
    ui_files: Mapping[str, str] | None = None,
) -> Path:
    mod_dir = modules_dir / module_id
    mod_dir.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, Any] = {
        "id": module_id,
        "name": f"Module {module_id}",
        "category": "test",
        "version": "1.0.0",
        "depends": depends or [],
        "requiredSecrets": required_secrets or [],
        "allowedVaultPrefixes": allowed_vault_prefixes or [],
        "builtIn": built_in,
        "defaultEnabled": built_in,
    }
    (mod_dir / "module.json").write_text(json.dumps(manifest), encoding="utf-8")
    if plugin_code is not None:
        (mod_dir / "plugin.py").write_text(plugin_code, encoding="utf-8")
    if probe_code is not None:
        (mod_dir / "probe.py").write_text(probe_code, encoding="utf-8")
    if extra_files:
        for rel_name, content in extra_files.items():
            target = mod_dir / rel_name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
    if ui_files:
        ui_dir = mod_dir / "ui"
        ui_dir.mkdir(parents=True, exist_ok=True)
        for rel_name, content in ui_files.items():
            target = ui_dir / rel_name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
    return mod_dir


async def test_vault_aad_tamper_corrupt_concurrency_and_fail_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    vault_path = tmp_path / "store" / "vault.json"
    key_path = tmp_path / "store" / ".vault-key"
    vault = VaultManager(vault_path, key_path)

    meta = await vault.set_secret("OPENAI_API_KEY", "sk-test-árvíztűrő-1234", label="OpenAI Key")
    assert meta.key_id == "OPENAI_API_KEY"
    assert await vault.get_secret("OPENAI_API_KEY") == "sk-test-árvíztűrő-1234"
    assert await vault.has_secret("OPENAI_API_KEY") is True

    raw_vault = json.loads(vault_path.read_text(encoding="utf-8"))
    entry = raw_vault["entries"]["OPENAI_API_KEY"]
    assert len(base64.b64decode(entry["nonce_b64"])) == 12
    assert len(base64.b64decode(entry["salt_b64"])) == 32

    # Invalid key_id formats must be rejected before vault access
    with pytest.raises(ValueError):
        await vault.set_secret("../escape", "bad")

    # list_secrets() must NOT derive keys or invoke scrypt (0 decryption calls)
    def _forbid_scrypt(*_args: Any, **_kwargs: Any) -> bytes:
        raise AssertionError("hashlib.scrypt must not be called by list_secrets()")

    with monkeypatch.context() as mp:
        mp.setattr(hashlib, "scrypt", _forbid_scrypt)
        listed = vault.list_secrets()
        assert len(listed) == 1
        assert listed[0].key_id == "OPENAI_API_KEY"

    # AAD / dict-key transplant tamper check
    await vault.set_secret("ADMIN_ONLY", "super-secret")
    tamper_json = json.loads(vault_path.read_text(encoding="utf-8"))
    saved_vault_text = vault_path.read_text(encoding="utf-8")

    # Case 1: Dict key swapped without updating inner key_id -> VaultStore validator rejects
    tamper_swap = json.loads(saved_vault_text)
    tamper_swap["entries"]["SWAPPED_KEY"] = tamper_swap["entries"]["ADMIN_ONLY"]
    vault_path.write_text(json.dumps(tamper_swap), encoding="utf-8")
    with pytest.raises(VaultKeyError):
        await vault.get_secret("SWAPPED_KEY")

    # Case 2: Attacker copies encrypted payload AND rewrites inner entry.key_id -> AAD blocks
    tamper_aad = json.loads(saved_vault_text)
    cloned = dict(tamper_aad["entries"]["ADMIN_ONLY"])
    cloned["key_id"] = "FORGED_KEY"
    tamper_aad["entries"]["FORGED_KEY"] = cloned
    vault_path.write_text(json.dumps(tamper_aad), encoding="utf-8")
    with pytest.raises(VaultKeyError):
        await vault.get_secret("FORGED_KEY")

    # Restore valid store and test corrupt JSON fail-closed
    vault_path.write_text("{corrupt-json", encoding="utf-8")
    with pytest.raises(VaultKeyError):
        await vault.initialize()

    vault_path.write_text(json.dumps(tamper_json), encoding="utf-8")

    # Fail-closed when .vault-key is missing alongside existing entries
    saved_key = key_path.read_bytes()
    key_path.unlink()
    with pytest.raises(VaultKeyError):
        await vault.initialize()
    with pytest.raises(VaultKeyError):
        await vault.get_secret("OPENAI_API_KEY")
    assert not key_path.exists()

    # Wrong key fails closed
    key_path.write_text(base64.b64encode(b"x" * 64).decode("ascii") + "\n", encoding="ascii")
    with pytest.raises(VaultKeyError):
        await vault.get_secret("OPENAI_API_KEY")

    # Restore valid key + verify concurrent writes lose 0 keys
    key_path.write_bytes(saved_key)
    await asyncio.gather(
        *(vault.set_secret(f"CONC_{idx}", f"val-{idx}") for idx in range(10))
    )
    for idx in range(10):
        assert await vault.get_secret(f"CONC_{idx}") == f"val-{idx}"
    assert await vault.delete_secret("OPENAI_API_KEY") is True
    assert await vault.get_secret("OPENAI_API_KEY") is None


def test_repo_manifests_and_agents_config_parse_strictly() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    agents_cfg = AgentsConfig.model_validate_json(
        (repo_root / "config" / "agents.json").read_text(encoding="utf-8")
    )
    assert len(agents_cfg.agents) >= 5
    for mod_json in sorted((repo_root / "modules").glob("*/module.json")):
        manifest = ModuleManifest.model_validate_json(mod_json.read_text(encoding="utf-8"))
        assert manifest.id == mod_json.parent.name


def test_kernel_dag_topo_sort_cycle_and_missing_dep() -> None:
    manifests = {
        "a": ModuleManifest(id="a", name="A", category="core", version="1.0.0", depends=[]),
        "b": ModuleManifest(id="b", name="B", category="core", version="1.0.0", depends=["a"]),
        "c": ModuleManifest(id="c", name="C", category="core", version="1.0.0", depends=["a", "b"]),
    }
    assert resolve_load_order(manifests, {"c", "a", "b"}) == ["a", "b", "c"]

    with pytest.raises(MissingDependencyError) as missing_exc:
        resolve_load_order(manifests, {"b"})
    assert missing_exc.value.status_code == 409
    assert missing_exc.value.dependency_id == "a"

    cyclic = {
        "x": ModuleManifest(id="x", name="X", category="t", version="1.0.0", depends=["z"]),
        "y": ModuleManifest(id="y", name="Y", category="t", version="1.0.0", depends=["x"]),
        "z": ModuleManifest(id="z", name="Z", category="t", version="1.0.0", depends=["y"]),
    }
    with pytest.raises(CircularDependencyError) as cyc_exc:
        resolve_load_order(cyclic, {"x", "y", "z"})
    assert cyc_exc.value.status_code == 422
    assert cyc_exc.value.cycle[0] == cyc_exc.value.cycle[-1]


async def test_zero_import_lazy_probe_relative_import_identity_and_rollback(
    tmp_path: Path,
) -> None:
    modules_dir = tmp_path / "modules"
    store_dir = tmp_path / "store"
    _write_module(
        modules_dir,
        "core-alpha",
        built_in=True,
        plugin_code=(
            "from alfred.kernel.types import BaseModulePlugin\n"
            "class AlphaPlugin(BaseModulePlugin):\n"
            "    id = 'core-alpha'\n"
            "plugin = AlphaPlugin()\n"
        ),
    )
    _write_module(
        modules_dir,
        "lazy-trap",
        built_in=False,
        plugin_code="raise RuntimeError('Inactive plugin.py MUST NEVER be imported!')\n",
        extra_files={"helper.py": "STATUS_MSG = 'helper relative import ok'\n"},
        probe_code=(
            "from alfred.kernel.types import ProbeCheck, ProbeResult\n"
            "from .helper import STATUS_MSG\n"
            "async def probe(ctx):\n"
            "    return ProbeResult(\n"
            "        ok=True,\n"
            "        module_id=ctx.module_id,\n"
            "        summary=STATUS_MSG,\n"
            "        checks=[ProbeCheck(name='env', ok=True, detail=STATUS_MSG)],\n"
            "    )\n"
        ),
    )
    _write_module(
        modules_dir,
        "lazy-good",
        built_in=False,
        depends=["core-alpha"],
        plugin_code=(
            "from alfred.kernel.types import BaseModulePlugin, ProbeResult\n"
            "class CustomState:\n"
            "    pass\n"
            "class GoodService:\n"
            "    def __init__(self):\n"
            "        self.state_cls = CustomState\n"
            "class GoodPlugin(BaseModulePlugin):\n"
            "    id = 'lazy-good'\n"
            "    def create_service(self, ctx):\n"
            "        return GoodService()\n"
            "plugin = GoodPlugin()\n"
        ),
    )
    _write_module(
        modules_dir,
        "broken-onload",
        built_in=False,
        plugin_code=(
            "from pydantic import BaseModel\n"
            "from alfred.kernel.types import BaseModulePlugin, ModuleToolDefinition\n"
            "class DummyArgs(BaseModel):\n"
            "    x: str\n"
            "async def noop(args, ctx):\n"
            "    raise AssertionError('never runs')\n"
            "class BrokenPlugin(BaseModulePlugin):\n"
            "    id = 'broken-onload'\n"
            "    def tools(self):\n"
            "        return [ModuleToolDefinition('broken_tool', 'd', DummyArgs, noop)]\n"
            "    async def on_load(self, ctx):\n"
            "        raise RuntimeError('on_load boom')\n"
            "plugin = BrokenPlugin()\n"
        ),
    )

    trap_pkg = module_package_name("lazy-trap")
    good_pkg = module_package_name("lazy-good")
    alpha_pkg = module_package_name("core-alpha")
    broken_pkg = module_package_name("broken-onload")

    try:
        async with SqlitePool(store_dir / "alfred.db") as db:
            vault = VaultManager(store_dir / "vault.json", store_dir / ".vault-key")
            registry = ModuleRegistry()
            loader = ModuleLoader(
                modules_dir=modules_dir,
                store_dir=store_dir,
                db=db,
                vault=vault,
                registry=registry,
                heavy_job=HeavyJobHoldManager(store_dir / ".heavy-job.lock"),
                project_root=tmp_path,
            )

            # Default load: only built-in active module loads; lazy modules stay unimported
            loaded = await loader.load_active_modules()
            assert loaded == ["core-alpha"]
            assert alpha_pkg in sys.modules
            assert trap_pkg not in sys.modules
            assert good_pkg not in sys.modules

            # Probe runs on inactive lazy-trap WITH relative import and WITHOUT plugin import
            probe_result = await loader.probe_inactive_module("lazy-trap")
            assert probe_result.ok is True
            assert probe_result.summary == "helper relative import ok"
            assert trap_pkg not in sys.modules

            # Activate lazy-good, verify reverse-dependency block, then unload & re-enable
            await loader.load_active_modules(active_ids={"core-alpha", "lazy-good"})
            svc_before = registry.get_service("lazy-good")
            assert svc_before is not None
            instance_before = svc_before.state_cls()

            with pytest.raises(ModuleError) as dep_block:
                await loader.deactivate_module("core-alpha")
            assert dep_block.value.status_code == 409
            assert dep_block.value.code == "MODULE_HAS_DEPENDENTS"

            await loader.deactivate_module("lazy-good")
            assert not registry.is_active("lazy-good")
            assert registry.get_service("lazy-good") is None
            # sys.modules entry retained to preserve class identity on re-activation
            assert good_pkg in sys.modules

            await loader.load_active_modules(active_ids={"core-alpha", "lazy-good"})
            svc_after = registry.get_service("lazy-good")
            assert svc_after is not None
            assert isinstance(instance_before, svc_after.state_cls)

            # Failed on_load rolls back cleanly from registry (no leaked tools)
            with pytest.raises(RuntimeError, match="on_load boom"):
                await loader.load_active_modules(active_ids={"core-alpha", "broken-onload"})
            assert not registry.is_active("broken-onload")
            assert registry.get_tool("broken_tool") is None
    finally:
        for pkg in (alpha_pkg, trap_pkg, good_pkg, broken_pkg):
            for key in list(sys.modules.keys()):
                if key == pkg or key.startswith(f"{pkg}."):
                    sys.modules.pop(key, None)


class _EchoToolArgs(BaseModel):
    path: str = Field(min_length=1, description="Relative file path")
    count: int = Field(ge=1, le=5, description="Repeat count between 1 and 5")


class _StubModelProvider:
    provider_id = "stub-provider"
    zero_cost_model_prefixes: tuple[str, ...] = ()
    eu_only_compliant = False

    def supports_model(self, model: str) -> bool:
        return model == "stub-1"

    async def generate(self, request: ModelProviderRequest) -> ModelProviderResponse:
        return ModelProviderResponse(
            content=f"ok:{request.model}",
            input_tokens=10,
            output_tokens=5,
        )


async def test_pydantic_tool_gate_provider_dto_and_compute_usage(tmp_path: Path) -> None:
    captured_args: list[_EchoToolArgs] = []

    async def _run_echo(args: _EchoToolArgs, ctx: ToolExecutionContext) -> ToolExecutionResult:
        assert isinstance(args, _EchoToolArgs)
        captured_args.append(args)
        return ToolExecutionResult(ok=True, output={"path": args.path, "count": args.count})

    tool = ModuleToolDefinition(
        name="echo_test",
        description="Typed echo tool",
        args_model=_EchoToolArgs,
        execute=_run_echo,
        module_id="test-mod",
    )

    assert tool.json_schema() == _EchoToolArgs.model_json_schema()

    store_dir = tmp_path / "store"
    modules_dir = tmp_path / "modules"
    _write_module(modules_dir, "test-mod", built_in=True)
    async with SqlitePool(store_dir / "alfred.db") as db:
        vault = VaultManager(store_dir / "vault.json", store_dir / ".vault-key")
        registry = ModuleRegistry()
        loader = ModuleLoader(
            modules_dir=modules_dir,
            store_dir=store_dir,
            db=db,
            vault=vault,
            registry=registry,
            heavy_job=HeavyJobHoldManager(store_dir / ".heavy-job.lock"),
            project_root=tmp_path,
        )
        mod_dir, manifest = loader.discover()["test-mod"]
        mod_ctx = loader.build_context(module_id="test-mod", module_dir=mod_dir, manifest=manifest)
        assert mod_ctx.project_root == loader.project_root

        # Verify ModuleModelProvider Protocol check & concrete DTOs
        provider: ModuleModelProvider = _StubModelProvider()
        assert isinstance(provider, ModuleModelProvider)
        resp = await provider.generate(
            ModelProviderRequest(
                agent_id="alfred-qa",
                session_id="sess-1",
                model="stub-1",
                workspace_dir=tmp_path,
            )
        )
        assert resp.content == "ok:stub-1"

        # Verify record_compute_usage persists cleanly to SQLite compute_usage
        await mod_ctx.record_compute_usage(
            ComputeUsageRecord(
                module_id="test-mod",
                agent="alfred-qa",
                session_id="sess-1",
                resource_label="gce-l4-spot",
                duration_sec=12.5,
                cost_usd=0.04,
            )
        )
        usage_rows = await db.read(
            lambda c: int(c.execute("SELECT COUNT(*) FROM compute_usage").fetchone()[0])
        )
        assert usage_rows == 1

        tool_ctx = ToolExecutionContext(
            agent_id="alfred-qa",
            session_id="sess-1",
            workspace_dir=tmp_path,
            module_ctx=mod_ctx,
        )

        # Valid call delivers typed BaseModel instance
        ok_res = await tool.invoke({"path": "docs/readme.md", "count": 3}, tool_ctx)
        assert ok_res.ok is True
        assert ok_res.output == {"path": "docs/readme.md", "count": 3}

        # Invalid dict & non-dict inputs return structured TOOL_VALIDATION_ERROR without crash
        for bad_payload in ({"count": 99}, ["not-a-dict"], "raw-string"):
            bad_res = await tool.invoke(bad_payload, tool_ctx)
            assert bad_res.ok is False
            assert bad_res.error_code == "TOOL_VALIDATION_ERROR"
            assert bad_res.error is not None
        assert len(captured_args) == 1


async def test_scoped_security_atomic_config_sqlite_wal_and_migrations(tmp_path: Path) -> None:
    modules_dir = tmp_path / "modules"
    store_dir = tmp_path / "store"
    _write_module(
        modules_dir,
        "provider-mod",
        built_in=True,
        required_secrets=["PROVIDER_KEY"],
        allowed_vault_prefixes=["prov_acc_"],
        plugin_code=(
            "from pydantic import BaseModel\n"
            "from alfred.kernel.types import BaseModulePlugin\n"
            "class PingDTO(BaseModel):\n"
            "    pong: str\n"
            "class ProviderService:\n"
            "    def ping(self) -> PingDTO:\n"
            "        return PingDTO(pong='ok')\n"
            "class ProviderPlugin(BaseModulePlugin):\n"
            "    id = 'provider-mod'\n"
            "    def create_service(self, ctx):\n"
            "        return ProviderService()\n"
            "plugin = ProviderPlugin()\n"
        ),
    )
    _write_module(
        modules_dir,
        "consumer-mod",
        built_in=True,
        depends=["provider-mod"],
        required_secrets=["CONSUMER_KEY"],
        plugin_code=(
            "from alfred.kernel.types import BaseModulePlugin\n"
            "class ConsumerPlugin(BaseModulePlugin):\n"
            "    id = 'consumer-mod'\n"
            "plugin = ConsumerPlugin()\n"
        ),
    )
    _write_module(
        modules_dir,
        "sneaky-mod",
        built_in=True,
        depends=[],
        plugin_code=(
            "from alfred.kernel.types import BaseModulePlugin\n"
            "class SneakyPlugin(BaseModulePlugin):\n"
            "    id = 'sneaky-mod'\n"
            "plugin = SneakyPlugin()\n"
        ),
    )

    try:
        async with SqlitePool(store_dir / "alfred.db") as db:
            vault = VaultManager(store_dir / "vault.json", store_dir / ".vault-key")
            await vault.set_secret("UNRELATED_ADMIN_SECRET", "top-secret-value")
            registry = ModuleRegistry()
            loader = ModuleLoader(
                modules_dir=modules_dir,
                store_dir=store_dir,
                db=db,
                vault=vault,
                registry=registry,
                heavy_job=HeavyJobHoldManager(store_dir / ".heavy-job.lock"),
            )
            await loader.load_active_modules(
                active_ids={"provider-mod", "consumer-mod", "sneaky-mod"}
            )

            prov_ctx = registry.get_context("provider-mod")
            cons_ctx = registry.get_context("consumer-mod")
            sneaky_ctx = registry.get_context("sneaky-mod")
            assert prov_ctx is not None and cons_ctx is not None and sneaky_ctx is not None

            # Scoped Vault enforcement + key format validation
            await prov_ctx.security.vault.set_secret("PROVIDER_KEY", "ok-1")
            await prov_ctx.security.vault.set_secret("prov_acc_work", "ok-2")
            assert await prov_ctx.security.vault.get_secret("PROVIDER_KEY") == "ok-1"
            assert {item.key_id for item in prov_ctx.security.vault.list_secrets()} == {
                "PROVIDER_KEY",
                "prov_acc_work",
            }
            with pytest.raises(ForbiddenVaultAccessError):
                await prov_ctx.security.vault.get_secret("UNRELATED_ADMIN_SECRET")
            with pytest.raises(ForbiddenVaultAccessError):
                await prov_ctx.security.vault.set_secret("CONSUMER_KEY", "steal")
            with pytest.raises(ValueError):
                await prov_ctx.security.vault.get_secret("bad key/1")

            # Concurrent atomic ScopedConfigProxy.update must lose 0 keys
            await asyncio.gather(
                *(prov_ctx.security.config.update({f"k_{i}": i}) for i in range(15))
            )
            merged_cfg = await prov_ctx.security.config.get()
            assert all(merged_cfg.get(f"k_{i}") == i for i in range(15))

            # Service Bus depends enforcement
            svc = cons_ctx.modules.require_service("provider-mod")
            assert svc.ping().pong == "ok"
            with pytest.raises(MissingDependencyError) as dep_err:
                sneaky_ctx.modules.require_service("provider-mod")
            assert dep_err.value.status_code == 409

            # Migrations: single-line multi-stmt, multi-line trigger, trailing comments, & rollback
            migs: Sequence[ModuleMigration] = [
                ModuleMigration(
                    version=1,
                    name="single_line_and_trigger",
                    sql=(
                        "CREATE TABLE IF NOT EXISTS test_items "
                        "(id INTEGER PRIMARY KEY, name TEXT); "
                        "CREATE TABLE IF NOT EXISTS item_audit (item_id INTEGER);"
                    ),
                ),
                ModuleMigration(
                    version=2,
                    name="trigger_and_comment",
                    sql=(
                        "CREATE TRIGGER trg_item_audit AFTER INSERT ON test_items BEGIN "
                        "INSERT INTO item_audit (item_id) VALUES (NEW.id); END;\n"
                        "INSERT INTO test_items (id, name) VALUES (1, 'first;semicolon');\n"
                        "-- trailing comment after final statement\n"
                    ),
                ),
            ]
            assert await apply_module_migrations(db, "provider-mod", migs) == [1, 2]
            assert await apply_module_migrations(db, "provider-mod", migs) == []
            audit_count = await db.read(
                lambda c: int(c.execute("SELECT COUNT(*) FROM item_audit").fetchone()[0])
            )
            assert audit_count == 1

            # Truncated SQL raises ModuleLoadError without committing partial version
            with pytest.raises(Exception) as trunc_err:
                await apply_module_migrations(
                    db,
                    "provider-mod",
                    [ModuleMigration(version=3, name="truncated", sql="INSERT INTO test_items")],
                )
            assert "Incomplete trailing SQL" in str(trunc_err.value)

            # Operational error inside migration rolls back both table write and module_migrations
            bad_mig = [
                ModuleMigration(
                    version=4,
                    name="broken_mig",
                    sql=(
                        "INSERT INTO test_items (id, name) VALUES (2, 'rolled_back');\n"
                        "INSERT INTO non_existent_table VALUES (1);"
                    ),
                )
            ]
            with pytest.raises(sqlite3.OperationalError):
                await apply_module_migrations(db, "provider-mod", bad_mig)
            assert (
                await db.read(
                    lambda c: int(c.execute("SELECT COUNT(*) FROM test_items").fetchone()[0])
                )
                == 1
            )
            recorded_versions = await db.read(
                lambda c: [
                    int(r["version"])
                    for r in c.execute(
                        "SELECT version FROM module_migrations WHERE module_id = 'provider-mod'"
                    ).fetchall()
                ]
            )
            assert recorded_versions == [1, 2]

            # _read_sync enforces query_only = ON + 20+ concurrent reads/writes succeed without lock
            with pytest.raises(sqlite3.OperationalError):
                await db.read(
                    lambda c: c.execute("INSERT INTO test_items (id, name) VALUES (99, 'nope')")
                )

            await asyncio.gather(
                *(
                    db.write(
                        lambda c, idx=i: c.execute(
                            "INSERT INTO test_items (id, name) VALUES (?, ?)",
                            (100 + idx, f"w-{idx}"),
                        )
                    )
                    for i in range(12)
                ),
                *(
                    db.read(lambda c: c.execute("SELECT COUNT(*) FROM test_items").fetchone())
                    for _ in range(12)
                ),
            )
    finally:
        for mid in ("provider-mod", "consumer-mod", "sneaky-mod"):
            sys.modules.pop(module_package_name(mid), None)


async def test_http_bridge_auth_csrf_405_streaming_and_ui_serving(tmp_path: Path) -> None:
    modules_dir = tmp_path / "modules"
    store_dir = tmp_path / "store"
    _write_module(
        modules_dir,
        "bridge-mod",
        built_in=True,
        plugin_code=(
            "from pydantic import BaseModel\n"
            "from starlette.responses import HTMLResponse\n"
            "from alfred.kernel.types import BaseModulePlugin, ModuleRouteDefinition\n"
            "class ItemDto(BaseModel):\n"
            "    itemId: str\n"
            "class StreamDto(BaseModel):\n"
            "    totalBytes: int\n"
            "class BridgePlugin(BaseModulePlugin):\n"
            "    id = 'bridge-mod'\n"
            "    def routes(self):\n"
            "        async def get_item(request):\n"
            "            return ItemDto(itemId=request.path_params['item_id'])\n"
            "        async def post_stream(request):\n"
            "            total = 0\n"
            "            async for chunk in request.stream():\n"
            "                total += len(chunk)\n"
            "            return StreamDto(totalBytes=total)\n"
            "        async def oauth_cb(request):\n"
            "            return HTMLResponse('<html>oauth ok</html>')\n"
            "        return [\n"
            "            ModuleRouteDefinition(\n"
            "                path='/api/bridge/items/{item_id}',\n"
            "                methods=('GET',), handler=get_item, auth='admin',\n"
            "            ),\n"
            "            ModuleRouteDefinition(\n"
            "                path='/api/bridge/upload',\n"
            "                methods=('POST', 'PUT', 'PATCH', 'DELETE'),\n"
            "                handler=post_stream, auth='dashboard',\n"
            "            ),\n"
            "            ModuleRouteDefinition(\n"
            "                path='/oauth-cloud-callback.html',\n"
            "                methods=('GET',), handler=oauth_cb, auth='public_oauth_callback',\n"
            "            ),\n"
            "        ]\n"
            "plugin = BridgePlugin()\n"
        ),
        ui_files={
            "panel.js": "export const ready = true;\n",
            "notes.txt": "disallowed extension\n",
            ".secret.js": "disallowed dotfile\n",
        },
    )
    _write_module(
        modules_dir,
        "inactive-ui-mod",
        built_in=False,
        ui_files={"card.js": "export const unused = 1;\n"},
    )

    try:
        async with SqlitePool(store_dir / "alfred.db") as db:
            vault = VaultManager(store_dir / "vault.json", store_dir / ".vault-key")
            registry = ModuleRegistry()
            loader = ModuleLoader(
                modules_dir=modules_dir,
                store_dir=store_dir,
                db=db,
                vault=vault,
                registry=registry,
                heavy_job=HeavyJobHoldManager(store_dir / ".heavy-job.lock"),
            )
            await loader.load_active_modules(active_ids={"bridge-mod"})

            app = FastAPI()

            @app.get("/api/core/health")
            async def core_health() -> JSONResponse:
                return JSONResponse({"ok": True})

            auth = AuthService(admin_token="test-admin-token-xyz")
            attach_module_bridge(app, registry, auth)

            admin_cookie, admin_csrf = auth.issue_dashboard_session(role="admin")
            dash_only_cookie, _ = auth.issue_dashboard_session(role="dashboard")
            expired_cookie, _ = auth.issue_dashboard_session(role="admin", ttl_sec=-5)

            async def _gen_chunks() -> AsyncIterator[bytes]:
                yield b"hello-"
                yield b"stream"

            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                # Core route works on GET and returns genuine 405 on POST (not swallowed to 404)
                assert (await client.get("/api/core/health")).status_code == 200
                core_405 = await client.post("/api/core/health")
                assert core_405.status_code == 405

                # Dynamic module route returns 405 + Allow when path matches but method doesn't
                mod_405 = await client.delete("/api/bridge/items/42")
                assert mod_405.status_code == 405
                assert "GET" in mod_405.headers.get("allow", "")

                # Unauthenticated / malformed / non-ASCII / invalid Bearer -> 401 (never 500)
                assert (await client.get("/api/bridge/items/42")).status_code == 401
                assert (
                    await client.get(
                        "/api/bridge/items/42",
                        headers={"Authorization": "Basic abc"},
                    )
                ).status_code == 401

                # Valid Bearer -> 200 DTO serialization
                ok_get = await client.get(
                    "/api/bridge/items/42",
                    headers={"Authorization": "Bearer test-admin-token-xyz"},
                )
                assert ok_get.status_code == 200
                assert ok_get.json() == {"itemId": "42"}

                # Public OAuth callback accessible without auth
                oauth = await client.get("/oauth-cloud-callback.html")
                assert oauth.status_code == 200
                assert "oauth ok" in oauth.text

                # UI GET/HEAD + ETag + 304 + inactive block + traversal + extension block
                ui_resp = await client.get("/api/modules/bridge-mod/ui/panel.js")
                assert ui_resp.status_code == 200
                etag = ui_resp.headers["etag"]
                head_resp = await client.head("/api/modules/bridge-mod/ui/panel.js")
                assert head_resp.status_code == 200
                assert head_resp.content == b""
                assert head_resp.headers["etag"] == etag

                ui_304 = await client.get(
                    "/api/modules/bridge-mod/ui/panel.js",
                    headers={"If-None-Match": etag},
                )
                assert ui_304.status_code == 304

                inactive_ui = await client.get("/api/modules/inactive-ui-mod/ui/card.js")
                assert inactive_ui.status_code == 404
                assert inactive_ui.json()["error"] == "MODULE_DISABLED"

                assert (
                    await client.get("/api/modules/bridge-mod/ui/../plugin.py")
                ).status_code in (403, 404)
                assert (
                    await client.get("/api/modules/bridge-mod/ui/..%2fplugin.py")
                ).status_code in (403, 404)
                assert (
                    await client.get("/api/modules/bridge-mod/ui/notes.txt")
                ).status_code == 403
                assert (
                    await client.get("/api/modules/bridge-mod/ui/.secret.js")
                ).status_code == 403

            # Negative cookie cases: expired, tampered, non-ASCII, role="dashboard" on admin route
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
                cookies={"alfred_session": expired_cookie},
            ) as exp_client:
                exp_res = await exp_client.get("/api/bridge/items/42")
                assert exp_res.status_code == 401
                assert exp_res.json()["error"] == "EXPIRED_SESSION"

            # Raw ASGI check for literal non-ASCII bytes in `Cookie: alfred_session=á.é`
            # (must return 401 INVALID_SESSION cleanly, never 500 UnicodeEncodeError)
            sent_messages: list[dict[str, Any]] = []

            async def _noop_receive() -> dict[str, Any]:
                return {"type": "http.request", "body": b"", "more_body": False}

            async def _capture_send(msg: dict[str, Any]) -> None:
                sent_messages.append(msg)

            await app(
                {
                    "type": "http",
                    "asgi": {"version": "3.0"},
                    "http_version": "1.1",
                    "method": "GET",
                    "path": "/api/bridge/items/42",
                    "raw_path": b"/api/bridge/items/42",
                    "query_string": b"",
                    "headers": [(b"cookie", "alfred_session=á.é".encode("latin-1"))],
                },
                _noop_receive,
                _capture_send,
            )
            assert sent_messages[0]["status"] == 401

            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
                cookies={"alfred_session": admin_cookie + "tamper"},
            ) as bad_sig_client:
                assert (await bad_sig_client.get("/api/bridge/items/42")).status_code == 401

            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
                cookies={"alfred_session": dash_only_cookie},
            ) as role_client:
                forbidden_res = await role_client.get("/api/bridge/items/42")
                assert forbidden_res.status_code == 403
                assert forbidden_res.json()["error"] == "FORBIDDEN"

            # Valid admin session: strict Authorization header no-fallback + CSRF on all mutations
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://test",
                cookies={"alfred_session": admin_cookie},
            ) as dash_client:
                # Bad Authorization header alongside valid cookie MUST fail with 401 (no fallback)
                no_fallback = await dash_client.get(
                    "/api/bridge/items/42",
                    headers={"Authorization": "Bearer "},
                )
                assert no_fallback.status_code == 401
                assert no_fallback.json()["error"] == "INVALID_TOKEN"

                for method in ("POST", "PUT", "PATCH", "DELETE"):
                    missing_csrf = await dash_client.request(
                        method,
                        "/api/bridge/upload",
                        content=b"x",
                    )
                    assert missing_csrf.status_code == 403
                    bad_csrf = await dash_client.request(
                        method,
                        "/api/bridge/upload",
                        headers={"X-CSRF-Token": "wrong-token"},
                        content=b"x",
                    )
                    assert bad_csrf.status_code == 403

                ok_stream = await dash_client.post(
                    "/api/bridge/upload",
                    headers={"X-CSRF-Token": admin_csrf},
                    content=_gen_chunks(),
                )
                assert ok_stream.status_code == 200
                assert ok_stream.json() == {"totalBytes": 12}
    finally:
        sys.modules.pop(module_package_name("bridge-mod"), None)


def _prepare_symlink_dirs(tmp_path: Path) -> tuple[Path, Path, Path, Path] | None:
    modules_dir = tmp_path / "modules"
    store_dir = tmp_path / "store"
    outside_dir = tmp_path / "outside"
    outside_dir.mkdir(parents=True, exist_ok=True)
    (outside_dir / "leak.js").write_text("export const x = 1;\n", encoding="utf-8")

    file_sym_dir = _write_module(
        modules_dir,
        "sym-file-mod",
        built_in=True,
        plugin_code=(
            "from alfred.kernel.types import BaseModulePlugin\n"
            "class P(BaseModulePlugin):\n"
            "    id = 'sym-file-mod'\n"
            "plugin = P()\n"
        ),
        ui_files={"ok.js": "export const ok = true;\n"},
    )
    dir_sym_dir = _write_module(
        modules_dir,
        "sym-dir-mod",
        built_in=True,
        plugin_code=(
            "from alfred.kernel.types import BaseModulePlugin\n"
            "class P(BaseModulePlugin):\n"
            "    id = 'sym-dir-mod'\n"
            "plugin = P()\n"
        ),
    )
    try:
        (file_sym_dir / "ui" / "evil.js").symlink_to(file_sym_dir / "plugin.py")
        (dir_sym_dir / "ui").symlink_to(outside_dir, target_is_directory=True)
    except (OSError, NotImplementedError):
        return None
    return modules_dir, store_dir, file_sym_dir, dir_sym_dir


def _link_data_escape(sym_ctx: Any, target: Path) -> None:
    data_dir = sym_ctx.security.data_dir.ensure_exists()
    (data_dir / "escape.json").symlink_to(target)


async def test_symlink_path_confinement_blocked(tmp_path: Path) -> None:
    prepared = _prepare_symlink_dirs(tmp_path)
    if prepared is None:
        pytest.skip("OS does not permit unprivileged symlink creation in test environment")
    modules_dir, store_dir, _file_sym_dir, _dir_sym_dir = prepared

    try:
        async with SqlitePool(store_dir / "alfred.db") as db:
            vault = VaultManager(store_dir / "vault.json", store_dir / ".vault-key")
            await vault.set_secret("ROOT_SECRET", "top-secret")
            registry = ModuleRegistry()
            loader = ModuleLoader(
                modules_dir=modules_dir,
                store_dir=store_dir,
                db=db,
                vault=vault,
                registry=registry,
                heavy_job=HeavyJobHoldManager(store_dir / ".heavy-job.lock"),
            )
            await loader.load_active_modules(active_ids={"sym-file-mod", "sym-dir-mod"})

            sym_ctx = registry.get_context("sym-file-mod")
            assert sym_ctx is not None
            _link_data_escape(sym_ctx, store_dir / "vault.json")

            app = FastAPI()
            attach_module_bridge(app, registry, AuthService(admin_token="sym-test-token"))

            transport = httpx.ASGITransport(app=app)
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
                assert (
                    await client.get("/api/modules/sym-file-mod/ui/evil.js")
                ).status_code == 403
                assert (
                    await client.get("/api/modules/sym-dir-mod/ui/leak.js")
                ).status_code == 403

            with pytest.raises(ModuleSecurityError):
                sym_ctx.security.data_dir.resolve_path("escape.json")
    finally:
        for mid in ("sym-file-mod", "sym-dir-mod"):
            sys.modules.pop(module_package_name(mid), None)
