"""Google Drive API v3 provider (PKCE S256, 8 MiB resumable upload, native Docs export)."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Final
from urllib.parse import quote, urlencode

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
    execute_with_retry,
    iter_file_chunks,
    post_oauth_form,
    stream_download_to_path,
)

GOOGLE_AUTH_URL: Final[str] = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL: Final[str] = "https://oauth2.googleapis.com/token"  # noqa: S105
GOOGLE_DRIVE_API: Final[str] = "https://www.googleapis.com/drive/v3"
GOOGLE_UPLOAD_API: Final[str] = "https://www.googleapis.com/upload/drive/v3"
GOOGLE_FOLDER_MIME: Final[str] = "application/vnd.google-apps.folder"
_GDRIVE_CHUNK_ALIGN: Final[int] = 256 * 1024
_SAFE_DRIVE_ID_RE: Final[re.Pattern[str]] = re.compile(r"^(?:root|[A-Za-z0-9._-]{3,128})$")
_DRIVE_FILE_FIELDS: Final[str] = (
    "id,name,mimeType,size,modifiedTime,webViewLink,parents,md5Checksum"
)

_EXPORT_BY_HINT: Final[dict[str, str]] = {
    "md": "text/markdown",
    "markdown": "text/markdown",
    "txt": "text/plain",
    "pdf": "application/pdf",
    "png": "image/png",
    "csv": "text/csv",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "html": "text/html",
}

_DEFAULT_NATIVE_EXPORT_MIME: Final[dict[str, str]] = {
    "application/vnd.google-apps.document": "text/markdown",
    "application/vnd.google-apps.spreadsheet": "text/csv",
    "application/vnd.google-apps.presentation": "application/pdf",
    "application/vnd.google-apps.drawing": "image/png",
}


def _assert_drive_id(raw: str, label: str) -> str:
    clean = raw.strip()
    if not _SAFE_DRIVE_ID_RE.match(clean):
        raise CloudStorageError(
            f"Invalid Google Drive {label}: {raw!r}",
            code="CLOUD_API_ERROR",
            status_code=400,
            provider="gdrive",
        )
    return clean


def _escape_drive_query(raw: str) -> str:
    return raw.replace("\\", "\\\\").replace("'", "\\'")


def _map_drive_file(raw: dict[str, Any]) -> CloudItem:
    mime = raw.get("mimeType")
    mime_str = str(mime) if isinstance(mime, str) else None
    is_folder = mime_str == GOOGLE_FOLDER_MIME
    raw_size = raw.get("size")
    size_bytes: int | None = None
    if not is_folder and raw_size is not None:
        try:
            size_bytes = int(raw_size)
        except (TypeError, ValueError):
            size_bytes = None
    parents = raw.get("parents")
    parent_ref = str(parents[0]) if isinstance(parents, list) and parents else None
    return CloudItem(
        id=str(raw.get("id") or ""),
        name=str(raw.get("name") or ""),
        kind="folder" if is_folder else "file",
        size_bytes=size_bytes,
        mime_type=mime_str,
        modified_at=str(raw["modifiedTime"]) if raw.get("modifiedTime") else None,
        web_url=str(raw["webViewLink"]) if raw.get("webViewLink") else None,
        parent_ref=parent_ref,
        checksum=str(raw["md5Checksum"]) if raw.get("md5Checksum") else None,
    )


def resolve_google_export_mime(
    native_mime: str,
    dest_path: Path,
    export_format: str | None = None,
) -> str | None:
    """Resolve target export MIME type for native Google Docs/Sheets/Slides/Drawing."""
    hint = (export_format or dest_path.suffix.lstrip(".")).strip().lower()
    if hint and hint in _EXPORT_BY_HINT:
        return _EXPORT_BY_HINT[hint]
    return _DEFAULT_NATIVE_EXPORT_MIME.get(native_mime)


async def _drive_json_request(
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
            f"Google Drive network error: {exc}",
            code="CLOUD_API_ERROR",
            status_code=502,
            provider="gdrive",
            account=ctx.account,
        ) from exc

    text = resp.text
    if resp.status_code >= 400:
        if is_invalid_grant_error(resp.status_code, text):
            raise CloudReauthRequiredError("gdrive", ctx.account, f"HTTP {resp.status_code}")
        if resp.status_code == 404:
            raise CloudStorageError(
                "Google Drive item not found (HTTP 404)",
                code="CLOUD_NOT_FOUND",
                status_code=404,
                provider="gdrive",
                account=ctx.account,
            )
        raise CloudStorageError(
            f"Google Drive API error (HTTP {resp.status_code}): {text[:240]}",
            code="CLOUD_API_ERROR",
            status_code=resp.status_code,
            provider="gdrive",
            account=ctx.account,
        )

    if not text.strip():
        return {}
    parsed = resp.json()
    return dict(parsed) if isinstance(parsed, dict) else {}


async def _find_child_by_name(
    ctx: CloudCallContext,
    parent_id: str,
    name: str,
    *,
    folder_only: bool,
) -> CloudItem | None:
    safe_parent = _assert_drive_id(parent_id, "parent_ref")
    op = "=" if folder_only else "!="
    query = (
        f"'{_escape_drive_query(safe_parent)}' in parents "
        f"and name = '{_escape_drive_query(name)}' "
        f"and trashed = false "
        f"and mimeType {op} '{GOOGLE_FOLDER_MIME}'"
    )
    data = await _drive_json_request(
        ctx,
        "GET",
        f"{GOOGLE_DRIVE_API}/files",
        params={
            "q": query,
            "pageSize": "5",
            "fields": f"files({_DRIVE_FILE_FIELDS})",
        },
    )
    files = data.get("files")
    if isinstance(files, list) and files and isinstance(files[0], dict):
        return _map_drive_file(files[0])
    return None


class GoogleDriveProvider:
    """SDK-free Google Drive v3 client using `httpx.AsyncClient`."""

    provider_id: CloudProviderId = "gdrive"
    display_name: str = "Google Drive"
    recommended_chunk_bytes: int = DEFAULT_CLOUD_CHUNK_BYTES
    api_base_url: str = GOOGLE_DRIVE_API

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
            "https://www.googleapis.com/auth/drive.readonly"
            if access_mode == "read_only"
            else "https://www.googleapis.com/auth/drive"
        )
        qs = urlencode(
            {
                "client_id": client_id,
                "redirect_uri": redirect_uri,
                "response_type": "code",
                "scope": scope,
                "access_type": "offline",
                "prompt": "select_account consent",
                "include_granted_scopes": "false",
                "code_challenge": code_challenge,
                "code_challenge_method": "S256",
                "state": state,
            }
        )
        return f"{GOOGLE_AUTH_URL}?{qs}"

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
            token_url=GOOGLE_TOKEN_URL,
            form_data={
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": code_verifier,
                "grant_type": "authorization_code",
            },
            provider="gdrive",
        )
        access_token = data.get("access_token")
        refresh_token = data.get("refresh_token")
        if not isinstance(access_token, str) or not isinstance(refresh_token, str):
            raise CloudStorageError(
                "Google OAuth2 response missing access_token or refresh_token "
                "(prompt='select_account consent' and access_type='offline' required)",
                code="CLOUD_API_ERROR",
                status_code=502,
                provider="gdrive",
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
            token_url=GOOGLE_TOKEN_URL,
            form_data={
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
            provider="gdrive",
            account=account,
            is_refresh=True,
        )
        access_token = data.get("access_token")
        if not isinstance(access_token, str) or not access_token:
            raise CloudStorageError(
                "Missing access_token in Google refresh response",
                code="CLOUD_API_ERROR",
                status_code=502,
                provider="gdrive",
                account=account,
            )
        rotated = data.get("refresh_token")
        return CloudRefreshResult(
            access_token=access_token,
            rotated_refresh_token=rotated if isinstance(rotated, str) and rotated else None,
            expires_in_sec=int(data.get("expires_in") or 3600),
        )

    async def get_account_quota(self, ctx: CloudCallContext) -> CloudQuotaInfo:
        data = await _drive_json_request(
            ctx,
            "GET",
            f"{GOOGLE_DRIVE_API}/about",
            params={
                "fields": "user(displayName,emailAddress),storageQuota(limit,usage,usageInDrive)"
            },
        )
        raw_user = data.get("user")
        user: dict[str, Any] = raw_user if isinstance(raw_user, dict) else {}
        raw_quota = data.get("storageQuota")
        quota: dict[str, Any] = raw_quota if isinstance(raw_quota, dict) else {}
        used_raw = quota.get("usage", quota.get("usageInDrive"))
        total_raw = quota.get("limit")
        used_bytes = int(used_raw) if used_raw is not None else None
        total_bytes = int(total_raw) if total_raw is not None else None
        email_val = user.get("emailAddress")
        name_val = user.get("displayName")
        return CloudQuotaInfo(
            account_email=str(email_val) if email_val else None,
            display_name=str(name_val) if name_val else None,
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
        parent_id = _assert_drive_id(folder_ref or ctx.root_ref or "root", "folder_ref")
        clamped = max(1, min(200, int(limit)))
        q_parts = ["trashed = false"]
        if query and query.strip():
            q_parts.append(f"name contains '{_escape_drive_query(query.strip())}'")
            if folder_ref or (ctx.root_ref and ctx.root_ref != "root"):
                q_parts.append(f"'{_escape_drive_query(parent_id)}' in parents")
        else:
            q_parts.append(f"'{_escape_drive_query(parent_id)}' in parents")

        if kind == "folder":
            q_parts.append(f"mimeType = '{GOOGLE_FOLDER_MIME}'")
        elif kind == "file":
            q_parts.append(f"mimeType != '{GOOGLE_FOLDER_MIME}'")

        data = await _drive_json_request(
            ctx,
            "GET",
            f"{GOOGLE_DRIVE_API}/files",
            params={
                "q": " and ".join(q_parts),
                "pageSize": str(clamped),
                "orderBy": "folder,modifiedTime desc",
                "fields": f"files({_DRIVE_FILE_FIELDS})",
            },
        )
        raw_files = data.get("files")
        if not isinstance(raw_files, list):
            return []
        return [_map_drive_file(item) for item in raw_files if isinstance(item, dict)]

    async def mkdir(
        self,
        ctx: CloudCallContext,
        *,
        name: str,
        parent_ref: str | None = None,
    ) -> CloudItem:
        parent_id = _assert_drive_id(parent_ref or ctx.root_ref or "root", "parent_ref")
        clean_name = name.strip()
        if not clean_name:
            raise CloudStorageError(
                "Folder name must not be empty",
                code="CLOUD_API_ERROR",
                status_code=400,
                provider="gdrive",
                account=ctx.account,
            )
        existing = await _find_child_by_name(ctx, parent_id, clean_name, folder_only=True)
        if existing is not None:
            return existing
        created = await _drive_json_request(
            ctx,
            "POST",
            f"{GOOGLE_DRIVE_API}/files",
            params={"fields": _DRIVE_FILE_FIELDS},
            json_body={
                "name": clean_name,
                "mimeType": GOOGLE_FOLDER_MIME,
                "parents": [parent_id],
            },
        )
        return _map_drive_file(created)

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
        parent_id = _assert_drive_id(parent_ref or ctx.root_ref or "root", "parent_ref")
        existing = await _find_child_by_name(ctx, parent_id, remote_name, folder_only=False)
        if existing is not None and on_conflict == "fail":
            raise CloudStorageError(
                f"File '{remote_name}' already exists in Google Drive (on_conflict='fail')",
                code="CLOUD_CONFLICT_EXISTS",
                status_code=409,
                provider="gdrive",
                account=ctx.account,
            )

        patch_in_place = existing is not None and on_conflict == "update_in_place"
        if patch_in_place and existing is not None:
            init_url = (
                f"{GOOGLE_UPLOAD_API}/files/{quote(existing.id, safe='')}"
                f"?uploadType=resumable&fields={quote(_DRIVE_FILE_FIELDS, safe='')}"
            )
            init_method = "PATCH"
            metadata_body: dict[str, Any] = {"name": remote_name}
        else:
            init_url = (
                f"{GOOGLE_UPLOAD_API}/files"
                f"?uploadType=resumable&fields={quote(_DRIVE_FILE_FIELDS, safe='')}"
            )
            init_method = "POST"
            metadata_body = {"name": remote_name, "parents": [parent_id]}

        init_resp = await ctx.http_client.request(
            init_method,
            init_url,
            headers={
                "Authorization": f"Bearer {ctx.access_token}",
                "Content-Type": "application/json; charset=UTF-8",
                "X-Upload-Content-Type": mime_type,
                "X-Upload-Content-Length": str(file_size_bytes),
            },
            json=metadata_body,
        )
        if init_resp.status_code >= 400:
            err_text = init_resp.text
            if is_invalid_grant_error(init_resp.status_code, err_text):
                raise CloudReauthRequiredError(
                    "gdrive",
                    ctx.account,
                    f"HTTP {init_resp.status_code}",
                )
            raise CloudStorageError(
                f"Google Drive resumable init failed (HTTP {init_resp.status_code}): "
                f"{err_text[:220]}",
                code="CLOUD_API_ERROR",
                status_code=init_resp.status_code,
                provider="gdrive",
                account=ctx.account,
            )

        session_uri = init_resp.headers.get("location")
        if not session_uri:
            raise CloudStorageError(
                "Missing Location header in Google Drive resumable upload response",
                code="CLOUD_API_ERROR",
                status_code=502,
                provider="gdrive",
                account=ctx.account,
            )

        if file_size_bytes == 0:
            zero_resp = await execute_with_retry(
                lambda: ctx.http_client.put(
                    session_uri,
                    headers={
                        "Content-Length": "0",
                        "Content-Range": "bytes */0",
                        "Content-Type": mime_type,
                    },
                    content=b"",
                ),
                retry_delays_sec=ctx.retry_delays_sec,
            )
            if zero_resp.status_code >= 400:
                raise CloudStorageError(
                    f"Google Drive 0-byte upload failed (HTTP {zero_resp.status_code})",
                    code="CLOUD_API_ERROR",
                    status_code=zero_resp.status_code,
                    provider="gdrive",
                    account=ctx.account,
                )
            return _map_drive_file(dict(zero_resp.json()))

        raw_chunk = chunk_bytes if chunk_bytes is not None else DEFAULT_CLOUD_CHUNK_BYTES
        aligned_chunk = max(
            _GDRIVE_CHUNK_ALIGN,
            (raw_chunk // _GDRIVE_CHUNK_ALIGN) * _GDRIVE_CHUNK_ALIGN,
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
                    session_uri,
                    headers={
                        "Content-Length": str(len(data)),
                        "Content-Range": f"bytes {s}-{e}/{file_size_bytes}",
                        "Content-Type": mime_type,
                    },
                    content=data,
                )

            resp = await execute_with_retry(
                _send_chunk,
                retry_delays_sec=ctx.retry_delays_sec,
                accepted_statuses=(200, 201, 308),
            )
            if resp.status_code == 308:
                await resp.aclose()
                continue
            if resp.status_code >= 400:
                raise CloudStorageError(
                    f"Google Drive chunk upload failed (HTTP {resp.status_code}): "
                    f"{resp.text[:220]}",
                    code="CLOUD_API_ERROR",
                    status_code=resp.status_code,
                    provider="gdrive",
                    account=ctx.account,
                )
            parsed = json.loads(resp.text)
            if isinstance(parsed, dict):
                final_raw = parsed

        if final_raw is None:
            raise CloudStorageError(
                "Google Drive resumable upload completed without returning file metadata",
                code="CLOUD_API_ERROR",
                status_code=502,
                provider="gdrive",
                account=ctx.account,
            )

        mapped = _map_drive_file(final_raw)
        if mapped.size_bytes is not None and mapped.size_bytes != file_size_bytes:
            raise CloudStorageError(
                f"Upload size mismatch on Google Drive: local={file_size_bytes} B, "
                f"remote={mapped.size_bytes} B",
                code="CLOUD_INTEGRITY_MISMATCH",
                status_code=502,
                provider="gdrive",
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
        file_id = _assert_drive_id(file_ref, "file_ref")
        raw_meta = await _drive_json_request(
            ctx,
            "GET",
            f"{GOOGLE_DRIVE_API}/files/{quote(file_id, safe='')}",
            params={"fields": _DRIVE_FILE_FIELDS},
        )
        item = _map_drive_file(raw_meta)

        exported_mime: str | None = None
        if item.mime_type and item.mime_type.startswith("application/vnd.google-apps."):
            exported_mime = resolve_google_export_mime(item.mime_type, dest_path, export_format)
            if exported_mime is None:
                raise CloudStorageError(
                    f"Google Workspace file ({item.mime_type}) cannot be exported",
                    code="CLOUD_API_ERROR",
                    status_code=400,
                    provider="gdrive",
                    account=ctx.account,
                )
            download_url = (
                f"{GOOGLE_DRIVE_API}/files/{quote(file_id, safe='')}/export"
                f"?mimeType={quote(exported_mime, safe='')}"
            )
        else:
            download_url = f"{GOOGLE_DRIVE_API}/files/{quote(file_id, safe='')}/?alt=media".replace(
                "/?alt=media", "?alt=media"
            )

        bytes_written, _ = await stream_download_to_path(
            ctx,
            method="GET",
            url=download_url,
            headers={"Authorization": f"Bearer {ctx.access_token}"},
            dest_path=dest_path,
            max_download_bytes=max_download_bytes,
            expected_size_bytes=None if exported_mime is not None else item.size_bytes,
            provider="gdrive",
        )
        return CloudDownloadResult(
            item=item,
            bytes_written=bytes_written,
            saved_path=str(dest_path),
            exported_mime_type=exported_mime,
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
        del expires_in_days
        file_id = _assert_drive_id(file_ref, "file_ref")
        drive_role = "writer" if role == "writer" else "reader"
        perm_payload: dict[str, Any] = (
            {"type": "anyone", "role": drive_role}
            if public_link
            else {"type": "user", "role": drive_role, "emailAddress": email}
        )
        params: dict[str, str] = {"fields": "id"}
        if not public_link:
            params["sendNotificationEmail"] = "true" if notify else "false"

        resp = await ctx.http_client.post(
            f"{GOOGLE_DRIVE_API}/files/{quote(file_id, safe='')}/permissions",
            params=params,
            headers={"Authorization": f"Bearer {ctx.access_token}"},
            json=perm_payload,
        )
        if resp.status_code >= 400:
            text = resp.text
            if is_invalid_grant_error(resp.status_code, text):
                raise CloudReauthRequiredError("gdrive", ctx.account, f"HTTP {resp.status_code}")
            if public_link and resp.status_code in (400, 403):
                raise CloudStorageError(
                    f"Google Drive blocked public link creation (HTTP {resp.status_code})",
                    code="CLOUD_PUBLIC_LINK_BLOCKED_BY_PROVIDER",
                    status_code=resp.status_code,
                    provider="gdrive",
                    account=ctx.account,
                )
            raise CloudStorageError(
                f"Google Drive share failed (HTTP {resp.status_code}): {text[:220]}",
                code="CLOUD_SHARE_PROVIDER_ERROR",
                status_code=resp.status_code,
                provider="gdrive",
                account=ctx.account,
            )

        meta = await _drive_json_request(
            ctx,
            "GET",
            f"{GOOGLE_DRIVE_API}/files/{quote(file_id, safe='')}",
            params={"fields": "id,name,webViewLink"},
        )
        fallback_url = f"https://drive.google.com/file/d/{quote(file_id, safe='')}/view"
        web_url = str(meta.get("webViewLink") or fallback_url)
        return CloudShareResult(
            provider="gdrive",
            account=ctx.account,
            item_id=file_id,
            web_url=web_url,
            mode="public_link" if public_link else "email",
            shared_with="anyone" if public_link else str(email or ""),
            role=role,
            notified=False if public_link else notify,
        )
