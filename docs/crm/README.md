# The CRM moved to its own repository

Moved on 2026-09-22 (CRMKULONREPO922, owner decision): https://github.com/gbpepe/alfred-crm

Everything that lived here (`src/crm/`, `web-crm/`, `docs/crm/`, `scripts/crm/`, the `crm-*` tests
and their fixtures, the `start:crm` and `crm:sync` scripts) is there, with the commit history replayed
(original authors, dates and messages, an `Origin: gbpepe/alfred@<sha>` trailer on each) from the
alfred PRs #1469, #1470, #1472, #1474, #1477, #1473, #1475 and #1479.

The CRM still authenticates with this dashboard's bearer token and reads `store/alfred.db`
read-only; on the host both are symlinked into the CRM's own `store/`. The Bridge port entry
(`/api/bridge/service-ports`) is unchanged: it is a dashboard mechanism, not CRM code.
