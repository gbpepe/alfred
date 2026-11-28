"""Async streaming cloud storage engine, security gates, Vault integration, and housekeeping."""

from __future__ import annotations

import asyncio
import contextlib
import fnmatch
import os
import re
import sqlite3
import time
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Final

import httpx

from alfred.core.security.secret_gate import SecretGateResult, SecretScanInput, scan_inputs
from alfred.kernel.errors import ModuleSecurityError
from alfred.kernel.types import HousekeepingStats, ModuleContext

from .models import (
    CLOUD_PROVIDERS,
    DEFAULT_CLOUD_ACCOUNT,
    DEFAULT_MAX_DOWNLOAD_MB,
    DEFAULT_MAX_UPLOAD_MB,
    EMAIL_RE,
    HEAVY_TRANSFER_HOLD_MIN_BYTES,
    MODULE_ID,
    PROVIDER_DISPLAY_NAMES,
    CloudAccessMode,
    CloudAccountStatus,
    CloudActivityEntry,
    CloudActivityResponse,
    CloudConnectionHealth,
    CloudDownloadResult,
    CloudItem,
    CloudItemKindFilter,
    CloudListResponse,
    CloudMkdirResponse,
    CloudOAuthCallbackResult,
    CloudOAuthStartResponse,
    CloudProviderId,
    CloudProviderStatus,
    CloudQuotaInfo,
    CloudReauthRequiredError,
    CloudShareResponse,
    CloudShareRole,
    CloudStatusResponse,
    CloudStorageError,
    CloudUploadConflictMode,
    cloud_vault_key,
    coerce_cloud_provider,
    discover_cloud_accounts,
    guess_mime_type,
    normalize_cloud_account,
    resolve_default_account,
    resolve_default_provider,
)
from .oauth import OAuthStateManager
from .providers.base import CloudCallContext, CloudStorageProvider
from .providers.dropbox import DropboxProvider, normalize_dropbox_confined_path
from .providers.google_drive import GoogleDriveProvider
from .providers.onedrive import OneDriveProvider

_STALE_PART_AGE_SEC: Final[int] = 3600
_PATH_CACHE_TTL_SEC: Final[float] = 60.0
_PATH_CACHE_MAX_ENTRIES: Final[int] = 500
_LARGE_SCAN_CHUNK_BYTES: Final[int] = 1024 * 1024  # 1 MiB
_LARGE_SCAN_OVERLAP_CHARS: Final[int] = 1024
_FILE_EXCEEDS_SCAN_LIMIT_PREFIX: Final[str] = "file exceeds scan limit"

_SENSITIVE_BASENAME_RE: Final[re.Pattern[str]] = re.compile(
    r"^(?:\.env(?:\.(?!example$).+|~)?|\.dashboard-token|\.vault-key(?:\.migrated)?|"
    r"vault\.json|id_rsa(?:\..*)?|id_ed25519(?:\..*)?|id_ecdsa(?:\..*)?|id_dsa(?:\..*)?|"
    r"vertex-eu-sa\.json|.*(?:service[-_]?account|credentials).*\.json|"
    r".*\.(?:pem|key|p12|pfx|ppk|sqlite3?|db|db-wal|db-shm|db-journal))$",
    re.IGNORECASE,
)
_SENSITIVE_DIR_RE: Final[re.Pattern[str]] = re.compile(
    r"(?:^|/)(?:store|\.cli-profiles|\.claude|\.gemini|\.codex|\.ssh|\.config/gcloud)(?:/|$)",
    re.IGNORECASE,
)
_BEARER_REDACT_RE: Final[re.Pattern[str]] = re.compile(r"Bearer\s+\S+", re.IGNORECASE)


@dataclass(slots=True)
class ResolvedCloudTarget:
    """Validated provider + account target with decrypted Vault credentials."""

    provider: CloudProviderId
    account: str
    meta: dict[str, Any]
    client_id: str
    client_secret: str
    refresh_token: str


def _make_providers() -> dict[CloudProviderId, CloudStorageProvider]:
    return {
        "gdrive": GoogleDriveProvider(),
        "onedrive": OneDriveProvider(),
        "dropbox": DropboxProvider(),
    }


def _split_complete_utf8_prefix(raw: bytes, *, at_eof: bool) -> tuple[bytes, bytes]:
    """Split `raw` into `(complete_utf8_bytes, trailing_incomplete_utf8_bytes)`."""
    if at_eof or not raw:
        return raw, b""
    for trim in range(4):
        end = len(raw) - trim
        if end <= 0:
            break
        try:
            raw[:end].decode("utf-8")
            return raw[:end], raw[end:]
        except UnicodeDecodeError as exc:
            if exc.start >= max(0, len(raw) - 3):
                continue
            return raw, b""
    return raw, b""


def _stream_scan_large_file_sync(path: Path, display_path: str) -> SecretGateResult:
    """Incrementally scan a `> 2 MiB` UTF-8 text file in `1 MiB` chunks with `1 KiB` overlap."""
    utf8_carry = b""
    text_overlap = ""
    chunks_scanned = 0

    try:
        with path.open("rb") as handle:
            while True:
                raw = handle.read(_LARGE_SCAN_CHUNK_BYTES)
                at_eof = len(raw) == 0
                if b"\x00" in raw:
                    return scan_inputs(
                        [
                            SecretScanInput(
                                path=display_path,
                                unreadable_reason="binary NUL bytes present (unscannable text)",
                            )
                        ]
                    )
                combined_bytes = utf8_carry + raw
                if not combined_bytes:
                    break
                decodable, utf8_carry = _split_complete_utf8_prefix(combined_bytes, at_eof=at_eof)
                if decodable:
                    try:
                        chunk_text = decodable.decode("utf-8")
                    except UnicodeDecodeError:
                        return scan_inputs(
                            [
                                SecretScanInput(
                                    path=display_path,
                                    unreadable_reason="non-UTF-8 content (fail-closed)",
                                )
                            ]
                        )
                    scan_text = f"{text_overlap}{chunk_text}"
                    res = scan_inputs([SecretScanInput(path=display_path, content=scan_text)])
                    chunks_scanned += 1
                    if not res.ok:
                        return res
                    text_overlap = chunk_text[-_LARGE_SCAN_OVERLAP_CHARS:]
                if at_eof:
                    break
    except OSError as exc:
        return scan_inputs(
            [SecretScanInput(path=display_path, unreadable_reason=f"os read error: {exc}")]
        )

    if chunks_scanned == 0:
        return scan_inputs([SecretScanInput(path=display_path, content="")])
    return SecretGateResult(ok=True, findings=[], scanned_count=chunks_scanned)


def _normalize_rel_posix(raw: str) -> str:
    norm = raw.replace("\\", "/")
    while norm.startswith("./"):
        norm = norm[2:]
    return norm.strip("/")


def _matches_protected_rule(rel_posix: str, rule: str) -> bool:
    clean_rule = _normalize_rel_posix(rule)
    if not clean_rule or not rel_posix or rel_posix == ".":
        return False
    rel_cmp = rel_posix.lower() if os.name == "nt" else rel_posix
    rule_cmp = clean_rule.lower() if os.name == "nt" else clean_rule
    if any(ch in rule_cmp for ch in "*?["):
        return fnmatch.fnmatch(rel_cmp, rule_cmp) or fnmatch.fnmatch(
            rel_cmp.split("/")[0],
            rule_cmp.rstrip("/"),
        )
    return rel_cmp == rule_cmp or rel_cmp.startswith(f"{rule_cmp}/")


def _split_cloud_path_segments(raw_path: str) -> list[str]:
    if "\x00" in raw_path:
        raise CloudStorageError(
            f"Invalid cloud path {raw_path!r}: NUL byte forbidden",
            code="CLOUD_PATH_TRAVERSAL",
            status_code=400,
        )
    norm = raw_path.replace("\\", "/").strip("/")
    if not norm:
        return []
    segments = [seg for seg in norm.split("/") if seg]
    for seg in segments:
        if seg in ("..", "."):
            raise CloudStorageError(
                f"Invalid cloud path {raw_path!r}: '{seg}' segment forbidden",
                code="CLOUD_PATH_TRAVERSAL",
                status_code=400,
            )
    return segments


def _looks_like_relative_path(ref: str) -> bool:
    clean = ref.strip()
    if not clean or clean == "root" or clean.startswith("id:"):
        return False
    return "/" in clean or "\\" in clean


def _account_meta_from_config(
    config: dict[str, Any],
    provider: CloudProviderId,
    account: str,
) -> dict[str, Any]:
    raw_accounts = config.get("accounts")
    prov_accounts = raw_accounts.get(provider) if isinstance(raw_accounts, dict) else None
    existing = prov_accounts.get(account) if isinstance(prov_accounts, dict) else None
    meta: dict[str, Any] = dict(existing) if isinstance(existing, dict) else {}

    legacy_root_key = f"cloud_{provider}_root_ref"
    legacy_root = config.get(legacy_root_key) if account == DEFAULT_CLOUD_ACCOUNT else None
    default_label = "Alapértelmezett" if account == DEFAULT_CLOUD_ACCOUNT else account
    return {
        "label": str(meta.get("label") or default_label),
        "account_email": meta.get("account_email"),
        "access_mode": "read_only" if meta.get("access_mode") == "read_only" else "read_write",
        "root_ref": meta.get("root_ref") if meta.get("root_ref") is not None else legacy_root,
        "default_share_email": meta.get("default_share_email"),
        "allow_public_links": meta.get("allow_public_links"),
        "needs_reauth": bool(meta.get("needs_reauth", False)),
        "last_error": meta.get("last_error"),
        "updated_at": str(meta.get("updated_at") or ""),
    }


def _stat_file_sync(path: Path) -> tuple[bool, bool, int]:
    if not path.exists():
        return False, False, 0
    if not path.is_file():
        return True, False, 0
    return True, True, int(path.stat().st_size)


def _prune_stale_part_files_sync(data_dir: Path, cutoff_epoch: float) -> tuple[int, int]:
    if not data_dir.is_dir():
        return 0, 0
    deleted_count = 0
    freed_bytes = 0
    for root, _dirs, files in os.walk(data_dir):
        for fname in files:
            if not fname.endswith(".part"):
                continue
            target = Path(root) / fname
            try:
                if target.is_symlink():
                    continue
                st = target.stat()
                if st.st_mtime < cutoff_epoch:
                    target.unlink()
                    deleted_count += 1
                    freed_bytes += int(st.st_size)
            except OSError:
                continue
    return deleted_count, freed_bytes


class CloudStorageEngine:
    """Coordinates OAuth2 PKCE, Vault secrets, bounded transfers, security gates & audit DB."""

    def __init__(
        self,
        ctx: ModuleContext,
        *,
        http_client: httpx.AsyncClient | None = None,
        retry_delays_sec: tuple[float, ...] = (0.2, 0.5, 1.0),
        skip_disk_space_check: bool = False,
    ) -> None:
        self.ctx = ctx
        self._owns_http_client = http_client is None
        self.http_client = (
            http_client
            if http_client is not None
            else httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=15.0))
        )
        self.retry_delays_sec = retry_delays_sec
        self.skip_disk_space_check = skip_disk_space_check
        self.providers: dict[CloudProviderId, CloudStorageProvider] = _make_providers()
        self.oauth_states = OAuthStateManager()
        self._access_token_cache: dict[tuple[CloudProviderId, str], tuple[str, float]] = {}
        self._path_id_cache: dict[str, tuple[str, float]] = {}

    async def aclose(self) -> None:
        """Close owned HTTP client and clear in-memory token/OAuth caches."""
        self._access_token_cache.clear()
        self._path_id_cache.clear()
        await self.oauth_states.clear()
        if self._owns_http_client:
            await self.http_client.aclose()

    def get_provider(self, provider: CloudProviderId) -> CloudStorageProvider:
        """Return registered cloud provider adapter."""
        return self.providers[provider]

    def resolve_max_download_bytes(self) -> int:
        """Read `ALFRED_CLOUD_MAX_DOWNLOAD_MB` (default 250 MiB)."""
        raw = os.environ.get("ALFRED_CLOUD_MAX_DOWNLOAD_MB", "").strip()
        try:
            mb = int(raw) if raw else DEFAULT_MAX_DOWNLOAD_MB
        except ValueError:
            mb = DEFAULT_MAX_DOWNLOAD_MB
        if mb < 1 or mb > 4096:
            mb = DEFAULT_MAX_DOWNLOAD_MB
        return mb * 1024 * 1024

    def resolve_max_upload_bytes(self) -> int:
        """Read `ALFRED_CLOUD_MAX_UPLOAD_MB` (default 500 MiB)."""
        raw = os.environ.get("ALFRED_CLOUD_MAX_UPLOAD_MB", "").strip()
        try:
            mb = int(raw) if raw else DEFAULT_MAX_UPLOAD_MB
        except ValueError:
            mb = DEFAULT_MAX_UPLOAD_MB
        if mb < 1 or mb > 8192:
            mb = DEFAULT_MAX_UPLOAD_MB
        return mb * 1024 * 1024

    def confine_local_path(
        self,
        raw_path: str,
        *,
        workspace_dir: Path | None,
        protected_paths: Sequence[str] = (),
        for_upload: bool = False,
    ) -> tuple[Path, str]:
        """Validate `raw_path` strictly inside `workspace_dir` or `ctx.security.data_dir`."""
        if not raw_path or not raw_path.strip():
            raise ModuleSecurityError("Local path must not be empty", module_id=MODULE_ID)
        if "\x00" in raw_path:
            raise ModuleSecurityError(
                f"NUL byte forbidden in local path: {raw_path!r}",
                module_id=MODULE_ID,
            )

        req_path = Path(raw_path)
        if ".." in req_path.parts:
            raise ModuleSecurityError(
                f"Path traversal '..' forbidden in local path: {raw_path!r}",
                module_id=MODULE_ID,
            )

        data_root = self.ctx.security.data_dir.base_dir.resolve()
        ws_root = workspace_dir.resolve() if workspace_dir is not None else None
        allowed_roots: list[Path] = [r for r in (ws_root, data_root) if r is not None]

        if req_path.is_absolute():
            lexical_norm = Path(os.path.normpath(str(req_path)))
            resolved = req_path.resolve()
            matched_root = next(
                (
                    r
                    for r in allowed_roots
                    if lexical_norm.is_relative_to(r) and resolved.is_relative_to(r)
                ),
                None,
            )
            if matched_root is None:
                raise ModuleSecurityError(
                    f"Absolute local path '{raw_path}' escapes workspace/data_dir",
                    module_id=MODULE_ID,
                )
        else:
            base_root = ws_root if ws_root is not None else data_root
            lexical = base_root / req_path
            lexical_norm = Path(os.path.normpath(str(lexical)))
            resolved = lexical.resolve()
            if not lexical_norm.is_relative_to(base_root) or not resolved.is_relative_to(base_root):
                raise ModuleSecurityError(
                    f"Local path '{raw_path}' escapes confined directory",
                    module_id=MODULE_ID,
                )
            matched_root = base_root

        rel_posix = _normalize_rel_posix(resolved.relative_to(matched_root).as_posix())
        if _SENSITIVE_BASENAME_RE.match(resolved.name):
            raise ModuleSecurityError(
                f"Access to sensitive file '{resolved.name}' is forbidden",
                module_id=MODULE_ID,
            )
        if for_upload and _SENSITIVE_DIR_RE.search(rel_posix):
            raise ModuleSecurityError(
                f"Uploading from protected directory '{rel_posix}' is forbidden",
                module_id=MODULE_ID,
            )

        for rule in protected_paths:
            if _matches_protected_rule(rel_posix, rule):
                raise ModuleSecurityError(
                    f"Path '{raw_path}' matches agent protected path '{rule}'",
                    module_id=MODULE_ID,
                )
        return resolved, rel_posix or resolved.name

    async def _scan_upload_file_fail_closed(
        self,
        local_path: Path,
        display_path: str,
    ) -> None:
        scan_res = await asyncio.to_thread(
            self.ctx.security.scan_file_for_secrets,
            local_path,
            display_path=display_path,
        )
        if scan_res.ok:
            return

        exceeds_only = bool(scan_res.findings) and all(
            finding.detector == "unscannable"
            and finding.reason.startswith(_FILE_EXCEEDS_SCAN_LIMIT_PREFIX)
            for finding in scan_res.findings
        )
        if exceeds_only:
            chunk_res = await asyncio.to_thread(
                _stream_scan_large_file_sync,
                local_path,
                display_path,
            )
            if chunk_res.ok:
                return
            reasons = "; ".join(f"{f.detector}: {f.reason}" for f in chunk_res.findings)
            raise CloudStorageError(
                f"Upload blocked by secret gate ({reasons})",
                code="CLOUD_SECRET_GATE_BLOCKED",
                status_code=403,
            )

        reasons = "; ".join(f"{f.detector}: {f.reason}" for f in scan_res.findings)
        raise CloudStorageError(
            f"Upload blocked by secret gate ({reasons})",
            code="CLOUD_SECRET_GATE_BLOCKED",
            status_code=403,
        )

    async def _read_client_credentials(
        self,
        provider: CloudProviderId,
        account: str,
    ) -> tuple[str, str]:
        client_id: str | None = None
        client_secret: str | None = None
        if account != DEFAULT_CLOUD_ACCOUNT:
            client_id = await self.ctx.security.vault.get_secret(
                cloud_vault_key(provider, "client_id", account)
            )
            client_secret = await self.ctx.security.vault.get_secret(
                cloud_vault_key(provider, "client_secret", account)
            )
        if not client_id:
            client_id = await self.ctx.security.vault.get_secret(
                cloud_vault_key(provider, "client_id", DEFAULT_CLOUD_ACCOUNT)
            )
        if not client_secret:
            client_secret = await self.ctx.security.vault.get_secret(
                cloud_vault_key(provider, "client_secret", DEFAULT_CLOUD_ACCOUNT)
            )
        return (client_id or "").strip(), (client_secret or "").strip()

    async def resolve_target(
        self,
        *,
        provider: CloudProviderId | str | None = None,
        account: str | None = None,
    ) -> ResolvedCloudTarget:
        """Resolve `(provider?, account?)` fail-closed against Vault & module config."""
        config = await self.ctx.security.config.get()
        vault_ids = {item.key_id for item in self.ctx.security.vault.list_secrets()}
        prov = (
            coerce_cloud_provider(provider)
            if provider is not None
            else resolve_default_provider(config, vault_ids)
        )
        known_accounts = discover_cloud_accounts(prov, config, vault_ids)

        raw_acc = (account or "").strip()
        if raw_acc:
            lower_req = raw_acc.lower()
            matched_acc: str | None = next(
                (k for k in known_accounts if k.lower() == lower_req),
                None,
            )
            if matched_acc is None:
                for cand in known_accounts:
                    meta_cand = _account_meta_from_config(config, prov, cand)
                    meta_email = str(meta_cand.get("account_email") or "").strip().lower()
                    if meta_email and meta_email == lower_req:
                        matched_acc = cand
                        break
                    email_key = cloud_vault_key(prov, "account_email", cand)
                    if email_key in vault_ids:
                        v_email = (
                            await self.ctx.security.vault.get_secret(email_key) or ""
                        ).strip().lower()
                        if v_email == lower_req:
                            matched_acc = cand
                            break
            if matched_acc is None:
                raise CloudStorageError(
                    f"Cloud account '{raw_acc}' not found under provider '{prov}'",
                    code="CLOUD_ACCOUNT_NOT_FOUND",
                    status_code=404,
                    provider=prov,
                )
            resolved_acc = matched_acc
        else:
            resolved_acc = resolve_default_account(prov, config, vault_ids)

        meta = _account_meta_from_config(config, prov, resolved_acc)
        if meta.get("needs_reauth"):
            raise CloudReauthRequiredError(
                prov,
                resolved_acc,
                str(meta.get("last_error") or "needs_reauth"),
            )

        client_id, client_secret = await self._read_client_credentials(prov, resolved_acc)
        refresh_token = (
            await self.ctx.security.vault.get_secret(
                cloud_vault_key(prov, "refresh_token", resolved_acc)
            )
            or ""
        ).strip()
        if not client_id or not client_secret or not refresh_token:
            raise CloudStorageError(
                f"Cloud account '{prov}::{resolved_acc}' is not configured or not connected",
                code="CLOUD_NOT_CONFIGURED",
                status_code=400,
                provider=prov,
                account=resolved_acc,
            )

        return ResolvedCloudTarget(
            provider=prov,
            account=resolved_acc,
            meta=meta,
            client_id=client_id,
            client_secret=client_secret,
            refresh_token=refresh_token,
        )

    async def _update_account_meta(
        self,
        provider: CloudProviderId,
        account: str,
        patch: dict[str, Any],
        *,
        set_default_if_missing: bool = False,
    ) -> None:
        config = await self.ctx.security.config.get()
        raw_accounts = config.get("accounts")
        accounts_root: dict[str, Any] = (
            dict(raw_accounts) if isinstance(raw_accounts, dict) else {}
        )
        raw_prov_map = accounts_root.get(provider)
        prov_map: dict[str, Any] = (
            dict(raw_prov_map) if isinstance(raw_prov_map, dict) else {}
        )
        prev = _account_meta_from_config(config, provider, account)
        prev.update(patch)
        prev["updated_at"] = datetime.now(tz=UTC).isoformat()
        prov_map[account] = prev
        accounts_root[provider] = prov_map

        cfg_patch: dict[str, Any] = {"accounts": accounts_root}
        if set_default_if_missing:
            raw_defaults = config.get("provider_defaults")
            defaults_map: dict[str, Any] = (
                dict(raw_defaults) if isinstance(raw_defaults, dict) else {}
            )
            if not defaults_map.get(provider):
                defaults_map[provider] = account
                cfg_patch["provider_defaults"] = defaults_map
        await self.ctx.security.config.update(cfg_patch)

    async def _mark_reauth_state(
        self,
        provider: CloudProviderId,
        account: str,
        *,
        needs_reauth: bool,
        last_error: str | None,
    ) -> None:
        if needs_reauth:
            self._access_token_cache.pop((provider, account), None)
        await self._update_account_meta(
            provider,
            account,
            {"needs_reauth": needs_reauth, "last_error": last_error},
        )

    async def _get_valid_access_token(self, target: ResolvedCloudTarget) -> str:
        cache_key = (target.provider, target.account)
        cached = self._access_token_cache.get(cache_key)
        now_mono = time.monotonic()
        if cached is not None and cached[1] - 60.0 > now_mono:
            return cached[0]

        adapter = self.get_provider(target.provider)
        try:
            refreshed = await adapter.refresh_access_token(
                self.http_client,
                client_id=target.client_id,
                client_secret=target.client_secret,
                refresh_token=target.refresh_token,
                account=target.account,
            )
        except CloudReauthRequiredError as exc:
            await self._mark_reauth_state(
                target.provider,
                target.account,
                needs_reauth=True,
                last_error=exc.message,
            )
            raise

        if refreshed.rotated_refresh_token:
            await self.ctx.security.vault.set_secret(
                cloud_vault_key(target.provider, "refresh_token", target.account),
                refreshed.rotated_refresh_token,
                label=f"Cloud {target.provider} ({target.account}) Refresh Token",
            )

        expires_mono = now_mono + max(60, refreshed.expires_in_sec)
        self._access_token_cache[cache_key] = (refreshed.access_token, expires_mono)
        return refreshed.access_token

    async def _build_call_ctx(self, target: ResolvedCloudTarget) -> CloudCallContext:
        token = await self._get_valid_access_token(target)
        raw_root = target.meta.get("root_ref")
        return CloudCallContext(
            http_client=self.http_client,
            access_token=token,
            account=target.account,
            root_ref=str(raw_root) if isinstance(raw_root, str) and raw_root.strip() else None,
            retry_delays_sec=self.retry_delays_sec,
            skip_disk_space_check=self.skip_disk_space_check,
        )

    def _assert_writable(self, target: ResolvedCloudTarget) -> None:
        if target.meta.get("access_mode") == "read_only":
            raise CloudStorageError(
                f"Cloud account '{target.provider}::{target.account}' is read-only",
                code="CLOUD_ACCOUNT_READONLY",
                status_code=403,
                provider=target.provider,
                account=target.account,
            )

    def _get_cached_path_id(self, key: str) -> str | None:
        hit = self._path_id_cache.get(key)
        if hit is None:
            return None
        if hit[1] <= time.monotonic():
            self._path_id_cache.pop(key, None)
            return None
        return hit[0]

    def _set_cached_path_id(self, key: str, item_id: str) -> None:
        if len(self._path_id_cache) >= _PATH_CACHE_MAX_ENTRIES:
            oldest_key = next(iter(self._path_id_cache))
            self._path_id_cache.pop(oldest_key, None)
        self._path_id_cache[key] = (item_id, time.monotonic() + _PATH_CACHE_TTL_SEC)

    async def _resolve_folder_ref(
        self,
        adapter: CloudStorageProvider,
        call_ctx: CloudCallContext,
        ref_or_path: str | None,
        *,
        create_missing: bool = False,
    ) -> str:
        raw = (ref_or_path or "").strip()
        if adapter.provider_id == "dropbox":
            if not raw:
                return normalize_cloud_path_dropbox(call_ctx.root_ref, "")
            segments = _split_cloud_path_segments(raw)
            if create_missing and segments:
                cur = normalize_cloud_path_dropbox(call_ctx.root_ref, "")
                for seg in segments:
                    created = await adapter.mkdir(call_ctx, name=seg, parent_ref=cur)
                    cur = created.path_display or normalize_cloud_path_dropbox(
                        call_ctx.root_ref,
                        f"{cur}/{seg}" if cur else f"/{seg}",
                    )
                return cur
            return normalize_cloud_path_dropbox(call_ctx.root_ref, raw)

        root_id = (call_ctx.root_ref or "").strip() or "root"
        if not raw or raw in ("root", "/", "."):
            return root_id
        if not _looks_like_relative_path(raw):
            return raw

        segments = _split_cloud_path_segments(raw)
        current_id = root_id
        walked = ""
        for seg in segments:
            walked = f"{walked}/{seg}" if walked else seg
            cache_key = (
                f"{adapter.provider_id}::{call_ctx.account}::{root_id}::dir::{walked.lower()}"
            )
            cached = self._get_cached_path_id(cache_key)
            if cached is not None:
                current_id = cached
                continue
            children = await adapter.list_items(
                call_ctx,
                folder_ref=current_id,
                kind="folder",
                limit=200,
            )
            hit = next((c for c in children if c.name.lower() == seg.lower()), None)
            if hit is not None:
                current_id = hit.id
                self._set_cached_path_id(cache_key, hit.id)
            elif create_missing:
                created = await adapter.mkdir(call_ctx, name=seg, parent_ref=current_id)
                current_id = created.id
                self._set_cached_path_id(cache_key, created.id)
            else:
                raise CloudStorageError(
                    f"Cloud folder '{walked}' not found "
                    f"({adapter.provider_id}::{call_ctx.account})",
                    code="CLOUD_NOT_FOUND",
                    status_code=404,
                    provider=adapter.provider_id,
                    account=call_ctx.account,
                )
        return current_id

    async def _resolve_item_ref(
        self,
        adapter: CloudStorageProvider,
        call_ctx: CloudCallContext,
        ref_or_path: str,
    ) -> str:
        raw = ref_or_path.strip()
        if not raw:
            raise CloudStorageError(
                "file_ref_or_path must not be empty",
                code="CLOUD_NOT_FOUND",
                status_code=400,
                provider=adapter.provider_id,
                account=call_ctx.account,
            )
        if adapter.provider_id == "dropbox":
            return normalize_cloud_path_dropbox(call_ctx.root_ref, raw)
        if not _looks_like_relative_path(raw):
            return raw

        segments = _split_cloud_path_segments(raw)
        if not segments:
            return (call_ctx.root_ref or "").strip() or "root"
        filename = segments[-1]
        parent_path = "/".join(segments[:-1])
        parent_id = await self._resolve_folder_ref(
            adapter,
            call_ctx,
            parent_path or None,
            create_missing=False,
        )
        items = await adapter.list_items(call_ctx, folder_ref=parent_id, limit=200)
        hit = next((item for item in items if item.name.lower() == filename.lower()), None)
        if hit is None:
            raise CloudStorageError(
                f"Cloud item '{raw}' not found ({adapter.provider_id}::{call_ctx.account})",
                code="CLOUD_NOT_FOUND",
                status_code=404,
                provider=adapter.provider_id,
                account=call_ctx.account,
            )
        return hit.id

    async def record_activity(
        self,
        *,
        action: str,
        provider: str,
        account: str,
        remote_ref: str,
        byte_size: int = 0,
        status: str = "ok",
        detail: str | None = None,
    ) -> None:
        """Persist an entry into `cloud_activity_log` with Bearer token redaction."""
        safe_detail = (
            _BEARER_REDACT_RE.sub("Bearer [REDACTED]", detail)[:240]
            if detail
            else None
        )
        norm_status = "error" if status == "error" else "ok"
        created_at = datetime.now(tz=UTC).isoformat()

        def _insert(conn: sqlite3.Connection) -> None:
            conn.execute(
                "INSERT INTO cloud_activity_log "
                "(action, provider, account, remote_ref, byte_size, status, detail, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    action,
                    provider,
                    account or DEFAULT_CLOUD_ACCOUNT,
                    remote_ref[:240],
                    max(0, int(byte_size)),
                    norm_status,
                    safe_detail,
                    created_at,
                ),
            )

        with contextlib.suppress(sqlite3.Error):
            await self.ctx.db.write(_insert)

    async def list_activity(self, *, limit: int = 50) -> CloudActivityResponse:
        """Read recent `cloud_activity_log` rows ordered newest first."""
        clamped = max(1, min(200, int(limit)))

        def _query(conn: sqlite3.Connection) -> list[CloudActivityEntry]:
            rows = conn.execute(
                "SELECT id, action, provider, account, remote_ref, byte_size, status, detail, "
                "created_at FROM cloud_activity_log ORDER BY id DESC LIMIT ?",
                (clamped,),
            ).fetchall()
            return [
                CloudActivityEntry(
                    id=int(row["id"]),
                    action=str(row["action"]),
                    provider=str(row["provider"]),
                    account=str(row["account"]),
                    remote_ref=str(row["remote_ref"]),
                    byte_size=int(row["byte_size"]),
                    status="error" if row["status"] == "error" else "ok",
                    detail=str(row["detail"]) if row["detail"] is not None else None,
                    created_at=str(row["created_at"]),
                )
                for row in rows
            ]

        entries = await self.ctx.db.read(_query)
        return CloudActivityResponse(activity=entries)

    async def get_status(self) -> CloudStatusResponse:
        """Return decryption-free multi-provider & multi-account status snapshot."""
        config = await self.ctx.security.config.get()
        vault_ids = {item.key_id for item in self.ctx.security.vault.list_secrets()}
        default_provider = resolve_default_provider(config, vault_ids)

        providers_out: list[CloudProviderStatus] = []
        for prov in CLOUD_PROVIDERS:
            has_cid = cloud_vault_key(prov, "client_id") in vault_ids
            has_csec = cloud_vault_key(prov, "client_secret") in vault_ids
            def_acc = resolve_default_account(prov, config, vault_ids)
            keys = discover_cloud_accounts(prov, config, vault_ids)
            raw_accounts_cfg = config.get("accounts")
            accounts_cfg: dict[str, Any] = (
                raw_accounts_cfg if isinstance(raw_accounts_cfg, dict) else {}
            )
            raw_prov_cfg = accounts_cfg.get(prov)
            prov_cfg_map: dict[str, Any] = (
                raw_prov_cfg if isinstance(raw_prov_cfg, dict) else {}
            )

            acc_views: list[CloudAccountStatus] = []
            for acc in keys:
                meta = _account_meta_from_config(config, prov, acc)
                has_refresh = cloud_vault_key(prov, "refresh_token", acc) in vault_ids
                has_custom_client = (
                    acc != DEFAULT_CLOUD_ACCOUNT
                    and cloud_vault_key(prov, "client_id", acc) in vault_ids
                    and cloud_vault_key(prov, "client_secret", acc) in vault_ids
                )
                if (
                    acc != DEFAULT_CLOUD_ACCOUNT
                    and not has_refresh
                    and not has_custom_client
                    and acc not in prov_cfg_map
                ):
                    continue

                needs_reauth = bool(meta.get("needs_reauth", False))
                health: CloudConnectionHealth = (
                    "needs_reauth"
                    if needs_reauth
                    else "connected"
                    if has_refresh
                    else "client_configured"
                    if ((has_cid and has_csec) or has_custom_client)
                    else "disconnected"
                )
                access_mode: CloudAccessMode = (
                    "read_only" if meta.get("access_mode") == "read_only" else "read_write"
                )
                raw_pub = meta.get("allow_public_links")
                allow_pub_val = raw_pub if isinstance(raw_pub, bool) else None
                acc_views.append(
                    CloudAccountStatus(
                        account=acc,
                        label=str(meta.get("label") or acc),
                        is_default=(acc == def_acc),
                        status=health,
                        access_mode=access_mode,
                        has_refresh_token=has_refresh,
                        has_custom_client=has_custom_client,
                        account_email=(
                            str(meta["account_email"]) if meta.get("account_email") else None
                        ),
                        root_ref=str(meta["root_ref"]) if meta.get("root_ref") else None,
                        default_share_email=(
                            str(meta["default_share_email"])
                            if meta.get("default_share_email")
                            else None
                        ),
                        allow_public_links=allow_pub_val,
                        needs_reauth=needs_reauth,
                        last_error=str(meta["last_error"]) if meta.get("last_error") else None,
                    )
                )

            connected_cnt = sum(1 for a in acc_views if a.has_refresh_token and not a.needs_reauth)
            providers_out.append(
                CloudProviderStatus(
                    id=prov,
                    display_name=PROVIDER_DISPLAY_NAMES[prov],
                    has_client_id=has_cid,
                    has_client_secret=has_csec,
                    default_account=def_acc,
                    connected_count=connected_cnt,
                    accounts=acc_views,
                )
            )

        raw_share = config.get("cloud_default_share_email") or os.environ.get(
            "ALFRED_CLOUD_SHARE_EMAIL"
        )
        share_email = (
            str(raw_share).strip()
            if isinstance(raw_share, str) and raw_share.strip()
            else None
        )
        return CloudStatusResponse(
            default_provider=default_provider,
            default_share_email=share_email,
            max_download_mb=self.resolve_max_download_bytes() // (1024 * 1024),
            max_upload_mb=self.resolve_max_upload_bytes() // (1024 * 1024),
            allow_public_links=config.get("cloud_allow_public_links") is True,
            providers=providers_out,
        )

    async def save_config(
        self,
        *,
        default_provider: CloudProviderId | None = None,
        default_share_email: str | None = None,
        allow_public_links: bool | None = None,
        provider: CloudProviderId | None = None,
        account: str | None = None,
        default_account: str | None = None,
        client_id: str | None = None,
        client_secret: str | None = None,
        root_ref: str | None = None,
        label: str | None = None,
        access_mode: CloudAccessMode | None = None,
        account_default_share_email: str | None = None,
        account_allow_public_links: bool | None = None,
    ) -> CloudStatusResponse:
        """Persist cloud storage config in `config_json` and OAuth2 client keys in Vault."""
        acc = normalize_cloud_account(account) if account is not None else DEFAULT_CLOUD_ACCOUNT
        if provider is not None:
            if client_id is not None and client_id.strip():
                await self.ctx.security.vault.set_secret(
                    cloud_vault_key(provider, "client_id", acc),
                    client_id.strip(),
                    label=f"Cloud {provider} ({acc}) Client ID",
                )
            if client_secret is not None and client_secret.strip():
                await self.ctx.security.vault.set_secret(
                    cloud_vault_key(provider, "client_secret", acc),
                    client_secret.strip(),
                    label=f"Cloud {provider} ({acc}) Client Secret",
                )

        config = await self.ctx.security.config.get()
        patch: dict[str, Any] = {}
        if default_provider is not None:
            patch["cloud_default_provider"] = default_provider
        if default_share_email is not None:
            patch["cloud_default_share_email"] = default_share_email.strip() or None
        if allow_public_links is not None:
            patch["cloud_allow_public_links"] = allow_public_links

        if provider is not None:
            if default_account is not None:
                raw_defaults = config.get("provider_defaults")
                defaults: dict[str, Any] = (
                    dict(raw_defaults) if isinstance(raw_defaults, dict) else {}
                )
                defaults[provider] = normalize_cloud_account(default_account)
                patch["provider_defaults"] = defaults

            if any(
                val is not None
                for val in (
                    root_ref,
                    label,
                    access_mode,
                    account_default_share_email,
                    account_allow_public_links,
                )
            ):
                acc_patch: dict[str, Any] = {}
                if label is not None:
                    acc_patch["label"] = label.strip() or acc
                if access_mode is not None:
                    acc_patch["access_mode"] = access_mode
                if root_ref is not None:
                    clean_root = root_ref.strip() or None
                    acc_patch["root_ref"] = clean_root
                    root_key = cloud_vault_key(provider, "root_ref", acc)
                    if clean_root:
                        await self.ctx.security.vault.set_secret(
                            root_key,
                            clean_root,
                            label=f"Cloud {provider} ({acc}) Root Ref",
                        )
                    else:
                        await self.ctx.security.vault.delete_secret(root_key)
                    if acc == DEFAULT_CLOUD_ACCOUNT:
                        patch[f"cloud_{provider}_root_ref"] = clean_root
                if account_default_share_email is not None:
                    acc_patch["default_share_email"] = account_default_share_email.strip() or None
                if account_allow_public_links is not None:
                    acc_patch["allow_public_links"] = account_allow_public_links
                if patch:
                    await self.ctx.security.config.update(patch)
                    patch = {}
                await self._update_account_meta(provider, acc, acc_patch)

        if patch:
            await self.ctx.security.config.update(patch)
        return await self.get_status()

    async def disconnect_account(
        self,
        *,
        provider: CloudProviderId,
        account: str | None = None,
    ) -> CloudStatusResponse:
        """Remove refresh_token/account_email from Vault and clear cached tokens."""
        config = await self.ctx.security.config.get()
        vault_ids = {item.key_id for item in self.ctx.security.vault.list_secrets()}
        acc = (
            normalize_cloud_account(account)
            if account
            else resolve_default_account(provider, config, vault_ids)
        )
        await self.ctx.security.vault.delete_secret(
            cloud_vault_key(provider, "refresh_token", acc)
        )
        await self.ctx.security.vault.delete_secret(
            cloud_vault_key(provider, "account_email", acc)
        )
        self._access_token_cache.pop((provider, acc), None)
        await self._update_account_meta(
            provider,
            acc,
            {"account_email": None, "needs_reauth": False, "last_error": None},
        )
        await self.record_activity(
            action="oauth_disconnect",
            provider=provider,
            account=acc,
            remote_ref=acc,
            status="ok",
        )
        return await self.get_status()

    async def start_oauth(
        self,
        *,
        provider: CloudProviderId | str | None,
        redirect_uri: str,
        account: str | None = None,
        create_new: bool = False,
        label: str | None = None,
        access_mode: CloudAccessMode = "read_write",
    ) -> CloudOAuthStartResponse:
        """Create signed PKCE `S256` state session and return provider authorization URL."""
        config = await self.ctx.security.config.get()
        vault_ids = {item.key_id for item in self.ctx.security.vault.list_secrets()}
        prov = (
            coerce_cloud_provider(provider)
            if provider is not None
            else resolve_default_provider(config, vault_ids)
        )
        if account and account.strip():
            target_account: str | None = normalize_cloud_account(account)
        elif create_new:
            target_account = None
        else:
            target_account = resolve_default_account(prov, config, vault_ids)

        lookup_acc = target_account or DEFAULT_CLOUD_ACCOUNT
        client_id, client_secret = await self._read_client_credentials(prov, lookup_acc)
        if not client_id or not client_secret:
            raise CloudStorageError(
                f"Save OAuth2 client_id and client_secret for '{prov}' in Vault first",
                code="CLOUD_NOT_CONFIGURED",
                status_code=400,
                provider=prov,
            )

        state, challenge = await self.oauth_states.create_session(
            provider=prov,
            account=target_account,
            label=label.strip() if label and label.strip() else None,
            access_mode=access_mode,
            redirect_uri=redirect_uri.strip(),
        )
        adapter = self.get_provider(prov)
        auth_url = adapter.build_authorization_url(
            client_id=client_id,
            redirect_uri=redirect_uri.strip(),
            state=state,
            code_challenge=challenge,
            access_mode=access_mode,
        )
        return CloudOAuthStartResponse(
            ok=True,
            provider=prov,
            account=target_account,
            state=state,
            redirect_uri=redirect_uri.strip(),
            auth_url=auth_url,
            access_mode=access_mode,
            expires_in_sec=600,
        )

    async def complete_oauth_callback(
        self,
        *,
        code: str,
        state: str,
    ) -> CloudOAuthCallbackResult:
        """Verify & consume one-time PKCE state, exchange code, and persist Vault tokens."""
        session = await self.oauth_states.consume_session(state)
        prov = session.provider
        lookup_acc = session.account or DEFAULT_CLOUD_ACCOUNT
        client_id, client_secret = await self._read_client_credentials(prov, lookup_acc)
        if not client_id or not client_secret:
            raise CloudStorageError(
                f"Missing OAuth2 client credentials for '{prov}'",
                code="CLOUD_NOT_CONFIGURED",
                status_code=400,
                provider=prov,
            )

        adapter = self.get_provider(prov)
        tokens = await adapter.exchange_code_for_tokens(
            self.http_client,
            client_id=client_id,
            client_secret=client_secret,
            code=code,
            redirect_uri=session.redirect_uri,
            code_verifier=session.code_verifier,
        )

        quota = CloudQuotaInfo()
        with contextlib.suppress(CloudStorageError):
            quota = await adapter.get_account_quota(
                CloudCallContext(
                    http_client=self.http_client,
                    access_token=tokens.access_token,
                    account=lookup_acc,
                    retry_delays_sec=self.retry_delays_sec,
                    skip_disk_space_check=self.skip_disk_space_check,
                )
            )

        config = await self.ctx.security.config.get()
        vault_ids = {item.key_id for item in self.ctx.security.vault.list_secrets()}
        final_acc = session.account
        if final_acc is None:
            default_tok_key = cloud_vault_key(prov, "refresh_token", DEFAULT_CLOUD_ACCOUNT)
            if default_tok_key not in vault_ids:
                final_acc = DEFAULT_CLOUD_ACCOUNT
            else:
                existing = set(discover_cloud_accounts(prov, config, vault_ids))
                final_acc = _derive_alias_from_email(quota.account_email, existing)

        await self.ctx.security.vault.set_secret(
            cloud_vault_key(prov, "refresh_token", final_acc),
            tokens.refresh_token,
            label=f"Cloud {prov} ({final_acc}) Refresh Token",
        )
        if quota.account_email:
            await self.ctx.security.vault.set_secret(
                cloud_vault_key(prov, "account_email", final_acc),
                quota.account_email,
                label=f"Cloud {prov} ({final_acc}) Account Email",
            )

        self._access_token_cache[(prov, final_acc)] = (
            tokens.access_token,
            time.monotonic() + max(60, tokens.expires_in_sec),
        )
        await self._update_account_meta(
            prov,
            final_acc,
            {
                "label": session.label or final_acc,
                "account_email": quota.account_email,
                "access_mode": session.access_mode,
                "needs_reauth": False,
                "last_error": None,
            },
            set_default_if_missing=True,
        )
        await self.record_activity(
            action="oauth_connect",
            provider=prov,
            account=final_acc,
            remote_ref=quota.account_email or final_acc,
            status="ok",
            detail=f"mode={session.access_mode}",
        )
        return CloudOAuthCallbackResult(
            ok=True,
            provider=prov,
            account=final_acc,
            account_email=quota.account_email,
            access_mode=session.access_mode,
            message=f"Connected {prov}::{final_acc}",
        )

    async def list_files(
        self,
        *,
        provider: CloudProviderId | str | None = None,
        account: str | None = None,
        folder_ref: str | None = None,
        query: str | None = None,
        kind: CloudItemKindFilter = "all",
        limit: int = 50,
    ) -> CloudListResponse:
        """List or search files/folders on the resolved cloud account."""
        target = await self.resolve_target(provider=provider, account=account)
        adapter = self.get_provider(target.provider)
        try:
            call_ctx = await self._build_call_ctx(target)
            resolved_folder = (
                await self._resolve_folder_ref(adapter, call_ctx, folder_ref, create_missing=False)
                if folder_ref
                else None
            )
            items = await adapter.list_items(
                call_ctx,
                folder_ref=resolved_folder,
                query=query,
                kind=kind,
                limit=limit,
            )
            await self.record_activity(
                action="list",
                provider=target.provider,
                account=target.account,
                remote_ref=query or folder_ref or call_ctx.root_ref or "root",
                status="ok",
                detail=f"{len(items)} items",
            )
            return CloudListResponse(provider=target.provider, account=target.account, items=items)
        except Exception as exc:
            if isinstance(exc, CloudReauthRequiredError):
                await self._mark_reauth_state(
                    target.provider,
                    target.account,
                    needs_reauth=True,
                    last_error=exc.message,
                )
            await self.record_activity(
                action="list",
                provider=target.provider,
                account=target.account,
                remote_ref=folder_ref or "root",
                status="error",
                detail=str(exc),
            )
            raise

    async def make_folder(
        self,
        *,
        path_or_name: str,
        parent_ref: str | None = None,
        provider: CloudProviderId | str | None = None,
        account: str | None = None,
    ) -> CloudMkdirResponse:
        """Create one or nested folders inside the resolved writable cloud account."""
        target = await self.resolve_target(provider=provider, account=account)
        self._assert_writable(target)
        adapter = self.get_provider(target.provider)
        try:
            call_ctx = await self._build_call_ctx(target)
            segments = _split_cloud_path_segments(path_or_name)
            if not segments:
                raise CloudStorageError(
                    "Folder name must not be empty",
                    code="CLOUD_API_ERROR",
                    status_code=400,
                    provider=target.provider,
                    account=target.account,
                )
            parent_id: str | None = (
                await self._resolve_folder_ref(adapter, call_ctx, parent_ref, create_missing=True)
                if parent_ref
                else None
            )
            last_folder: CloudItem | None = None
            for seg in segments:
                last_folder = await adapter.mkdir(call_ctx, name=seg, parent_ref=parent_id)
                parent_id = (
                    (last_folder.path_display or last_folder.id)
                    if adapter.provider_id == "dropbox"
                    else last_folder.id
                )
            if last_folder is None:
                raise CloudStorageError("Failed to create folder", code="CLOUD_API_ERROR")
            await self.record_activity(
                action="mkdir",
                provider=target.provider,
                account=target.account,
                remote_ref=path_or_name,
                status="ok",
            )
            return CloudMkdirResponse(
                provider=target.provider,
                account=target.account,
                folder=last_folder,
            )
        except Exception as exc:
            if isinstance(exc, CloudReauthRequiredError):
                await self._mark_reauth_state(
                    target.provider,
                    target.account,
                    needs_reauth=True,
                    last_error=exc.message,
                )
            await self.record_activity(
                action="mkdir",
                provider=target.provider,
                account=target.account,
                remote_ref=path_or_name,
                status="error",
                detail=str(exc),
            )
            raise

    async def upload_file(
        self,
        *,
        local_path: str,
        workspace_dir: Path | None,
        protected_paths: Sequence[str] = (),
        remote_path_or_name: str | None = None,
        parent_ref: str | None = None,
        on_conflict: CloudUploadConflictMode = "update_in_place",
        provider: CloudProviderId | str | None = None,
        account: str | None = None,
        chunk_bytes: int | None = None,
    ) -> tuple[CloudProviderId, str, CloudItem]:
        """Confine path, run fail-closed secret scan, hold if >= 16 MiB, and upload in chunks."""
        resolved_local, rel_display = self.confine_local_path(
            local_path,
            workspace_dir=workspace_dir,
            protected_paths=protected_paths,
            for_upload=True,
        )
        exists, is_file, file_size = await asyncio.to_thread(_stat_file_sync, resolved_local)
        if not exists:
            raise CloudStorageError(
                f"Local file not found: {local_path!r}",
                code="CLOUD_NOT_FOUND",
                status_code=404,
            )
        if not is_file:
            raise CloudStorageError(
                f"Local upload path is not a regular file: {local_path!r}",
                code="CLOUD_API_ERROR",
                status_code=400,
            )

        max_upload = self.resolve_max_upload_bytes()
        if file_size > max_upload:
            raise CloudStorageError(
                f"Local file ({file_size} B) exceeds max upload limit ({max_upload} B)",
                code="CLOUD_UPLOAD_LIMIT_EXCEEDED",
                status_code=413,
            )

        await self._scan_upload_file_fail_closed(resolved_local, rel_display)

        target = await self.resolve_target(provider=provider, account=account)
        self._assert_writable(target)
        adapter = self.get_provider(target.provider)
        raw_remote = (remote_path_or_name or resolved_local.name).strip()

        async def _perform_upload() -> CloudItem:
            call_ctx = await self._build_call_ctx(target)
            resolved_parent: str | None = (
                await self._resolve_folder_ref(adapter, call_ctx, parent_ref, create_missing=True)
                if parent_ref
                else None
            )
            remote_name = raw_remote
            if "/" in raw_remote or "\\" in raw_remote:
                segs = _split_cloud_path_segments(raw_remote)
                remote_name = segs[-1] if segs else resolved_local.name
                sub_dir = "/".join(segs[:-1])
                if sub_dir:
                    combined = f"{parent_ref}/{sub_dir}" if parent_ref else sub_dir
                    resolved_parent = await self._resolve_folder_ref(
                        adapter,
                        call_ctx,
                        combined,
                        create_missing=True,
                    )
            return await adapter.upload_file(
                call_ctx,
                local_path=resolved_local,
                remote_name=remote_name,
                file_size_bytes=file_size,
                mime_type=guess_mime_type(remote_name),
                parent_ref=resolved_parent,
                on_conflict=on_conflict,
                chunk_bytes=chunk_bytes,
            )

        try:
            if file_size >= HEAVY_TRANSFER_HOLD_MIN_BYTES:
                async with self.ctx.heavy_job.hold(
                    f"cloud:upload:{target.provider}:{resolved_local.name}"
                ):
                    item = await _perform_upload()
            else:
                item = await _perform_upload()

            await self.record_activity(
                action="upload",
                provider=target.provider,
                account=target.account,
                remote_ref=item.name or raw_remote,
                byte_size=file_size,
                status="ok",
            )
            return target.provider, target.account, item
        except Exception as exc:
            if isinstance(exc, CloudReauthRequiredError):
                await self._mark_reauth_state(
                    target.provider,
                    target.account,
                    needs_reauth=True,
                    last_error=exc.message,
                )
            await self.record_activity(
                action="upload",
                provider=target.provider,
                account=target.account,
                remote_ref=raw_remote,
                byte_size=file_size,
                status="error",
                detail=str(exc),
            )
            raise

    async def download_file(
        self,
        *,
        file_ref_or_path: str,
        local_dest_path: str,
        workspace_dir: Path | None,
        protected_paths: Sequence[str] = (),
        export_format: str | None = None,
        provider: CloudProviderId | str | None = None,
        account: str | None = None,
    ) -> tuple[CloudProviderId, str, CloudDownloadResult]:
        """Confine destination path, check disk space, and stream to atomic `.part` file."""
        resolved_dest, _ = self.confine_local_path(
            local_dest_path,
            workspace_dir=workspace_dir,
            protected_paths=protected_paths,
            for_upload=False,
        )
        target = await self.resolve_target(provider=provider, account=account)
        adapter = self.get_provider(target.provider)
        max_download = self.resolve_max_download_bytes()

        async def _perform_download() -> CloudDownloadResult:
            call_ctx = await self._build_call_ctx(target)
            resolved_ref = await self._resolve_item_ref(adapter, call_ctx, file_ref_or_path)
            return await adapter.download_file(
                call_ctx,
                file_ref=resolved_ref,
                dest_path=resolved_dest,
                max_download_bytes=max_download,
                export_format=export_format,
            )

        try:
            async with self.ctx.heavy_job.hold(
                f"cloud:download:{target.provider}:{resolved_dest.name}"
            ):
                result = await _perform_download()
            await self.record_activity(
                action="download",
                provider=target.provider,
                account=target.account,
                remote_ref=result.item.name or file_ref_or_path,
                byte_size=result.bytes_written,
                status="ok",
            )
            return target.provider, target.account, result
        except Exception as exc:
            if isinstance(exc, CloudReauthRequiredError):
                await self._mark_reauth_state(
                    target.provider,
                    target.account,
                    needs_reauth=True,
                    last_error=exc.message,
                )
            await self.record_activity(
                action="download",
                provider=target.provider,
                account=target.account,
                remote_ref=file_ref_or_path,
                status="error",
                detail=str(exc),
            )
            raise

    async def share_file(
        self,
        *,
        file_ref_or_path: str,
        email: str | None = None,
        role: CloudShareRole = "reader",
        public_link: bool = False,
        notify: bool = False,
        expires_in_days: int | None = None,
        provider: CloudProviderId | str | None = None,
        account: str | None = None,
    ) -> CloudShareResponse:
        """Share a cloud item while enforcing `cloud_allow_public_links` policy."""
        target = await self.resolve_target(provider=provider, account=account)
        self._assert_writable(target)
        config = await self.ctx.security.config.get()

        if public_link:
            acc_allow = target.meta.get("allow_public_links")
            allowed = (
                acc_allow is True
                if isinstance(acc_allow, bool)
                else config.get("cloud_allow_public_links") is True
            )
            if not allowed:
                raise CloudStorageError(
                    f"Public link sharing is disabled for '{target.provider}::{target.account}' "
                    "(cloud_allow_public_links=false)",
                    code="CLOUD_PUBLIC_LINK_FORBIDDEN",
                    status_code=403,
                    provider=target.provider,
                    account=target.account,
                )
            resolved_email: str | None = None
            effective_notify = False
        else:
            candidates = (
                email,
                target.meta.get("default_share_email"),
                config.get("cloud_default_share_email"),
                os.environ.get("ALFRED_CLOUD_SHARE_EMAIL"),
            )
            chosen = next(
                (str(val).strip() for val in candidates if isinstance(val, str) and val.strip()),
                "",
            )
            if not chosen or not EMAIL_RE.match(chosen):
                raise CloudStorageError(
                    "Share recipient email is required when public_link is disabled",
                    code="CLOUD_SHARE_RECIPIENT_REQUIRED",
                    status_code=400,
                    provider=target.provider,
                    account=target.account,
                )
            resolved_email = chosen
            effective_notify = notify

        adapter = self.get_provider(target.provider)
        try:
            call_ctx = await self._build_call_ctx(target)
            resolved_ref = await self._resolve_item_ref(adapter, call_ctx, file_ref_or_path)
            res = await adapter.share_item(
                call_ctx,
                file_ref=resolved_ref,
                email=resolved_email,
                role=role,
                public_link=public_link,
                notify=effective_notify,
                expires_in_days=expires_in_days,
            )
            await self.record_activity(
                action="share",
                provider=target.provider,
                account=target.account,
                remote_ref=file_ref_or_path,
                status="ok",
                detail=f"{res.mode}:{res.shared_with}",
            )
            return CloudShareResponse(share=res)
        except Exception as exc:
            if isinstance(exc, CloudReauthRequiredError):
                await self._mark_reauth_state(
                    target.provider,
                    target.account,
                    needs_reauth=True,
                    last_error=exc.message,
                )
            await self.record_activity(
                action="share",
                provider=target.provider,
                account=target.account,
                remote_ref=file_ref_or_path,
                status="error",
                detail=str(exc),
            )
            raise

    async def run_housekeeping(
        self,
        *,
        retention_days: int,
        disk_used_pct: float,
    ) -> HousekeepingStats:
        """Prune stale `.part` files under `data_dir` and expired `cloud_activity_log` rows."""
        deleted_parts, freed_bytes = await asyncio.to_thread(
            _prune_stale_part_files_sync,
            self.ctx.security.data_dir.base_dir,
            time.time() - _STALE_PART_AGE_SEC,
        )

        deleted_rows = 0
        if retention_days > 0:
            cutoff_iso = (datetime.now(tz=UTC) - timedelta(days=retention_days)).isoformat()

            def _prune_db(conn: sqlite3.Connection) -> int:
                exists = conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' "
                    "AND name = 'cloud_activity_log'"
                ).fetchone()
                if exists is None:
                    return 0
                cursor = conn.execute(
                    "DELETE FROM cloud_activity_log WHERE created_at < ?",
                    (cutoff_iso,),
                )
                return max(0, int(cursor.rowcount))

            deleted_rows = await self.ctx.db.write(_prune_db)

        return HousekeepingStats(
            module_id=MODULE_ID,
            deleted_rows=deleted_rows,
            freed_bytes=freed_bytes,
            notes=(
                f"pruned {deleted_parts} stale .part file(s) and {deleted_rows} activity row(s) "
                f"(retention={retention_days}d, disk={disk_used_pct:.1f}%)"
            ),
        )


def normalize_cloud_path_dropbox(root_ref: str | None, requested: str | None) -> str:
    """Delegate Dropbox path confinement to `providers.dropbox.normalize_dropbox_confined_path`."""
    return normalize_dropbox_confined_path(root_ref, requested)


def _derive_alias_from_email(email: str | None, existing: set[str]) -> str:
    local = (email or "").strip().lower().split("@")[0]
    cleaned = re.sub(r"[^a-z0-9_-]+", "-", local).strip("-")[:24]
    base = cleaned if cleaned and re.match(r"^[a-z0-9][a-z0-9_-]{0,31}$", cleaned) else "account"
    if base not in existing:
        return base
    for idx in range(2, 100):
        cand = f"{base[:28]}-{idx}"
        if cand not in existing:
            return cand
    return f"acc-{int(time.time()) % 100_000}"
