"""Lazy module discovery, DAG topological ordering, migration runner, and probe execution."""

from __future__ import annotations

import heapq
import importlib.util
import inspect
import logging
import sqlite3
import sys
import types
import uuid
from collections.abc import Mapping, Sequence
from collections.abc import Set as AbstractSet
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from alfred.core.db import ModuleState, SqlitePool
from alfred.core.security.heavy_job_hold import HeavyJobHoldManager
from alfred.core.vault import VaultManager
from alfred.kernel.errors import (
    CircularDependencyError,
    MissingDependencyError,
    ModuleLoadError,
    ModuleSecurityError,
)
from alfred.kernel.registry import ModuleRegistry, ScopedServiceBus, module_package_name
from alfred.kernel.security import (
    ModuleDataDir,
    ModuleSecurityProxy,
    ScopedConfigProxy,
    ScopedVaultProxy,
)
from alfred.kernel.types import (
    AlfredModulePlugin,
    ModuleContext,
    ModuleManifest,
    ModuleMigration,
    ProbeResult,
)


def discover_manifests(modules_dir: Path) -> dict[str, tuple[Path, ModuleManifest]]:
    """Scan `modules_dir/*/module.json` using strict Pydantic `ModuleManifest` parsing."""
    if not modules_dir.exists():
        return {}
    discovered: dict[str, tuple[Path, ModuleManifest]] = {}
    for child in sorted(modules_dir.iterdir(), key=lambda p: p.name):
        if not child.is_dir() or child.name.startswith((".", "__")):
            continue
        manifest_path = child / "module.json"
        if not manifest_path.is_file():
            continue
        try:
            manifest = ModuleManifest.model_validate_json(manifest_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, ValidationError) as exc:
            raise ModuleLoadError(
                f"Invalid module.json in '{child.name}': {exc}",
                module_id=child.name,
            ) from exc
        if manifest.id != child.name:
            raise ModuleLoadError(
                f"Manifest id '{manifest.id}' does not match directory '{child.name}'",
                module_id=child.name,
            )
        discovered[manifest.id] = (child.resolve(), manifest)
    return discovered


def resolve_load_order(
    manifests: Mapping[str, ModuleManifest],
    active_ids: AbstractSet[str],
) -> list[str]:
    """Topologically sort `active_ids` by `depends`, detecting cycles and missing dependencies."""
    ordered_active = sorted(active_ids)
    for mod_id in ordered_active:
        if mod_id not in manifests:
            raise ModuleLoadError(
                f"Active module '{mod_id}' has no manifest in modules directory",
                module_id=mod_id,
            )

    in_degree: dict[str, int] = {mod_id: 0 for mod_id in ordered_active}
    dependents: dict[str, list[str]] = {mod_id: [] for mod_id in ordered_active}

    for mod_id in ordered_active:
        for dep_id in manifests[mod_id].depends:
            if dep_id not in manifests:
                raise MissingDependencyError(dep_id, module_id=mod_id)
            if dep_id not in active_ids:
                raise MissingDependencyError(
                    dep_id,
                    module_id=mod_id,
                    message=(
                        f"Module '{mod_id}' depends on '{dep_id}', which is not active"
                    ),
                )
            in_degree[mod_id] += 1
            dependents[dep_id].append(mod_id)

    heap: list[str] = [mod_id for mod_id, deg in in_degree.items() if deg == 0]
    heapq.heapify(heap)
    result: list[str] = []

    while heap:
        current = heapq.heappop(heap)
        result.append(current)
        for nxt in sorted(dependents[current]):
            in_degree[nxt] -= 1
            if in_degree[nxt] == 0:
                heapq.heappush(heap, nxt)

    if len(result) != len(ordered_active):
        cycle = _find_dependency_cycle(manifests, active_ids)
        raise CircularDependencyError(cycle)
    return result


def _find_dependency_cycle(
    manifests: Mapping[str, ModuleManifest],
    active_ids: AbstractSet[str],
) -> list[str]:
    state: dict[str, int] = {}
    stack: list[str] = []

    def dfs(node: str) -> list[str] | None:
        state[node] = 1
        stack.append(node)
        for dep in sorted(manifests[node].depends):
            if dep not in active_ids:
                continue
            dep_state = state.get(dep, 0)
            if dep_state == 1:
                idx = stack.index(dep)
                return stack[idx:] + [dep]
            if dep_state == 0:
                found = dfs(dep)
                if found is not None:
                    return found
        stack.pop()
        state[node] = 2
        return None

    for mod_id in sorted(active_ids):
        if state.get(mod_id, 0) == 0:
            found = dfs(mod_id)
            if found is not None:
                return found
    return sorted(active_ids)


def _confine_module_entry(module_id: str, module_dir: Path, entry_file: str) -> Path:
    if "\x00" in entry_file or "\\" in entry_file:
        raise ModuleSecurityError(
            f"Invalid entry path: {entry_file!r}",
            module_id=module_id,
        )
    rel = Path(entry_file)
    if rel.is_absolute():
        raise ModuleSecurityError(
            f"Entry path must be relative: {entry_file!r}",
            module_id=module_id,
        )
    resolved_dir = module_dir.resolve()
    resolved_entry = (resolved_dir / rel).resolve()
    if not resolved_entry.is_relative_to(resolved_dir):
        raise ModuleSecurityError(
            f"Module entry escapes module directory: {entry_file!r}",
            module_id=module_id,
        )
    return resolved_entry


def _purge_module_namespace(pkg_prefix: str) -> None:
    sub_prefix = f"{pkg_prefix}."
    for key in list(sys.modules.keys()):
        if key == pkg_prefix or key.startswith(sub_prefix):
            sys.modules.pop(key, None)


def load_module_entrypoint(
    module_id: str,
    module_dir: Path,
    entry_file: str = "plugin.py",
) -> AlfredModulePlugin:
    """Lazy-load `modules/<id>/plugin.py` using `spec_from_file_location`."""
    safe_pkg = module_package_name(module_id)
    existing = sys.modules.get(safe_pkg)
    if existing is not None:
        return _extract_plugin_object(existing, module_id)

    entry_path = _confine_module_entry(module_id, module_dir, entry_file)
    if not entry_path.is_file():
        raise ModuleLoadError(
            f"Module entrypoint '{entry_file}' not found for '{module_id}'",
            module_id=module_id,
        )

    spec = importlib.util.spec_from_file_location(
        safe_pkg,
        entry_path,
        submodule_search_locations=list(
            dict.fromkeys([str(entry_path.parent.resolve()), str(module_dir.resolve())])
        ),
    )
    if spec is None or spec.loader is None:
        raise ModuleLoadError(
            f"Failed to create import spec for '{module_id}' at {entry_path}",
            module_id=module_id,
        )

    mod = importlib.util.module_from_spec(spec)
    sys.modules[safe_pkg] = mod
    try:
        spec.loader.exec_module(mod)
        return _extract_plugin_object(mod, module_id)
    except BaseException:
        _purge_module_namespace(safe_pkg)
        raise


def _extract_plugin_object(mod: Any, module_id: str) -> AlfredModulePlugin:
    candidate: Any = getattr(mod, "plugin", None)
    if candidate is None:
        factory = getattr(mod, "create_plugin", None)
        if callable(factory):
            candidate = factory()
    if not isinstance(candidate, AlfredModulePlugin):
        raise ModuleLoadError(
            f"Module '{module_id}' entrypoint must export `plugin` implementing AlfredModulePlugin",
            module_id=module_id,
        )
    if candidate.id != module_id:
        raise ModuleLoadError(
            f"Loaded plugin.id '{candidate.id}' does not match manifest '{module_id}'",
            module_id=module_id,
        )
    return candidate


def _load_probe_callable_sync(
    module_id: str,
    module_dir: Path,
    probe_entry: str,
) -> tuple[str, Any] | None:
    probe_path = _confine_module_entry(module_id, module_dir, probe_entry)
    if not probe_path.is_file():
        return None

    resolved_dir = module_dir.resolve()
    probe_root = f"_alfred_probe_{module_id.replace('-', '_')}_{uuid.uuid4().hex[:8]}"
    rel_parts = probe_path.relative_to(resolved_dir).with_suffix("").parts
    probe_mod_name = ".".join((probe_root, *rel_parts))

    root_pkg = types.ModuleType(probe_root)
    root_pkg.__path__ = [str(resolved_dir)]
    root_pkg.__package__ = probe_root
    sys.modules[probe_root] = root_pkg

    try:
        for idx in range(1, len(rel_parts)):
            sub_dotted = ".".join((probe_root, *rel_parts[:idx]))
            sub_dir = resolved_dir.joinpath(*rel_parts[:idx])
            sub_pkg = types.ModuleType(sub_dotted)
            sub_pkg.__path__ = [str(sub_dir)]
            sub_pkg.__package__ = sub_dotted
            sys.modules[sub_dotted] = sub_pkg

        spec = importlib.util.spec_from_file_location(probe_mod_name, probe_path)
        if spec is None or spec.loader is None:
            raise ModuleLoadError(
                f"Unable to build probe import spec for '{module_id}'",
                module_id=module_id,
            )

        mod = importlib.util.module_from_spec(spec)
        sys.modules[probe_mod_name] = mod
        spec.loader.exec_module(mod)
        probe_fn = getattr(mod, "probe", None) or getattr(mod, "wizard_probe", None)
        if not callable(probe_fn):
            raise ModuleLoadError(
                f"Module '{module_id}' probe.py must define callable `probe(ctx)`",
                module_id=module_id,
            )
        return probe_root, probe_fn
    except BaseException:
        _purge_module_namespace(probe_root)
        raise


async def run_module_probe(
    module_id: str,
    module_dir: Path,
    manifest: ModuleManifest,
    ctx: ModuleContext,
) -> ProbeResult:
    """Execute lightweight `probe.py` with relative-import package WITHOUT importing `plugin.py`."""
    probe_entry = manifest.probe_entry or "probe.py"
    loaded = _load_probe_callable_sync(module_id, module_dir, probe_entry)
    if loaded is None:
        return ProbeResult(
            ok=False,
            module_id=module_id,
            summary=f"Probe entrypoint '{probe_entry}' not found",
        )
    probe_root, probe_fn = loaded
    try:
        outcome = probe_fn(ctx)
        if inspect.isawaitable(outcome):
            outcome = await outcome
        if isinstance(outcome, ProbeResult):
            return outcome
        return ProbeResult.model_validate(outcome)
    finally:
        _purge_module_namespace(probe_root)


def _has_non_comment_sql(text: str) -> bool:
    idx = 0
    n = len(text)
    while idx < n:
        ch = text[idx]
        if ch.isspace():
            idx += 1
            continue
        if ch == "-" and idx + 1 < n and text[idx + 1] == "-":
            nl = text.find("\n", idx + 2)
            if nl == -1:
                return False
            idx = nl + 1
            continue
        if ch == "/" and idx + 1 < n and text[idx + 1] == "*":
            end = text.find("*/", idx + 2)
            if end == -1:
                return True
            idx = end + 2
            continue
        return True
    return False


def _split_sql_statements(sql: str, *, module_id: str = "") -> list[str]:
    """Split SQL into individual complete statements (single-line multi-stmt & triggers safe)."""
    statements: list[str] = []
    start = 0
    idx = 0
    n = len(sql)
    in_single = False
    in_double = False
    in_line_comment = False
    in_block_comment = False

    while idx < n:
        ch = sql[idx]
        if in_line_comment:
            if ch == "\n":
                in_line_comment = False
            idx += 1
            continue
        if in_block_comment:
            if ch == "*" and idx + 1 < n and sql[idx + 1] == "/":
                in_block_comment = False
                idx += 2
            else:
                idx += 1
            continue
        if in_single:
            if ch == "'":
                if idx + 1 < n and sql[idx + 1] == "'":
                    idx += 2
                    continue
                in_single = False
            idx += 1
            continue
        if in_double:
            if ch == '"':
                if idx + 1 < n and sql[idx + 1] == '"':
                    idx += 2
                    continue
                in_double = False
            idx += 1
            continue

        if ch == "-" and idx + 1 < n and sql[idx + 1] == "-":
            in_line_comment = True
            idx += 2
            continue
        if ch == "/" and idx + 1 < n and sql[idx + 1] == "*":
            in_block_comment = True
            idx += 2
            continue
        if ch == "'":
            in_single = True
            idx += 1
            continue
        if ch == '"':
            in_double = True
            idx += 1
            continue

        if ch == ";":
            candidate = sql[start : idx + 1].strip()
            if candidate and sqlite3.complete_statement(candidate):
                statements.append(candidate)
                start = idx + 1
        idx += 1

    tail = sql[start:].strip()
    if _has_non_comment_sql(tail):
        if sqlite3.complete_statement(tail):
            statements.append(tail)
        else:
            raise ModuleLoadError(
                f"Incomplete trailing SQL statement in migration: {tail[:80]!r}",
                module_id=module_id or None,
            )
    return statements


async def apply_module_migrations(
    db: SqlitePool,
    module_id: str,
    migrations: Sequence[ModuleMigration],
) -> list[int]:
    """Run unapplied module migrations atomically inside a `BEGIN IMMEDIATE` transaction."""
    if not migrations:
        return []
    ordered = sorted(migrations, key=lambda m: m.version)
    now_iso = datetime.now(tz=UTC).isoformat()

    def _run_tx(conn: sqlite3.Connection) -> list[int]:
        rows = conn.execute(
            "SELECT version FROM module_migrations WHERE module_id = ?",
            (module_id,),
        ).fetchall()
        applied_versions = {int(row["version"]) for row in rows}
        newly_applied: list[int] = []

        for mig in ordered:
            if mig.version in applied_versions:
                continue
            if mig.sql is not None:
                for stmt in _split_sql_statements(mig.sql, module_id=module_id):
                    conn.execute(stmt)
            if mig.apply is not None:
                mig.apply(conn)
            conn.execute(
                "INSERT INTO module_migrations (module_id, version, name, applied_at) "
                "VALUES (?, ?, ?, ?)",
                (module_id, mig.version, mig.name, now_iso),
            )
            applied_versions.add(mig.version)
            newly_applied.append(mig.version)
        return newly_applied

    return await db.write(_run_tx)


class ModuleLoader:
    """Orchestrates discovery, lazy loading, migrations, probes, and unloading."""

    def __init__(
        self,
        *,
        modules_dir: Path,
        store_dir: Path,
        db: SqlitePool,
        vault: VaultManager,
        registry: ModuleRegistry,
        heavy_job: HeavyJobHoldManager,
        project_root: Path | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        self.modules_dir = modules_dir.resolve()
        self.store_dir = store_dir.resolve()
        self.project_root = (project_root or self.modules_dir.parent).resolve()
        self.db = db
        self.vault = vault
        self.registry = registry
        self.heavy_job = heavy_job
        self.logger = logger or logging.getLogger("alfred.kernel.loader")

    def discover(self) -> dict[str, tuple[Path, ModuleManifest]]:
        """Discover all valid module manifests under `modules_dir`."""
        return discover_manifests(self.modules_dir)

    def build_context(
        self,
        *,
        module_id: str,
        module_dir: Path,
        manifest: ModuleManifest,
    ) -> ModuleContext:
        """Create an isolated `ModuleContext` backed by scoped Vault/config/ServiceBus."""
        scoped_vault = ScopedVaultProxy(
            module_id=module_id,
            vault=self.vault,
            allowed_keys=manifest.effective_vault_keys(),
            allowed_prefixes=tuple(manifest.allowed_vault_prefixes),
        )
        scoped_config = ScopedConfigProxy(module_id=module_id, db=self.db)
        data_dir = ModuleDataDir(
            module_id=module_id,
            base_dir=self.store_dir / "modules" / module_id,
        )
        sec_proxy = ModuleSecurityProxy(
            module_id=module_id,
            vault=scoped_vault,
            config=scoped_config,
            data_dir=data_dir,
        )
        service_bus = ScopedServiceBus(
            caller_id=module_id,
            declared_depends=frozenset(manifest.depends),
            registry=self.registry,
        )
        return ModuleContext(
            module_id=module_id,
            manifest=manifest,
            module_dir=module_dir,
            project_root=self.project_root,
            db=self.db,
            security=sec_proxy,
            modules=service_bus,
            heavy_job=self.heavy_job,
            logger=logging.getLogger(f"alfred.modules.{module_id}"),
        )

    async def load_active_modules(
        self,
        active_ids: AbstractSet[str] | None = None,
    ) -> list[str]:
        """Discover manifests and lazy-load ONLY active modules in DAG order."""
        discovered = self.discover()
        manifests = {mid: pair[1] for mid, pair in discovered.items()}

        if active_ids is None:
            resolved_active: set[str] = set()
            existing_rows = {row.module_id: row for row in await self.db.list_module_rows()}
            now_iso = datetime.now(tz=UTC).isoformat()
            for mod_id, manifest in manifests.items():
                row = existing_rows.get(mod_id)
                if row is None:
                    initial_state: ModuleState = (
                        "active" if (manifest.built_in or manifest.default_enabled) else "available"
                    )
                    row = await self.db.set_module_state(mod_id, initial_state, now_iso)
                if row.state == "active":
                    resolved_active.add(mod_id)
            target_active: AbstractSet[str] = resolved_active
        else:
            target_active = active_ids

        load_order = resolve_load_order(manifests, target_active)
        loaded: list[str] = []
        for mod_id in load_order:
            if self.registry.is_active(mod_id):
                continue
            mod_dir, manifest = discovered[mod_id]
            await self._load_single(mod_id, mod_dir, manifest)
            loaded.append(mod_id)
        return loaded

    async def _load_single(
        self,
        module_id: str,
        module_dir: Path,
        manifest: ModuleManifest,
    ) -> None:
        plugin = load_module_entrypoint(module_id, module_dir, entry_file=manifest.entry)
        ctx = self.build_context(module_id=module_id, module_dir=module_dir, manifest=manifest)
        await apply_module_migrations(self.db, module_id, plugin.migrations())
        self.registry.register_module(
            plugin=plugin,
            manifest=manifest,
            module_dir=module_dir,
            ctx=ctx,
        )
        try:
            await plugin.on_load(ctx)
        except BaseException:
            await self.registry.unregister_module(module_id, force=True)
            raise

    async def probe_inactive_module(self, module_id: str) -> ProbeResult:
        """Run Setup Wizard probe (`probe.py`) without loading or activating `plugin.py`."""
        discovered = self.discover()
        if module_id not in discovered:
            raise ModuleLoadError(f"Unknown module '{module_id}'", module_id=module_id)
        mod_dir, manifest = discovered[module_id]
        ctx = self.build_context(module_id=module_id, module_dir=mod_dir, manifest=manifest)
        active_plugin = self.registry.get_plugin(module_id)
        if active_plugin is not None:
            return await active_plugin.wizard_probe(ctx)
        return await run_module_probe(module_id, mod_dir, manifest, ctx)

    async def deactivate_module(self, module_id: str, *, force: bool = False) -> None:
        """Unload a module from runtime registry without deleting persistent DB/data state."""
        await self.registry.unregister_module(module_id, force=force)
        now_iso = datetime.now(tz=UTC).isoformat()
        await self.db.set_module_state(module_id, "installed_disabled", now_iso)
