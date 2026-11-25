# 6. Aszinkron Batch Feldolgozás & Költségoptimalizálás (`#alfred-batch` & `#vps`)

Ez a fejezet az Alfred **Több-szolgáltatós Aszinkron Batch API Feldolgozóját** (`src/alfred/batch-runner.ts`), a **Kanonikus JSONL Fordítót**, az **`auto` Szolgáltató-választót**, a proaktív **`alfred-batch`** koordinátort és a `#vps` Dashboard **Batch Áttekintő & Megtakarítás** kártyáját mutatja be.

---

## 6.1. Miért Batch API? (50%-os kedvezmény + CLI kvóta védelme)

Az Alfred szigorúan szétválasztja a munkaterheléseket:
- **Azonnali, interaktív fejlesztés & tervezés** → előfizetéses headless CLI-k (`claude-cli`, `agy-cli`, `codex-cli`), `$0` API-költséggel.
- **Tömeges, párhuzamosítható, nem azonnali határidejű feladatok** (többnyelvű lokalizáció, sok fájl/dokumentum elemzése, tömeges teszt- vagy tartalomgenerálás) → **Aszinkron Batch API (`alfred-batch`)**, ahol minden támogatott szolgáltató **50%-os (0.5×) kedvezményt** ad a valós idejű API-árból, és egyetlen CLI kvóta-token sem fogy el.
- **Provider-tudatos Kvótakapu (`src/quota-gate.ts` + `model-router.ts`):** Ha egy előfizetéses CLI kvótája telített (`>= 85%` vagy reset-közeli nyomás), a `model-router` strukturált `quotaAdvice` metaadatban (a modell nyers `replyText` válaszának megváltoztatása nélkül) javasolja a halasztható feladatok átterelését az `alfred-batch` koordinátorhoz.

---

## 6.2. Egységes (Kanonikus) JSONL Séma és Prompt Caching

Az `alfred-batch` koordinátor a bemeneti kötegeket kizárólag a `batch/` vagy `store/batch/` könyvtárban állítja össze (`realpathSync` útvonal-korlátozással és kötelező `src/security/secret-gate.ts` titok-ellenőrzéssel):

```jsonl
{"custom_id": "doc_001", "system": "Egységes, közös rendszerutasítás...", "prompt": "Elemezd az 1. dokumentumot...", "max_tokens": 1024, "task_type": "extraction", "eu_only": false}
{"custom_id": "doc_002", "system": "Egységes, közös rendszerutasítás...", "prompt": "Elemezd a 2. dokumentumot...", "max_tokens": 1024, "task_type": "extraction", "eu_only": false}
```

- **`custom_id` szabály:** Szigorúan `^[a-zA-Z0-9_-]{1,64}$`, kötegen belül egyedi (streamelés közbeni in-memory `Set<string>` deduplikálással).
- **Prompt Caching + Batch 50% halmozódás:** Anthropic adapter esetén a rendszer automatikusan felteszi a `cache_control: { type: "ephemeral" }` jelölést, ha a `system` prefix legalább 2 elemnél közös **és** eléri a ~1024 tokenes küszöböt (`>= 4096` karakter).
- **Egységes visszafordított kimenet (`store/batch/<jobId>.output.jsonl`):**
  ```jsonl
  {"custom_id":"doc_001","status":"ok","text":"...","usage":{"input_tokens":420,"output_tokens":185},"cost_usd":0.000087}
  ```

---

## 6.3. `auto` Szolgáltató-választó & a 4 Natív Batch Adapter

Ha `provider: "auto"` értékkel indul a `batch_submit`:
1. **`eu_only: true` (GDPR):** Kizárólag **`vertex-eu`** (`europe-central2`) választható. Ellenőrzi a `VERTEX_EU_BATCH_BUCKET` meglétét és (gyorsítótárazva) a GCS bucket EU-lokációját (`EU` / `europe-*`). Nem-EU fallback **tilos** (`GDPR_EU_ONLY_BATCH_ERROR`).
2. **`task_type: "code"` vagy `"reasoning"`:** Elsődlegesen **`anthropic`** (`/v1/messages/batches`, 10 000 kérés / 32 MB korlát-ellenőrzéssel, `POST .../cancel` lemondással), fallback: `gemini` → `vertex-eu` → `openai`.
3. **`translation`, `extraction`, `general`:** Elsődlegesen **`gemini`** (Files API + `batchGenerateContent` + `x-goog-api-key` fejléces `?alt=media` letöltés), fallback: `vertex-eu` (multi-shard `predictions*.jsonl` GCS összefűzés) → `openai` (`multipart/form-data` `/v1/files` + `/v1/batches` + `output_file_id` & `error_file_id` + `expired` kezelés) → `anthropic`.

---

## 6.4. Üzembiztonság, Crash-Recovery, Belső QA & Dashboard (`#vps`)

- **Job-szintű `worksource-queue` (`store/batch/worksource-queue`):** Atomi `pending/<jobId>.json` → `active/<jobId>.json` → `done/<jobId>.json` állapotgép.
- **`heavy-job-hold` & `recoverStuckBatchJobs`:** Összeállítás és eredmény-letöltés közben PID-alapú újraindítás-védelem; induláskor a beragadt `downloading` kötegek visszaállnak `running`-ra, a halott PID-ű holdok takarítódnak.
- **Pre-flight Budget & 0.5× elszámolás:** Beküldés előtt ellenőrzi a becsült 50%-os költséget a Circuit Breaker és Agent Budget keretével szemben. Lezáráskor atomi SQLite `db.transaction()`-ben állítja a `cost_recorded = 0 → 1` jelzőt és könyveli a `token_usage` rekordot (`batch:<model>` + `tool_name = 'batch'` 0.5× szorzóval).
- **Belső programatikus `alfred-qa` mintavétel:** A tranzakción kívül, nem-fatális blokkban 3–5 mintaelemet `wrapUntrusted` + `composeBatchInjection` borítékban átnézet az `alfred-qa` ágenssel, majd egyetlen összegzett jelentést küld a `#alfred-batch` csatornára.
- **Dashboard `#vps` Batch Áttekintő (`#vpsBatchCard`):** Valós időben mutatja a fő KPI sávot (Elköltve 50%-os áron, **Megtakarítás USD**, aktív kötegek), a **4 szolgáltatós megtakarítás-bontást** (Anthropic, Gemini, Vertex EU, OpenAI), valamint a futó/legutóbbi kötegek listáját élő előrehaladási sávval és `Cancel` gombbal (`GET /api/admin/batches`, `POST /api/admin/batches/:id/cancel`).
