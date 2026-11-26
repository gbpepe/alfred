# 📘 Alfred Kézikönyv & Lépésről-lépésre Tutorialok

Ez az átfogó magyar nyelvű kézikönyv az **Alfred Multi-Agent Core & Egységes VPS Dashboard** összes éles funkcióját bemutatja az architektúrától a `$0`-s előfizetéses CLI-k böngészős OAuth belépésén, a per-agent profil-izoláción, a közös `SKILL.md` biztonsági szkenneren és az MCP + Vault szinkronon át az automatikus RAM/SSD takarításig (Housekeeping).

> **Tipp:** Használd a fenti gyorsválasztó füleket, a dokumentumon belüli tartalomjegyzéket vagy a bal oldali keresőmezőt a témakörök közötti azonnali ugráshoz. Minden parancs- és konfigurációs blokk jobb felső sarkában a **Másolás** gombbal egy kattintással vágólapra teheted a kódot.

---

## 1. Áttekintés & Gyorsindítás

### 1.1. Alfred Architektúra és Egységes Dashboard
Az Alfred három, egymástól szigorúan védett systemd szolgáltatásként fut a Linux VPS-en (`/home/alfred` rendszerfelhasználó alatt, `ProtectHome=read-only` védelemmel):

| Szolgáltatás | Munkakönyvtár & Adatbázis | Feladat |
| :--- | :--- | :--- |
| **`alfred-prod`** | `/opt/alfred-prod` (`store/alfred-prod.db`) | Éles Discord Gateway, hibrid Modell Router, 4-CLI futtató (`cli-runner.ts`), 5 perces erőforrás-őr (`system-monitor.ts`) és automatikus takarító (`housekeeper.ts`). |
| **`alfred-ops`** | `/opt/alfred-ops` (`store/alfred-ops.db`) | Mindig éber DevOps vezérlősík (`#alfred-ops` csatorna): szigorúan korlátozott bash-whitelisttel (`spinup-test.sh`, `reload-test.sh`, `teardown-test.sh`, `check-health.sh`), `cli_manage` és `system_storage` eszközökkel. |
| **`alfred-web`** | `/opt/alfred-prod` (`WEB_ONLY=true`, port `3420`) | **Egységes Webes Dashboard** (`#overview`, `#kanban`, `#agents`, `#providers`, `#vps`, `#docs`, illetve stagingen `#testsim`). |

### 1.2. Discord Csatornák és Munkakörök (4 Role-alapú Modell-választó)
Az Alfredben az ügynökök **munkaköröket (Roles)** kapnak. Ha egy munkakör szolgáltatóját vagy modelljét átállítod az **Ügynökök (`#agents`)** lapon a **Munkakör-alapú Modell-választó** kártyán, minden olyan ügynök automatikusan örökli, amelyiknél nincs egyedi felülírás (`hasOverride`):

| Munkakör ID | Megnevezés | Alapértelmezett szerep és javasolt motor |
| :--- | :--- | :--- |
| `tervezo` | **Tervező** | Architektúra, rendszertervezés, komplex döntések (`claude-cli` Opus/Sonnet, `agy-cli` Gemini 4, vagy `deepseek-reasoner`). |
| `szakmunkas` | **Szakértő / Kódoló** | Implementáció, refaktorálás, tesztírás, fájl- és git-műveletek (`claude-cli`, `codex-cli`, `agy-cli`, vagy `deepseek-chat`). |
| `technikus` | **Technikus (Ops & QA)** | Üzemeltetés, staging tesztelés, kód-review, diagnosztika (`agy-cli`, `vertex-eu` / `gemini-2.5-flash`). |
| `segedmunkas` | **Segítő** | Gyors, olcsó rutin feladatok, összefoglalás, fordítás (`agy-cli`, `vertex-eu` / `gemini-2.5-flash-lite`). |

### 1.3. Hibrid Költségoptimalizálás: `$0` Előfizetéses CLI-k vs. Valós Idejű API-k
- **Előfizetéses Headless CLI-k (`claude-cli`, `agy-cli`, `codex-cli`, `gemini-cli`):**
  - Ha **OAuth előfizetéssel** (Claude Pro/Max/Team, Google AI Pro/Ultra, ChatGPT Plus/Pro, Google Workspace Enterprise) lépsz be, a hívások a meglévő havi előfizetési kvótádat használják.
  - A CostOps és a Circuit Breaker a CLI-futtatásokat **`$0.00` API-költséggel** könyveli a `token_usage` táblába (miközben a felhasznált input/output/cache tokeneket pontosan naplózza), így nem merítik a napi USD költségkeretet (`dailyBudgetUsd`).
  - Globális FIFO mutex (`CliExecutionQueue`) garantálja, hogy a 4 GB RAM-os VPS-en egyszerre legfeljebb `ALFRED_CLI_MAX_CONCURRENCY` (alapértelmezetten `1`) nehéz CLI folyamat fusson, elkerülve az OOM-ot.
- **Valós idejű HTTP Modell API-k (`deepseek`, `vertex-eu`, `gemini`, `openai`, `xai`):**
  - Tokenenként számlázott API-k azonnali válaszidővel, illetve opcionális **automatikus tartalék (`fallback`)** útvonalként, ha egy CLI kvótája kimerül.

---

## 2. CLI Szolgáltatók & Böngészős OAuth Belépés (`#providers`)

Az **API & CLI (`#providers`)** oldalon a **CLI Szolgáltatók** kártyán 4 előfizetéses headless CLI-t kezelhetsz közvetlenül a böngészőből, SSH és `sudo` nélkül.

### 2.1. A 4 Támogatott CLI Szolgáltató Összehasonlítása

| CLI Szolgáltató | Csomag / Bináris | Előfizetés típusa | Izolációs ENV & OAuth fájl |
| :--- | :--- | :--- | :--- |
| **`claude-cli`** | `@anthropic-ai/claude-code` (`claude`) | Claude Pro / Max / Team OAuth | `CLAUDE_CONFIG_DIR` (`~/.claude/.credentials.json`) |
| **`agy-cli`** | Antigravity CLI (`agy`) | **Egyéni (Individual) Google AI Pro / Ultra** előfizetés | `AGY_CONFIG_DIR` (`~/.gemini/antigravity-cli/antigravity-oauth-token`) |
| **`codex-cli`** | `@openai/codex` (`codex`) | ChatGPT Plus / Pro / Team (Device Code OAuth) | `CODEX_HOME` (`~/.codex/auth.json`) |
| **`gemini-cli`** | `@google/gemini-cli` (`gemini`) | **Csak Enterprise / céges** Google Code Assist OAuth (vagy fizetős API kulcs) | `GEMINI_CLI_HOME` (`~/.gemini/oauth_creds.json`) |

> **Fontos különbség (`agy-cli` vs. `gemini-cli`):** Egyéni (`@gmail.com`) Google AI Pro vagy Ultra előfizetéssel **mindig az `agy-cli` (Antigravity CLI)** szolgáltatót használd! A hivatalos `gemini-cli` OAuth módban kizárólag céges Google Cloud Code Assist licenccel működik.

### 2.2. Lépésről-lépésre Tutorial: Sudo-mentes CLI Telepítés és Böngészős OAuth Belépés

1. **Nyisd meg az `API & CLI` (`#providers`) lapot** a bal oldali menüben.
2. **Telepítés / Frissítés (sudo nélkül):**
   - Kattints a választott CLI kártyáján a **Telepítés** (vagy **Frissítés**) gombra.
   - A rendszer a `/home/alfred/.local` user-prefixbe telepíti a csomagot (`NPM_CONFIG_PREFIX=/home/alfred/.local`).
3. **Böngészős OAuth belépés indítása (SSH nélkül):**
   - Kattints a kártyán a **Belépés / Token** gombra a fiók-fiók (drawer) lenyitásához, majd nyomd meg a **Böngészős OAuth indítása** gombot.
   - **`codex-cli` esetén (Device Code flow):**
     1. A kártyán megjelenik egy **Eszközkód** (pl. `ABCD-1234`) és az **OAuth oldal megnyitása ↗** gomb.
     2. Kattints a linkre, írd be az eszközkódot az OpenAI oldalán, és hagyd jóvá. A Dashboard 1,5 másodpercenként lekérdezi a folyamatot, és automatikusan átvált **OAuth előfizetés OK** állapotra.
   - **`claude-cli`, `agy-cli` és `gemini-cli` esetén (Localhost Callback URL visszaadás):**
     1. Kattints a megjelenő **OAuth oldal megnyitása ↗** gombra, és jelentkezz be a saját böngésződben.
     2. A jóváhagyás után a böngésződ egy `http://localhost:<port>/callback?code=...&state=...` címre irányít át (amely a saját gépeden „Az oldal nem érhető el” üzenetet mutathat, mivel a CLI a távoli VPS-en várja a választ).
     3. **Másold ki a böngésződ címsorából a teljes `http://localhost:...` URL-t** (vagy a kapott kódot), illeszd be a Dashboardon a CLI kártya szövegmezőjébe, és kattints a **Kód beküldése** gombra!
     4. A VPS backend biztonságosan továbbítja a callbacket a helyi `127.0.0.1:<port>` loopback portra (vagy `code#state` formátumban a PTY folyamatnak), és elmenti az OAuth hitelesítést.

### 2.3. Élő Kapcsolat Teszt (`Teszt`) és 0-Tokenes Kvóta (`Kvóta`)
- **Teszt gomb:** Valós, minimális ping kérést küld a CLI-nek, és kiírja a válaszidőt, az aktív hitelesítési módot (`oauth`) és a modell nevét (pl. `✓ Kapcsolat OK (1420 ms) · auth: oauth`).
- **Kvóta gomb (és automatikus kvóta-sávok):**
  - `claude-cli`, `agy-cli` és `codex-cli` esetén OAuth belépés után automatikusan megjelenik az **5 órás** és **7 napos (heti)** előfizetési kvóta-kihasználtság (`% szabad`, `% használt` és a pontos `reset` időpont), **0 LLM token fogyasztásával**.
- **Piros Fizetős API-kulcs Figyelmeztetés:**
  - Ha egy CLI kártyán a piros `⚠ API kulcs (FIZETŐS!)` jelvény látható, a CLI jelenleg a `.env`-ben lévő API kulcsot használja előfizetés helyett. Ilyenkor lépj be OAuth-tal a fenti lépésekkel!

---

## 3. Per-Agent Profil-izoláció, Közös `SKILL.md` & MCP + Vault (`#providers` & `#agents`)

### 3.1. Per-Agent CLI Profil-izoláció (`/home/alfred/.cli-profiles/<cliId>/<agentId>`)
Az Alfredben minden ügynök **saját, elszigetelt CLI konfigurációs könyvtárat** kap mind a 4 CLI-hez (`src/alfred/cli-profile-manager.ts`):

```text
/home/alfred/.cli-profiles/
├── claude/<agentId>/      # CLAUDE_CONFIG_DIR (.credentials.json, .claude.json, .mcp.json, skills/)
├── agy/<agentId>/         # AGY_CONFIG_DIR (antigravity-oauth-token, mcp_config.json, settings.json, skills/)
├── codex/<agentId>/       # CODEX_HOME (auth.json, config.toml, skills/)
└── gemini/<agentId>/      # GEMINI_CLI_HOME (oauth_creds.json, settings.json, skills/)
```

- **Automatikus OAuth-öröklés (`0600`):** Amikor a `#providers` lapon belépsz egy CLI-be, a `syncOAuthToAgentProfile()` minden indítás és szinkron alkalmával automatikusan átmásolja a friss OAuth hitelesítőfájlokat az egyes ügynökök profiljaiba `0600` jogosultsággal.
- **Ügynök-szintű szeparáció:** Egy ügynök a saját CLI profiljában **kizárólag a saját maga számára engedélyezett** `SKILL.md` fájlokat és MCP szervereket látja.

### 3.2. Közös `SKILL.md` Könyvtár, Biztonsági Szkenner & 4-CLI Szinkron
Az **API & CLI (`#providers`)** oldalon a **Közös Skill Könyvtár & Biztonsági Szkenner** kártyán kezelheted a flotta megosztott tudásmoduljait (`skills/<skillId>/SKILL.md`):

1. **Új Skill létrehozása és szkennelése:**
   - Kattints a **+ Új Skill** gombra, add meg a `skill-id`-t (pl. `pr-security-audit`), a rövid leírást és a Markdown instrukciókat, majd kattints a **Szkennelés & Mentés** gombra.
   - Mentéskor automatikusan lefut a kétlépcsős determinisztikus biztonsági szkenner (`src/skill-scan.ts` + `src/web/skill-quarantine.ts`):
     - **`✓ Szkenner: Tiszta` (`clean`):** Nincs gyanús minta; a skill azonnal szinkronizálódik.
     - **`⚠ Figyelmeztetés` (`warning`):** Audit-szintű találat (pl. külső URL vagy környezeti változó említése), de nem blokkolt.
     - **`⚠ Blokkolt minta` (`flagged`):** Magas kockázatú prompt-injection vagy titok-kiszivárgási kísérlet (`ignore previous instructions`, `curl ... | sh`, rejtett irányító HTML kommentek, láthatatlan Unicode karakterek). A mentést a szerver `400 Bad Request` hibával megállítja, és a blokkolt skillt soha nem másolja be a CLI profilokba.
2. **4-CLI Szinkronizálás (`Szinkronizálás (4 CLI)` gomb):**
   - Egyetlen kattintással szinkronizálja az összes tiszta `SKILL.md` fájlt a 4 CLI globális/workspace skill-mappáiba (`.claude/skills`, `.gemini/skills`, `.agents/skills`, `.codex/skills`), valamint az egyes ügynökök `.cli-profiles/<cliId>/<agentId>/skills/` mappáiba (csak az adott ügynökhöz bepipált skilleket).

### 3.3. Közös MCP Szerverek, Titkosított Vault & 4-CLI Konfiguráció Fordító
Az **API & CLI (`#providers`)** oldalon a **Közös MCP Szerverek & Vault (4-CLI Szinkron)** kártyán vehetsz fel külső MCP eszközöket:

1. **Telepítés a 17-elemű MCP Katalógusból vagy egyedileg:**
   - Válassz sablont a **+ Sablon a katalógusból...** legördülőből (`github`, `filesystem`, `postgres`, `sqlite`, `brave-search`, `fetch`, `puppeteer`, `memory`, `slack`, `google-drive`, `linear`, `notion`, `sentry`, `sequential-thinking` stb.), vagy kattints a **+ Egyedi MCP** gombra.
2. **Automatikus Vault Titkosítás (`AES-256-GCM`):**
   - Ha a környezeti változó neve érzékeny kulcsra utal (`TOKEN`, `KEY`, `SECRET`, `PASSWORD`, `AUTH`), az értéket a rendszer automatikusan a titkosított **Vaultba** (`store/vault.json` + `store/.vault-key`) menti, a központi `.mcp.json` fájlba pedig csak egy `vault:mcp_<szerver>_<kulcs>` hivatkozás kerül (`🔒 Vault` jelvénnyel).
3. **Automatikus 4-CLI Formátum-fordítás (`4-CLI Profil Szinkron`):**
   - A `cli-profile-manager.ts` feloldja az adott ügynökhöz engedélyezett MCP szerverek Vault-titkait, és `0600` jogosultsággal kiírja mind a 4 CLI saját natív konfigurációs formátumába:
     - **Claude CLI (`claude`):** `<profileDir>/.claude.json` és `<profileDir>/.mcp.json` (`{ "mcpServers": { ... } }`)
     - **Antigravity CLI (`agy`):** `<profileDir>/mcp_config.json` és `<profileDir>/settings.json`
     - **Gemini CLI (`gemini`):** `<profileDir>/settings.json` (`trustedFolder: true` megőrzésével)
     - **Codex CLI (`codex`):** `<profileDir>/config.toml` — a meglévő TOML beállítások megtartásával, `# BEGIN ALFRED MANAGED MCP` ... `# END ALFRED MANAGED MCP` blokkba rendezett `[mcp_servers.<name>]` szekciókkal:

```toml
# BEGIN ALFRED MANAGED MCP
[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
[mcp_servers.github.env]
GITHUB_PERSONAL_ACCESS_TOKEN = "ghp_..."

# END ALFRED MANAGED MCP
```

4. **Ügynök-szintű MCP hozzárendelés (`#agents`):**
   - Nyisd meg bármelyik ügynököt az **Ügynökök (`#agents`)** oldalon, lépj a **Beállítások** fülre, és az **Engedélyezett MCP szerverek** sorban pipáld be, mely MCP szervereket érheti el az adott ügynök, majd kattints a **Mentés** gombra.

---

## 4. VPS Erőforrás-figyelés, Automatikus Takarítás (Housekeeping) & `alfred-ops` (`#vps`)

### 4.1. A „Memória & SSD” Kártya Mutatói (`#vps`)
A **VPS (`#vps`)** oldalon a **Memória & SSD** kártya valós időben mutatja a szerver állapotát (`src/alfred/system-monitor.ts` + `src/web/machine-state.ts`):
- **RAM & Node RSS:** Fizikai memória telítettsége (`MB` és `%`), a Node.js folyamat saját RSS memóriája, a **Top RSS folyamat** (`Top RSS: <folyamatnév> (PID <pid>, <MB> MB)`), valamint Linuxon a **PSI (Pressure Stall Information)** memórianyomás (`PSI avg10`).
- **Swap memória:** Aktív cserehely (`MB` és `%`).
- **SSD partíciók (`/`, `/opt/alfred-*`):** Foglalt és szabad tárhely.
- **Mappánkénti bontás:** `store/` (külön feltüntetve az SQLite `DB` és `WAL` fájlméretet!), `logs/`, `batch/`, `~/.local` és `~/.npm`.

### 4.2. Mit csinál az Automatikus és Kézi Takarítás (Housekeeping)?
Az **Azonnali takarítás** gomb (vagy az 5 percenkénti erőforrás-őr küszöbátlépéskor, illetve a 6 óránkénti ütemezett takarító) az alábbi műveleteket hajtja végre (`src/alfred/housekeeper.ts`):
1. **SQLite WAL Checkpoint (`PRAGMA wal_checkpoint(TRUNCATE)`):** Minden Alfred SQLite adatbázis (`alfred-prod.db`, `alfred-ops.db`, `alfred-test.db`) `-wal` naplóját visszaírja és `0` bájtra csonkolja.
2. **Feltételes SQLite `VACUUM` & Tábla-retenció (`checkpointAndCompact`):** Ha az adatbázisban a szabad lapok aránya eléri a **20%-ot** (és legalább **1000 szabad lap** van), automatikus `VACUUM` tömörítést futtat, valamint törli a lejárt retenciós sorokat (`conversation_log`, `otel_spans`, `agent_messages`, `tool_call_log`).
3. **In-App Copytruncate Gzip Logrotáció (`runLogRotationSweep`):** A 20 MB-ot meghaladó alkalmazásnaplókat (`dashboard.log`, `channels.log` stb.) a fájl-leíró megszakítása nélkül `.1.gz`..`.5.gz` archívumokba tömöríti és lenullázza.
4. **30 Napos Artifact & Árva `.tmp` Takarítás:** Törli a 30 napnál (`ALFRED_ARTIFACT_RETENTION_DAYS`) régebbi lezárt (`completed`/`failed`/`cancelled`) batch fájlokat, régi naplókat és a 24 óránál régebbi árva atomi `.env.*.*.tmp` fájlokat — miközben **szigorúan megőrzi** az élő `.db`, `.env`, `.dashboard-token`, `.vault-key` és `running` batch fájlokat.
5. **Vészhelyzeti `npm cache clean --force`:** Ha az SSD telítettsége eléri a figyelmeztetési küszöböt (`80%`), automatikusan kiüríti az `~/.npm` gyorsítótárat.

### 4.3. Konfigurálható `.env` Küszöbértékek

| Környezeti változó | Alapértelmezés | Leírás |
| :--- | :---: | :--- |
| `ALFRED_MEM_WARN_PCT` | `85` | RAM figyelmeztetési küszöb (`%`), amely felett `#alfred-ops` Discord riasztás megy (Top RSS folyamattal). |
| `ALFRED_DISK_WARN_PCT` | `80` | SSD figyelmeztetési küszöb (`%`); elérésekor automatikus Housekeeping + `npm cache clean` indul. |
| `ALFRED_DISK_CRIT_PCT` | `90` | SSD kritikus küszöb (`%`); azonnali `[CRITICAL]` riasztást küld (a cooldown megkerülésével). |
| `ALFRED_MONITOR_COOLDOWN_MS` | `3600000` | Riasztási türelmi idő (1 óra), hogy ugyanaz a szint ne spammelje a `#alfred-ops` csatornát. |
| `ALFRED_ARTIFACT_RETENTION_DAYS` | `30` | Lezárt batch fájlok és régi naplók megőrzési ideje napokban. |

### 4.4. Az `alfred-ops` `system_storage` Discord Eszköze
A `#alfred-ops` Discord csatornában (vagy a Dashboard jobb alsó **💬 Alfred Chat** ablakában `alfred-ops` kiválasztásával) természetes nyelven is kérhetsz állapotjelentést vagy takarítást:
- *„Nézd meg a VPS memória és SSD állapotát!”* → meghívja a `system_storage` eszközt `action: "status"` paraméterrel.
- *„Futtass egy azonnali takarítást npm cache ürítéssel!”* → meghívja a `system_storage` eszközt `action: "cleanup", forceNpmCacheClean: true` paraméterrel.

---

## 5. Hibaelhárítás (Troubleshooting) & Üzemeltetési Parancsok

### 5.1. Gyakori Hibák és Megoldásaik

| Jelenség / Hibaüzenet | Ok | Megoldás |
| :--- | :--- | :--- |
| **`AUTH_REQUIRED` / `Not logged in` CLI hiba** | A CLI OAuth tokenje lejárt vagy még nincs beléptetve. | Nyisd meg a `#providers` lapot, kattints a CLI kártyáján a **Belépés / Token → Böngészős OAuth indítása** gombra, majd futtasd a **4-CLI Profil Szinkron** gombot. |
| **`gemini-cli` OAuth hiba egyéni Google fiókkal** | A `gemini-cli` OAuth csak céges Workspace / Code Assist licenccel működik. | Váltsd az ügynököt vagy munkakört **`agy-cli`** (Antigravity CLI) szolgáltatóra az `#agents` oldalon! |
| **`Biztonsági szkenner megállította a mentést` (`SKILL.md`)** | A `SKILL.md` tiltott prompt-injection vagy `curl \| sh` mintát tartalmaz (`SKILL_HOLD_PATTERNS`). | Távolítsd el a veszélyes parancsot vagy az utasítás-felülíró szöveget a `SKILL.md`-ből, majd mentsd újra. |
| **`EROFS: read-only file system` `/home/alfred/.cli-profiles` alatt** | A systemd unitban a `ProtectHome=read-only` mellett nem volt engedélyezve a mappa. | Ellenőrizd, hogy a `deploy/alfred-*.service` fájlok `ReadWritePaths=` sorában szerepel-e a `-/home/alfred/.cli-profiles`, majd futtasd a lenti `systemctl daemon-reload` parancsot. |

### 5.2. Hasznos VPS Üzemeltetési Parancsok

```bash
# Szolgáltatások állapotának ellenőrzése
sudo systemctl status alfred-prod alfred-ops alfred-web

# Élő naplók követése
sudo journalctl -u alfred-prod -u alfred-ops -u alfred-web -f

# Systemd unitok újratöltése és szolgáltatások újraindítása
sudo cp /opt/alfred-prod/deploy/alfred-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart alfred-prod alfred-ops alfred-web

# Per-agent izolált CLI profilok jogosultságának ellenőrzése
ls -la /home/alfred/.cli-profiles/
```

---

## 6. Aszinkron Batch Feldolgozás & Költségoptimalizálás (`#alfred-batch` & `#vps`)

Részletes leírás: **[6. Aszinkron Batch Feldolgozás & Költségoptimalizálás](06-batch-feldolgozas-es-koltsegoptimalizalas.md)**

- **50%-os Batch API ár + CLI kvóta védelme:** A tömeges, párhuzamosítható, nem azonnali feladatokat az `alfred-batch` (`#alfred-batch`) koordinátor veszi át `provider: "auto"` útválasztással (`anthropic`, `gemini`, `vertex-eu`, `openai`), `secret-gate` szűréssel és pre-flight költségkeret-ellenőrzéssel.
- **Kanonikus JSONL & Prompt Caching:** Egységes `custom_id` (`^[a-zA-Z0-9_-]{1,64}$`), job-szintű `worksource-queue` (`store/batch/worksource-queue`), `heavy-job-hold` I/O védelem és automatikus belső `alfred-qa` mintavételezés.
- **Dashboard `#vps` kártya (`#vpsBatchCard`):** Fő KPI sáv, 4 szolgáltatós megtakarítás-bontás (Elköltve vs. Megtakarítva) és élő köteglista `Cancel` gombbal.

---

## 7. Modul- és Ügynökkatalógus (`#modules`)

Részletes leírás: **[7. Modul- és Ügynökkatalógus](07-modul-es-ugynok-katalogus.md)**

- **Rendszermodulok & 2 GB RAM keret:** Egyetlen kattintással kapcsolhatók az opcionális modulok (pl. `batch-api`), miközben a `builtIn` alapmodulok (`core-cli`, `core-ops`) védettek maradnak, a kikapcsolt modulok eszközei és Heartbeat-ciklusai pedig automatikusan leállnak.
- **Specialista Ügynökök & Adatmegőrzés:** Biztonsági szkennerrel ellenőrzött ügynökcsomagok (`alfred-batch`, `alfred-self-coder`, `alfred-qa`, `alfred-architect`, `iris-video`), biztonságos `enabled: false` telepítéssel, azonnali hot-reloaddal és teljes `SOUL.md` / `workspaces/` adatmegőrzéssel.
