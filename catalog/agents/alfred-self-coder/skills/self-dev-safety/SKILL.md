---
name: self-dev-safety
description: Biztonságos önfejlesztési protokoll feat/self-* ágakon, typecheck és unit teszt kapuval.
---

# Önfejlesztési Biztonsági Protokoll

1. Ellenőrizd az aktív git ágat (`git status`, `git branch --show-current`) minden szerkesztés előtt.
2. Csak célzott, jól tesztelhető módosításokat végezz; ne módosíts védett rendszerfájlokat.
3. Minden változtatást hitelesíts `typecheck:alfred` és `test:alfred` futtatással commit előtt.
