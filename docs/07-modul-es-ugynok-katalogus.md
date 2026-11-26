# 7. Modul- és Ügynökkatalógus (`#modules`)

Az **Egységes Dashboard** bal oldali **Rendszer** csoportjában elérhető **Modulok & Ügynökök (`#modules`)** nézet egy Odoo Apps-stílusú vezérlőpult, amellyel kódmódosítás, SSH és szolgáltatás-újraindítás nélkül szabályozhatod az Alfred háttérképességeit és specialista ügynökeit — szigorú **2 GB RAM védelemmel**.

---

## 7.1. Kétszintű Felépítés: Rendszermodulok vs. Specialista Ügynökök

Az Alfred katalógusa két egymásra épülő, tisztán elválasztott rétegből áll:

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                2. RÉTEG: SPECIALISTA ÜGYNÖK CSOMAGOK                    │
│   catalog/agents/<id>/  (manifest.json + SOUL.md + skills/*/SKILL.md)   │
│   ┌──────────────┐  ┌───────────────────┐  ┌────────────┐  ┌──────────┐ │
│   │ alfred-batch │  │ alfred-self-coder │  │ alfred-qa  │  │iris-video│ │
│   └──────┬───────┘  └─────────┬─────────┘  └─────┬──────┘  └────┬─────┘ │
└──────────┼────────────────────┼──────────────────┼──────────────┼───────┘
           │ requires           │ requires         │ requires     │ requires (hiányzik)
           ▼                    ▼                  ▼              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   1. RÉTEG: RENDSZERMODULOK                             │
│      modules/<id>/module.json  +  SQLite `installed_modules` tábla      │
│   ┌──────────────────┐  ┌──────────────────┐  ┌───────────────────────┐ │
│   │ core-cli 🔒      │  │ core-ops 🔒      │  │ batch-api (opcionális)│ │
│   │ builtIn: true    │  │ builtIn: true    │  │ tools: batch_*        │ │
│   │ fs/git/bash/mem  │  │ cli/sys/mod_mgr  │  │ ui: #vpsBatchCard     │ │
│   └──────────────────┘  └──────────────────┘  └───────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

| Szempont | Rendszermodulok (`modules/`) | Specialista Ügynök Csomagok (`catalog/agents/`) |
| :--- | :--- | :--- |
| **Definíció helye** | `modules/<id>/module.json` | `catalog/agents/<id>/manifest.json` + `SOUL.md` + `skills/*/SKILL.md` |
| **Állapot tárolása** | SQLite `installed_modules` tábla (`available` / `installed_disabled` / `active`) | `config/agents.json` (`enabled: true \| false`) |
| **Mit szabályoz?** | LLM eszközcsoportok (`tools`), Heartbeat háttérfeladatok, `#vps` felületi kártyák (`uiCardIds`) | Szerepkör (`role`), ajánlott modell/szolgáltató, napi költségkeret, `SOUL.md` és megosztott skillek |
| **Induló állapot** | Alapmodulok (`builtIn`) mindig `active`; opcionálisak egy kattintással kapcsolhatók | Telepítés után mindig **`Kikapcsolva` (`enabled: false`)** állapotban jön létre |
| **Kikapcsolás / eltávolítás** | Kikapcsoláskor a modul eszközei eltűnnek az LLM sémákból és a Heartbeatből (0 token / 0 RAM zaj) | Eltávolításkor csak a `config/agents.json`-ből kerül ki; `SOUL.md`, `workspaces/<id>` és a memória megmarad |

### Csomagtípusok a jelenlegi katalógusban
- **Beépített alapmodulok (`builtIn: true`, 🔒):** `core-cli` (`fs_read`, `fs_write`, `bash`, `git`, `memory`) és `core-ops` (`cli_manage`, `system_storage`, `module_manage`). Nem kapcsolhatók ki (`409 BUILTIN_MODULE_LOCKED`), és induláskor mindig `active` állapotra kényszerülnek.
- **Opcionális rendszermodul:** `batch-api` — az 50%-os aszinkron Batch API eszközcsoport (`batch_submit`, `batch_status`, `batch_list`, `batch_cancel`), a Heartbeat `pollPendingBatches` ciklus és a `#vpsBatchCard` felületi kártya.
- **Telepíthető specialista ügynökök:** `alfred-batch`, `alfred-self-coder`, `alfred-qa`, `alfred-architect`.
- **Előkészített csomag (proaktívan letiltva):** `iris-video` — a későbbi `cloud-storage` és `worker-machines` modulokra vár, ezért a kártyán **„Előkészített · Hiányzó modul”** jelvénnyel és letiltott *Telepítés* gombbal jelenik meg.

---

## 7.2. A `#modules` Dashboard Felület Részei

1. **Fejléc & Kontextuális Súgó (`?` popover és bevezető tippsáv):**
   - A fejléc **`?`** gombja megnyitja a gyors összefoglalót, innen egyetlen kattintással megnyithatod ezt a kézikönyv-fejezetet (`#docs`) vagy visszaállíthatod az elrejtett tippeket.
   - A `[data-inline-tip="modules-intro"]` sáv 2 pontban foglalja össze a modulok és ügynökök különbségét (`localStorage`-ban megjegyzi a bezárást).
2. **Összefoglaló sáv (`#modulesSummaryBar`) és 2 GB RAM telítettségi csík:**
   - Valós időben mutatja a VPS fizikai RAM-használatát (`used / total MB`, szabad RAM) és az aktív modulok összesített becsült lábnyomát (`+X MB`).
   - Színkódolás: **zöld (`< 80%`)** biztonságos, **borostyán (`80–90%`)** figyelmeztetés, **piros (`> 90%`)** kritikus memórianyomás.
3. **Gyorskereső, állapot-fülek és kategória-chipek:**
   - A keresőmező név, azonosító, leírás, eszköz (`tools`) és skill alapján szűr.
   - Állapot-fülek: **Összes** | **Aktív** | **Kikapcsolva** | **Konfigurációra vár ⚠** (hiányzó Vault-kulcs vagy modul-függőség; telepítetlen ügynökök opcionális Discord csatornája nem szemeteli tele).
   - Kategória-chipek: `core`, `storage`, `compute`, `automation`, `security`.
4. **`Részletek` modal:**
   - Rendszermoduloknál listázza a verziót, RAM-igényt, függőségeket, `tools` és `uiCardIds` listát, valamint a hiányzó Vault-kulcsokat (kattintásra közvetlenül a `#vault` űrlapra ugrik előtöltött kulcsnévvel).
   - Ügynökcsomagoknál megjeleníti a szerepkört, ajánlott modellt, skilleket és a **`SOUL.md` előnézetét**.
   - Mindhárom új modal (`Részletek`, `Megerősítés`, `Telepítés kész`) bezárható **`Esc`** billentyűvel és a sötét háttérre kattintva is.

---

## 7.3. Biztonság és 2 GB RAM Védelem

- **Kétlépcsős dinamikus eszköz-kapuzás:**
  1. *1. réteg (`getWhitelistedToolSchemas` + `buildCliCommandSpec`):* Kikapcsolt modul eszközei eleve nem kerülnek be az LLM function-calling sémáiba (0 kontextus-token zaj) és a CLI jogosultságokba sem.
  2. *2. réteg (`executeWhitelistedTool` / `executeWhitelistedToolAsync`):* Ha egy ügynök mégis megpróbálná meghívni egy kikapcsolt modul eszközét, a futtató **`MODULE_DISABLED_ERROR`** strukturált hibával blokkolja.
- **Heartbeat & kvóta-kapuzás + split-brain védelem:** Kikapcsolt `batch-api` mellett sem a Heartbeat (`pollPendingBatches`), sem a CLI kvóta-tanácsadó nem futtatja a batch alrendszert. Az admin API automatikusan szinkronizálja az `installed_modules` táblát a Dashboard és a futó `alfred-prod` / `alfred-test` SQLite adatbázisai között.
- **Azonnali hot-reload (`mtimeMs` cache):** A futó `alfred-prod` a `config/agents.json` módosítási ideje alapján azonnal átveszi az ügynökök `enabled` állapotát újraindítás és futó munkamenetek megszakítása nélkül.
- **Dekriptálás-mentes Vault-ellenőrzés:** A modulok `requiredSecrets` ellenőrzése kizárólag a `listSecrets()` metaadat-listát és a `.env` kulcsneveket olvassa (soha nem hív `scryptSync` dekriptálást listázáskor).
- **Kötelező `SKILL.md` biztonsági szkenner:** Ügynökcsomag telepítésekor minden mellékelt `SKILL.md` átmegy a `scanSkillMarkdownContent()` vizsgálaton még bármilyen fájlírás előtt; gyanús minta esetén `400 SKILL_SECURITY_SCAN_BLOCKED` hibával leáll.
- **Adatvesztés-mentes eltávolítás & `PROTECTED_CORE_AGENT`:** Az `alfred`, `alfred-core` és `alfred-ops` core ügynökök sem nem kapcsolhatók ki, sem nem távolíthatók el (`409 PROTECTED_CORE_AGENT`). Bármely más ügynök eltávolításakor a `agents/<id>/SOUL.md`, a `workspaces/<id>/` mappa és a SQLite memória érintetlenül megmarad.

---

## 7.4. Lépésről-lépésre Tutorialok

### Tutorial 1: Modul kikapcsolása kaszkád védelemmel (`batch-api` + `Alfred Batch`)
1. Nyisd meg a bal oldali menüben a **Rendszer → Modulok & Ügynökök (`#modules`)** oldalt.
2. Keresd meg a **Batch API (`batch-api`)** kártyát, és kattints a **Kikapcsolás** gombra.
3. Mivel az **Alfred Batch** ügynök aktívan igényli a modult, megjelenik egy **megerősítő modal**: *„A(z) batch-api modult aktív specialista ügynökök használják: Alfred Batch — Kikapcsolod a modullal együtt?”*.
4. Kattints a **Kikapcsolás együtt** gombra: a rendszer egy lépésben leállítja az `alfred-batch` ügynököt (`enabled: false`) és `installed_disabled` állapotba teszi a `batch-api` modult.
5. **Kereszt-nézet ellenőrzés:**
   - A **VPS (`#vps`)** oldalon a `#vpsBatchCard` kártya eltűnik, alul pedig megjelenik a rejtett kártyákra figyelmeztető `#vpsHiddenModulesNotice` sáv.
   - Az **Ügynökök (`#agents`)** oldalon az `Alfred Batch` kártya halványítva, **`Kikapcsolva`** jelvénnyel és egykattintásos **Bekapcsolás** gombbal látható.
6. **Visszakapcsolás:** A `#modules` oldalon kattints a `batch-api` **Bekapcsolás**, majd az `alfred-batch` **Bekapcsolás** gombjára — a `#vpsBatchCard` azonnal visszatér.

### Tutorial 2: Specialista ügynök telepítése és 3 lépéses onboarding
1. A `#modules` oldal **Specialista Ügynök Katalógus** szekciójában válassz egy **Elérhető** csomagot (pl. `alfred-qa` vagy `alfred-self-coder`), és kattints a **Telepítés** gombra.
2. A rendszer lefuttatja a `SKILL.md` biztonsági szkennert, bekapcsolja a szükséges modulokat, bemásolja a `SOUL.md`-t (meglévő egyedit soha nem ír felül), és `enabled: false` állapotban regisztrálja az ügynököt.
3. A megjelenő **Telepítés kész** ablak 3 lépésben vezet végig:
   - **1. Kulcsok / csatorna:** Ha hiányzik Vault-kulcs vagy `DISCORD_CHANNEL_*` változó, a mellette lévő gombbal közvetlenül a `#vault` űrlapra ugorhatsz előre kitöltött kulcsnévvel.
   - **2. Finomhangolás:** A **Megnyitás az Ügynökök lapon →** gomb átnavigál az `#agents` nézetre és finoman odagörget a frissen telepített ügynök kártyájához.
   - **3. Indítás:** Ha minden kész, kattints az **„Ügynök indítása most”** gombra (`enabled: true`).

### Tutorial 3: Kezelés Discordon a `module_manage` eszközzel (`#alfred-ops`)
A `module_manage` eszköz kizárólag a fő ügynök és az **`alfred-ops`** számára engedélyezett. A `#alfred-ops` csatornában természetes nyelven kérheted:
- *„Listázd az összes aktív és elérhető Alfred modult és ügynökcsomagot!”* → `module_manage({ action: "list" })`
- *„Kapcsold ki a batch-api modult az Alfred Batch ügynökkel együtt!”* → `module_manage({ action: "disable_module", target_id: "batch-api", disable_dependent_agents: true })`
- *„Kapcsold vissza a batch-api modult és az alfred-batch ügynököt!”* → `enable_module` + `enable_agent`
- *„Telepítsd az alfred-qa specialista ügynökcsomagot!”* → `module_manage({ action: "install_agent", target_id: "alfred-qa" })`

### Tutorial 4: Fejlesztői útmutató — saját modul és ügynökcsomag hozzáadása
1. **Új rendszermodul (`modules/<modul-id>/module.json`):**
   ```json
   {
     "id": "my-feature",
     "name": "Saját Funkció Modul",
     "category": "automation",
     "version": "1.0.0",
     "description": "Rövid, max. 2 soros leírás a #modules kártyára.",
     "depends": ["core-cli"],
     "requiredSecrets": ["MY_FEATURE_API_KEY"],
     "tools": [],
     "uiCardIds": ["vpsMyFeatureCard"],
     "ramImpactMb": 15,
     "builtIn": false,
     "defaultEnabled": false
   }
   ```
   A kapcsolódó `#vps` kártyára tedd rá a `data-module-card="my-feature"` attribútumot a `web/index.html`-ben — a Dashboard automatikusan elrejti/megjeleníti a modul állapota szerint.
2. **Új specialista ügynökcsomag (`catalog/agents/<agent-id>/`):**
   - Hozd létre a `manifest.json`, `SOUL.md` és opcionálisan a `skills/<skill-slug>/SKILL.md` fájlokat:
   ```json
   {
     "id": "my-specialist",
     "displayName": "My Specialist",
     "role": "szakmunkas",
     "category": "automation",
     "description": "Specialista ügynök rövid leírása.",
     "requiredModules": ["core-cli", "my-feature"],
     "recommendedProvider": "deepseek",
     "recommendedModel": "deepseek-chat",
     "dailyBudgetUsd": 3.0,
     "tools": ["fs_read", "memory"],
     "skills": ["my-skill"],
     "optionalEnvVars": ["DISCORD_CHANNEL_MY_SPECIALIST"]
   }
   ```
   A `modules/` és `catalog/` mappák a `protectedPaths` védelme alatt állnak, így a self-coder és ops ügynökök nem módosíthatják őket önkényesen.

---

## 7.5. Admin REST API Referencia

Minden végpont `authorizeAdminCliRequest` (Dashboard Bearer token vagy Owner munkamenet) védelemmel fut:

| Metódus & Útvonal | Törzs (JSON) | Leírás |
| :--- | :--- | :--- |
| `GET /api/admin/modules` | — | Összes rendszermodul, ügynökcsomag, `totalActiveRamMb` és valós `systemMemory` (`memTotalMb`, `memUsedMb`, `memAvailMb`). |
| `POST /api/admin/modules/:id/enable` | `{ "withDependencies": true }` | Modul (és opcionálisan függőségei) bekapcsolása + runtime DB szinkron. |
| `POST /api/admin/modules/:id/disable` | `{ "disableDependentAgents": false }` | Opcionális modul kikapcsolása; `true` esetén kaszkád módon kikapcsolja a függő ügynököket is. |
| `POST /api/admin/agent-packages/:agentId/install` | `{ "enableRequiredModules": true }` | `SKILL.md` szkennelés, modul-aktiválás, `SOUL.md` másolás, `enabled: false` regisztráció + onboarding checklist. |
| `POST /api/admin/agent-packages/:agentId/enable` | `{}` | Telepített (vagy egyedi) ügynök aktiválása (`enabled: true`), előzetes modulfüggőség-ellenőrzéssel. |
| `POST /api/admin/agent-packages/:agentId/disable` | `{}` | Ügynök leállítása (`enabled: false`), `PROTECTED_CORE_AGENT` védelemmel. |
| `POST /api/admin/agent-packages/:agentId/uninstall` | `{}` | Ügynök eltávolítása a `config/agents.json`-ből a `SOUL.md` és a `workspaces/<id>` megőrzésével. |

---

## 7.6. Hibaelhárítás (Hibakódok)

| Hibakód | HTTP | Ok | Megoldás |
| :--- | :---: | :--- | :--- |
| **`BUILTIN_MODULE_LOCKED`** | `409` | A `core-cli` vagy `core-ops` alapmodult próbáltad kikapcsolni. | Ezek az alaprendszer kötelező részei; csak nem-beépített modulok (pl. `batch-api`) kapcsolhatók ki. |
| **`DEPENDENT_MODULES_ACTIVE`** | `409` | A kikapcsolandó modult másik aktív modul vagy aktív ügynök (pl. `Alfred Batch`) használja. | A Dashboard megerősítő ablakában válaszd a kaszkád kikapcsolást (`disableDependentAgents: true`), vagy kapcsold ki előbb a függő modult. |
| **`MISSING_REQUIRED_MODULES`** | `409` | Az ügynökcsomag olyan modult igényel, amely nincs a rendszerben (pl. `iris-video`: `cloud-storage`, `worker-machines`) vagy ki van kapcsolva. | Inaktív modulnál engedélyezd az `enableRequiredModules: true` opciót; még nem létező modulnál várd meg a modul megjelenését. |
| **`MODULE_DISABLED_ERROR`** | — | Egy ügynök kikapcsolt modul eszközét próbálta meghívni futásidőben. | Kapcsold be a megnevezett modult a `#modules` oldalon vagy a `module_manage` eszközzel. |
| **`SKILL_SECURITY_SCAN_BLOCKED`** | `400` | A telepítendő ügynökcsomag `SKILL.md` fájlja tiltott prompt-injection vagy veszélyes parancs-mintát tartalmaz. | Vizsgáld át a `details.findings` listát, javítsd a `SKILL.md`-t, majd indítsd újra a telepítést. |
| **`PROTECTED_CORE_AGENT`** | `409` | Az `alfred`, `alfred-core` vagy `alfred-ops` ügynök kikapcsolási/eltávolítási kísérlete. | Ezek a rendszer működéséhez kötelező alapügynökök; beállításaik az `#agents` oldalon finomhangolhatók. |
