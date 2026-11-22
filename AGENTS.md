# Alfred projekt szabályok

## 1. Egységes Dashboard felület (TILOS külön admin oldal)
- Az Alfred webes kezelőfelülete **egyetlen egységes Dashboard** (`web/index.html`, `web/vps.js`, `src/web/routes/alfred-vps.ts`).
- **Soha ne hozz létre** külön `/admin` oldalt vagy második admin HTML/UI felületet; minden új admin és VPS vezérlőt a meglévő Dashboardba integrálj.

## 2. Kötelező staging VPS frissítés + saját izolált UI/UX teszt
Minden olyan módosítás után, amely érinti a webes felületet (`web/**`) vagy a webes/admin backend végpontokat (`src/web/**`, `src/alfred/cli-manager.ts`, `src/alfred/cli-runner.ts`), **csak akkor jelenthetsz kész állapotot**, ha az alábbi lépések mind sikeresen (zölden) lefutottak:

1. **Lokális ellenőrzés és push:**
   - `npm.cmd run typecheck:alfred`
   - `npm.cmd run build:alfred` és `npm.cmd run build:web`
   - `npm.cmd run test:alfred`
   - `node --check web/vps.js` (és módosított `web/*.js` fájlok)
   - Commit + `git push origin <aktív-staging-branch>`

2. **Staging VPS frissítése (SSH-val, felhasználói beavatkozás nélkül):**
   - Használd a lokális `gcloud.cmd`-t (`%LOCALAPPDATA%\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd`):
     `gcloud compute ssh alfred-vps --zone=europe-central2-a --project=alferd-hq-gc`
   - Frissítsd az aktív staging worktree-t (`git pull`, `npm run build:alfred`, `npm run build:web`) és indítsd újra a staging systemd szolgáltatásokat (`alfred-test@<slug>`, `alfred-test-web@<slug>`).

3. **Saját, izolált headless Playwright UI/UX teszt (SOHA ne a felhasználó Chrome-ját használd):**
   - Futtasd a dedikált headless Playwright tesztcsomagot: `npm.cmd run test:staging-ui`
   - A `STAGING_URL` a tesztelt staging URL legyen (pl. `https://<slug>-test-alfred.princicol.co.uk`), a `STAGING_TOKEN` pedig a staging `store/.dashboard-token` fájlból olvasandó ki (soha ne logold ki a tokent).
   - **Soha ne csatlakozz** a felhasználó személyes Chrome böngészőjéhez/profiljához (`DevToolsActivePort`), és ne kérd tőle a remote debugging bekapcsolását — mindig a saját, izolált headless Chromium/Playwright folyamatot használd.
   - Ha új UI funkciót vagy javítást készítesz, bővítsd a `tests/staging-ui/` Playwright teszteket is úgy, hogy az új viselkedést is lefedjék.
