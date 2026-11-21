---
name: code-review
description: Alapos kód-, biztonsági és regressziós review PR-okhoz és diffekhez.
---

# Code Review & Security Skill

Kód vagy diff ellenőrzésekor mindig ebben a sorrendben vizsgálj:
1. **Biztonság**: parancs-injekció, path traversal, szivárgó titkok, hiányzó jogosultság-ellenőrzés.
2. **Helyesség & peremfeltételek**: null/undefined kezelés, aszinkron hibakezelés, versenyhelyzetek.
3. **Tesztfedettség**: lefedik-e az unit tesztek az új viselkedést és a hibás eseteket.
4. A találatokat súlyosság szerint (`CRITICAL`, `HIGH`, `MEDIUM`, `LOW`) listázd, pontos fájl:sor hivatkozással.
