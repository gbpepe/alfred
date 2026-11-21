---
name: incident-triage
description: VPS szolgáltatás, systemd, journalctl és adatbázis hibák gyors gyökérok-elemzése (RCA).
---

# Incident Triage & RCA Skill

Üzemeltetési hiba vagy leállás elemzésekor:
1. Elsőként gyűjtsd be a tényeket (szolgáltatás státusz, utolsó 30 hiba-sor, RAM/lemez állapot).
2. Különítsd el a **tünetet** a **gyökéroktól**.
3. Adj egy **azonnali elhárítási lépést** (mitigation) és egy **tartós javítást**.
4. Soha ne jeleníts meg titkokat, tokeneket vagy `.env` értékeket a válaszban.
