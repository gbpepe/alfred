"""HTTP routes for `cloud-storage` OAuth2 PKCE flow, status, activity, and file ops."""

from __future__ import annotations

import html
import json
from collections.abc import Callable, Sequence
from typing import Any
from urllib.parse import parse_qs, urlparse

from fastapi import Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.responses import HTMLResponse, JSONResponse

from alfred.kernel.errors import ModuleDisabledError
from alfred.kernel.types import ModuleRouteDefinition, RouteReturn

from .engine import CloudStorageEngine
from .models import (
    MODULE_ID,
    CloudAccessMode,
    CloudItemKindFilter,
    CloudProviderId,
    CloudShareRole,
    CloudStorageError,
)


class CloudAdminOAuthCallbackRequest(BaseModel):
    """Validated JSON payload for `POST /api/admin/cloud/oauth/callback`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    callback_url: str | None = Field(default=None, alias="callbackUrl")
    code: str | None = None
    state: str | None = None


class CloudOAuthStartQuery(BaseModel):
    """Validated query parameters for `GET /api/cloud/oauth/start`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    provider: CloudProviderId | None = None
    account: str | None = None
    create_new: bool = Field(default=False, alias="createNew")
    label: str | None = None
    access_mode: CloudAccessMode = Field(default="read_write", alias="accessMode")
    redirect_uri: str | None = Field(default=None, alias="redirectUri")


class CloudListQuery(BaseModel):
    """Validated query parameters for `GET /api/cloud/list`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    provider: CloudProviderId | None = None
    account: str | None = None
    folder_ref: str | None = Field(default=None, alias="folderRef")
    query: str | None = None
    kind: CloudItemKindFilter = "all"
    limit: int = Field(default=50, ge=1, le=200)


class CloudActivityQuery(BaseModel):
    """Validated query parameters for `GET /api/cloud/activity`."""

    model_config = ConfigDict(extra="forbid")

    limit: int = Field(default=50, ge=1, le=200)


class CloudMkdirRequest(BaseModel):
    """Validated JSON payload for `POST /api/cloud/mkdir`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    path_or_name: str = Field(min_length=1, alias="pathOrName")
    parent_ref: str | None = Field(default=None, alias="parentRef")
    provider: CloudProviderId | None = None
    account: str | None = None


class CloudShareRequest(BaseModel):
    """Validated JSON payload for `POST /api/cloud/share`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    file_ref_or_path: str = Field(min_length=1, alias="fileRefOrPath")
    email: str | None = None
    role: CloudShareRole = "reader"
    public_link: bool = Field(default=False, alias="publicLink")
    notify: bool = False
    expires_in_days: int | None = Field(default=None, alias="expiresInDays", ge=1, le=365)
    provider: CloudProviderId | None = None
    account: str | None = None


class CloudConfigRequest(BaseModel):
    """Validated JSON payload for `POST /api/cloud/config`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    default_provider: CloudProviderId | None = Field(default=None, alias="defaultProvider")
    default_share_email: str | None = Field(default=None, alias="defaultShareEmail")
    allow_public_links: bool | None = Field(default=None, alias="allowPublicLinks")
    provider: CloudProviderId | None = None
    account: str | None = None
    default_account: str | None = Field(default=None, alias="defaultAccount")
    client_id: str | None = Field(default=None, alias="clientId")
    client_secret: str | None = Field(default=None, alias="clientSecret")
    root_ref: str | None = Field(default=None, alias="rootRef")
    label: str | None = None
    access_mode: CloudAccessMode | None = Field(default=None, alias="accessMode")
    account_default_share_email: str | None = Field(
        default=None,
        alias="accountDefaultShareEmail",
    )
    account_allow_public_links: bool | None = Field(
        default=None,
        alias="accountAllowPublicLinks",
    )


class CloudDisconnectRequest(BaseModel):
    """Validated JSON payload for `POST /api/cloud/disconnect`."""

    model_config = ConfigDict(extra="forbid")

    provider: CloudProviderId
    account: str | None = None


def format_validation_error(exc: ValidationError) -> str:
    """Format Pydantic `ValidationError` safely without leaking raw input values or URLs."""
    parts: list[str] = []
    for err in exc.errors(include_url=False, include_input=False):
        loc = ".".join(str(part) for part in err.get("loc", ())) or "<root>"
        msg = str(err.get("msg", "Invalid value"))
        parts.append(f"{loc}: {msg}")
    return "; ".join(parts) if parts else "Validation failed"


def _error_json(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": code, "message": message})


def _require_engine(
    request: Request,
    fallback_getter: Callable[[], CloudStorageEngine | None],
) -> CloudStorageEngine:
    container = getattr(request.app.state, "container", None)
    if container is not None:
        registry = getattr(container, "registry", None)
        if registry is not None:
            svc = registry.get_service(MODULE_ID)
            if isinstance(svc, CloudStorageEngine):
                return svc
    fallback = fallback_getter()
    if fallback is not None:
        return fallback
    raise ModuleDisabledError(MODULE_ID)


async def _parse_json_object(
    request: Request,
) -> tuple[dict[str, Any] | None, JSONResponse | None]:
    raw_bytes = await request.body()
    if not raw_bytes.strip():
        return None, _error_json(400, "INVALID_REQUEST", "Request body is required")
    try:
        parsed = json.loads(raw_bytes)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        return None, _error_json(400, "INVALID_JSON", "Malformed JSON request body")
    if not isinstance(parsed, dict):
        return None, _error_json(400, "INVALID_REQUEST", "Request JSON body must be an object")
    return parsed, None


def _wants_json(request: Request) -> bool:
    fmt = (request.query_params.get("format") or "").strip().lower()
    if fmt == "json":
        return True
    accept = (request.headers.get("accept") or "").lower()
    return "application/json" in accept and "text/html" not in accept


def _render_oauth_html(*, ok: bool, title: str, detail: str) -> HTMLResponse:
    status_code = 200 if ok else 400
    safe_title = html.escape(title)
    safe_detail = html.escape(detail)
    color = "#16a34a" if ok else "#dc2626"
    body = (
        "<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'>"
        "<title>Alfred Cloud OAuth2</title></head>"
        "<body style='font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc;"
        "display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0'>"
        "<div style='max-width:480px;padding:24px;border-radius:12px;background:#1e293b;"
        "border:1px solid #334155'>"
        f"<h1 style='margin:0 0 8px;font-size:18px;color:{color}'>{safe_title}</h1>"
        f"<p style='margin:0;font-size:14px;color:#cbd5e1'>{safe_detail}</p>"
        "</div></body></html>"
    )
    return HTMLResponse(content=body, status_code=status_code)


def build_cloud_routes(
    engine_getter: Callable[[], CloudStorageEngine | None],
) -> Sequence[ModuleRouteDefinition]:
    """Build all Auth/CSRF-gated HTTP routes for `cloud-storage`."""

    async def handle_oauth_start(request: Request) -> RouteReturn:
        engine = _require_engine(request, engine_getter)
        qp = dict(request.query_params)
        try:
            query = CloudOAuthStartQuery.model_validate(qp)
        except ValidationError as exc:
            return _error_json(400, "VALIDATION_ERROR", format_validation_error(exc))

        base_url = str(request.base_url).rstrip("/")
        redirect_uri = query.redirect_uri or f"{base_url}/api/cloud/oauth/callback"
        return await engine.start_oauth(
            provider=query.provider,
            redirect_uri=redirect_uri,
            account=query.account,
            create_new=query.create_new,
            label=query.label,
            access_mode=query.access_mode,
        )

    async def handle_oauth_callback(request: Request) -> RouteReturn:
        engine = _require_engine(request, engine_getter)
        qp = request.query_params
        err = (qp.get("error") or "").strip()
        if err:
            desc = (qp.get("error_description") or err).strip()
            if _wants_json(request):
                return _error_json(400, "CLOUD_OAUTH_DENIED", f"OAuth2 denied: {desc[:200]}")
            return _render_oauth_html(
                ok=False,
                title="Cloud OAuth2 Authorization Failed",
                detail=desc[:200],
            )

        code = (qp.get("code") or "").strip()
        state = (qp.get("state") or "").strip()
        if not code or not state:
            if _wants_json(request):
                return _error_json(
                    400,
                    "CLOUD_OAUTH_STATE_INVALID",
                    "Missing required OAuth2 'code' or 'state' parameter",
                )
            return _render_oauth_html(
                ok=False,
                title="Invalid OAuth2 Callback",
                detail="Missing required OAuth2 code or state parameter.",
            )

        try:
            result = await engine.complete_oauth_callback(code=code, state=state)
        except CloudStorageError as exc:
            if _wants_json(request):
                return _error_json(exc.status_code, exc.code, exc.message)
            return _render_oauth_html(
                ok=False,
                title="Cloud OAuth2 Verification Failed",
                detail=exc.message,
            )

        if _wants_json(request):
            return result
        email_note = f" ({result.account_email})" if result.account_email else ""
        return _render_oauth_html(
            ok=True,
            title="Cloud Storage Connected",
            detail=f"Connected {result.provider}::{result.account}{email_note}. "
            "Tokens encrypted in Vault. You may close this window.",
        )

    async def handle_status(request: Request) -> RouteReturn:
        engine = _require_engine(request, engine_getter)
        return await engine.get_status()

    async def handle_activity(request: Request) -> RouteReturn:
        engine = _require_engine(request, engine_getter)
        try:
            query = CloudActivityQuery.model_validate(dict(request.query_params))
        except ValidationError as exc:
            return _error_json(400, "VALIDATION_ERROR", format_validation_error(exc))
        return await engine.list_activity(limit=query.limit)

    async def handle_list(request: Request) -> RouteReturn:
        engine = _require_engine(request, engine_getter)
        try:
            query = CloudListQuery.model_validate(dict(request.query_params))
        except ValidationError as exc:
            return _error_json(400, "VALIDATION_ERROR", format_validation_error(exc))
        return await engine.list_files(
            provider=query.provider,
            account=query.account,
            folder_ref=query.folder_ref,
            query=query.query,
            kind=query.kind,
            limit=query.limit,
        )

    async def handle_mkdir(request: Request) -> RouteReturn:
        engine = _require_engine(request, engine_getter)
        raw, err = await _parse_json_object(request)
        if err is not None:
            return err
        if raw is None:
            return _error_json(400, "INVALID_REQUEST", "Request body is required")
        try:
            payload = CloudMkdirRequest.model_validate(raw)
        except ValidationError as exc:
            return _error_json(400, "VALIDATION_ERROR", format_validation_error(exc))
        return await engine.make_folder(
            path_or_name=payload.path_or_name,
            parent_ref=payload.parent_ref,
            provider=payload.provider,
            account=payload.account,
        )

    async def handle_share(request: Request) -> RouteReturn:
        engine = _require_engine(request, engine_getter)
        raw, err = await _parse_json_object(request)
        if err is not None:
            return err
        if raw is None:
            return _error_json(400, "INVALID_REQUEST", "Request body is required")
        try:
            payload = CloudShareRequest.model_validate(raw)
        except ValidationError as exc:
            return _error_json(400, "VALIDATION_ERROR", format_validation_error(exc))
        return await engine.share_file(
            file_ref_or_path=payload.file_ref_or_path,
            email=payload.email,
            role=payload.role,
            public_link=payload.public_link,
            notify=payload.notify,
            expires_in_days=payload.expires_in_days,
            provider=payload.provider,
            account=payload.account,
        )

    async def handle_config(request: Request) -> RouteReturn:
        engine = _require_engine(request, engine_getter)
        raw, err = await _parse_json_object(request)
        if err is not None:
            return err
        if raw is None:
            return _error_json(400, "INVALID_REQUEST", "Request body is required")
        try:
            payload = CloudConfigRequest.model_validate(raw)
        except ValidationError as exc:
            return _error_json(400, "VALIDATION_ERROR", format_validation_error(exc))
        return await engine.save_config(
            default_provider=payload.default_provider,
            default_share_email=payload.default_share_email,
            allow_public_links=payload.allow_public_links,
            provider=payload.provider,
            account=payload.account,
            default_account=payload.default_account,
            client_id=payload.client_id,
            client_secret=payload.client_secret,
            root_ref=payload.root_ref,
            label=payload.label,
            access_mode=payload.access_mode,
            account_default_share_email=payload.account_default_share_email,
            account_allow_public_links=payload.account_allow_public_links,
        )

    async def handle_disconnect(request: Request) -> RouteReturn:
        engine = _require_engine(request, engine_getter)
        raw, err = await _parse_json_object(request)
        if err is not None:
            return err
        if raw is None:
            return _error_json(400, "INVALID_REQUEST", "Request body is required")
        try:
            payload = CloudDisconnectRequest.model_validate(raw)
        except ValidationError as exc:
            return _error_json(400, "VALIDATION_ERROR", format_validation_error(exc))
        return await engine.disconnect_account(
            provider=payload.provider,
            account=payload.account,
        )

    async def handle_admin_oauth_callback(request: Request) -> RouteReturn:
        engine = _require_engine(request, engine_getter)
        raw, err = await _parse_json_object(request)
        if err is not None:
            return err
        if raw is None:
            return _error_json(400, "INVALID_REQUEST", "Request body is required")
        try:
            payload = CloudAdminOAuthCallbackRequest.model_validate(raw)
        except ValidationError as exc:
            return _error_json(400, "VALIDATION_ERROR", format_validation_error(exc))

        code = (payload.code or "").strip()
        state = (payload.state or "").strip()
        if payload.callback_url and payload.callback_url.strip():
            raw_cb = payload.callback_url.strip()
            cb_url = raw_cb if "://" in raw_cb else f"https://localhost/?{raw_cb.lstrip('?')}"
            parsed_url = urlparse(cb_url)
            qs_map = parse_qs(parsed_url.query)
            cb_err = (qs_map.get("error") or [""])[0].strip()
            if cb_err:
                desc = (qs_map.get("error_description") or [cb_err])[0].strip()
                return _error_json(400, "CLOUD_OAUTH_DENIED", f"OAuth2 denied: {desc[:200]}")
            code = (qs_map.get("code") or [code])[0].strip()
            state = (qs_map.get("state") or [state])[0].strip()

        if not code or not state:
            return _error_json(
                400,
                "CLOUD_OAUTH_STATE_INVALID",
                "Missing required OAuth2 'code' or 'state' parameter",
            )
        return await engine.complete_oauth_callback(code=code, state=state)

    async def handle_oauth_popup_html(_request: Request) -> RouteReturn:
        body = (
            "<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'>"
            "<title>Alfred Cloud OAuth2 Callback</title></head>"
            "<body style='font-family:system-ui,sans-serif;background:#0f172a;color:#f8fafc;"
            "display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0'>"
            "<div style='max-width:520px;padding:24px;border-radius:12px;background:#1e293b;"
            "border:1px solid #334155'>"
            "<h1 style='margin:0 0 8px;font-size:18px;color:#38bdf8'>Alfred OAuth2 Callback</h1>"
            "<p id='msg' style='margin:0;font-size:14px;color:#cbd5e1'>"
            "Completing authorization... If this tab stays open (Zero Trust / SSH tunnel), "
            "copy the full address bar URL and paste it into the "
            "Alfred Dashboard Manual OAuth2 Callback box."
            "</p>"
            "</div>"
            "<script>"
            "(function(){"
            "try{"
            "var p=new URLSearchParams(window.location.search);"
            "var payload={"
            "type:'alfred:cloud-oauth-callback',"
            "code:p.get('code')||'',"
            "state:p.get('state')||'',"
            "error:p.get('error')||'',"
            "errorDescription:p.get('error_description')||''"
            "};"
            "if(window.opener&&typeof window.opener.postMessage==='function'){"
            "window.opener.postMessage(payload,window.location.origin);"
            "document.getElementById('msg').textContent="
            "'Authorization delivered to Alfred Dashboard. You may close this window.';"
            "}"
            "}catch(_e){}"
            "})();"
            "</script></body></html>"
        )
        return HTMLResponse(content=body, status_code=200)

    return (
        ModuleRouteDefinition(
            path="/oauth-cloud-callback.html",
            methods=("GET",),
            handler=handle_oauth_popup_html,
            auth="public_oauth_callback",
            summary="OAuth2 browser popup landing helper delivering code/state via postMessage",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/cloud/oauth/start",
            methods=("GET",),
            handler=handle_oauth_start,
            auth="admin",
            summary="Start PKCE S256 OAuth2 flow for a cloud provider",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/cloud/oauth/callback",
            methods=("GET",),
            handler=handle_oauth_callback,
            auth="public_oauth_callback",
            summary="Verify single-use PKCE state, exchange OAuth2 code, and store tokens in Vault",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/admin/cloud/oauth/callback",
            methods=("POST",),
            handler=handle_admin_oauth_callback,
            auth="admin",
            summary="Admin CSRF-gated manual OAuth2 callback URL or code/state completion",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/cloud/status",
            methods=("GET",),
            handler=handle_status,
            auth="dashboard",
            summary="Get decryption-free multi-cloud provider & account status",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/cloud/activity",
            methods=("GET",),
            handler=handle_activity,
            auth="dashboard",
            summary="List recent cloud storage activity audit rows",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/cloud/list",
            methods=("GET",),
            handler=handle_list,
            auth="dashboard",
            summary="List or search files/folders in a connected cloud account",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/cloud/mkdir",
            methods=("POST",),
            handler=handle_mkdir,
            auth="admin",
            summary="Create folder(s) in a connected cloud account",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/cloud/share",
            methods=("POST",),
            handler=handle_share,
            auth="admin",
            summary="Share a cloud item via email or policy-gated public link",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/cloud/config",
            methods=("POST",),
            handler=handle_config,
            auth="admin",
            summary="Update cloud storage defaults, policy, or Vault client credentials",
            module_id=MODULE_ID,
        ),
        ModuleRouteDefinition(
            path="/api/cloud/disconnect",
            methods=("POST",),
            handler=handle_disconnect,
            auth="admin",
            summary="Disconnect a cloud account and delete its Vault refresh token",
            module_id=MODULE_ID,
        ),
    )
