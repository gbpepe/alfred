"""PKCE S256 generation and signed single-use OAuth2 state store."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import secrets
import time
from dataclasses import dataclass

from .models import OAUTH_STATE_TTL_SEC, CloudAccessMode, CloudProviderId, CloudStorageError


def generate_code_verifier() -> str:
    """Return a high-entropy PKCE `code_verifier` (RFC 7636)."""
    return secrets.token_urlsafe(48)


def compute_s256_challenge(code_verifier: str) -> str:
    """Compute base64url-encoded SHA-256 PKCE `code_challenge` (`S256`)."""
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


@dataclass(slots=True)
class PendingOAuthSession:
    """In-memory single-use PKCE session stored while user authorizes in browser."""

    provider: CloudProviderId
    account: str | None
    label: str | None
    access_mode: CloudAccessMode
    redirect_uri: str
    code_verifier: str
    expires_at_mono: float


class OAuthStateManager:
    """Thread/async-safe signed one-time PKCE `state` store with automatic TTL expiry."""

    def __init__(
        self,
        *,
        signing_secret: bytes | None = None,
        ttl_sec: int = OAUTH_STATE_TTL_SEC,
    ) -> None:
        self._secret = signing_secret if signing_secret is not None else secrets.token_bytes(32)
        self._ttl_sec = max(30, int(ttl_sec))
        self._pending: dict[str, PendingOAuthSession] = {}
        self._lock = asyncio.Lock()

    def _sign_nonce(self, nonce: str) -> str:
        return hmac.new(self._secret, nonce.encode("ascii"), hashlib.sha256).hexdigest()[:24]

    def _purge_expired_locked(self, now_mono: float) -> None:
        expired = [k for k, sess in self._pending.items() if sess.expires_at_mono <= now_mono]
        for key in expired:
            self._pending.pop(key, None)

    async def create_session(
        self,
        *,
        provider: CloudProviderId,
        account: str | None,
        label: str | None,
        access_mode: CloudAccessMode,
        redirect_uri: str,
        ttl_sec: int | None = None,
    ) -> tuple[str, str]:
        """Issue signed one-time `state` and `code_challenge` (`S256`)."""
        nonce = secrets.token_urlsafe(24)
        sig = self._sign_nonce(nonce)
        state = f"{nonce}.{sig}"
        verifier = generate_code_verifier()
        challenge = compute_s256_challenge(verifier)
        effective_ttl = max(1, int(ttl_sec)) if ttl_sec is not None else self._ttl_sec
        now_mono = time.monotonic()

        session = PendingOAuthSession(
            provider=provider,
            account=account,
            label=label,
            access_mode=access_mode,
            redirect_uri=redirect_uri,
            code_verifier=verifier,
            expires_at_mono=now_mono + effective_ttl,
        )
        async with self._lock:
            self._purge_expired_locked(now_mono)
            self._pending[state] = session
        return state, challenge

    async def consume_session(
        self,
        state: str,
        *,
        expected_provider: CloudProviderId | None = None,
    ) -> PendingOAuthSession:
        """Verify signature, enforce TTL, and consume `state` atomically once."""
        clean = state.strip()
        if "." not in clean:
            raise CloudStorageError(
                "Invalid or malformed OAuth2 state token",
                code="CLOUD_OAUTH_STATE_INVALID",
                status_code=400,
            )
        nonce, sig = clean.split(".", 1)
        expected_sig = self._sign_nonce(nonce)
        if not hmac.compare_digest(sig, expected_sig):
            raise CloudStorageError(
                "Invalid OAuth2 state signature",
                code="CLOUD_OAUTH_STATE_INVALID",
                status_code=400,
            )

        now_mono = time.monotonic()
        async with self._lock:
            self._purge_expired_locked(now_mono)
            session = self._pending.pop(clean, None)

        if session is None or session.expires_at_mono <= now_mono:
            raise CloudStorageError(
                "OAuth2 state is unknown, expired, or already used",
                code="CLOUD_OAUTH_STATE_INVALID",
                status_code=400,
            )
        if expected_provider is not None and session.provider != expected_provider:
            raise CloudStorageError(
                "OAuth2 state provider mismatch",
                code="CLOUD_OAUTH_STATE_INVALID",
                status_code=400,
                provider=expected_provider,
            )
        return session

    async def clear(self) -> None:
        """Clear all pending OAuth2 sessions (used on module unload)."""
        async with self._lock:
            self._pending.clear()
