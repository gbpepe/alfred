"""Shared pytest fixtures for fast functional tests without weakening crypto coverage."""

from __future__ import annotations

import pytest

from alfred.core import vault as vault_mod


@pytest.fixture(autouse=True)
def _fast_vault_scrypt_for_tests(
    request: pytest.FixtureRequest,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Keep real production `SCRYPT_N=16384` in Vault crypto test, use `16` elsewhere."""
    if request.node.name == "test_vault_aad_tamper_corrupt_concurrency_and_fail_closed":
        assert vault_mod.SCRYPT_N == 16384
        return
    monkeypatch.setattr(vault_mod, "SCRYPT_N", 16)
