#!/bin/bash
# HOSTINGERDOCKER1107: the container's start. The code first (atomic, verified: a mismatch stops the start), then the
# first-boot seeds, then supervisor runs the dashboard, the main agent's channels.sh and the two timers.
set -u
# DOCKERSEEDREFRESH1108: the old tree's seed sources, kept before the swap for first-boot's seed refresh. Its failure only
# skips that refresh this time.
bash /opt/alfred-docker/seed-snapshot.sh || echo "entrypoint: WARN: the seed snapshot failed; the seed refresh is skipped this time"
python3 -I /opt/alfred-docker/code-sync.py || { echo "entrypoint: the code sync failed; nothing is started"; exit 1; }
bash /opt/alfred-docker/first-boot.sh || { echo "entrypoint: the first-boot setup failed; nothing is started"; exit 1; }
exec /usr/bin/supervisord -n -c /opt/alfred-docker/supervisord.conf
