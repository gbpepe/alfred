"""FastAPI HTTP bridge: central Auth/CSRF gate, streaming ASGI fallback, and UI host."""

from __future__ import annotations

import hashlib
import weakref
from pathlib import Path
from typing import Final

from fastapi import FastAPI, Request
from pydantic import BaseModel
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp, Receive, Scope, Send

from alfred.core.auth import AuthError, AuthService
from alfred.kernel.errors import ModuleError
from alfred.kernel.registry import ModuleRegistry

_PREV_ROUTER_DEFAULTS: dict[int, ASGIApp] = {}

_ALLOWED_UI_EXTENSIONS: Final[dict[str, str]] = {
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
}


def mount_module_ui_routes(app: FastAPI, registry: ModuleRegistry) -> None:
    """Serve static ES module assets strictly for active modules (`0` bytes when inactive)."""

    @app.api_route(
        "/api/modules/{module_id}/ui/{file_path:path}",
        methods=["GET", "HEAD"],
    )
    async def serve_module_ui_asset(
        module_id: str,
        file_path: str,
        request: Request,
    ) -> Response:
        if not registry.is_active(module_id):
            return JSONResponse(
                status_code=404,
                content={
                    "error": "MODULE_DISABLED",
                    "message": f"Module '{module_id}' is not active",
                },
            )
        module_dir = registry.get_module_dir(module_id)
        if module_dir is None:
            return JSONResponse(
                status_code=404,
                content={
                    "error": "MODULE_DISABLED",
                    "message": f"Module '{module_id}' is not active",
                },
            )

        if (
            not file_path
            or "\x00" in file_path
            or "\\" in file_path
            or ".." in Path(file_path).parts
        ):
            return JSONResponse(
                status_code=403,
                content={"error": "MODULE_SECURITY_ERROR", "message": "Invalid UI asset path"},
            )

        parts = [part for part in file_path.split("/") if part]
        if not parts or any(part.startswith(".") or part == ".." for part in parts):
            return JSONResponse(
                status_code=403,
                content={"error": "MODULE_SECURITY_ERROR", "message": "Forbidden UI asset path"},
            )

        resolved_module_dir = module_dir.resolve()
        ui_root = (resolved_module_dir / "ui").resolve()
        if not ui_root.is_relative_to(resolved_module_dir):
            return JSONResponse(
                status_code=403,
                content={
                    "error": "MODULE_SECURITY_ERROR",
                    "message": "UI directory symlink escapes module directory",
                },
            )

        candidate = (ui_root / Path(*parts)).resolve()
        if not candidate.is_relative_to(ui_root):
            return JSONResponse(
                status_code=403,
                content={"error": "MODULE_SECURITY_ERROR", "message": "UI asset path traversal"},
            )

        media_type = _ALLOWED_UI_EXTENSIONS.get(candidate.suffix.lower())
        if media_type is None:
            return JSONResponse(
                status_code=403,
                content={"error": "MODULE_SECURITY_ERROR", "message": "Disallowed UI file type"},
            )
        if not candidate.is_file():
            return JSONResponse(
                status_code=404,
                content={"error": "NOT_FOUND", "message": "UI asset not found"},
            )

        try:
            data = candidate.read_bytes()
        except OSError:
            return JSONResponse(
                status_code=404,
                content={"error": "NOT_FOUND", "message": "UI asset unreadable"},
            )

        digest = hashlib.sha256(data).hexdigest()[:24]
        etag = f'"{digest}"'
        if request.headers.get("if-none-match") == etag:
            return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "no-cache"})

        headers = {
            "ETag": etag,
            "Cache-Control": "no-cache",
            "Content-Length": str(len(data)),
        }
        body = b"" if request.method.upper() == "HEAD" else data
        return Response(
            content=body,
            status_code=200,
            media_type=media_type,
            headers=headers,
        )


def mount_module_dispatcher(
    app: FastAPI,
    registry: ModuleRegistry,
    auth_service: AuthService,
) -> None:
    """Attach ASGI fallback dispatcher preserving FastAPI `405` and streaming request bodies."""
    router_key = id(app.router)
    if router_key not in _PREV_ROUTER_DEFAULTS:
        _PREV_ROUTER_DEFAULTS[router_key] = app.router.default
        weakref.finalize(app.router, _PREV_ROUTER_DEFAULTS.pop, router_key, None)
    prev_default: ASGIApp = _PREV_ROUTER_DEFAULTS[router_key]

    async def _module_asgi_fallback(scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await prev_default(scope, receive, send)
            return

        request = Request(scope, receive, send)
        lookup = registry.resolve_route(request.method, request.url.path)
        if lookup is None:
            await prev_default(scope, receive, send)
            return

        if lookup.route is None:
            resp = JSONResponse(
                status_code=405,
                content={
                    "error": "METHOD_NOT_ALLOWED",
                    "message": f"Method {request.method} not allowed for {request.url.path}",
                },
                headers={"Allow": ", ".join(lookup.allowed_methods)},
            )
            await resp(scope, receive, send)
            return

        route = lookup.route
        try:
            principal = auth_service.verify_request(request, route.auth)
        except AuthError as auth_err:
            resp = JSONResponse(
                status_code=auth_err.status_code,
                content={"error": auth_err.code, "message": auth_err.message},
            )
            await resp(scope, receive, send)
            return

        scope["path_params"] = dict(lookup.path_params)
        request.state.path_params = lookup.path_params
        request.state.auth_principal = principal

        try:
            result = await route.handler(request)
        except ModuleError as mod_err:
            err_resp = JSONResponse(status_code=mod_err.status_code, content=mod_err.to_payload())
            await err_resp(scope, receive, send)
            return

        if isinstance(result, BaseModel):
            dto_resp = JSONResponse(
                status_code=200,
                content=result.model_dump(mode="json", by_alias=True),
            )
            await dto_resp(scope, receive, send)
            return
        await result(scope, receive, send)

    app.router.default = _module_asgi_fallback


def attach_module_bridge(
    app: FastAPI,
    registry: ModuleRegistry,
    auth_service: AuthService,
) -> None:
    """Attach both `/api/modules/{id}/ui/*` and the dynamic Auth-gated module route bridge."""
    mount_module_ui_routes(app, registry)
    mount_module_dispatcher(app, registry, auth_service)
