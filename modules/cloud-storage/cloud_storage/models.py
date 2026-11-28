"""Boundary DTOs, constants, Vault key helpers, and exceptions for `cloud-storage`."""

from __future__ import annotations

import mimetypes
import re
from collections.abc import Mapping
from collections.abc import Set as AbstractSet
from pathlib import Path
from typing import Any, Final, Literal

from pydantic import BaseModel, ConfigDict, Field

from alfred.kernel.errors import ModuleError

MODULE_ID: Final[str] = "cloud-storage"
DEFAULT_CLOUD_ACCOUNT: Final[str] = "default"
CLOUD_PROVIDERS: Final[tuple[CloudProviderId, ...]] = ("gdrive", "onedrive", "dropbox")

DEFAULT_CLOUD_CHUNK_BYTES: Final[int] = 8 * 1024 * 1024  # 8_388_608 B (8 MiB)
ONEDRIVE_CHUNK_ALIGNMENT: Final[int] = 320 * 1024  # 327_680 B (320 KiB)
ONEDRIVE_CHUNK_BYTES: Final[int] = 25 * ONEDRIVE_CHUNK_ALIGNMENT  # 8_192_000 B
MIN_FREE_DISK_RESERVE_BYTES: Final[int] = 512 * 1024 * 1024  # 512 MiB
HEAVY_TRANSFER_HOLD_MIN_BYTES: Final[int] = 16 * 1024 * 1024  # 16 MiB
DOWNLOAD_STREAM_ITER_BYTES: Final[int] = 65_536  # 64 KiB
DEFAULT_MAX_DOWNLOAD_MB: Final[int] = 250
DEFAULT_MAX_UPLOAD_MB: Final[int] = 500
OAUTH_STATE_TTL_SEC: Final[int] = 600

SAFE_CLOUD_ACCOUNT_RE: Final[re.Pattern[str]] = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
EMAIL_RE: Final[re.Pattern[str]] = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_NAMED_VAULT_KEY_RE: Final[re.Pattern[str]] = re.compile(
    r"^([a-z0-9][a-z0-9_-]{0,31})_(?:client_id|client_secret|refresh_token|account_email|root_ref)$"
)

CLOUD_CLI_ENV_SANITIZE_KEYS: Final[tuple[str, ...]] = (
    "cloud_gdrive_client_id",
    "cloud_gdrive_client_secret",
    "cloud_gdrive_refresh_token",
    "cloud_onedrive_client_id",
    "cloud_onedrive_client_secret",
    "cloud_onedrive_refresh_token",
    "cloud_dropbox_client_id",
    "cloud_dropbox_client_secret",
    "cloud_dropbox_refresh_token",
    "CLOUD_GDRIVE_CLIENT_SECRET",
    "CLOUD_GDRIVE_REFRESH_TOKEN",
    "CLOUD_ONEDRIVE_CLIENT_SECRET",
    "CLOUD_ONEDRIVE_REFRESH_TOKEN",
    "CLOUD_DROPBOX_CLIENT_SECRET",
    "CLOUD_DROPBOX_REFRESH_TOKEN",
    "ALFRED_CLOUD_SHARE_EMAIL",
)

CloudProviderId = Literal["gdrive", "onedrive", "dropbox"]
CloudVaultField = Literal[
    "client_id",
    "client_secret",
    "refresh_token",
    "account_email",
    "root_ref",
]
CloudAccessMode = Literal["read_write", "read_only"]
CloudUploadConflictMode = Literal["update_in_place", "autorename", "fail"]
CloudItemKindFilter = Literal["all", "file", "folder"]
CloudShareRole = Literal["reader", "writer"]
CloudShareMode = Literal["email", "public_link"]
CloudConnectionHealth = Literal[
    "disconnected",
    "client_configured",
    "connected",
    "needs_reauth",
    "error",
]

PROVIDER_DISPLAY_NAMES: Final[dict[CloudProviderId, str]] = {
    "gdrive": "Google Drive",
    "onedrive": "Microsoft OneDrive",
    "dropbox": "Dropbox",
}


class CloudStorageError(ModuleError):
    """Structured error raised by `cloud-storage` providers, engine, or routes."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "CLOUD_ERROR",
        status_code: int = 400,
        provider: CloudProviderId | None = None,
        account: str | None = None,
    ) -> None:
        super().__init__(
            message,
            code=code,
            module_id=MODULE_ID,
            status_code=status_code,
        )
        self.provider = provider
        self.account = account


class CloudReauthRequiredError(CloudStorageError):
    """Raised when OAuth2 refresh token is expired or revoked (fail-closed)."""

    def __init__(
        self,
        provider: CloudProviderId,
        account: str,
        detail: str | None = None,
    ) -> None:
        suffix = f" ({detail})" if detail else ""
        super().__init__(
            f"Cloud account '{provider}::{account}' requires re-authentication{suffix}",
            code="CLOUD_NEEDS_REAUTH",
            status_code=401,
            provider=provider,
            account=account,
        )


def coerce_cloud_provider(raw: str) -> CloudProviderId:
    """Validate and narrow a raw provider identifier to `CloudProviderId`."""
    clean = raw.strip().lower()
    if clean == "gdrive":
        return "gdrive"
    if clean == "onedrive":
        return "onedrive"
    if clean == "dropbox":
        return "dropbox"
    raise CloudStorageError(
        f"Invalid cloud provider '{raw}'. Allowed: gdrive, onedrive, dropbox.",
        code="CLOUD_INVALID_PROVIDER",
        status_code=400,
    )


def normalize_cloud_account(raw: str | None) -> str:
    """Validate and normalize a cloud account alias (empty -> `'default'`)."""
    clean = (raw or "").strip().lower()
    if not clean:
        return DEFAULT_CLOUD_ACCOUNT
    if not SAFE_CLOUD_ACCOUNT_RE.match(clean):
        raise CloudStorageError(
            f"Invalid cloud account alias '{raw}'",
            code="CLOUD_INVALID_ACCOUNT",
            status_code=400,
        )
    return clean


def cloud_vault_key(
    provider: CloudProviderId,
    field: CloudVaultField,
    account: str | None = None,
) -> str:
    """Return canonical Vault key (`cloud_{provider}_{field}` or `...__{account}_{field}`)."""
    norm_acc = normalize_cloud_account(account)
    if norm_acc == DEFAULT_CLOUD_ACCOUNT:
        return f"cloud_{provider}_{field}"
    return f"cloud_{provider}__{norm_acc}_{field}"


def discover_cloud_accounts(
    provider: CloudProviderId,
    config: Mapping[str, Any],
    vault_key_ids: AbstractSet[str],
) -> list[str]:
    """Collect configured/Vault-backed account aliases for `provider` (`default` first)."""
    accounts: set[str] = {DEFAULT_ACCOUNT_ALIAS}
    raw_accounts = config.get("accounts")
    if isinstance(raw_accounts, Mapping):
        prov_map = raw_accounts.get(provider)
        if isinstance(prov_map, Mapping):
            for key in prov_map:
                if isinstance(key, str) and SAFE_CLOUD_ACCOUNT_RE.match(key):
                    accounts.add(key)

    named_prefix = f"cloud_{provider}__"
    for vid in vault_key_ids:
        if not vid.startswith(named_prefix):
            continue
        match = _NAMED_VAULT_KEY_RE.match(vid[len(named_prefix) :])
        if match is not None:
            accounts.add(match.group(1))

    raw_defaults = config.get("provider_defaults")
    if isinstance(raw_defaults, Mapping):
        default_acc = raw_defaults.get(provider)
        if isinstance(default_acc, str) and SAFE_CLOUD_ACCOUNT_RE.match(default_acc):
            accounts.add(default_acc)

    return sorted(
        accounts,
        key=lambda a: (0, "") if a == DEFAULT_CLOUD_ACCOUNT else (1, a),
    )


DEFAULT_ACCOUNT_ALIAS: Final[str] = DEFAULT_CLOUD_ACCOUNT


def resolve_default_account(
    provider: CloudProviderId,
    config: Mapping[str, Any],
    vault_key_ids: AbstractSet[str],
) -> str:
    """Select default account for `provider` without switching away from explicit defaults."""
    raw_defaults = config.get("provider_defaults")
    if isinstance(raw_defaults, Mapping):
        explicit = raw_defaults.get(provider)
        if isinstance(explicit, str) and SAFE_CLOUD_ACCOUNT_RE.match(explicit):
            return explicit

    if cloud_vault_key(provider, "refresh_token", DEFAULT_CLOUD_ACCOUNT) in vault_key_ids:
        return DEFAULT_CLOUD_ACCOUNT

    for acc in discover_cloud_accounts(provider, config, vault_key_ids):
        if cloud_vault_key(provider, "refresh_token", acc) in vault_key_ids:
            return acc
    return DEFAULT_CLOUD_ACCOUNT


def resolve_default_provider(
    config: Mapping[str, Any],
    vault_key_ids: AbstractSet[str],
) -> CloudProviderId:
    """Select default cloud provider from module config or connected Vault tokens."""
    raw_default = config.get("cloud_default_provider")
    if isinstance(raw_default, str):
        clean = raw_default.strip().lower()
        if clean == "gdrive":
            return "gdrive"
        if clean == "onedrive":
            return "onedrive"
        if clean == "dropbox":
            return "dropbox"

    for prov in CLOUD_PROVIDERS:
        for acc in discover_cloud_accounts(prov, config, vault_key_ids):
            if cloud_vault_key(prov, "refresh_token", acc) in vault_key_ids:
                return prov
    return "gdrive"


def compute_quota_pct(used_bytes: int | None, total_bytes: int | None) -> float | None:
    """Compute bounded percentage `(0.0..100.0)` when both quota numbers are known."""
    if used_bytes is None or total_bytes is None or total_bytes <= 0:
        return None
    pct = round((used_bytes / total_bytes) * 100.0, 1)
    return max(0.0, min(100.0, pct))


def guess_mime_type(filename: str) -> str:
    """Infer MIME type from filename extension with `application/octet-stream` fallback."""
    ext = Path(filename).suffix.lower()
    explicit: dict[str, str] = {
        ".md": "text/markdown",
        ".jsonl": "application/x-ndjson",
        ".webp": "image/webp",
    }
    if ext in explicit:
        return explicit[ext]
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or "application/octet-stream"


def is_invalid_grant_error(status_code: int, body_text: str) -> bool:
    """Detect OAuth2 revoked/expired token responses requiring re-authentication."""
    lower = body_text.lower()
    if status_code == 401 and any(
        marker in lower
        for marker in (
            "invalid_token",
            "expired_access_token",
            "invalid_grant",
            "token",
            "unauthorized",
        )
    ):
        return True
    return any(
        marker in lower
        for marker in (
            "invalid_grant",
            "expired_token",
            "token has been expired or revoked",
            "aadsts70000",
            "aadsts50173",
            "invalid_refresh_token",
        )
    )


class CloudItem(BaseModel):
    """Normalized file or folder metadata returned across all cloud providers."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str
    name: str
    kind: Literal["file", "folder"]
    size_bytes: int | None = Field(default=None, alias="sizeBytes")
    mime_type: str | None = Field(default=None, alias="mimeType")
    modified_at: str | None = Field(default=None, alias="modifiedAt")
    web_url: str | None = Field(default=None, alias="webUrl")
    parent_ref: str | None = Field(default=None, alias="parentRef")
    path_display: str | None = Field(default=None, alias="pathDisplay")
    checksum: str | None = None


class CloudQuotaInfo(BaseModel):
    """Account email and storage quota details."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    account_email: str | None = Field(default=None, alias="accountEmail")
    display_name: str | None = Field(default=None, alias="displayName")
    used_bytes: int | None = Field(default=None, alias="usedBytes")
    total_bytes: int | None = Field(default=None, alias="totalBytes")
    used_pct: float | None = Field(default=None, alias="usedPct")


class CloudTokenBundle(BaseModel):
    """OAuth2 authorization code exchange output."""

    model_config = ConfigDict(extra="forbid")

    access_token: str
    refresh_token: str
    expires_in_sec: int = 3600


class CloudRefreshResult(BaseModel):
    """OAuth2 refresh token exchange output."""

    model_config = ConfigDict(extra="forbid")

    access_token: str
    rotated_refresh_token: str | None = None
    expires_in_sec: int = 3600


class CloudDownloadResult(BaseModel):
    """Verified streaming download outcome."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    item: CloudItem
    bytes_written: int = Field(alias="bytesWritten", ge=0)
    saved_path: str = Field(alias="savedPath")
    exported_mime_type: str | None = Field(default=None, alias="exportedMimeType")


class CloudShareResult(BaseModel):
    """Normalized sharing result across Google Drive, OneDrive, and Dropbox."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    provider: CloudProviderId
    account: str
    item_id: str = Field(alias="itemId")
    web_url: str = Field(alias="webUrl")
    mode: CloudShareMode
    shared_with: str = Field(alias="sharedWith")
    role: CloudShareRole
    notified: bool
    expires_at: str | None = Field(default=None, alias="expiresAt")


class CloudActivityEntry(BaseModel):
    """Single audit row from `cloud_activity_log`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: int
    action: str
    provider: str
    account: str
    remote_ref: str = Field(alias="remoteRef")
    byte_size: int = Field(alias="byteSize")
    status: Literal["ok", "error"]
    detail: str | None = None
    created_at: str = Field(alias="createdAt")


class CloudAccountStatus(BaseModel):
    """Decryption-free status view of one configured cloud account."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    account: str
    label: str
    is_default: bool = Field(alias="isDefault")
    status: CloudConnectionHealth
    access_mode: CloudAccessMode = Field(alias="accessMode")
    has_refresh_token: bool = Field(alias="hasRefreshToken")
    has_custom_client: bool = Field(alias="hasCustomClient")
    account_email: str | None = Field(default=None, alias="accountEmail")
    root_ref: str | None = Field(default=None, alias="rootRef")
    default_share_email: str | None = Field(default=None, alias="defaultShareEmail")
    allow_public_links: bool | None = Field(default=None, alias="allowPublicLinks")
    needs_reauth: bool = Field(alias="needsReauth")
    last_error: str | None = Field(default=None, alias="lastError")


class CloudProviderStatus(BaseModel):
    """Per-provider status aggregated for `GET /api/cloud/status`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: CloudProviderId
    display_name: str = Field(alias="displayName")
    has_client_id: bool = Field(alias="hasClientId")
    has_client_secret: bool = Field(alias="hasClientSecret")
    default_account: str = Field(alias="defaultAccount")
    connected_count: int = Field(alias="connectedCount")
    accounts: list[CloudAccountStatus] = Field(default_factory=list)


class CloudStatusResponse(BaseModel):
    """Response DTO for `GET /api/cloud/status`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    default_provider: CloudProviderId = Field(alias="defaultProvider")
    default_share_email: str | None = Field(default=None, alias="defaultShareEmail")
    max_download_mb: int = Field(alias="maxDownloadMb")
    max_upload_mb: int = Field(alias="maxUploadMb")
    allow_public_links: bool = Field(alias="allowPublicLinks")
    providers: list[CloudProviderStatus] = Field(default_factory=list)


class CloudActivityResponse(BaseModel):
    """Response DTO for `GET /api/cloud/activity`."""

    model_config = ConfigDict(extra="forbid")

    activity: list[CloudActivityEntry] = Field(default_factory=list)


class CloudListResponse(BaseModel):
    """Response DTO for `GET /api/cloud/list`."""

    model_config = ConfigDict(extra="forbid")

    provider: CloudProviderId
    account: str
    items: list[CloudItem] = Field(default_factory=list)


class CloudMkdirResponse(BaseModel):
    """Response DTO for `POST /api/cloud/mkdir`."""

    model_config = ConfigDict(extra="forbid")

    provider: CloudProviderId
    account: str
    folder: CloudItem


class CloudShareResponse(BaseModel):
    """Response DTO for `POST /api/cloud/share`."""

    model_config = ConfigDict(extra="forbid")

    share: CloudShareResult


class CloudOAuthStartResponse(BaseModel):
    """Response DTO for `GET /api/cloud/oauth/start` (never leaks secrets or PKCE verifier)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    ok: bool = True
    provider: CloudProviderId
    account: str | None = None
    state: str
    redirect_uri: str = Field(alias="redirectUri")
    auth_url: str = Field(alias="authUrl")
    access_mode: CloudAccessMode = Field(alias="accessMode")
    expires_in_sec: int = Field(alias="expiresInSec")


class CloudOAuthCallbackResult(BaseModel):
    """Safe response DTO for OAuth2 callback (never exposes access or refresh tokens)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    ok: bool = True
    provider: CloudProviderId
    account: str
    account_email: str | None = Field(default=None, alias="accountEmail")
    access_mode: CloudAccessMode = Field(alias="accessMode")
    message: str
