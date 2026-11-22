# 5. Hibaelhárítás (Troubleshooting) & Üzemeltetési Parancsok

## 🛠 Gyors Hibaelhárítási Ellenőrzőlista

### 1. CLI OAuth vagy Kapcsolati Hiba (`#providers`)
- **Tünet:** A CLI kártyán `✕ Hiba [AUTH_REQUIRED]` vagy `⚠ API kulcs (FIZETŐS!)` jelenik meg.
- **Megoldás:**
  1. Nyisd meg az **API & CLI (`#providers`)** oldalt.
  2. Kattints a CLI kártyáján a **Belépés / Token → Böngészős OAuth indítása** gombra.
  3. Fejezd be az OAuth folyamatot (a `http://localhost:...` callback URL visszamásolásával vagy a Codex eszközkóddal).
  4. Kattints a **4-CLI Profil Szinkron** gombra, hogy az új OAuth fájl minden ügynök `/home/alfred/.cli-profiles/<cliId>/<agentId>` profiljába átmásolódjon.

### 2. `SKILL.md` Mentés Megállítva a Biztonsági Szkenner Által
- **Tünet:** `Biztonsági szkenner megállította a mentést (...)` hibaüzenet.
- **Ok:** A `SKILL.md` olyan kifejezést tartalmaz, amely szerepel a `SKILL_HOLD_PATTERNS` tiltólistán (pl. `ignore previous instructions`, `curl ... | sh`, `base64 --decode | sh`, `<system-reminder>`).
- **Megoldás:** Fogalmazd át a skill instrukcióit biztonságos, deklaratív szabályokká, majd kattints újra a **Szkennelés & Mentés** gombra.

### 3. `systemd` Jogosultságok és `ProtectHome=read-only` Ellenőrzése
Mivel a systemd szolgáltatások `ProtectHome=read-only` védelemmel futnak, a `/home/alfred/.cli-profiles` könyvtárnak szerepelnie kell a `ReadWritePaths` felsorolásban:

```bash
# Ellenőrzés a VPS-en
grep ReadWritePaths /etc/systemd/system/alfred-*.service

# Ha frissítetted a deploy/*.service fájlokat:
sudo mkdir -p /home/alfred/.cli-profiles
sudo chown -R alfred:alfred /home/alfred/.cli-profiles
sudo chmod 700 /home/alfred/.cli-profiles
sudo cp /opt/alfred-prod/deploy/alfred-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart alfred-prod alfred-ops alfred-web
```

### 4. Staging Környezet Újratöltése és Naplók Vizsgálata

```bash
# Aktív staging szolgáltatások listázása
systemctl list-units 'alfred-test*'

# Utolsó 100 naplósor lekérdezése
sudo journalctl -u alfred-prod -n 100 --no-pager
sudo journalctl -u alfred-ops -n 100 --no-pager
```
