"""Clean Python 3.14 Vault: standard AES-256-GCM (12-byte nonce) + scrypt + fail-closed."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import os
import re
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from alfred.core.env_file import atomic_write_text, ensure_secure_dir

SALT_LEN: Final[int] = 32
NONCE_LEN: Final[int] = 12
KEY_LEN: Final[int] = 32
MASTER_KEY_RAW_LEN: Final[int] = 64
SCRYPT_N: Final[int] = 16384
SCRYPT_R: Final[int] = 8
SCRYPT_P: Final[int] = 1
SCRYPT_MAXMEM: Final[int] = 64 * 1024 * 1024
VAULT_KEY_ID_RE: Final[re.Pattern[str]] = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


class VaultError(Exception):
    """Base error raised for Vault failures."""


class VaultKeyError(VaultError):
    """Fail-closed error when Vault master key or ciphertext integrity fails."""


def validate_vault_key_id(key_id: str) -> str:
    """Enforce strict Vault key identifier format."""
    if not isinstance(key_id, str) or not VAULT_KEY_ID_RE.match(key_id):
        raise ValueError(
            "Vault key_id must match ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$"
        )
    return key_id


class VaultSecretMetadata(BaseModel):
    """Public metadata returned by `list_secrets()` without decrypting."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    key_id: str
    label: str | None = None
    created_at: str
    updated_at: str


class VaultEntry(BaseModel):
    """Persisted encrypted secret record inside `store/vault.json`."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    version: int = 2
    key_id: str
    label: str | None = None
    salt_b64: str
    nonce_b64: str
    ciphertext_b64: str
    created_at: str
    updated_at: str

    def to_metadata(self) -> VaultSecretMetadata:
        """Project encrypted entry to decryption-free metadata DTO."""
        return VaultSecretMetadata(
            key_id=self.key_id,
            label=self.label,
            created_at=self.created_at,
            updated_at=self.updated_at,
        )


class VaultStore(BaseModel):
    """Top-level `store/vault.json` document."""

    model_config = ConfigDict(extra="forbid")

    version: int = 2
    entries: dict[str, VaultEntry] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _validate_entry_keys_match(self) -> VaultStore:
        for dict_key, entry in self.entries.items():
            validate_vault_key_id(dict_key)
            if dict_key != entry.key_id:
                raise ValueError(
                    f"Vault entry key mismatch: '{dict_key}' != '{entry.key_id}'"
                )
        return self


@contextmanager
def _vault_file_lock(lock_path: Path, *, timeout_sec: float = 10.0) -> Iterator[None]:
    """Cross-process exclusive advisory file lock (`fcntl` on POSIX, `msvcrt` on Windows)."""
    ensure_secure_dir(lock_path.parent, mode=0o700)
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        try:
            os.chmod(lock_path, 0o600)
        except OSError:
            pass
        if sys.platform == "win32":
            import msvcrt

            if os.fstat(fd).st_size == 0:
                os.write(fd, b"\x00")
            deadline = time.monotonic() + timeout_sec
            while True:
                os.lseek(fd, 0, os.SEEK_SET)
                try:
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                    break
                except OSError as exc:
                    if time.monotonic() >= deadline:
                        raise VaultError(f"Timed out acquiring vault lock: {lock_path}") from exc
                    time.sleep(0.01)
            try:
                yield
            finally:
                os.lseek(fd, 0, os.SEEK_SET)
                try:
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                except OSError:
                    pass
        else:
            import fcntl

            fcntl.flock(fd, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


def _derive_key_sync(master_key: bytes, salt: bytes) -> bytes:
    return hashlib.scrypt(
        master_key,
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        maxmem=SCRYPT_MAXMEM,
        dklen=KEY_LEN,
    )


def _encrypt_sync(master_key: bytes, key_id: str, plaintext: str) -> tuple[str, str, str]:
    salt = os.urandom(SALT_LEN)
    nonce = os.urandom(NONCE_LEN)
    derived_key = _derive_key_sync(master_key, salt)
    aad = key_id.encode("utf-8")
    ciphertext = AESGCM(derived_key).encrypt(nonce, plaintext.encode("utf-8"), aad)
    return (
        base64.b64encode(salt).decode("ascii"),
        base64.b64encode(nonce).decode("ascii"),
        base64.b64encode(ciphertext).decode("ascii"),
    )


def _decrypt_sync(master_key: bytes, requested_key_id: str, entry: VaultEntry) -> str:
    try:
        salt = base64.b64decode(entry.salt_b64, validate=True)
        nonce = base64.b64decode(entry.nonce_b64, validate=True)
        ciphertext = base64.b64decode(entry.ciphertext_b64, validate=True)
    except ValueError as exc:
        raise VaultKeyError(
            f"Corrupted base64 encoding for vault key '{requested_key_id}'"
        ) from exc
    if len(salt) != SALT_LEN or len(nonce) != NONCE_LEN or len(ciphertext) < 16:
        raise VaultKeyError(f"Malformed vault payload lengths for key '{requested_key_id}'")
    derived_key = _derive_key_sync(master_key, salt)
    aad = requested_key_id.encode("utf-8")
    try:
        plaintext_bytes = AESGCM(derived_key).decrypt(nonce, ciphertext, aad)
    except InvalidTag as exc:
        raise VaultKeyError(
            f"Vault master key mismatch or authentication failure for '{requested_key_id}'"
        ) from exc
    return plaintext_bytes.decode("utf-8")


class VaultManager:
    """Thread-offloaded, fail-closed AES-256-GCM secret store with cross-process lock."""

    def __init__(self, vault_path: Path, key_path: Path) -> None:
        self.vault_path = vault_path
        self.key_path = key_path
        self.lock_path = vault_path.parent / ".vault.lock"
        self._lock = asyncio.Lock()

    def _read_store_sync(self) -> VaultStore:
        if not self.vault_path.exists():
            return VaultStore()
        try:
            raw = self.vault_path.read_text(encoding="utf-8")
            return VaultStore.model_validate_json(raw)
        except (OSError, ValueError, ValidationError) as exc:
            raise VaultKeyError(f"Unable to read or parse vault file: {exc}") from exc

    def _read_master_key_file_sync(self) -> bytes:
        try:
            raw = self.key_path.read_text(encoding="ascii").strip()
            master = base64.b64decode(raw, validate=True)
        except (OSError, ValueError) as exc:
            raise VaultKeyError("Vault master key file is missing or unreadable") from exc
        if len(master) != MASTER_KEY_RAW_LEN:
            raise VaultKeyError("Vault master key length is invalid")
        return master

    def _create_master_key_exclusive_sync(self) -> bytes:
        ensure_secure_dir(self.key_path.parent, mode=0o700)
        master = os.urandom(MASTER_KEY_RAW_LEN)
        encoded = base64.b64encode(master).decode("ascii") + "\n"
        try:
            fd = os.open(self.key_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            return self._read_master_key_file_sync()
        try:
            with os.fdopen(fd, "w", encoding="ascii") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            try:
                os.chmod(self.key_path, 0o600)
            except OSError:
                pass
            return master
        except BaseException:
            try:
                self.key_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise

    def _resolve_master_key_sync(self, store: VaultStore, *, create_if_empty: bool) -> bytes:
        if store.entries:
            if not self.key_path.exists():
                raise VaultKeyError(
                    "Vault contains encrypted secrets but '.vault-key' is missing (fail-closed)"
                )
            master = self._read_master_key_file_sync()
            first_key, first_entry = next(iter(store.entries.items()))
            _decrypt_sync(master, first_key, first_entry)
            return master

        if self.key_path.exists():
            return self._read_master_key_file_sync()

        if not create_if_empty:
            raise VaultKeyError("Vault master key '.vault-key' does not exist")

        return self._create_master_key_exclusive_sync()

    def _initialize_sync(self) -> None:
        with _vault_file_lock(self.lock_path):
            store = self._read_store_sync()
            if store.entries or self.key_path.exists():
                self._resolve_master_key_sync(store, create_if_empty=False)

    async def initialize(self) -> None:
        """Verify vault integrity on startup (fails closed on key/entry mismatch)."""
        async with self._lock:
            await asyncio.to_thread(self._initialize_sync)

    def list_secrets(self) -> list[VaultSecretMetadata]:
        """List stored secret metadata without deriving keys or decrypting ciphertexts."""
        if not self.vault_path.exists():
            return []
        with _vault_file_lock(self.lock_path):
            store = self._read_store_sync()
            return [store.entries[key].to_metadata() for key in sorted(store.entries.keys())]

    def _has_secret_sync(self, key_id: str) -> bool:
        with _vault_file_lock(self.lock_path):
            store = self._read_store_sync()
            return key_id in store.entries

    async def has_secret(self, key_id: str) -> bool:
        """Check whether a secret key exists without decrypting."""
        validate_vault_key_id(key_id)
        return await asyncio.to_thread(self._has_secret_sync, key_id)

    def _set_secret_sync(
        self,
        key_id: str,
        value: str,
        label: str | None,
    ) -> VaultSecretMetadata:
        with _vault_file_lock(self.lock_path):
            store = self._read_store_sync()
            master = self._resolve_master_key_sync(store, create_if_empty=True)
            salt_b64, nonce_b64, ciphertext_b64 = _encrypt_sync(master, key_id, value)
            now = datetime.now(tz=UTC).isoformat()
            prev = store.entries.get(key_id)
            entry = VaultEntry(
                version=2,
                key_id=key_id,
                label=label if label is not None else (prev.label if prev else None),
                salt_b64=salt_b64,
                nonce_b64=nonce_b64,
                ciphertext_b64=ciphertext_b64,
                created_at=prev.created_at if prev else now,
                updated_at=now,
            )
            store.entries[key_id] = entry
            atomic_write_text(
                self.vault_path,
                store.model_dump_json(indent=2) + "\n",
                mode=0o600,
                dir_mode=0o700,
            )
            return entry.to_metadata()

    async def set_secret(
        self,
        key_id: str,
        value: str,
        *,
        label: str | None = None,
    ) -> VaultSecretMetadata:
        """Encrypt and persist a secret atomically with `0o600` permissions."""
        validate_vault_key_id(key_id)
        async with self._lock:
            return await asyncio.to_thread(self._set_secret_sync, key_id, value, label)

    def _get_secret_sync(self, key_id: str) -> str | None:
        with _vault_file_lock(self.lock_path):
            store = self._read_store_sync()
            entry = store.entries.get(key_id)
            if entry is None:
                return None
            if not self.key_path.exists():
                raise VaultKeyError(
                    "Vault contains encrypted secrets but '.vault-key' is missing (fail-closed)"
                )
            master = self._read_master_key_file_sync()
            return _decrypt_sync(master, key_id, entry)

    async def get_secret(self, key_id: str) -> str | None:
        """Decrypt and return a stored secret value, or `None` if absent."""
        validate_vault_key_id(key_id)
        async with self._lock:
            return await asyncio.to_thread(self._get_secret_sync, key_id)

    def _delete_secret_sync(self, key_id: str) -> bool:
        with _vault_file_lock(self.lock_path):
            store = self._read_store_sync()
            if key_id not in store.entries:
                return False
            del store.entries[key_id]
            atomic_write_text(
                self.vault_path,
                store.model_dump_json(indent=2) + "\n",
                mode=0o600,
                dir_mode=0o700,
            )
            return True

    async def delete_secret(self, key_id: str) -> bool:
        """Delete a secret entry atomically if present."""
        validate_vault_key_id(key_id)
        async with self._lock:
            return await asyncio.to_thread(self._delete_secret_sync, key_id)
