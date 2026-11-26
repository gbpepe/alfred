# 7. Modul- és Ügynökkatalógus (`#modules`)

Az **Egységes Dashboard** bal oldali **Rendszer** menüjében elérhető **Modulok & Ügynökök (`#modules`)** nézet segítségével kódmódosítás és SSH nélkül, egyetlen kattintással szabályozhatod az Alfred infrastruktúra-képességeit és specialista ügynökeit.

---

## 1. Rendszermodulok vs. Specialista Ügynökök

A katalógus két egymásra épülő rétegből áll:

| Réteg | Mappa / Forrás | Mit kezel? |
| :--- | :--- | :--- |
| **Rendszermodulok** | `modules/<id>/module.json` + SQLite `installed_modules` | Háttérképességek, LLM eszközök (`tools`), Heartbeat ciklusok és Dashboard kártyák (`uiCardIds`). Példák: `core-cli`, `core-ops`, `batch-api`. |
| **Specialista Ügynökök** | `catalog/agents/<id>/manifest.json` + `SOUL.md` + `skills/` | Előre összeállított ügynökcsomagok (szerepkör, ajánlott modell, napi költségkeret, skillek). Példák: `alfred-batch`, `alfred-self-coder`, `alfred-qa`, `alfred-architect`, `iris-video`. |

### Alapmodulok (`builtIn: true`)
A **`core-cli`** és **`core-ops`** beépített alapmodulok: az Alfred és a Dashboard üzemeltetéséhez elengedhetetlenek, ezért **nem kapcsolhatók ki** (`409 BUILTIN_MODULE_LOCKED`), és újraindításkor is garantáltan `active` állapotban indulnak.

---

## 2. 2 GB RAM Erőforrás-keret & Dinamikus Kapuzás

A `#modules` fejlécében lévő **RAM-keret sáv** valós időben mutatja a VPS fizikai memóriahasználatát és az aktív modulok összesített RAM-igényét (`+X MB`):
- **Zöld (`< 80%`)**: biztonságos tartomány.
- **Borostyán (`80–90%`)**: érdemes kikapcsolni a nem használt opcionális modulokat.
- **Piros (`> 90%`)**: kritikus memórianyomás — kerüld új, nehéz modulok bekapcsolását.

Ha kikapcsolsz egy opcionális modult (pl. `batch-api`):
1. Az eszközei (`batch_submit`, `batch_status`, `batch_list`, `batch_cancel`) azonnal eltűnnek az LLM tool-sémákból és futásidőben `MODULE_DISABLED_ERROR` választ adnak.
2. A Heartbeat ciklus (`pollPendingBatches`) és a CLI kvóta-tanácsadó sem futtatja tovább a kikapcsolt modult.
3. A hozzá tartozó `#vps` kártya automatikusan elrejtődik, a fejlécben megjelenő figyelmeztetésből pedig bármikor visszaugorhatsz a `#modules` nézetre.

---

## 3. Vault-kulcsok és Konfiguráció-ellenőrzés

- A modulok `requiredSecrets` kulcsait a rendszer **dekriptálás nélkül** (`listSecrets()` + `.env` kulcslista alapján) ellenőrzi, így a `#modules` betöltése nem terheli a CPU-t és a memóriát.
- Ha egy modulhoz vagy telepített ügynökhöz hiányzik egy kulcs / Discord csatorna változó, a kártyán megjelenik a **Konfigurációra vár ⚠** jelzés, és a **Részletek** vagy a telepítés utáni **Checklist** modálból egyetlen kattintással megnyithatod a Vault kulcsbeviteli mezőjét előre kitöltött kulcsnévvel.

---

## 4. Kaszkád Kikapcsolás, Azonnali Hot-Reload és Adatmegőrzés

- **Kaszkád kikapcsolás:** Ha egy modult aktív specialista ügynök használ (pl. `batch-api` ← `alfred-batch`), a Dashboard megerősítő ablakban felajánlja, hogy a függő ügynököt is kikapcsolja a modullal együtt (`disableDependentAgents: true`).
- **Azonnali érvényesülés (`mtimeMs` hot-reload):** A futó `alfred-prod` folyamat automatikusan figyeli a `config/agents.json` módosítási idejét, így az ügynökök be-/kikapcsolása a következő Discord üzenettől újraindítás és aktív munkamenetek megszakítása nélkül érvénybe lép.
- **Biztonságos telepítés és adatmegőrzés:**
  - Új ügynökcsomag telepítésekor a csomag `SKILL.md` fájljai először átmennek a determinisztikus **biztonsági szkenneren**; a telepített ügynök alapértelmezetten **`Kikapcsolva` (`enabled: false`)** állapotban jön létre.
  - **Eltávolítás (`uninstall`)** esetén az ügynök csak a `config/agents.json`-ből kerül ki: a testreszabott **`agents/<id>/SOUL.md`** fájlod és a **`workspaces/<id>/`** munkakönyvtár **mindig érintetlenül megmarad**.
