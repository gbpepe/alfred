# Alfred — Funkció-dokumentáció

Alfred egy önfejlesztő, proaktív Multi-Agent AI rendszer és egységes VPS Dashboard. Nem chatbot: ügynök-flotta, amely `$0`-s előfizetéses CLI-ket (`claude-cli`, `agy-cli`, `codex-cli`, `gemini-cli`) és valós idejű Modell API-kat kombinál per-agent profil-izolációval, közös `SKILL.md` biztonsági szkennerrel, Vaulttal védett MCP szerverekkel és automatikus VPS erőforrás-takarítóval.

## 📘 Kiemelt Kézikönyv & Lépésről-lépésre Tutorialok

| Fejezet | Tartalom |
| :--- | :--- |
| **[📘 Komplett Alfred Kézikönyv & Tutorialok](00-alfred-kezikonyv-es-tutorialok.md)** | **Minden egyben:** Architektúra, 4-CLI OAuth belépés, Per-Agent profilok, `SKILL.md` szkenner, MCP + Vault, VPS Memória/SSD & Housekeeping, Hibaelhárítás |
| **[1. Áttekintés & Gyorsindítás](01-attekintes-es-gyorsinditas.md)** | `alfred-prod` / `alfred-ops` / `alfred-web` felépítés, 4 munkakör (Tervező, Szakértő, Technikus, Segítő), hibrid CostOps (`$0` CLI vs. API) |
| **[2. CLI Szolgáltatók & Böngészős OAuth Belépés](02-cli-szolgaltatok-es-oauth-belepes.md)** | `claude-cli`, `agy-cli` (egyéni Google AI Pro/Ultra), `codex-cli` és Enterprise `gemini-cli` telepítése, SSH-mentes OAuth belépés, `Teszt` és 0-tokenes `Kvóta` sávok |
| **[3. Per-Agent Profilok, SKILL.md & MCP + Vault](03-per-agent-profilok-skill-es-mcp-vault.md)** | `/home/alfred/.cli-profiles/<cliId>/<agentId>` izoláció, OAuth-öröklés, prompt-injection szkenner, MCP katalógus, Vault és Claude/AGY/Gemini JSON + Codex TOML szinkron |
| **[4. VPS Erőforrás-figyelés & Housekeeping](04-vps-eroforras-figyeles-es-housekeeping.md)** | `#vps` Memória & SSD kártya (Top RSS, Linux PSI), `wal_checkpoint(TRUNCATE)`, feltételes `VACUUM`, `.gz` logrotáció, 30 napos artifact takarítás és `system_storage` eszköz |
| **[5. Hibaelhárítás & Üzemeltetési Parancsok](05-hibaelharitas-es-uzemeltetesi-parancsok.md)** | Gyakori hibák (`AUTH_REQUIRED`, blokkolt `SKILL.md`, `ProtectHome=read-only` / `ReadWritePaths`) és `systemctl` / `journalctl` parancsok |
| **[6. Aszinkron Batch Feldolgozás & Költségoptimalizálás](06-batch-feldolgozas-es-koltsegoptimalizalas.md)** | 50%-os több-szolgáltatós Batch API (`anthropic`, `gemini`, `vertex-eu`, `openai`), kanonikus JSONL, `auto` router, `alfred-batch` koordinátor, belső `alfred-qa` mintavétel és `#vps` megtakarítás kártya |

---

Minden további funkció-lap két szemszögből mutatja be a rendszert:
- **🎯 Mit tud / miért érdekes** — közérthető bemutatás, kuriózumok, használati példák
- **🛠 Hogyan működik** — technikai felépítés, hogyan bővíthető

## További Rendszermodulok

| Funkció | Leírás |
|---------|--------|
| [Heartbeat + fokozatos autonómia](heartbeat-autonomy.md) | Önjáró ütemezett ellenőrzések + kategóriánként állítható bizalmi-létra (jelez → javasol → autonóm) |
| [Memória-rendszer](memory-system.md) | 3-tier (hot/warm/cold) FTS5 + napi salience decay + napi napló |
| [Kanban + auto-breakdown](kanban.md) | Feladatkezelés LLM-es részfeladat-bontással |
| [Ügynök-flotta + inter-agent kommunikáció](agent-fleet.md) | Több specializált ügynök közös üzenetsoron keresztül |
| [Ügynök-létrehozás jóváhagyással](agent-create-approval.md) | Egy ügynök kérheti új ügynök létrehozását; a szerver tárolja és hash-eli a specifikációt, és csak a gazda jóváhagyása után hozza létre, ugyanazon a kódon, mint a dashboard (alapból KI) |
| [Föderáció](federation.md) | Több Alfred-példány összekötése: rendszer-minősített címzés (`teodor/backend-dev`) + HTTPS-híd, dashboard-menü, per-társ tokenek, automatikus ügynök-felkészítés, **képesség-alapú auto-routing** (LLM-katalógus) + fő-ügynök auto-drain, beépített rollback — opt-in, fail-closed |
| [Skill-factory (öntanulás)](skill-factory.md) | Visszatérő munkafolyamatokból újrahasznosítható skill-ek |
| [Channels (Telegram / Slack)](channels.md) | Natív üzenetküldő-integráció proaktív értesítésekkel |
| [Hangüzenetek (voice)](voice.md) | Per-agent STT+TTS: helyben futó hang oda-vissza Telegramon, ügynökönként állítható móddal |
| [Printing-press CLI-k](printing-press-cli.md) | API nélküli oldalakhoz is agent-natív CLI generálás |
| [CLI-nyilvántartás](cli-inventory.md) | A flotta parancssori eszközei a Kapcsolatok > CLI oldalon: parancsok, hitelesítés, hivatkozó skillek; a talált binárist leíró hívással futtatja ([EN](en/cli-inventory.md)) |
| [Skool CLI](skool-cli.md) | Közösségi platform kezelése parancssorból (API nélkül) |
| [connectors.hu](connectors-hu.md) | Üzleti API-átjáró (NAV, Billingo, Wise, fal.ai) MCP-n |
| [Egy Google-jóváhagyás minden fogyasztónak](google-consent.md) | Egy telefonos jóváhagyás, egy refresh token a Gmail/Calendar/Drive MCP-knek és az API-szkripteknek, mindegyik a saját fájlformátumában; scope-hiány és 7 napos "Testing" token hangos jelzése ([EN](en/google-consent.md)) |
| [Vault & titkosítás](vault.md) | Titkosított titok-tár (AES-256-GCM) OS-kulcstárral |
| [Belépés-visszaút & vészreset](dashboard-auth-recovery.md) | Elfelejtett jelszó, kizárás, `security:reset` pánikgomb -- HTTP-független break-glass CLI |
| [Dream-engine](dream-engine.md) | Éjszakai tudás-konszolidáció + reggeli prioritás-javaslatok |
| [Proaktív hírszerző (intel registry)](intel-registry.md) | Óránkénti gyűjtő + napi brief közös SQLite tény-registry-vel, dedup + tény-életciklus |
| [Háttér-feladatok](background-tasks.md) | Leválasztott, hosszú feladatok futtatása + értesítés |
| [Piros gomb: a flotta fagyasztása](fleet-freeze.md) | Egy mozdulattal leállítható flotta: eszközhívás-tiltás, álló háttér-ciklusok, feloldás csak a gazdának |
| [Meta Graph olvasó](meta-graph-olvasas.md) | Csak olvasó Facebook/Instagram Graph-hívások egy paranccsal: kizárólag GET, a token a store-ból, közös hívásszám-szünet ([EN](en/meta-graph-read.md)) |
| [Hook-metaadatok és env-kapcsolók](hook-metaadatok.md) | Oldalfájl a settings.json hookjai mellett: a CI megfogja a csendes hook-átírást, átrendezést és a hiányzó szkriptet; naplózó hook env-ből kikapcsolható, kapu soha ([EN](en/hook-metadata.md)) |
| [Nehéz-feladat kapu](heavy-job-gate.md) | Egyszerre egy nehéz feladat (render, teljes tesztsor, build) érkezési sorrendben, memória-padló és saját cgroup-memóriakeret; opt-in, csak Linuxon |
| [macOS: Spotlight és a System Data](macos-spotlight.md) | Ha a „System Data” nő: a Spotlight-index a sok napló/jsonl/sqlite írástól; ellenőrzés, javítás a Keresési adatvédelem listával |

*A dokumentáció él; javításokat/bővítéseket szívesen fogadunk.*
