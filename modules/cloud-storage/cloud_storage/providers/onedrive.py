"""Microsoft OneDrive Graph v1.0 provider (PKCE S256, strictly 8_192_000 B chunks)."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Final
from urllib.parse import quote, urlencode

import httpx

from ..models import (
    ONEDRIVE_CHUNK_ALIGNMENT,
    ONEDRIVE_CHUNK_BYTES,
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
    execute_with_retry,
    iter_file_chunks,
    post_oauth_form,
    stream_download_to_path,
)

MS_AUTH_URL: Final[str] = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
MS_TOKEN_URL: Final[str] = "https://login.microsoftonline.com/common/oauth2/v2.0/token"  # noqa: S105
GRAPH_API: Final[str] = "https://graph.microsoft.com/v1.0"
_SAFE_ITEM_ID_RE: Final[re.Pattern[str]] = re.compile(r"^(?:root|[A-Za-z0-9!._-]{3,160})$")
_GRAPH_SELECT: Final[str] = "id,name,size,file,folder,lastModifiedDateTime,webUrl,parentReference"


def _assert_graph_item_id(raw: str, label: str) -> str:
    clean = raw.strip()
    if not _SAFE_ITEM_ID_RE.match(clean):
        raise CloudStorageError(
            f"Invalid OneDrive {label}: {raw!r}",
            code="CLOUD_API_ERROR",
            status_code=400,
            provider="onedrive",
        )
    return clean


def _item_base_url(item_id: str) -> str:
    if item_id == "root":
        return f"{GRAPH_API}/me/drive/root"
    return f"{GRAPH_API}/me/drive/items/{quote(item_id, safe='')}"


def _map_graph_item(raw: dict[str, Any]) -> CloudItem:
    is_folder = isinstance(raw.get("folder"), dict)
    raw_size = raw.get("size")
    size_bytes = None if is_folder else (int(raw_size) if isinstance(raw_size, int) else None)
    raw_file = raw.get("file")
    file_info: dict[str, Any] = raw_file if isinstance(raw_file, dict) else {}
    raw_hashes = file_info.get("hashes")
    hashes: dict[str, Any] = raw_hashes if isinstance(raw_hashes, dict) else {}
    raw_parent = raw.get("parentReference")
    parent_ref_obj: dict[str, Any] = raw_parent if isinstance(raw_parent, dict) else {}
    mime = file_info.get("mimeType")
    mime_str = str(mime) if isinstance(mime, str) else ("folder" if is_folder else None)
    checksum = hashes.get("sha256Hash") or hashes.get("quickXorHash")
    mod_val = raw.get("lastModifiedDateTime")
    web_val = raw.get("webUrl")
    parent_id = parent_ref_obj.get("id")
    return CloudItem(
        id=str(raw.get("id") or ""),
        name=str(raw.get("name") or ""),
        kind="folder" if is_folder else "file",
        size_bytes=size_bytes,
        mime_type=mime_str,
        modified_at=str(mod_val) if mod_val else None,
        web_url=str(web_val) if web_val else None,
        parent_ref=str(parent_id) if parent_id else None,
        checksum=str(checksum) if checksum else None,
    )


async def _graph_json_request(
    ctx: CloudCallContext,
    method: str,
    url: str,
    *,
    params: dict[str, str] | None = None,
    json_body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    headers: dict[str, str] = {"Authorization": f"Bearer {ctx.access_token}"}
    try:
        resp = await ctx.http_client.request(
            method,
            url,
            params=params,
            json=json_body,
            headers=headers,
        )
    except httpx.HTTPError as exc:
        raise CloudStorageError(
            f"OneDrive Graph network error: {exc}",
            code="CLOUD_API_ERROR",
            status_code=502,
            provider="onedrive",
            account=ctx.account,
        ) from exc

    text = resp.text
    if resp.status_code >= 400:
        if is_invalid_grant_error(resp.status_code, text):
            raise CloudReauthRequiredError("onedrive", ctx.account, f"HTTP {resp.status_code}")
        if resp.status_code == 404:
            raise CloudStorageError(
                "OneDrive item not found (HTTP 404)",
                code="CLOUD_NOT_FOUND",
                status_code=404,
                provider="onedrive",
                account=ctx.account,
            )
        raise CloudStorageError(
            f"OneDrive Graph API error (HTTP {resp.status_code}): {text[:240]}",
            code="CLOUD_API_ERROR",
            status_code=resp.status_code,
            provider="onedrive",
            account=ctx.account,
        )
    if not text.strip():
        return {}
    parsed = resp.json()
    return dict(parsed) if isinstance(parsed, dict) else {}


class OneDriveProvider:
    """SDK-free Microsoft OneDrive Graph v1.0 client using `httpx.AsyncClient`."""

    provider_id: CloudProviderId = "onedrive"
    display_name: str = "Microsoft OneDrive"
    recommended_chunk_bytes: int = ONEDRIVE_CHUNK_BYTES
    api_base_url: str = GRAPH_API

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
            "Files.Read.All User.Read offline_access"
            if access_mode == "read_only"
            else "Files.ReadWrite.All User.Read offline_access"
        )
        qs = urlencode(
            {
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": scope,
                "prompt": "select_account",
                "code_challenge": code_challenge,
                "code_challenge_method": "S256",
                "state": state,
            }
        )
        return f"{MS_AUTH_URL}?{qs}"

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
            token_url=MS_TOKEN_URL,
            form_data={
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": code_verifier,
                "grant_type": "authorization_code",
            },
            provider="onedrive",
        )
        access_token = data.get("access_token")
        refresh_token = data.get("refresh_token")
        if not isinstance(access_token, str) or not isinstance(refresh_token, str):
            raise CloudStorageError(
                "OneDrive OAuth2 response missing access_token or refresh_token "
                "(offline_access scope required)",
                code="CLOUD_API_ERROR",
                status_code=502,
                provider="onedrive",
            )
        return CloudTokenBundle(
            access_token=access_token,
            refresh_token=refresh_token,
            expires_in_sec=int(data.get("expires_in") or 3600),
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
            token_url=MS_TOKEN_URL,
            form_data={
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
            provider="onedrive",
            account=account,
            is_refresh=True,
        )
        access_token = data.get("access_token")
        if not isinstance(access_token, str) or not access_token:
            raise CloudStorageError(
                "Missing access_token in Microsoft refresh response",
                code="CLOUD_API_ERROR",
                status_code=502,
                provider="onedrive",
                account=account,
            )
        rotated = data.get("refresh_token")
        return CloudRefreshResult(
            access_token=access_token,
            rotated_refresh_token=rotated if isinstance(rotated, str) and rotated else None,
            expires_in_sec=int(data.get("expires_in") or 3600),
        )

    async def get_account_quota(self, ctx: CloudCallContext) -> CloudQuotaInfo:
        me = await _graph_json_request(
            ctx,
            "GET",
            f"{GRAPH_API}/me",
            params={"$select": "displayName,mail,userPrincipalName"},
        )
        drive = await _graph_json_request(
            ctx,
            "GET",
            f"{GRAPH_API}/me/drive",
            params={"$select": "id,driveType,quota"},
        )
        raw_quota = drive.get("quota")
        quota: dict[str, Any] = raw_quota if isinstance(raw_quota, dict) else {}
        used_raw = quota.get("used")
        total_raw = quota.get("total")
        used_bytes = int(used_raw) if isinstance(used_raw, int) else None
        total_bytes = int(total_raw) if isinstance(total_raw, int) else None
        email = me.get("mail") or me.get("userPrincipalName")
        return CloudQuotaInfo(
            account_email=str(email) if email else None,
            display_name=str(me["displayName"]) if me.get("displayName") else None,
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
        folder_id = _assert_graph_item_id(folder_ref or ctx.root_ref or "root", "folder_ref")
        clamped = max(1, min(200, int(limit)))
        base = _item_base_url(folder_id)
        if query and query.strip():
            escaped_q = quote(query.strip().replace("'", "''"), safe="")
            url = f"{base}/search(q='{escaped_q}')"
        else:
            url = f"{base}/children"

        data = await _graph_json_request(
            ctx,
            "GET",
            url,
            params={"$top": str(clamped), "$select": _GRAPH_SELECT},
        )
        raw_values = data.get("value")
        if not isinstance(raw_values, list):
            return []
        items = [_map_graph_item(item) for item in raw_values if isinstance(item, dict)]
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
        parent_id = _assert_graph_item_id(parent_ref or ctx.root_ref or "root", "parent_ref")
        clean_name = name.strip()
        if not clean_name:
            raise CloudStorageError(
                "Folder name must not be empty",
                code="CLOUD_API_ERROR",
                status_code=400,
                provider="onedrive",
                account=ctx.account,
            )
        children = await self.list_items(ctx, folder_ref=parent_id, kind="folder", limit=200)
        for child in children:
            if child.name.lower() == clean_name.lower():
                return child

        resp = await ctx.http_client.post(
            f"{_item_base_url(parent_id)}/children",
            headers={"Authorization": f"Bearer {ctx.access_token}"},
            json={
                "name": clean_name,
                "folder": {},
                "@microsoft.graph.conflictBehavior": "fail",
            },
        )
        if resp.status_code == 409:
            refreshed = await self.list_items(ctx, folder_ref=parent_id, kind="folder", limit=200)
            for child in refreshed:
                if child.name.lower() == clean_name.lower():
                    return child
        if resp.status_code >= 400:
            text = resp.text
            if is_invalid_grant_error(resp.status_code, text):
                raise CloudReauthRequiredError("onedrive", ctx.account, f"HTTP {resp.status_code}")
            raise CloudStorageError(
                f"OneDrive mkdir failed (HTTP {resp.status_code}): {text[:220]}",
                code="CLOUD_API_ERROR",
                status_code=resp.status_code,
                provider="onedrive",
                account=ctx.account,
            )
        return _map_graph_item(dict(resp.json()))

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
        parent_id = _assert_graph_item_id(parent_ref or ctx.root_ref or "root", "parent_ref")
        conflict_behavior = (
            "fail"
            if on_conflict == "fail"
            else "rename"
            if on_conflict == "autorename"
            else "replace"
        )
        encoded_name = quote(remote_name, safe="")
        target_prefix = (
            f"{GRAPH_API}/me/drive/root:/{encoded_name}:"
            if parent_id == "root"
            else f"{GRAPH_API}/me/drive/items/{quote(parent_id, safe='')}:/{encoded_name}:"
        )

        if file_size_bytes == 0:
            zero_resp = await ctx.http_client.put(
                f"{target_prefix}/content",
                params={"@microsoft.graph.conflictBehavior": conflict_behavior},
                headers={
                    "Authorization": f"Bearer {ctx.access_token}",
                    "Content-Type": mime_type,
                    "Content-Length": "0",
                },
                content=b"",
            )
            if zero_resp.status_code == 409:
                raise CloudStorageError(
                    f"File '{remote_name}' already exists in OneDrive",
                    code="CLOUD_CONFLICT_EXISTS",
                    status_code=409,
                    provider="onedrive",
                    account=ctx.account,
                )
            if zero_resp.status_code >= 400:
                raise CloudStorageError(
                    f"OneDrive 0-byte upload failed (HTTP {zero_resp.status_code})",
                    code="CLOUD_API_ERROR",
                    status_code=zero_resp.status_code,
                    provider="onedrive",
                    account=ctx.account,
                )
            return _map_graph_item(dict(zero_resp.json()))

        session_resp = await ctx.http_client.post(
            f"{target_prefix}/createUploadSession",
            headers={"Authorization": f"Bearer {ctx.access_token}"},
            json={
                "item": {
                    "@microsoft.graph.conflictBehavior": conflict_behavior,
                    "name": remote_name,
                }
            },
        )
        if session_resp.status_code == 409:
            raise CloudStorageError(
                f"File '{remote_name}' already exists in OneDrive (on_conflict='fail')",
                code="CLOUD_CONFLICT_EXISTS",
                status_code=409,
                provider="onedrive",
                account=ctx.account,
            )
        if session_resp.status_code >= 400:
            text = session_resp.text
            if is_invalid_grant_error(session_resp.status_code, text):
                raise CloudReauthRequiredError(
                    "onedrive",
                    ctx.account,
                    f"HTTP {session_resp.status_code}",
                )
            raise CloudStorageError(
                f"OneDrive createUploadSession failed (HTTP {session_resp.status_code}): "
                f"{text[:220]}",
                code="CLOUD_API_ERROR",
                status_code=session_resp.status_code,
                provider="onedrive",
                account=ctx.account,
            )

        session_data = session_resp.json()
        upload_url = session_data.get("uploadUrl") if isinstance(session_data, dict) else None
        if not isinstance(upload_url, str) or not upload_url:
            raise CloudStorageError(
                "Missing uploadUrl in OneDrive createUploadSession response",
                code="CLOUD_API_ERROR",
                status_code=502,
                provider="onedrive",
                account=ctx.account,
            )

        raw_chunk = chunk_bytes if chunk_bytes is not None else ONEDRIVE_CHUNK_BYTES
        aligned_chunk = max(
            ONEDRIVE_CHUNK_ALIGNMENT,
            (raw_chunk // ONEDRIVE_CHUNK_ALIGNMENT) * ONEDRIVE_CHUNK_ALIGNMENT,
        )

        final_raw: dict[str, Any] | None = None
        async for chunk_data, start, end, _is_final in iter_file_chunks(
            local_path,
            file_size_bytes,
            aligned_chunk,
        ):

            async def _send_chunk(
                data: bytes = chunk_data,
                s: int = start,
                e: int = end,
            ) -> httpx.Response:
                return await ctx.http_client.put(
                    upload_url,
                    headers={
                        "Content-Length": str(len(data)),
                        "Content-Range": f"bytes {s}-{e}/{file_size_bytes}",
                    },
                    content=data,
                )

            resp = await execute_with_retry(
                _send_chunk,
                retry_delays_sec=ctx.retry_delays_sec,
                accepted_statuses=(200, 201, 202),
            )
            if resp.status_code >= 400:
                raise CloudStorageError(
                    f"OneDrive chunk upload failed (HTTP {resp.status_code}): {resp.text[:220]}",
                    code="CLOUD_API_ERROR",
                    status_code=resp.status_code,
                    provider="onedrive",
                    account=ctx.account,
                )
            if resp.status_code in (200, 201):
                parsed = json.loads(resp.text)
                if isinstance(parsed, dict):
                    final_raw = parsed

        if final_raw is None:
            raise CloudStorageError(
                "OneDrive upload did not return final DriveItem metadata",
                code="CLOUD_API_ERROR",
                status_code=502,
                provider="onedrive",
                account=ctx.account,
            )
        mapped = _map_graph_item(final_raw)
        if mapped.size_bytes is not None and mapped.size_bytes != file_size_bytes:
            raise CloudStorageError(
                f"Upload size mismatch on OneDrive: local={file_size_bytes} B, "
                f"remote={mapped.size_bytes} B",
                code="CLOUD_INTEGRITY_MISMATCH",
                status_code=502,
                provider="onedrive",
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
        item_id = _assert_graph_item_id(file_ref, "file_ref")
        raw_meta = await _graph_json_request(
            ctx,
            "GET",
            _item_base_url(item_id),
            params={"$select": _GRAPH_SELECT},
        )
        item = _map_graph_item(raw_meta)
        bytes_written, _ = await stream_download_to_path(
            ctx,
            method="GET",
            url=f"{_item_base_url(item_id)}/content",
            headers={"Authorization": f"Bearer {ctx.access_token}"},
            dest_path=dest_path,
            max_download_bytes=max_download_bytes,
            expected_size_bytes=item.size_bytes,
            provider="onedrive",
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
        item_id = _assert_graph_item_id(file_ref, "file_ref")
        if public_link:
            body: dict[str, Any] = {
                "type": "edit" if role == "writer" else "view",
                "scope": "anonymous",
            }
            expires_iso: str | None = None
            if expires_in_days is not None and expires_in_days > 0:
                expires_iso = (
                    (datetime.now(tz=UTC) + timedelta(days=expires_in_days))
                    .isoformat()
                    .replace("+00:00", "Z")
                )
                body["expirationDateTime"] = expires_iso
            resp = await ctx.http_client.post(
                f"{_item_base_url(item_id)}/createLink",
                headers={"Authorization": f"Bearer {ctx.access_token}"},
                json=body,
            )
            if resp.status_code >= 400:
                text = resp.text
                if is_invalid_grant_error(resp.status_code, text):
                    raise CloudReauthRequiredError(
                        "onedrive",
                        ctx.account,
                        f"HTTP {resp.status_code}",
                    )
                raise CloudStorageError(
                    f"OneDrive blocked anonymous link creation (HTTP {resp.status_code})",
                    code="CLOUD_PUBLIC_LINK_BLOCKED_BY_PROVIDER",
                    status_code=resp.status_code,
                    provider="onedrive",
                    account=ctx.account,
                )
            parsed = resp.json()
            link = parsed.get("link") if isinstance(parsed, dict) else {}
            web_url = str(link.get("webUrl") or "") if isinstance(link, dict) else ""
            return CloudShareResult(
                provider="onedrive",
                account=ctx.account,
                item_id=item_id,
                web_url=web_url,
                mode="public_link",
                shared_with="anyone",
                role=role,
                notified=False,
                expires_at=expires_iso,
            )

        invite_resp = await ctx.http_client.post(
            f"{_item_base_url(item_id)}/invite",
            headers={"Authorization": f"Bearer {ctx.access_token}"},
            json={
                "recipients": [{"email": email}],
                "message": "",
                "requireSignIn": True,
                "sendInvitation": notify,
                "roles": ["write" if role == "writer" else "read"],
            },
        )
        if invite_resp.status_code >= 400:
            text = invite_resp.text
            if is_invalid_grant_error(invite_resp.status_code, text):
                raise CloudReauthRequiredError(
                    "onedrive",
                    ctx.account,
                    f"HTTP {invite_resp.status_code}",
                )
            raise CloudStorageError(
                f"OneDrive email share failed (HTTP {invite_resp.status_code}): {text[:220]}",
                code="CLOUD_SHARE_PROVIDER_ERROR",
                status_code=invite_resp.status_code,
                provider="onedrive",
                account=ctx.account,
            )

        invite_data = invite_resp.json()
        web_url = ""
        if isinstance(invite_data, dict):
            values = invite_data.get("value")
            if isinstance(values, list) and values and isinstance(values[0], dict):
                link_obj = values[0].get("link")
                if isinstance(link_obj, dict):
                    web_url = str(link_obj.get("webUrl") or "")
        if not web_url:
            meta = await _graph_json_request(
                ctx,
                "GET",
                _item_base_url(item_id),
                params={"$select": "webUrl"},
            )
            web_url = str(meta.get("webUrl") or "")
        return CloudShareResult(
            provider="onedrive",
            account=ctx.account,
            item_id=item_id,
            web_url=web_url,
            mode="email",
            shared_with=str(email or ""),
            role=role,
            notified=notify,
        )
