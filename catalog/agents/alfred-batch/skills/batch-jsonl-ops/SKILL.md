---
name: batch-jsonl-ops
description: Kanonikus JSONL kötegek előállítása, darabolása és költségbecslése az Alfred Batch API számára.
---

# Batch JSONL Műveletek

1. Minden bemeneti JSONL fájlt kizárólag a `batch/` vagy `store/batch/` könyvtárba írj.
2. Minden sor tartalmazzon egyedi `custom_id` (`^[a-zA-Z0-9_-]{1,64}$`), közös `system` prefixet és tömör `prompt` mezőt.
3. GDPR-érzékeny adatoknál állítsd be az `eu_only: true` jelzőt a `batch_submit` hívásban.
4. Beküldés előtt ellenőrizd, hogy a köteg nem tartalmaz API-kulcsot vagy személyes hitelesítő adatot.
