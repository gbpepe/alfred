"""Shared cloud provider Protocol, HTTP retry logic, and bounded streaming helpers."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import secrets
import shutil
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Protocol

import httpx

from ..models import (
    DOWNLOAD_STREAM_ITER_BYTES,
    MIN_FREE_DISK_RESERVE_BYTES,
    CloudAccessMode,
    CloudDownloadResult,
    CloudItem,
    CloudItemKindFilter,
    CloudProviderId,
    CloudQuotaInfo,
    CloudRefreshResult,
    CloudShareResult,
    CloudShareRole,
    CloudStorageError,
    CloudTokenBundle,
    CloudUploadConflictMode,
    is_invalid_grant_error,
)

_RETRYABLE_HTTP_STATUSES: frozenset[int] = frozenset({429, 500, 502, 503, 504})


@dataclass(slots=True)
class CloudCallContext:
    """Per-operation HTTP and account context passed to cloud providers."""

    http_client: httpx.AsyncClient
    access_token: str
    account: str
    root_ref: str | None = None
    retry_delays_sec: tuple[float, ...] = (0.2, 0.5, 1.0)
    skip_disk_space_check: bool = False


class CloudStorageProvider(Protocol):
    """Unified async protocol implemented by Google Drive, OneDrive, and Dropbox adapters."""

    @property
    def provider_id(self) -> CloudProviderId: ...

    @property
    def display_name(self) -> str: ...

    @property
    def recommended_chunk_bytes(self) -> int: ...

    @property
    def api_base_url(self) -> str: ...

    def build_authorization_url(
        self,
        *,
        client_id: str,
        redirect_uri: str,
        state: str,
        code_challenge: str,
        access_mode: CloudAccessMode = "read_write",
    ) -> str: ...

    async def exchange_code_for_tokens(
        self,
        http_client: httpx.AsyncClient,
        *,
        client_id: str,
        client_secret: str,
        code: str,
        redirect_uri: str,
        code_verifier: str,
    ) -> CloudTokenBundle: ...

    async def refresh_access_token(
        self,
        http_client: httpx.AsyncClient,
        *,
        client_id: str,
        client_secret: str,
        refresh_token: str,
        account: str,
    ) -> CloudRefreshResult: ...

    async def get_account_quota(self, ctx: CloudCallContext) -> CloudQuotaInfo: ...

    async def list_items(
        self,
        ctx: CloudCallContext,
        *,
        folder_ref: str | None = None,
        query: str | None = None,
        kind: CloudItemKindFilter = "all",
        limit: int = 50,
    ) -> list[CloudItem]: ...

    async def mkdir(
        self,
        ctx: CloudCallContext,
        *,
        name: str,
        parent_ref: str | None = None,
    ) -> CloudItem: ...

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
    ) -> CloudItem: ...

    async def download_file(
        self,
        ctx: CloudCallContext,
        *,
        file_ref: str,
        dest_path: Path,
        max_download_bytes: int,
        export_format: str | None = None,
    ) -> CloudDownloadResult: ...

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
    ) -> CloudShareResult: ...


def escape_http_header_json(payload: Mapping[str, Any]) -> str:
    """Serialize JSON strictly with `ensure_ascii=True` (`\\uXXXX`) for HTTP headers."""
    return json.dumps(dict(payload), ensure_ascii=True, separators=(",", ":"))


def _read_file_chunk_sync(path: Path, offset: int, size: int) -> bytes:
    with path.open("rb") as handle:
        handle.seek(offset)
        return handle.read(size)


async def iter_file_chunks(
    path: Path,
    total_bytes: int,
    chunk_bytes: int,
) -> AsyncIterator[tuple[bytes, int, int, bool]]:
    """Yield `(data, start, end_inclusive, is_final)` using fixed bounded RAM chunks."""
    if total_bytes <= 0:
        return
    safe_chunk = max(1, int(chunk_bytes))
    offset = 0
    while offset < total_bytes:
        to_read = min(safe_chunk, total_bytes - offset)
        data = await asyncio.to_thread(_read_file_chunk_sync, path, offset, to_read)
        if not data:
            break
        start = offset
        end = start + len(data) - 1
        offset += len(data)
        yield data, start, end, offset >= total_bytes


def _parse_retry_after_sec(header_val: str | None) -> float | None:
    if not header_val:
        return None
    try:
        secs = float(header_val.strip())
    except ValueError:
        return None
    if secs < 0:
        return None
    return min(30.0, secs)


async def execute_with_retry(
    send_attempt: Callable[[], Awaitable[httpx.Response]],
    *,
    retry_delays_sec: tuple[float, ...] = (0.2, 0.5, 1.0),
    accepted_statuses: tuple[int, ...] = (200, 201),
) -> httpx.Response:
    """Retry transient `429`/`5xx`/transport failures without re-uploading earlier chunks."""
    last_exc: Exception | None = None
    for attempt in range(len(retry_delays_sec) + 1):
        try:
            resp = await send_attempt()
            if resp.status_code in accepted_statuses:
                return resp
            if resp.status_code not in _RETRYABLE_HTTP_STATUSES or attempt == len(retry_delays_sec):
                return resp
            delay = _parse_retry_after_sec(resp.headers.get("retry-after"))
            if delay is None:
                delay = retry_delays_sec[attempt]
            await resp.aclose()
            if delay > 0:
                await asyncio.sleep(delay)
        except httpx.TransportError as exc:
            last_exc = exc
            if attempt == len(retry_delays_sec):
                raise CloudStorageError(
                    f"Cloud HTTP transport failure: {exc}",
                    code="CLOUD_API_ERROR",
                    status_code=502,
                ) from exc
            delay = retry_delays_sec[attempt]
            if delay > 0:
                await asyncio.sleep(delay)
    raise CloudStorageError(
        f"Cloud request failed after retries: {last_exc}",
        code="CLOUD_API_ERROR",
        status_code=502,
    )


def _check_disk_space_sync(dest_dir: Path, min_free_bytes: int) -> tuple[bool, int]:
    dest_dir.mkdir(parents=True, exist_ok=True)
    usage = shutil.disk_usage(dest_dir)
    return usage.free >= min_free_bytes, int(usage.free)


async def assert_disk_space_available(
    dest_dir: Path,
    *,
    min_free_bytes: int = MIN_FREE_DISK_RESERVE_BYTES,
) -> None:
    """Ensure destination filesystem has at least `min_free_bytes` (`512 MiB`) free."""
    ok, free_bytes = await asyncio.to_thread(_check_disk_space_sync, dest_dir, min_free_bytes)
    if not ok:
        free_mb = round(free_bytes / 1_048_576, 1)
        req_mb = round(min_free_bytes / 1_048_576, 1)
        raise CloudStorageError(
            f"Insufficient free disk space in '{dest_dir}': {free_mb} MiB free < {req_mb} MiB",
            code="CLOUD_DISK_SPACE_INSUFFICIENT",
            status_code=507,
        )


def _append_part_bytes_sync(part_path: Path, chunk: bytes) -> None:
    with part_path.open("ab") as handle:
        handle.write(chunk)


def _touch_part_sync(part_path: Path) -> None:
    part_path.parent.mkdir(parents=True, exist_ok=True)
    part_path.write_bytes(b"")


def _atomic_rename_sync(part_path: Path, dest_path: Path) -> None:
    try:
        os.chmod(part_path, 0o600)
    except OSError:
        pass
    os.replace(part_path, dest_path)


def _parse_content_length(headers: httpx.Headers) -> int | None:
    raw = headers.get("content-length")
    if not raw:
        return None
    try:
        val = int(raw.strip())
    except ValueError:
        return None
    return val if val >= 0 else None


async def stream_download_to_path(
    ctx: CloudCallContext,
    *,
    method: Literal["GET", "POST"],
    url: str,
    headers: Mapping[str, str],
    dest_path: Path,
    max_download_bytes: int,
    expected_size_bytes: int | None,
    provider: CloudProviderId,
    expected_size_from_headers: Callable[[httpx.Headers], int | None] | None = None,
) -> tuple[int, httpx.Headers]:
    """Stream response via `aiter_bytes(65536)` to atomic `.part` file with disk & size gates."""
    if expected_size_bytes is not None and expected_size_bytes > max_download_bytes:
        raise CloudStorageError(
            f"Requested file ({expected_size_bytes} B) exceeds max download limit "
            f"({max_download_bytes} B)",
            code="CLOUD_DOWNLOAD_LIMIT_EXCEEDED",
            status_code=413,
            provider=provider,
            account=ctx.account,
        )

    if not ctx.skip_disk_space_check:
        await assert_disk_space_available(dest_path.parent)
    else:
        await asyncio.to_thread(dest_path.parent.mkdir, parents=True, exist_ok=True)

    part_path = dest_path.parent / f".{dest_path.name}.{secrets.token_hex(6)}.part"
    bytes_written = 0

    try:
        async with ctx.http_client.stream(method, url, headers=dict(headers)) as resp:
            if resp.status_code >= 400:
                err_bytes = await resp.aread()
                err_text = err_bytes.decode("utf-8", errors="replace")
                if is_invalid_grant_error(resp.status_code, err_text):
                    from ..models import CloudReauthRequiredError

                    raise CloudReauthRequiredError(
                        provider,
                        ctx.account,
                        f"HTTP {resp.status_code}",
                    )
                if resp.status_code == 404 or (
                    provider == "dropbox"
                    and resp.status_code == 409
                    and "not_found" in err_text.lower()
                ):
                    raise CloudStorageError(
                        f"Cloud item not found (HTTP {resp.status_code})",
                        code="CLOUD_NOT_FOUND",
                        status_code=404,
                        provider=provider,
                        account=ctx.account,
                    )
                raise CloudStorageError(
                    f"Cloud download failed (HTTP {resp.status_code}): {err_text[:240]}",
                    code="CLOUD_API_ERROR",
                    status_code=resp.status_code,
                    provider=provider,
                    account=ctx.account,
                )

            header_len = _parse_content_length(resp.headers)
            has_encoding = bool(resp.headers.get("content-encoding"))
            known_len = (
                expected_size_bytes
                if expected_size_bytes is not None
                else (header_len if not has_encoding else None)
            )
            if known_len is not None and known_len > max_download_bytes:
                raise CloudStorageError(
                    f"Download Content-Length ({known_len} B) exceeds limit "
                    f"({max_download_bytes} B)",
                    code="CLOUD_DOWNLOAD_LIMIT_EXCEEDED",
                    status_code=413,
                    provider=provider,
                    account=ctx.account,
                )

            async for chunk in resp.aiter_bytes(DOWNLOAD_STREAM_ITER_BYTES):
                if not chunk:
                    continue
                bytes_written += len(chunk)
                if bytes_written > max_download_bytes:
                    raise CloudStorageError(
                        f"Streamed download exceeded limit ({max_download_bytes} B) and aborted",
                        code="CLOUD_DOWNLOAD_LIMIT_EXCEEDED",
                        status_code=413,
                        provider=provider,
                        account=ctx.account,
                    )
                await asyncio.to_thread(_append_part_bytes_sync, part_path, chunk)

            if known_len is not None and bytes_written != known_len:
                raise CloudStorageError(
                    f"Download integrity mismatch: expected {known_len} B, wrote {bytes_written} B",
                    code="CLOUD_INTEGRITY_MISMATCH",
                    status_code=502,
                    provider=provider,
                    account=ctx.account,
                )

            if expected_size_from_headers is not None:
                meta_len = expected_size_from_headers(resp.headers)
                if meta_len is not None and bytes_written != meta_len:
                    raise CloudStorageError(
                        f"Download metadata integrity mismatch: expected {meta_len} B, "
                        f"wrote {bytes_written} B",
                        code="CLOUD_INTEGRITY_MISMATCH",
                        status_code=502,
                        provider=provider,
                        account=ctx.account,
                    )

            if bytes_written == 0:
                await asyncio.to_thread(_touch_part_sync, part_path)

            await asyncio.to_thread(_atomic_rename_sync, part_path, dest_path)
            return bytes_written, resp.headers
    except httpx.HTTPError as exc:
        with contextlib.suppress(OSError):
            part_path.unlink(missing_ok=True)
        raise CloudStorageError(
            f"Cloud download transport error: {exc}",
            code="CLOUD_API_ERROR",
            status_code=502,
            provider=provider,
            account=ctx.account,
        ) from exc
    except BaseException:
        with contextlib.suppress(OSError):
            part_path.unlink(missing_ok=True)
        raise


async def post_oauth_form(
    http_client: httpx.AsyncClient,
    *,
    token_url: str,
    form_data: Mapping[str, str],
    provider: CloudProviderId,
    account: str | None = None,
    is_refresh: bool = False,
) -> dict[str, Any]:
    """Execute OAuth2 `application/x-www-form-urlencoded` token POST cleanly."""
    try:
        resp = await http_client.post(
            token_url,
            data=dict(form_data),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    except httpx.HTTPError as exc:
        raise CloudStorageError(
            f"{provider} OAuth2 network error: {exc}",
            code="CLOUD_API_ERROR",
            status_code=502,
            provider=provider,
            account=account,
        ) from exc

    body_text = resp.text
    if resp.status_code >= 400:
        if is_refresh and is_invalid_grant_error(resp.status_code, body_text):
            from ..models import CloudReauthRequiredError

            raise CloudReauthRequiredError(
                provider,
                account or "default",
                f"HTTP {resp.status_code}",
            )
        raise CloudStorageError(
            f"{provider} OAuth2 token error (HTTP {resp.status_code}): {body_text[:240]}",
            code="CLOUD_API_ERROR",
            status_code=resp.status_code,
            provider=provider,
            account=account,
        )

    try:
        parsed = resp.json()
    except ValueError as exc:
        raise CloudStorageError(
            f"{provider} OAuth2 returned malformed JSON",
            code="CLOUD_API_ERROR",
            status_code=502,
            provider=provider,
            account=account,
        ) from exc

    if not isinstance(parsed, dict):
        raise CloudStorageError(
            f"{provider} OAuth2 returned non-object JSON",
            code="CLOUD_API_ERROR",
            status_code=502,
            provider=provider,
            account=account,
        )
    return parsed
