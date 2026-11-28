"""Dynamic module registry, dependency-checked Service Bus, and clean unload."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from alfred.kernel.errors import MissingDependencyError, ModuleError, ModuleLoadError
from alfred.kernel.types import (
    AlfredModulePlugin,
    ModuleContext,
    ModuleManifest,
    ModuleModelProvider,
    ModuleRouteDefinition,
    ModuleToolDefinition,
    ModuleUiContribution,
    ServiceBus,
)

_PARAM_PATTERN = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)(?::(path))?\}")


@dataclass(frozen=True, slots=True)
class CompiledModuleRoute:
    """Internal compiled route entry for path & method matching."""

    definition: ModuleRouteDefinition
    regex: re.Pattern[str]
    methods: frozenset[str]


@dataclass(frozen=True, slots=True)
class RouteLookupResult:
    """Outcome of resolving a dynamically mounted module route."""

    route: ModuleRouteDefinition | None
    path_params: dict[str, str]
    allowed_methods: tuple[str, ...]


def _compile_route_pattern(path_pattern: str) -> re.Pattern[str]:
    if not path_pattern.startswith("/"):
        raise ModuleLoadError(f"Module route path must start with '/': {path_pattern!r}")
    parts: list[str] = ["^"]
    pos = 0
    for match in _PARAM_PATTERN.finditer(path_pattern):
        parts.append(re.escape(path_pattern[pos : match.start()]))
        param_name = match.group(1)
        param_kind = match.group(2)
        if param_kind == "path":
            parts.append(f"(?P<{param_name}>.+)")
        else:
            parts.append(f"(?P<{param_name}>[^/]+)")
        pos = match.end()
    parts.append(re.escape(path_pattern[pos:]))
    parts.append("$")
    return re.compile("".join(parts))


class ScopedServiceBus(ServiceBus):
    """Per-module view over the Service Bus enforcing declared `depends` contracts."""

    def __init__(
        self,
        *,
        caller_id: str,
        declared_depends: frozenset[str],
        registry: ModuleRegistry,
    ) -> None:
        self.caller_id = caller_id
        self.declared_depends = declared_depends
        self._registry = registry

    def require_service(self, module_id: str) -> Any:
        """Return typed service for `module_id` or raise 409 `MissingDependencyError`."""
        if module_id != self.caller_id and module_id not in self.declared_depends:
            raise MissingDependencyError(
                module_id,
                module_id=self.caller_id,
                message=(
                    f"Module '{self.caller_id}' cannot access service '{module_id}' "
                    "without declaring it in manifest `depends`"
                ),
            )
        if not self._registry.is_active(module_id):
            raise MissingDependencyError(module_id, module_id=self.caller_id)
        service = self._registry.get_service(module_id)
        if service is None:
            raise MissingDependencyError(
                module_id,
                module_id=self.caller_id,
                message=f"Active dependency '{module_id}' did not export a service instance",
            )
        return service

    def get_service(self, module_id: str) -> Any | None:
        """Return service if declared & active with exported service, else `None`."""
        if module_id != self.caller_id and module_id not in self.declared_depends:
            return None
        if not self._registry.is_active(module_id):
            return None
        return self._registry.get_service(module_id)


class ModuleRegistry:
    """Central runtime registry holding active plugins, tools, routes, providers, services & UI."""

    def __init__(self) -> None:
        self._plugins: dict[str, AlfredModulePlugin] = {}
        self._manifests: dict[str, ModuleManifest] = {}
        self._module_dirs: dict[str, Path] = {}
        self._contexts: dict[str, ModuleContext] = {}
        self._tools: dict[str, ModuleToolDefinition[Any]] = {}
        self._routes: list[CompiledModuleRoute] = []
        self._providers: dict[str, tuple[str, ModuleModelProvider]] = {}
        self._services: dict[str, Any] = {}
        self._ui_contributions: dict[str, ModuleUiContribution] = {}
        self._cli_sanitize_keys: dict[str, tuple[str, ...]] = {}

    def is_active(self, module_id: str) -> bool:
        """Check whether `module_id` is currently loaded and active."""
        return module_id in self._plugins

    def active_module_ids(self) -> list[str]:
        """Return active module ids in insertion/load order."""
        return list(self._plugins.keys())

    def get_manifest(self, module_id: str) -> ModuleManifest | None:
        """Return manifest of an active module, or `None` if inactive."""
        return self._manifests.get(module_id)

    def get_module_dir(self, module_id: str) -> Path | None:
        """Return filesystem root of an active module, or `None` if inactive."""
        return self._module_dirs.get(module_id)

    def get_context(self, module_id: str) -> ModuleContext | None:
        """Return runtime context of an active module, or `None` if inactive."""
        return self._contexts.get(module_id)

    def get_plugin(self, module_id: str) -> AlfredModulePlugin | None:
        """Return active plugin instance, or `None`."""
        return self._plugins.get(module_id)

    def get_service(self, module_id: str) -> Any | None:
        """Return exported service object for an active module, or `None`."""
        return self._services.get(module_id)

    def get_tool(self, name: str) -> ModuleToolDefinition[Any] | None:
        """Look up a registered tool by name across active modules."""
        return self._tools.get(name)

    def list_tools(self) -> list[ModuleToolDefinition[Any]]:
        """List all tools registered by currently active modules."""
        return list(self._tools.values())

    def list_providers(self) -> list[ModuleModelProvider]:
        """List all pluggable AI/compute providers registered by active modules."""
        return [provider for _, provider in self._providers.values()]

    def find_provider_for_model(self, model: str) -> ModuleModelProvider | None:
        """Find first active module provider supporting the requested model id."""
        for _, provider in self._providers.values():
            if provider.supports_model(model):
                return provider
        return None

    def list_ui_contributions(
        self,
        slot: str | None = None,
    ) -> list[ModuleUiContribution]:
        """Return UI contributions ordered by `(order, module_id, id)`."""
        items = list(self._ui_contributions.values())
        if slot is not None:
            items = [item for item in items if item.slot == slot]
        items.sort(key=lambda item: (item.order, item.module_id, item.id))
        return items

    def list_cli_env_sanitize_keys(self) -> tuple[str, ...]:
        """Return deduplicated env keys collected from all active modules for CLI sanitization."""
        ordered: list[str] = []
        seen: set[str] = set()
        for keys in self._cli_sanitize_keys.values():
            for key in keys:
                if key and key not in seen:
                    seen.add(key)
                    ordered.append(key)
        return tuple(ordered)

    def resolve_route(self, method: str, path: str) -> RouteLookupResult | None:
        """Match path + method against registered module routes, distinguishing 404 vs 405."""
        upper_method = method.upper()
        matched_route: ModuleRouteDefinition | None = None
        matched_params: dict[str, str] = {}
        allowed_methods: set[str] = set()

        for compiled in self._routes:
            matched = compiled.regex.match(path)
            if matched is None:
                continue
            allowed_methods.update(compiled.methods)
            if matched_route is None and upper_method in compiled.methods:
                matched_route = compiled.definition
                matched_params = matched.groupdict()

        if not allowed_methods:
            return None
        return RouteLookupResult(
            route=matched_route,
            path_params=matched_params,
            allowed_methods=tuple(sorted(allowed_methods)),
        )

    def match_route(
        self,
        method: str,
        path: str,
    ) -> tuple[ModuleRouteDefinition, dict[str, str]] | None:
        """Match HTTP method and path against dynamically registered module routes."""
        result = self.resolve_route(method, path)
        if result is None or result.route is None:
            return None
        return result.route, result.path_params

    def register_module(
        self,
        *,
        plugin: AlfredModulePlugin,
        manifest: ModuleManifest,
        module_dir: Path,
        ctx: ModuleContext,
    ) -> None:
        """Validate and register all tools, routes, providers, UI, and services for a module."""
        module_id = manifest.id
        if module_id in self._plugins:
            raise ModuleLoadError(
                f"Module '{module_id}' is already registered",
                module_id=module_id,
            )

        new_tools: dict[str, ModuleToolDefinition[Any]] = {}
        for tool in plugin.tools():
            if tool.name in self._tools or tool.name in new_tools:
                raise ModuleLoadError(
                    f"Tool name collision for '{tool.name}' in module '{module_id}'",
                    module_id=module_id,
                )
            tool.module_id = module_id
            new_tools[tool.name] = tool

        new_routes: list[CompiledModuleRoute] = []
        for route in plugin.routes():
            norm_methods = frozenset(m.upper() for m in route.methods)
            for existing in self._routes:
                if existing.definition.path == route.path and (existing.methods & norm_methods):
                    raise ModuleLoadError(
                        f"HTTP route collision on {sorted(norm_methods)} {route.path}",
                        module_id=module_id,
                    )
            scoped_route = ModuleRouteDefinition(
                path=route.path,
                methods=tuple(sorted(norm_methods)),
                handler=route.handler,
                auth=route.auth,
                summary=route.summary,
                module_id=module_id,
            )
            new_routes.append(
                CompiledModuleRoute(
                    definition=scoped_route,
                    regex=_compile_route_pattern(route.path),
                    methods=norm_methods,
                )
            )

        new_providers: dict[str, tuple[str, ModuleModelProvider]] = {}
        for provider in plugin.providers():
            if provider.provider_id in self._providers or provider.provider_id in new_providers:
                raise ModuleLoadError(
                    f"Model provider collision for '{provider.provider_id}'",
                    module_id=module_id,
                )
            new_providers[provider.provider_id] = (module_id, provider)

        new_ui: dict[str, ModuleUiContribution] = {}
        for contrib in plugin.ui_contributions():
            key = f"{module_id}:{contrib.id}"
            normalized = contrib.model_copy(update={"module_id": module_id})
            new_ui[key] = normalized

        service = plugin.create_service(ctx)

        self._plugins[module_id] = plugin
        self._manifests[module_id] = manifest
        self._module_dirs[module_id] = module_dir.resolve()
        self._contexts[module_id] = ctx
        self._tools.update(new_tools)
        self._routes.extend(new_routes)
        self._providers.update(new_providers)
        if service is not None:
            self._services[module_id] = service
        self._ui_contributions.update(new_ui)
        self._cli_sanitize_keys[module_id] = tuple(plugin.cli_env_sanitize_keys)

    def active_dependents_of(self, module_id: str) -> list[str]:
        """Return active module ids declaring `module_id` in their `depends` list."""
        return [
            other_id
            for other_id, manifest in self._manifests.items()
            if other_id != module_id and module_id in manifest.depends
        ]

    async def unregister_module(self, module_id: str, *, force: bool = False) -> None:
        """Unload a module cleanly from registry while keeping `sys.modules` class identity."""
        plugin = self._plugins.get(module_id)
        ctx = self._contexts.get(module_id)
        if plugin is None or ctx is None:
            return

        dependents = self.active_dependents_of(module_id)
        if dependents and not force:
            raise ModuleError(
                f"Cannot unload '{module_id}'; active dependents remain: {', '.join(dependents)}",
                code="MODULE_HAS_DEPENDENTS",
                module_id=module_id,
                status_code=409,
            )

        try:
            await plugin.on_unload(ctx)
        finally:
            # Keep loaded module classes in `sys.modules` so re-activation preserves
            # `isinstance()` and avoids duplicate Pydantic models; clear registry state only.
            self._plugins.pop(module_id, None)
            self._manifests.pop(module_id, None)
            self._module_dirs.pop(module_id, None)
            self._contexts.pop(module_id, None)
            self._services.pop(module_id, None)
            self._cli_sanitize_keys.pop(module_id, None)

            self._tools = {
                name: tool for name, tool in self._tools.items() if tool.module_id != module_id
            }
            self._routes = [
                route for route in self._routes if route.definition.module_id != module_id
            ]
            self._providers = {
                pid: pair for pid, pair in self._providers.items() if pair[0] != module_id
            }
            self._ui_contributions = {
                key: item
                for key, item in self._ui_contributions.items()
                if item.module_id != module_id
            }


def module_package_name(module_id: str) -> str:
    """Canonical Python module namespace used in `sys.modules` for loaded modules."""
    return f"_alfred_mod_{module_id.replace('-', '_')}"
