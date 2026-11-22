# 3. Per-Agent Profil-izoláció, Közös `SKILL.md` & MCP + Vault (`#providers` & `#agents`)

## 🎯 Hogyan különülnek el az ügynökök jogosultságai a 4 CLI-ben?
Minden ügynök saját, `0700` jogosultságú profilkönyvtárat kap a `/home/alfred/.cli-profiles/<cliId>/<agentId>` útvonalon (`src/alfred/cli-profile-manager.ts`). Amikor a `cli-runner.ts` elindít egy CLI folyamatot, a megfelelő környezeti változót (`CLAUDE_CONFIG_DIR`, `AGY_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`) erre az izolált profilra irányítja.

---

## 🛠 1. Automatikus OAuth-öröklés
A host globális hitelesítőfájljai minden szinkron és futtatás előtt automatikusan (`0600` jogosultsággal) átmásolódnak az ügynök profiljába:
- `claude` → `.credentials.json`, `credentials.json`
- `agy` → `antigravity-oauth-token`, `credentials.json`, `oauth_creds.json`
- `codex` → `auth.json`, `credentials.json`
- `gemini` → `oauth_creds.json`, `google_accounts.json`

---

## 🛠 2. Közös `SKILL.md` Könyvtár & Biztonsági Szkenner (`#providers`)
1. Az **API & CLI (`#providers`)** oldalon a **Közös Skill Könyvtár & Biztonsági Szkenner** kártyán kattints a **+ Új Skill** gombra.
2. Mentéskor a `scanSkillMarkdownContent()` lefuttatja a `src/skill-scan.ts` és `src/web/skill-quarantine.ts` szabályait:
   - Megfogja a prompt-injection (`ignore previous instructions`), a távoli shell-futtatás (`curl ... | sh`), a rejtett HTML direktívák és a láthatatlan Unicode karakterek mintáit (`SKILL_HOLD_PATTERNS`).
3. A **Szinkronizálás (4 CLI)** gomb a tiszta skilleket bemásolja a `.claude/skills`, `.gemini/skills`, `.agents/skills`, `.codex/skills` mappákba, az egyes ügynökök profiljaiba pedig **kizárólag az adott ügynökhöz rendelt** (`agent.skills`) skilleket helyezi el.

---

## 🛠 3. Közös MCP Szerverek, Vault & 4-CLI Fordító (`#providers` & `#agents`)
1. **MCP szerver felvétele:** A **Közös MCP Szerverek & Vault (4-CLI Szinkron)** kártyán válassz a katalógusból (`mcp-catalog.json`) vagy kattints a **+ Egyedi MCP** gombra.
2. **Vault titkosítás:** A megadott titkos környezeti változókat (pl. `GITHUB_PERSONAL_ACCESS_TOKEN`) a rendszer az AES-256-GCM alapú **Vaultba** (`src/web/vault.ts`) menti, a `.mcp.json` fájlba pedig `vault:mcp_<szerver>_<kulcs>` referencia kerül.
3. **4-CLI Konfiguráció Szinkron (`4-CLI Profil Szinkron` gomb):**
   - `claude-cli`: `.claude.json` és `.mcp.json`
   - `agy-cli`: `mcp_config.json` és `settings.json`
   - `gemini-cli`: `settings.json`
   - `codex-cli`: `config.toml` (`# BEGIN ALFRED MANAGED MCP` blokkban `[mcp_servers.<name>]` TOML szekciók)
4. **Ügynök-szintű MCP kijelölés:** Az **Ügynökök (`#agents`)** oldalon az ügynök **Beállítások** fülén az **Engedélyezett MCP szerverek** checkbox-listával szabhatod meg, melyik ügynök mely MCP szervereket kapja meg a saját profiljába.
