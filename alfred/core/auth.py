"""Central authentication and CSRF verification gate (`Bearer`, Dashboard session, OAuth)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Final, Literal

from fastapi import Request
from pydantic import BaseModel, ConfigDict

AuthLevel = Literal["admin", "dashboard", "public_oauth_callback"]

_SAFE_HTTP_METHODS: Final[frozenset[str]] = frozenset({"GET", "HEAD", "OPTIONS"})


class AuthPrincipal(BaseModel):
    """Authenticated caller identity attached to a verified HTTP request."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["bearer", "dashboard_session", "public"]
    subject: str
    role: Literal["admin", "dashboard", "public"]


class AuthError(Exception):
    """Raised when HTTP authentication or CSRF verification fails."""

    def __init__(self, *, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


class AuthService:
    """Verifies constant-time Bearer tokens and HMAC-signed Dashboard sessions + CSRF."""

    def __init__(
        self,
        *,
        admin_token: str,
        session_secret: bytes | None = None,
        session_cookie_name: str = "alfred_session",
        csrf_header_name: str = "X-CSRF-Token",
        default_ttl_sec: int = 86400,
    ) -> None:
        if not admin_token:
            raise ValueError("admin_token must not be empty")
        self._admin_token = admin_token
        self._session_secret = (
            session_secret
            if session_secret is not None
            else hashlib.sha256(b"alfred-v2-session:" + admin_token.encode("utf-8")).digest()
        )
        self.session_cookie_name = session_cookie_name
        self.csrf_header_name = csrf_header_name
        self.default_ttl_sec = default_ttl_sec

    def _sign(self, payload_b64: str) -> str:
        return hmac.new(
            self._session_secret,
            payload_b64.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

    def issue_dashboard_session(
        self,
        *,
        subject: str = "dashboard",
        role: Literal["admin", "dashboard"] = "admin",
        ttl_sec: int | None = None,
    ) -> tuple[str, str]:
        """Issue an HMAC-signed session cookie value paired with its CSRF token."""
        csrf = secrets.token_urlsafe(24)
        exp = int(time.time()) + (ttl_sec if ttl_sec is not None else self.default_ttl_sec)
        payload = json.dumps(
            {"sub": subject, "role": role, "exp": exp, "csrf": csrf},
            separators=(",", ":"),
        ).encode("utf-8")
        payload_b64 = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
        sig = self._sign(payload_b64)
        return f"{payload_b64}.{sig}", csrf

    def _verify_session_cookie(
        self,
        cookie_val: str,
    ) -> tuple[str, Literal["admin", "dashboard"], str]:
        if not cookie_val or not cookie_val.isascii() or "." not in cookie_val:
            raise AuthError(status_code=401, code="INVALID_SESSION", message="Malformed session")
        payload_b64, sig = cookie_val.split(".", 1)
        expected_sig = self._sign(payload_b64)
        if not hmac.compare_digest(sig.encode("utf-8"), expected_sig.encode("utf-8")):
            raise AuthError(
                status_code=401,
                code="INVALID_SESSION",
                message="Invalid session signature",
            )
        padding = "=" * (-len(payload_b64) % 4)
        try:
            decoded = base64.urlsafe_b64decode(payload_b64 + padding)
            data = json.loads(decoded.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise AuthError(
                status_code=401,
                code="INVALID_SESSION",
                message="Corrupt session payload",
            ) from exc
        if not isinstance(data, dict):
            raise AuthError(status_code=401, code="INVALID_SESSION", message="Invalid session")
        exp = data.get("exp")
        sub = data.get("sub")
        role = data.get("role")
        csrf = data.get("csrf")
        if (
            not isinstance(exp, int)
            or exp < int(time.time())
            or not isinstance(sub, str)
            or role not in ("admin", "dashboard")
            or not isinstance(csrf, str)
        ):
            raise AuthError(status_code=401, code="EXPIRED_SESSION", message="Session expired")
        resolved_role: Literal["admin", "dashboard"] = "admin" if role == "admin" else "dashboard"
        return sub, resolved_role, csrf

    def verify_request(self, request: Request, level: AuthLevel) -> AuthPrincipal:
        """Enforce authentication and CSRF checks matching the route's security level."""
        if level == "public_oauth_callback":
            return AuthPrincipal(kind="public", subject="oauth-callback", role="public")

        auth_header = request.headers.get("authorization")
        if auth_header is not None:
            scheme, _, token = auth_header.partition(" ")
            if scheme.lower() != "bearer" or not token:
                raise AuthError(
                    status_code=401,
                    code="INVALID_TOKEN",
                    message="Invalid authorization header",
                )
            if hmac.compare_digest(
                token.encode("utf-8"),
                self._admin_token.encode("utf-8"),
            ):
                return AuthPrincipal(kind="bearer", subject="admin-token", role="admin")
            raise AuthError(
                status_code=401,
                code="INVALID_TOKEN",
                message="Invalid bearer token",
            )

        cookie_val = request.cookies.get(self.session_cookie_name)
        if not cookie_val:
            raise AuthError(
                status_code=401,
                code="UNAUTHORIZED",
                message="Authentication required",
            )

        sub, role, expected_csrf = self._verify_session_cookie(cookie_val)
        if level == "admin" and role != "admin":
            raise AuthError(status_code=403, code="FORBIDDEN", message="Admin access required")

        if request.method.upper() not in _SAFE_HTTP_METHODS:
            provided_csrf = request.headers.get(self.csrf_header_name, "")
            if not provided_csrf or not hmac.compare_digest(
                provided_csrf.encode("utf-8"),
                expected_csrf.encode("utf-8"),
            ):
                raise AuthError(
                    status_code=403,
                    code="CSRF_FAILED",
                    message="Missing or invalid CSRF token",
                )

        return AuthPrincipal(kind="dashboard_session", subject=sub, role=role)
