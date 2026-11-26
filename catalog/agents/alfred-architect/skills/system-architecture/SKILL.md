---
name: system-architecture
description: Moduláris rendszertervezési, séma- és biztonsági audit elvek kis erőforrású VPS környezethez.
---

# Rendszertervezési Alapelvek

1. Minimalizáld a futásidejű memória-lábnyomot: kerüld a felesleges háttérfolyamatokat és dekriptálási ciklusokat.
2. Minden új táblát és API-végpontot idempotens migrációval és explicit hibakódokkal tervezz meg.
3. Tartsd fenn az egységes Dashboard architektúrát és a szigorú eszköz-whitelist határokat.
