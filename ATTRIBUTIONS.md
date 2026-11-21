# Köszönet

Az **Alfred** több nyílt forrású projektre és koncepcióra épít. Ez a dokumentum azokat a forrásokat kreditálja, amelyek alapot adtak a projektnek, beépültek a kódbázisba, vagy érdemi hatással voltak a tervezésre.

Az Alfred saját licensze: [LICENSE](./LICENSE) (MIT).

## Eredet és köszönetnyilvánítás — Marveen (fork: 2026-11-21)

- **Forrás**: https://github.com/Szotasz/marveen (MIT)
- **Szerző**: Szotasz és a Marveen közreműködői
- **Miért különleges köszönet**: Az Alfred **2026-11-21-én a Marveen projektből lett forkolva**, és azóta önálló irányba fejlődik (többügynökös Discord-architektúra, hibrid modell-router, CostOps védelem). Hálás köszönet illeti Szotasz-t és a teljes Marveen-csapatot a rendkívül alapos mérnöki alapokért: a webes dashboardért, a többrétegű memóriarendszerért, a kanbanért, a csatorna-bővítményekért, a biztonsági kapukért, az autonómia-, ütemezés- és föderációs alrendszerért.

## Becsomagolt vagy adaptált kód

### Bumblebee (ellátási-lánc biztonsági scanner)
- **Forrás**: https://github.com/perplexityai/bumblebee
- **Szerző**: Perplexity AI
- **Licensz**: Apache 2.0
- **Hol az Alfredben**: `seed-scheduled-tasks/bumblebee-hygiene-scan/` (a bináris, a scan profil és a beépített threat-intel katalógusok az integráció időpontjában aktuális verziójukkal)
- **Mit csinál nálunk**: heti hétfő 09:00-kor read-only leltár a telepített csomagokról, MCP konfigurációkról és kiterjesztésekről, összeillesztve a beépített ellátási-lánc fenyegetés-katalógusokkal. Csak találat esetén szól.

### Zhutov skill csomag (handoff / retrospective / skill-management)
- **Forrás**: https://artemxtech.substack.com/p/3-claude-code-skills-that-make-claude
- **Szerző**: Artem Zhutov
- **Hol az Alfredben**: `seed-skills/handoff/`, `seed-skills/retrospective/`, `seed-skills/skill-management/`
- **Mit csinál nálunk**: a skill-csontváz az Alfred flotta-architektúrájára adaptálva. Az 5-szekciós handoff struktúra (Goal, Current Progress, What Worked, What Didn't Work, Next Steps), a sub-agent retrospective minta, és a skill-rot életciklus-kezelés koncepció mind Zhutov csomagjából származik. A megvalósítás TypeScript-ben újraírva, integrálva az Alfred checkpoint, DREAM, memória és inter-agent message rendszereivel.

### printing-press (agent-CLI generátor)
- **Forrás**: https://github.com/mvanhorn/cli-printing-press
- **Szerző**: Mike Van Horn
- **Hol az Alfredben**: generátor eszközként használjuk (nem becsomagolva) -- ezzel készülnek a `skool-cli`, `aiam-blog-pp-cli`, `connectors-hu` CLI csomagok, amelyek külső API-kat csomagolnak, plusz a hozzájuk tartozó Claude Code skill fájlok.

## Koncepcionális hatás (nem becsomagolt kód)

### Mark Kashef -- Claude Code-alapú AI-asszisztens architektúra
- **Forrás**: https://youtube.com/@mark_kashef
- **Hol az Alfredben**: a projektet megalapozó Marveen alapkoncepciója (Claude Code mint folyamatosan futó AI-asszisztens, saját csatornákkal, tmux-session-alapú headless működéssel, scheduled-task-okkal). A közösség a megközelítést "Claude Claw" / "ClaudeClaw" néven hivatkozza; az ősprojekt első verziója is ezen a néven indult (2026-04-08), nem fork, hanem a koncepció alapján nulláról felépített saját implementáció, amelyből a Marveen született, majd abból forkolt az Alfred.

### Karpathy CLAUDE.md alapelvek
- **Forrás**: Andrej Karpathy CLAUDE.md útmutatása (publikus)
- **Hol az Alfredben**: a saját gyökér `CLAUDE.md` mintareferenciája. Nem másoltunk kódot; a felépítés és a szabály-stílus Karpathy mintájából inspirálódott.

### Matt Pocock -- "/handoff is my new favourite skill"
- **Forrás**: https://youtu.be/dtAJ2dOd3ko
- **Hol az Alfredben**: a "purpose" argumentum mint kötelező paraméter a `/handoff`-on, és a cross-agent portable design (hogy egy HANDOFF.md működjön Claude Code, Codex, Copilot CLI stb. között) Matt videós design-javaslataiból átvéve.

---

Ha hiányzó attribúciót észlelsz vagy korrekciót szeretnél, nyiss egy issue-t vagy PR-t: https://github.com/gbpepe/alfred.
