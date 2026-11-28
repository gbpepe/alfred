"""FastAPI web application factory and service container (`create_app`)."""

from __future__ import annotations

import os
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import httpx
from fastapi import FastAPI

from alfred.core.agents_config import AgentsConfigManager
from alfred.core.auth import AuthService
from alfred.core.circuit_breaker import CircuitBreaker
from alfred.core.config import CoreSettings
from alfred.core.db import SqlitePool
from alfred.core.gcp_auth import GcpTokenProvider, ServiceAccountCredentials
from alfred.core.model_router import ModelRouter
from alfred.core.module_manager import ModuleManager
from alfred.core.module_wizard import ModuleWizardService
from alfred.core.routes import create_core_router
from alfred.core.security.heavy_job_hold import HeavyJobHoldManager
from alfred.core.test_simulator import TestSimulator
from alfred.core.tool_executor import ToolExecutor
from alfred.core.vault import VaultManager
from alfred.kernel.http_bridge import mount_module_dispatcher, mount_module_ui_routes
from alfred.kernel.loader import ModuleLoader, resolve_load_order
from alfred.kernel.registry import ModuleRegistry


@dataclass(slots=True)
class CoreAppContainer:
    """Dependency-injection container wiring kernel and core services."""

    settings: CoreSettings
    db: SqlitePool
    vault: VaultManager
    auth: AuthService
    registry: ModuleRegistry
    heavy_job: HeavyJobHoldManager
    loader: ModuleLoader
    agents: AgentsConfigManager
    circuit_breaker: CircuitBreaker
    router: ModelRouter
    tool_executor: ToolExecutor
    module_manager: ModuleManager
    module_wizard: ModuleWizardService
    test_simulator: TestSimulator


def _resolve_environment(raw: str | None) -> Literal["prod", "staging", "test", "dev"]:
    val = (raw or "dev").strip().lower()
    if val in ("prod", "staging", "test", "dev"):
        if val == "prod":
            return "prod"
        if val == "staging":
            return "staging"
        if val == "test":
            return "test"
    return "dev"


def _resolve_admin_token(settings: CoreSettings, explicit_token: str | None) -> str:
    if explicit_token:
        return explicit_token
    env_token = os.environ.get("ALFRED_DASHBOARD_TOKEN", "").strip()
    if env_token:
        return env_token
    token_file = settings.store_dir / ".dashboard-token"
    if token_file.is_file():
        loaded = token_file.read_text(encoding="utf-8").strip()
        if loaded:
            return loaded
    if settings.environment == "prod":
        raise RuntimeError(
            "ALFRED_DASHBOARD_TOKEN or store/.dashboard-token is required when ALFRED_ENV=prod"
        )
    return secrets.token_urlsafe(32)


def _build_optional_gcp_token_provider(
    http_client: httpx.AsyncClient | None,
) -> GcpTokenProvider | None:
    creds_raw = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    if not creds_raw:
        return None
    creds_path = Path(creds_raw)
    if not creds_path.is_file():
        return None
    creds = ServiceAccountCredentials.model_validate_json(creds_path.read_text(encoding="utf-8"))
    return GcpTokenProvider(creds, http_client=http_client)


def build_core_container(
    settings: CoreSettings | None = None,
    *,
    admin_token: str | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> CoreAppContainer:
    """Construct `CoreAppContainer` synchronously without performing I/O."""
    if settings is None:
        root = Path(os.environ.get("ALFRED_PROJECT_ROOT", Path.cwd()))
        env_name = _resolve_environment(os.environ.get("ALFRED_ENV"))
        db_name = os.environ.get("ALFRED_DB_FILENAME", "alfred.db")
        settings = CoreSettings.from_project_root(root, db_filename=db_name, environment=env_name)

    db = SqlitePool(settings.db_path)
    vault = VaultManager(settings.vault_path, settings.vault_key_path)
    token = _resolve_admin_token(settings, admin_token)
    auth = AuthService(admin_token=token)
    registry = ModuleRegistry()
    heavy_job = HeavyJobHoldManager(settings.heavy_job_lock_path)
    loader = ModuleLoader(
        modules_dir=settings.modules_dir,
        store_dir=settings.store_dir,
        db=db,
        vault=vault,
        registry=registry,
        heavy_job=heavy_job,
        project_root=settings.project_root,
    )
    agents = AgentsConfigManager(settings.agents_config_path, modules_dir=settings.modules_dir)
    circuit_breaker = CircuitBreaker(db, registry=registry)
    gcp_token_provider = _build_optional_gcp_token_provider(http_client=http_client)
    router = ModelRouter(
        db=db,
        circuit_breaker=circuit_breaker,
        registry=registry,
        http_client=http_client,
        vault=vault,
        gcp_token_provider=gcp_token_provider,
        vertex_project_id=os.environ.get("GOOGLE_CLOUD_PROJECT") or None,
        vertex_location=os.environ.get("VERTEX_LOCATION", "europe-west1"),
    )
    tool_executor = ToolExecutor(registry=registry)
    module_manager = ModuleManager(
        settings=settings,
        db=db,
        vault=vault,
        registry=registry,
        loader=loader,
    )
    module_wizard = ModuleWizardService(
        settings=settings,
        db=db,
        vault=vault,
        loader=loader,
    )
    test_simulator = TestSimulator(
        settings=settings,
        agents=agents,
        router=router,
        tool_executor=tool_executor,
    )
    return CoreAppContainer(
        settings=settings,
        db=db,
        vault=vault,
        auth=auth,
        registry=registry,
        heavy_job=heavy_job,
        loader=loader,
        agents=agents,
        circuit_breaker=circuit_breaker,
        router=router,
        tool_executor=tool_executor,
        module_manager=module_manager,
        module_wizard=module_wizard,
        test_simulator=test_simulator,
    )


def create_app(
    settings: CoreSettings | None = None,
    *,
    admin_token: str | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> FastAPI:
    """FastAPI application factory (`uvicorn alfred.core.web_app:create_app --factory`)."""
    container = build_core_container(
        settings,
        admin_token=admin_token,
        http_client=http_client,
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        await container.db.initialize()
        await container.vault.initialize()
        await container.loader.load_active_modules()
        try:
            yield
        finally:
            active_ids = set(container.registry.active_module_ids())
            if active_ids:
                manifests = {
                    mid: pair[1]
                    for mid, pair in container.loader.discover().items()
                    if mid in active_ids
                }
                order = resolve_load_order(manifests, active_ids)
                for mid in reversed(order):
                    await container.registry.unregister_module(mid, force=True)
            await container.db.close()

    app = FastAPI(title="Alfred v2", version="2.0.0", lifespan=lifespan)
    app.state.container = container

    mount_module_ui_routes(app, container.registry)
    app.include_router(create_core_router(container))
    mount_module_dispatcher(app, container.registry, container.auth)
    return app
