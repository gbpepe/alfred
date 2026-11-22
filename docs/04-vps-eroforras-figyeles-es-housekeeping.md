# 4. VPS Erőforrás-figyelés, Automatikus Takarítás (Housekeeping) & `alfred-ops` (`#vps`)

## 🎯 Hogyan előzi meg az Alfred a RAM és SSD betelését?
Az Alfred 5 percenként ellenőrzi a VPS memóriáját, a Linux PSI nyomásmutatókat, a legtöbb RAM-ot fogyasztó folyamatot (`findTopRss`) és az SSD partíciókat (`src/alfred/system-monitor.ts`), 6 óránként (vagy küszöbátlépéskor azonnal) pedig lefuttatja az automatikus takarítót (`src/alfred/housekeeper.ts`).

---

## 🛠 1. A `#vps` „Memória & SSD” Kártya
- **RAM & Node RSS sáv:** Megjeleníti a foglalt/szabad RAM-ot, a Node.js RSS-t, a **Top RSS folyamatot** (`Top RSS: <comm> (PID <pid>, <MB> MB)`) és a Linux PSI (`avg10`) értéket.
- **Mappabontás:** `store/` (külön `DB` és `WAL` mérettel), `logs/`, `batch/`, `~/.local`, `~/.npm`.
- **Azonnali takarítás gomb (`POST /api/admin/system/cleanup`):** Kézzel is bármikor lefuttatható, és tételesen kiírja a felszabadított bájtokat, a törölt régi fájlok számát, az SQLite WAL és `VACUUM` eredményét, valamint a `.gz` logrotációt.

---

## 🛠 2. A Housekeeping 5 Lépése (`runHousekeeping`)
1. **SQLite WAL Checkpoint:** `PRAGMA wal_checkpoint(TRUNCATE);` az összes Alfred adatbázison.
2. **Feltételes `VACUUM` & Retenció (`src/db.ts`):** Ha a szabad lapok száma `>= 1000` és aránya `>= 20%`, lefuttatja a `VACUUM` tömörítést és a tábla-retenciót (`pruneConversationLog`, `pruneOtelSpans`, `pruneAgentMessages`, `pruneToolCallLogRetention`).
3. **Copytruncate `.gz` Logrotáció (`src/web/log-rotation.ts`):** A 20 MB feletti naplófájlokat `.1.gz`..`.5.gz` generációkba forgatja.
4. **30 Napos Artifact Takarítás:** Törli a 30 napnál régebbi lezárt batch fájlokat, régi naplókat és 24 óránál régebbi `.tmp` fájlokat (az élő `.db`, `.env`, token és `running` batch fájlok szigorú védelme mellett).
5. **Vészhelyzeti `npm cache clean --force`:** Automatikusan lefut, ha az SSD telítettsége eléri az `ALFRED_DISK_WARN_PCT` (`80%`) értéket.

---

## 🛠 3. Konfigurációs Küszöbök (`.env`)

```dotenv
ALFRED_MEM_WARN_PCT=85
ALFRED_DISK_WARN_PCT=80
ALFRED_DISK_CRIT_PCT=90
ALFRED_MONITOR_COOLDOWN_MS=3600000
ALFRED_ARTIFACT_RETENTION_DAYS=30
```
