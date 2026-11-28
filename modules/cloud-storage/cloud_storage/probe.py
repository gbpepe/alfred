"""0-token lightweight Setup Wizard probe for `cloud-storage` (never imports `plugin.py`)."""

from __future__ import annotations

from alfred.kernel.types import ModuleContext, ProbeCheck, ProbeResult

from .models import (
    CLOUD_PROVIDERS,
    PROVIDER_DISPLAY_NAMES,
    cloud_vault_key,
    discover_cloud_accounts,
    resolve_default_provider,
)


async def probe(ctx: ModuleContext) -> ProbeResult:
    """Verify Vault credentials and config readiness without loading `plugin.py` or decrypting."""
    vault_keys = {item.key_id for item in ctx.security.vault.list_secrets()}
    config = await ctx.security.config.get()

    checks: list[ProbeCheck] = []
    configured_providers = 0
    connected_accounts = 0

    for prov in CLOUD_PROVIDERS:
        display = PROVIDER_DISPLAY_NAMES[prov]
        has_client = (
            cloud_vault_key(prov, "client_id") in vault_keys
            and cloud_vault_key(prov, "client_secret") in vault_keys
        )
        accounts = discover_cloud_accounts(prov, config, vault_keys)
        token_accounts = [
            acc for acc in accounts if cloud_vault_key(prov, "refresh_token", acc) in vault_keys
        ]
        if token_accounts:
            configured_providers += 1
            connected_accounts += len(token_accounts)
            checks.append(
                ProbeCheck(
                    name=f"provider:{prov}",
                    ok=True,
                    detail=f"{display}: {len(token_accounts)} account(s) connected "
                    f"({', '.join(token_accounts)})",
                )
            )
        elif has_client:
            configured_providers += 1
            checks.append(
                ProbeCheck(
                    name=f"provider:{prov}",
                    ok=True,
                    detail=f"{display}: OAuth2 client configured in Vault (awaiting OAuth link)",
                )
            )
        else:
            checks.append(
                ProbeCheck(
                    name=f"provider:{prov}",
                    ok=False,
                    detail=f"{display}: missing OAuth2 client_id / client_secret in Vault",
                )
            )

    default_prov = resolve_default_provider(config, vault_keys)
    allow_public = config.get("cloud_allow_public_links") is True
    checks.append(
        ProbeCheck(
            name="policy",
            ok=True,
            detail=f"default_provider={default_prov}, allow_public_links={allow_public}",
        )
    )

    ok = configured_providers > 0
    summary = (
        f"{configured_providers}/3 cloud provider(s) configured "
        f"({connected_accounts} account(s) connected)"
        if ok
        else "No cloud storage OAuth2 client configured in Vault"
    )
    return ProbeResult(
        ok=ok,
        module_id=ctx.module_id,
        summary=summary,
        checks=checks,
    )
