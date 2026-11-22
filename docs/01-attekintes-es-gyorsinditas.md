# 1. Áttekintés & Gyorsindítás (Architektúra, Szerepkörök, CostOps)

## 🎯 Mit tud az Alfred?
Az **Alfred** egy önfejlesztő, több-ügynökös (Multi-Agent) AI rendszer és egységes VPS vezérlőpult, amely Discord csatornákon és egyetlen központi Webes Dashboardon keresztül irányítható. Kombinálja a **`$0` API-költségű előfizetéses CLI-ket** (`claude-cli`, `agy-cli`, `codex-cli`, `gemini-cli`) a **valós idejű Modell API-kkal** (`deepseek`, `vertex-eu`, `gemini`, `openai`, `xai`).

---

## 🛠 Architektúra és Szolgáltatások

```text
+-----------------------------------------------------------------------+
|                    Egységes Dashboard (alfred-web)                    |
|     #overview | #kanban | #agents | #providers | #vps | #docs         |
+-------------------+-----------------------+---------------------------+
                    |                       |
                    v                       v
      +---------------------------+   +---------------------------+
      |   alfred-prod (Éles Core) |   | alfred-ops (DevOps Őrszem)|
      | - Discord Gateway         |   | - #alfred-ops csatorna    |
      | - Hybrid Model Router     |   | - Scoped bash whitelist   |
      | - 4-CLI Runner + Mutex    |   | - cli_manage eszköz       |
      | - System Monitor & HK     |   | - system_storage eszköz   |
      +---------------------------+   +---------------------------+
```

### A 4 Munkakör (Role-alapú Modell-választás az `#agents` lapon)
1. **Tervező (`tervezo`):** Rendszertervezés, architektúra, összetett elemzés.
2. **Szakértő / Kódoló (`szakmunkas`):** Kódírás, tesztelés, fájlrendszer és git műveletek.
3. **Technikus (`technikus`):** QA, kód-ellenőrzés, DevOps és szerver-diagnosztika.
4. **Segítő (`segedmunkas`):** Gyors, kis erőforrás-igényű napi feladatok és összefoglalók.

---

## 🚀 Gyorsindítás 3 Lépésben

1. **CLI-k és API-k bekötése (`#providers`):**
   - Lépj az **API & CLI (`#providers`)** oldalra, telepítsd a kívánt CLI-ket (`claude-cli`, `agy-cli`, `codex-cli`), és jelentkezz be a **Böngészős OAuth indítása** gombbal.
2. **Munkakörök és Ügynökök beállítása (`#agents`):**
   - Lépj az **Ügynökök (`#agents`)** oldalra, és a **Munkakör-alapú Modell-választó** kártyán rendeld hozzá az előfizetéses CLI-ket vagy API modelleket a 4 munkakörhöz.
3. **VPS egészség ellenőrzése (`#vps`):**
   - Lépj a **VPS (`#vps`)** oldalra, ahol a **Memória & SSD** kártyán látod a RAM, Swap, Top RSS folyamat és SSD mutatókat, valamint egy kattintással elindíthatod az **Azonnali takarítás** folyamatot.
