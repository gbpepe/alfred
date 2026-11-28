"""Dropbox API v2 provider (PKCE S256, confined paths, upload_session 8 MiB chunks)."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Final
from urllib.parse import urlencode

import httpx

from ..models import (
    DEFAULT_CLOUD_CHUNK_BYTES,
    CloudAccessMode,
    CloudDownloadResult,
    CloudItem,
    CloudItemKindFilter,
    CloudProviderId,
    CloudQuotaInfo,
    CloudReauthRequiredError,
    CloudRefreshResult,
    CloudShareResult,
    CloudShareRole,
    CloudStorageError,
    CloudTokenBundle,
    CloudUploadConflictMode,
    compute_quota_pct,
    is_invalid_grant_error,
)
from .base import (
    CloudCallContext,
    escape_http_header_json,
    execute_with_retry,
    iter_file_chunks,
    post_oauth_form,
    stream_download_to_path,
)

DROPBOX_AUTH_URL: Final[str] = "https://www.dropbox.com/oauth2/authorize"
DROPBOX_TOKEN_URL: Final[str] = "https://api.dropboxapi.com/oauth2/token"  # noqa: S105
DROPBOX_RPC_API: Final[str] = "https://api.dropboxapi.com/2"
DROPBOX_CONTENT_API: Final[str] = "https://content.dropboxapi.com/2"


def _validate_dropbox_raw(raw: str, label: str) -> str:
    if "\x00" in raw or "\\" in raw:
        raise CloudStorageError(
            f"Invalid Dropbox {label} {raw!r}: NUL bytes and backslashes are forbidden",
            code="CLOUD_PATH_TRAVERSAL",
            status_code=400,
            provider="dropbox",
        )
    return raw.strip()


def normalize_dropbox_confined_path(
    root_ref: str | None,
    requested: str | None = None,
) -> str:
    """Normalize a Dropbox path inside optional `root_ref`, blocking `..`, `\\`, and NUL."""
    clean_root = _validate_dropbox_raw(root_ref or "", "root_ref").rstrip("/")
    normalized_root = ""
    if clean_root and clean_root != "/":
        root_segments = [seg for seg in clean_root.split("/") if seg]
        if any(seg in ("..", ".") for seg in root_segments):
            raise CloudStorageError(
                f"Invalid Dropbox root_ref {root_ref!r}: traversal segment forbidden",
                code="CLOUD_PATH_TRAVERSAL",
                status_code=400,
                provider="dropbox",
            )
        normalized_root = "/" + "/".join(root_segments) if root_segments else ""

    raw_req = _validate_dropbox_raw(requested or "", "path")
    if not raw_req or raw_req in ("/", "."):
        return normalized_root
    if raw_req.startswith("id:"):
        if ".." in raw_req:
            raise CloudStorageError(
                f"Invalid Dropbox item id {requested!r}",
                code="CLOUD_PATH_TRAVERSAL",
                status_code=400,
                provider="dropbox",
            )
        return raw_req

    segments = [seg for seg in raw_req.split("/") if seg]
    for seg in segments:
        if seg in ("..", "."):
            raise CloudStorageError(
                f"Invalid Dropbox path {requested!r}: '{seg}' segment is forbidden",
                code="CLOUD_PATH_TRAVERSAL",
                status_code=400,
                provider="dropbox",
            )

    if not segments:
        return normalized_root

    joined_req = "/" + "/".join(segments)
    if not normalized_root:
        return joined_req

    root_lower = normalized_root.lower()
    req_lower = joined_req.lower()
    if req_lower == root_lower or req_lower.startswith(f"{root_lower}/"):
        return joined_req
    return f"{normalized_root}{joined_req}"


def _map_dropbox_entry(raw: dict[str, Any]) -> CloudItem:
    is_folder = raw.get(".tag") == "folder"
    raw_size = raw.get("size")
    size_bytes = None if is_folder else (int(raw_size) if isinstance(raw_size, int) else None)
    item_id = raw.get("id") or raw.get("path_display") or raw.get("path_lower") or ""
    path_disp = raw.get("path_display") or raw.get("path_lower")
    return CloudItem(
        id=str(item_id),
        name=str(raw.get("name") or ""),
        kind="folder" if is_folder else "file",
        size_bytes=size_bytes,
        modified_at=str(raw["server_modified"]) if raw.get("server_modified") else None,
        path_display=str(path_disp) if path_disp else None,
        checksum=str(raw["content_hash"]) if raw.get("content_hash") else None,
    )


async def _dropbox_rpc(
    ctx: CloudCallContext,
    endpoint: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    try:
        resp = await ctx.http_client.post(
            f"{DROPBOX_RPC_API}{endpoint}",
            headers={
                "Authorization": f"Bearer {ctx.access_token}",
                "Content-Type": "application/json",
            },
            content=json.dumps(payload),
        )
    except httpx.HTTPError as exc:
        raise CloudStorageError(
            f"Dropbox RPC network error: {exc}",
            code="CLOUD_API_ERROR",
            status_code=502,
            provider="dropbox",
            account=ctx.account,
        ) from exc

    text = resp.text
    if resp.status_code >= 400:
        if is_invalid_grant_error(resp.status_code, text):
            raise CloudReauthRequiredError("dropbox", ctx.account, f"HTTP {resp.status_code}")
        if resp.status_code == 409 and "not_found" in text.lower():
            raise CloudStorageError(
                f"Dropbox item not found: {text[:180]}",
                code="CLOUD_NOT_FOUND",
                status_code=404,
                provider="dropbox",
                account=ctx.account,
            )
        raise CloudStorageError(
            f"Dropbox API error (HTTP {resp.status_code}): {text[:240]}",
            code="CLOUD_API_ERROR",
            status_code=resp.status_code,
            provider="dropbox",
            account=ctx.account,
        )

    if not text.strip():
        return {}
    parsed = resp.json()
    return dict(parsed) if isinstance(parsed, dict) else {}


class DropboxProvider:
    """SDK-free Dropbox API v2 client using `httpx.AsyncClient`."""

    provider_id: CloudProviderId = "dropbox"
    display_name: str = "Dropbox"
    recommended_chunk_bytes: int = DEFAULT_CLOUD_CHUNK_BYTES
    api_base_url: str = DROPBOX_RPC_API

    def build_authorization_url(
        self,
        *,
        client_id: str,
        redirect_uri: str,
        state: str,
        code_challenge: str,
        access_mode: CloudAccessMode = "read_write",
    ) -> str:
        scope = (
            "files.metadata.read files.content.read account_info.read"
            if access_mode == "read_only"
            else "files.metadata.read files.content.write files.content.read "
            "sharing.write account_info.read"
        )
        qs = urlencode(
            {
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "token_access_type": "offline",
                "force_reapprove": "true",
                "scope": scope,
                "code_challenge": code_challenge,
                "code_challenge_method": "S256",
                "state": state,
            }
        )
        return f"{DROPBOX_AUTH_URL}?{qs}"

    async def exchange_code_for_tokens(
        self,
        http_client: httpx.AsyncClient,
        *,
        client_id: str,
        client_secret: str,
        code: str,
        redirect_uri: str,
        code_verifier: str,
    ) -> CloudTokenBundle:
        data = await post_oauth_form(
            http_client,
            token_url=DROPBOX_TOKEN_URL,
            form_data={
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": code_verifier,
                "grant_type": "authorization_code",
            },
            provider="dropbox",
        )
        access_token = data.get("access_token")
        refresh_token = data.get("refresh_token")
        if not isinstance(access_token, str) or not isinstance(refresh_token, str):
            raise CloudStorageError(
                "Dropbox OAuth2 response missing access_token or refresh_token "
                "(token_access_type='offline' required)",
                code="CLOUD_API_ERROR",
                status_code=502,
                provider="dropbox",
            )
        return CloudTokenBundle(
            access_token=access_token,
            refresh_token=refresh_token,
            expires_in_sec=int(data.get("expires_in") or 14_400),
        )

    async def refresh_access_token(
        self,
        http_client: httpx.AsyncClient,
        *,
        client_id: str,
        client_secret: str,
        refresh_token: str,
        account: str,
    ) -> CloudRefreshResult:
        data = await post_oauth_form(
            http_client,
            token_url=DROPBOX_TOKEN_URL,
            form_data={
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
            provider="dropbox",
            account=account,
            is_refresh=True,
        )
        access_token = data.get("access_token")
        if not isinstance(access_token, str) or not access_token:
            raise CloudStorageError(
                "Missing access_token in Dropbox refresh response",
                code="CLOUD_API_ERROR",
                status_code=502,
                provider="dropbox",
                account=account,
            )
        return CloudRefreshResult(
            access_token=access_token,
            expires_in_sec=int(data.get("expires_in") or 14_400),
        )

    async def get_account_quota(self, ctx: CloudCallContext) -> CloudQuotaInfo:
        acct = await _dropbox_rpc(ctx, "/users/get_current_account", None)
        space = await _dropbox_rpc(ctx, "/users/get_space_usage", None)
        raw_name = acct.get("name")
        name_obj: dict[str, Any] = raw_name if isinstance(raw_name, dict) else {}
        raw_alloc = space.get("allocation")
        alloc: dict[str, Any] = raw_alloc if isinstance(raw_alloc, dict) else {}
        used_raw = space.get("used")
        total_raw = alloc.get("allocated")
        used_bytes = int(used_raw) if isinstance(used_raw, int) else None
        total_bytes = int(total_raw) if isinstance(total_raw, int) else None
        disp_name = name_obj.get("display_name")
        return CloudQuotaInfo(
            account_email=str(acct["email"]) if acct.get("email") else None,
            display_name=str(disp_name) if disp_name else None,
            used_bytes=used_bytes,
            total_bytes=total_bytes,
            used_pct=compute_quota_pct(used_bytes, total_bytes),
        )

    async def list_items(
        self,
        ctx: CloudCallContext,
        *,
        folder_ref: str | None = None,
        query: str | None = None,
        kind: CloudItemKindFilter = "all",
        limit: int = 50,
    ) -> list[CloudItem]:
        path = normalize_dropbox_confined_path(ctx.root_ref, folder_ref)
        clamped = max(1, min(200, int(limit)))
        items: list[CloudItem] = []

        if query and query.strip():
            options: dict[str, Any] = {"max_results": clamped}
            if path:
                options["path"] = path
            data = await _dropbox_rpc(
                ctx,
                "/files/search_v2",
                {"query": query.strip(), "options": options},
            )
            matches = data.get("matches")
            if isinstance(matches, list):
                for m in matches:
                    if not isinstance(m, dict):
                        continue
                    outer_meta = m.get("metadata")
                    if isinstance(outer_meta, dict):
                        inner_meta = outer_meta.get("metadata")
                        if isinstance(inner_meta, dict):
                            items.append(_map_dropbox_entry(inner_meta))
        else:
            data = await _dropbox_rpc(
                ctx,
                "/files/list_folder",
                {"path": path, "limit": clamped},
            )
            entries = data.get("entries")
            if isinstance(entries, list):
                items = [_map_dropbox_entry(e) for e in entries if isinstance(e, dict)]

        if kind == "folder":
            items = [i for i in items if i.kind == "folder"]
        elif kind == "file":
            items = [i for i in items if i.kind == "file"]
        return items[:clamped]

    async def mkdir(
        self,
        ctx: CloudCallContext,
        *,
        name: str,
        parent_ref: str | None = None,
    ) -> CloudItem:
        clean_name = name.strip().strip("/")
        if not clean_name:
            raise CloudStorageError(
                "Folder name must not be empty",
                code="CLOUD_API_ERROR",
                status_code=400,
                provider="dropbox",
                account=ctx.account,
            )
        parent_path = normalize_dropbox_confined_path(ctx.root_ref, parent_ref)
        joined = f"{parent_path}/{clean_name}" if parent_path else f"/{clean_name}"
        target_path = normalize_dropbox_confined_path(ctx.root_ref, joined)

        resp = await ctx.http_client.post(
            f"{DROPBOX_RPC_API}/files/create_folder_v2",
            headers={"Authorization": f"Bearer {ctx.access_token}"},
            json={"path": target_path, "autorename": False},
        )
        text = resp.text
        if resp.status_code == 409 and "conflict/folder" in text.lower():
            existing = await _dropbox_rpc(ctx, "/files/get_metadata", {"path": target_path})
            return _map_dropbox_entry(existing)
        if resp.status_code >= 400:
            if is_invalid_grant_error(resp.status_code, text):
                raise CloudReauthRequiredError("dropbox", ctx.account, f"HTTP {resp.status_code}")
            raise CloudStorageError(
                f"Dropbox mkdir failed (HTTP {resp.status_code}): {text[:220]}",
                code="CLOUD_API_ERROR",
                status_code=resp.status_code,
                provider="dropbox",
                account=ctx.account,
            )
        parsed = resp.json()
        metadata = parsed.get("metadata") if isinstance(parsed, dict) else None
        if isinstance(metadata, dict):
            return _map_dropbox_entry(metadata)
        return _map_dropbox_entry(
            {".tag": "folder", "name": clean_name, "path_display": target_path}
        )

    async def upload_file(
        self,
        ctx: CloudCallContext,
        *,
        local_path: Path,
        remote_name: str,
        file_size_bytes: int,
        mime_type: str,
        parent_ref: str | None = None,
        on_conflict: CloudUploadConflictMode = "update_in_place",
        chunk_bytes: int | None = None,
    ) -> CloudItem:
        del mime_type
        parent_path = normalize_dropbox_confined_path(ctx.root_ref, parent_ref)
        raw_target = f"{parent_path}/{remote_name}" if parent_path else f"/{remote_name}"
        target_path = normalize_dropbox_confined_path(ctx.root_ref, raw_target)

        commit_mode = "overwrite" if on_conflict == "update_in_place" else "add"
        autorename = on_conflict == "autorename"

        start_resp = await execute_with_retry(
            lambda: ctx.http_client.post(
                f"{DROPBOX_CONTENT_API}/files/upload_session/start",
                headers={
                    "Authorization": f"Bearer {ctx.access_token}",
                    "Content-Type": "application/octet-stream",
                    "Dropbox-API-Arg": escape_http_header_json({"close": False}),
                },
                content=b"",
            ),
            retry_delays_sec=ctx.retry_delays_sec,
        )
        if start_resp.status_code >= 400:
            text = start_resp.text
            if is_invalid_grant_error(start_resp.status_code, text):
                raise CloudReauthRequiredError(
                    "dropbox",
                    ctx.account,
                    f"HTTP {start_resp.status_code}",
                )
            raise CloudStorageError(
                f"Dropbox upload_session/start failed (HTTP {start_resp.status_code}): "
                f"{text[:220]}",
                code="CLOUD_API_ERROR",
                status_code=start_resp.status_code,
                provider="dropbox",
                account=ctx.account,
            )

        start_json = start_resp.json()
        session_id = start_json.get("session_id") if isinstance(start_json, dict) else None
        if not isinstance(session_id, str) or not session_id:
            raise CloudStorageError(
                "Missing session_id in Dropbox upload_session/start response",
                code="CLOUD_API_ERROR",
                status_code=502,
                provider="dropbox",
                account=ctx.account,
            )

        effective_chunk = chunk_bytes if chunk_bytes is not None else DEFAULT_CLOUD_CHUNK_BYTES
        uploaded_offset = 0
        async for chunk_data, start, end, _is_final in iter_file_chunks(
            local_path,
            file_size_bytes,
            effective_chunk,
        ):

            async def _send_append(
                data: bytes = chunk_data,
                s: int = start,
            ) -> httpx.Response:
                return await ctx.http_client.post(
                    f"{DROPBOX_CONTENT_API}/files/upload_session/append_v2",
                    headers={
                        "Authorization": f"Bearer {ctx.access_token}",
                        "Content-Type": "application/octet-stream",
                        "Dropbox-API-Arg": escape_http_header_json(
                            {"cursor": {"session_id": session_id, "offset": s}, "close": False}
                        ),
                    },
                    content=data,
                )

            append_resp = await execute_with_retry(
                _send_append,
                retry_delays_sec=ctx.retry_delays_sec,
            )
            if append_resp.status_code >= 400:
                raise CloudStorageError(
                    f"Dropbox upload_session/append_v2 failed (HTTP {append_resp.status_code}): "
                    f"{append_resp.text[:220]}",
                    code="CLOUD_API_ERROR",
                    status_code=append_resp.status_code,
                    provider="dropbox",
                    account=ctx.account,
                )
            uploaded_offset = end + 1

        finish_arg = escape_http_header_json(
            {
                "cursor": {"session_id": session_id, "offset": uploaded_offset},
                "commit": {
                    "path": target_path,
                    "mode": commit_mode,
                    "autorename": autorename,
                    "mute": True,
                },
            }
        )
        finish_resp = await execute_with_retry(
            lambda: ctx.http_client.post(
                f"{DROPBOX_CONTENT_API}/files/upload_session/finish",
                headers={
                    "Authorization": f"Bearer {ctx.access_token}",
                    "Content-Type": "application/octet-stream",
                    "Dropbox-API-Arg": finish_arg,
                },
                content=b"",
            ),
            retry_delays_sec=ctx.retry_delays_sec,
        )
        finish_text = finish_resp.text
        if finish_resp.status_code == 409 and "conflict" in finish_text.lower():
            raise CloudStorageError(
                f"File '{remote_name}' already exists in Dropbox (on_conflict='fail')",
                code="CLOUD_CONFLICT_EXISTS",
                status_code=409,
                provider="dropbox",
                account=ctx.account,
            )
        if finish_resp.status_code >= 400:
            raise CloudStorageError(
                f"Dropbox upload_session/finish failed (HTTP {finish_resp.status_code}): "
                f"{finish_text[:220]}",
                code="CLOUD_API_ERROR",
                status_code=finish_resp.status_code,
                provider="dropbox",
                account=ctx.account,
            )

        mapped = _map_dropbox_entry(dict(json.loads(finish_text)))
        if mapped.size_bytes is not None and mapped.size_bytes != file_size_bytes:
            raise CloudStorageError(
                f"Upload size mismatch on Dropbox: local={file_size_bytes} B, "
                f"remote={mapped.size_bytes} B",
                code="CLOUD_INTEGRITY_MISMATCH",
                status_code=502,
                provider="dropbox",
                account=ctx.account,
            )
        return mapped

    async def download_file(
        self,
        ctx: CloudCallContext,
        *,
        file_ref: str,
        dest_path: Path,
        max_download_bytes: int,
        export_format: str | None = None,
    ) -> CloudDownloadResult:
        del export_format
        target_ref = normalize_dropbox_confined_path(ctx.root_ref, file_ref)
        bytes_written, resp_headers = await stream_download_to_path(
            ctx,
            method="POST",
            url=f"{DROPBOX_CONTENT_API}/files/download",
            headers={
                "Authorization": f"Bearer {ctx.access_token}",
                "Dropbox-API-Arg": escape_http_header_json({"path": target_ref}),
            },
            dest_path=dest_path,
            max_download_bytes=max_download_bytes,
            expected_size_bytes=None,
            provider="dropbox",
        )
        raw_header = resp_headers.get("dropbox-api-result")
        raw_meta: dict[str, Any] = {".tag": "file", "path_display": target_ref}
        if raw_header:
            parsed = json.loads(raw_header)
            if isinstance(parsed, dict):
                raw_meta = parsed
        item = _map_dropbox_entry(raw_meta)
        if item.size_bytes is not None and bytes_written != item.size_bytes:
            raise CloudStorageError(
                f"Dropbox download size mismatch: expected {item.size_bytes} B, "
                f"wrote {bytes_written} B",
                code="CLOUD_INTEGRITY_MISMATCH",
                status_code=502,
                provider="dropbox",
                account=ctx.account,
            )
        return CloudDownloadResult(
            item=item,
            bytes_written=bytes_written,
            saved_path=str(dest_path),
        )

    async def share_item(
        self,
        ctx: CloudCallContext,
        *,
        file_ref: str,
        email: str | None,
        role: CloudShareRole,
        public_link: bool,
        notify: bool,
        expires_in_days: int | None = None,
    ) -> CloudShareResult:
        target_ref = normalize_dropbox_confined_path(ctx.root_ref, file_ref)
        if public_link:
            settings: dict[str, Any] = {"requested_visibility": "public"}
            expires_iso: str | None = None
            if expires_in_days is not None and expires_in_days > 0:
                expires_iso = (
                    (datetime.now(tz=UTC) + timedelta(days=expires_in_days))
                    .strftime("%Y-%m-%dT%H:%M:%SZ")
                )
                settings["expires"] = expires_iso
            resp = await ctx.http_client.post(
                f"{DROPBOX_RPC_API}/sharing/create_shared_link_with_settings",
                headers={"Authorization": f"Bearer {ctx.access_token}"},
                json={"path": target_ref, "settings": settings},
            )
            text = resp.text
            if resp.status_code == 409 and "shared_link_already_exists" in text.lower():
                list_data = await _dropbox_rpc(
                    ctx,
                    "/sharing/list_shared_links",
                    {"path": target_ref, "direct_only": True},
                )
                links = list_data.get("links")
                existing_url = (
                    str(links[0].get("url") or "")
                    if isinstance(links, list) and links and isinstance(links[0], dict)
                    else ""
                )
                return CloudShareResult(
                    provider="dropbox",
                    account=ctx.account,
                    item_id=target_ref,
                    web_url=existing_url,
                    mode="public_link",
                    shared_with="anyone",
                    role=role,
                    notified=False,
                    expires_at=expires_iso,
                )
            if resp.status_code >= 400:
                if is_invalid_grant_error(resp.status_code, text):
                    raise CloudReauthRequiredError(
                        "dropbox",
                        ctx.account,
                        f"HTTP {resp.status_code}",
                    )
                raise CloudStorageError(
                    f"Dropbox blocked public link creation (HTTP {resp.status_code}): {text[:220]}",
                    code="CLOUD_PUBLIC_LINK_BLOCKED_BY_PROVIDER",
                    status_code=resp.status_code,
                    provider="dropbox",
                    account=ctx.account,
                )
            created = resp.json()
            web_url = str(created.get("url") or "") if isinstance(created, dict) else ""
            return CloudShareResult(
                provider="dropbox",
                account=ctx.account,
                item_id=target_ref,
                web_url=web_url,
                mode="public_link",
                shared_with="anyone",
                role=role,
                notified=False,
                expires_at=expires_iso,
            )

        add_resp = await ctx.http_client.post(
            f"{DROPBOX_RPC_API}/sharing/add_file_member",
            headers={"Authorization": f"Bearer {ctx.access_token}"},
            json={
                "file": target_ref,
                "members": [{".tag": "email", "email": email}],
                "access_level": "editor" if role == "writer" else "viewer",
                "quiet": not notify,
            },
        )
        if add_resp.status_code >= 400:
            text = add_resp.text
            if is_invalid_grant_error(add_resp.status_code, text):
                raise CloudReauthRequiredError(
                    "dropbox",
                    ctx.account,
                    f"HTTP {add_resp.status_code}",
                )
            raise CloudStorageError(
                f"Dropbox email share failed (HTTP {add_resp.status_code}): {text[:220]}",
                code="CLOUD_SHARE_PROVIDER_ERROR",
                status_code=add_resp.status_code,
                provider="dropbox",
                account=ctx.account,
            )

        web_url = ""
        try:
            meta = await _dropbox_rpc(ctx, "/sharing/get_file_metadata", {"file": target_ref})
            web_url = str(meta.get("preview_url") or "")
        except CloudStorageError:
            web_url = ""

        return CloudShareResult(
            provider="dropbox",
            account=ctx.account,
            item_id=target_ref,
            web_url=web_url,
            mode="email",
            shared_with=str(email or ""),
            role=role,
            notified=notify,
        )
