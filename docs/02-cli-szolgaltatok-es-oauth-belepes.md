# 2. CLI Szolgáltatók & Böngészős OAuth Belépés (`#providers`)

## 🎯 Miért előfizetéses CLI-ket használunk?
Az előfizetéses headless CLI-k (`claude-cli`, `agy-cli`, `codex-cli`, `gemini-cli`) a meglévő havi AI előfizetésedet használják, így a CostOps számlálóban **`$0.00` változó API-költséggel** futnak.

| Szolgáltató | Kinek ajánlott? | Hitelesítési folyamat a Dashboardon |
| :--- | :--- | :--- |
| **`claude-cli`** | Claude Pro / Max / Team előfizetőknek | Böngészős OAuth + `http://localhost:...` callback URL visszamásolása |
| **`agy-cli`** | **Egyéni (Individual) Google AI Pro / Ultra** előfizetőknek | Böngészős OAuth + `http://localhost:...` callback URL visszamásolása |
| **`codex-cli`** | ChatGPT Plus / Pro / Team előfizetőknek | Böngészős Device Code OAuth (egyszeri 8 jegyű eszközkóddal) |
| **`gemini-cli`** | **Csak Enterprise / céges** Google Code Assist licenchez | Böngészős OAuth + callback URL (egyéni fiókhoz az `agy-cli` használandó!) |

---

## 🛠 Lépésről-lépésre Tutorial: Böngészős OAuth Belépés (SSH nélkül)

### A) `claude-cli` és `agy-cli` (Antigravity CLI) beléptetése
1. Nyisd meg az **API & CLI (`#providers`)** oldalt.
2. Ha a kártyán `nincs telepítve` szerepel, kattints a **Telepítés** gombra (sudo nélkül a `~/.local` prefixbe települ).
3. Kattints a **Belépés / Token** gombra, majd a **Böngészős OAuth indítása** gombra.
4. Kattints a megjelenő **OAuth oldal megnyitása ↗** gombra, és hagyd jóvá a belépést a böngésződben.
5. Amikor a böngésző átirányít a `http://localhost:<port>/...` címre, **másold ki a teljes URL-t a böngésződ címsorából**, illeszd be a Dashboardon a CLI kártya beviteli mezőjébe, és nyomd meg a **Kód beküldése** gombot.
6. A kártya állapota **OAuth előfizetés OK** jelvényre vált, és automatikusan betöltődik az élő **Kvóta** sáv.

### B) `codex-cli` beléptetése (Device Code)
1. Kattints a `codex-cli` kártyán a **Belépés / Token → Böngészős OAuth indítása** gombra.
2. Másold ki a megjelenő **Eszközkódot** (pl. `ABCD-1234`), kattints az **OAuth oldal megnyitása ↗** linkre (`https://auth.openai.com/codex/device`), és add meg a kódot.
3. A Dashboard automatikusan érzékeli a jóváhagyást, és elmenti a `~/.codex/auth.json` tokent.

### C) Kapcsolat Tesztelése és 0-Tokenes Kvóta Lekérdezés
- **Teszt gomb:** Lefuttat egy rövid headless tesztkérést (`Reply with exactly: OK`), és megjeleníti a válaszidőt (`ms`) és a modellt.
- **Kvóta gomb:** `claude-cli`, `agy-cli` és `codex-cli` esetén 0 LLM token felhasználásával lekérdezi az **5 órás** és **7 napos** kvótaablakok szabad százalékát és a következő reset időpontját.
