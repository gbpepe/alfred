"""SDK-free Google Service Account RS256 JWT signing & OAuth2 access_token cache."""

from __future__ import annotations

import asyncio
import base64
import json
import time
from collections.abc import Callable

import httpx
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from pydantic import BaseModel, ConfigDict, Field

_GOOGLE_OAUTH_ENDPOINT = "https://oauth2.googleapis.com/token"


class GcpAuthError(Exception):
    """Raised when Google Service Account signing or OAuth2 exchange fails."""


class ServiceAccountCredentials(BaseModel):
    """Google Cloud Service Account JSON fields needed for RS256 JWT assertion."""

    model_config = ConfigDict(extra="ignore")

    client_email: str = Field(min_length=3)
    private_key: str = Field(min_length=20)
    token_uri: str = _GOOGLE_OAUTH_ENDPOINT
    project_id: str | None = None


class _CachedAccessToken(BaseModel):
    model_config = ConfigDict(extra="forbid")

    access_token: str
    expires_at: float


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


class GcpTokenProvider:
    """Issues cached OAuth2 access tokens via `cryptography` RS256 + `httpx.AsyncClient`."""

    def __init__(
        self,
        credentials: ServiceAccountCredentials,
        *,
        scopes: tuple[str, ...] = ("https://www.googleapis.com/auth/cloud-platform",),
        http_client: httpx.AsyncClient | None = None,
        refresh_margin_sec: int = 120,
        clock: Callable[[], float] | None = None,
        monotonic_clock: Callable[[], float] | None = None,
    ) -> None:
        self.credentials = credentials
        self.scopes = scopes
        self._http_client = http_client
        self._refresh_margin_sec = refresh_margin_sec
        self._clock = clock or time.time
        self._mono_clock = monotonic_clock or (clock if clock is not None else time.monotonic)
        self._lock = asyncio.Lock()
        self._cached: _CachedAccessToken | None = None
        loaded_key = serialization.load_pem_private_key(
            credentials.private_key.encode("utf-8"),
            password=None,
        )
        if not isinstance(loaded_key, rsa.RSAPrivateKey):
            raise GcpAuthError("Service account private_key must be an RSA private key")
        self._rsa_key: rsa.RSAPrivateKey = loaded_key

    def build_signed_jwt(self, *, now: float | None = None) -> str:
        """Build an RS256-signed JWT assertion for Google OAuth2 token exchange."""
        issued_at = int(now if now is not None else self._clock())
        header = {"alg": "RS256", "typ": "JWT"}
        claims = {
            "iss": self.credentials.client_email,
            "sub": self.credentials.client_email,
            "aud": self.credentials.token_uri,
            "scope": " ".join(self.scopes),
            "iat": issued_at,
            "exp": issued_at + 3600,
        }
        signing_input = (
            _b64url(json.dumps(header, separators=(",", ":")).encode("utf-8"))
            + "."
            + _b64url(json.dumps(claims, separators=(",", ":")).encode("utf-8"))
        ).encode("ascii")
        signature = self._rsa_key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
        return f"{signing_input.decode('ascii')}.{_b64url(signature)}"

    async def get_access_token(self) -> str:
        """Return valid cached OAuth2 access token or exchange a fresh RS256 JWT via `httpx`."""
        async with self._lock:
            mono_now = self._mono_clock()
            if (
                self._cached is not None
                and self._cached.expires_at - mono_now > self._refresh_margin_sec
            ):
                return self._cached.access_token

            assertion = self.build_signed_jwt(now=self._clock())
            owns_client = self._http_client is None
            client = self._http_client or httpx.AsyncClient(timeout=15.0)
            try:
                resp = await client.post(
                    self.credentials.token_uri,
                    data={
                        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                        "assertion": assertion,
                    },
                )
            except httpx.HTTPError as exc:
                raise GcpAuthError(f"GCP OAuth2 HTTP request failed: {exc}") from exc
            finally:
                if owns_client:
                    await client.aclose()

            if resp.status_code != 200:
                raise GcpAuthError(
                    f"GCP OAuth2 exchange failed (HTTP {resp.status_code}): {resp.text[:200]}"
                )
            payload = resp.json()
            token = payload.get("access_token")
            expires_in_raw = payload.get("expires_in", 3600)
            try:
                expires_in = max(60, min(int(expires_in_raw), 86400))
            except (TypeError, ValueError):
                expires_in = 3600
            if not isinstance(token, str) or not token:
                raise GcpAuthError("GCP OAuth2 response omitted access_token")
            self._cached = _CachedAccessToken(
                access_token=token,
                expires_at=mono_now + expires_in,
            )
            return token
