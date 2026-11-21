#!/bin/bash
# Alfred - OS-detect wrapper
# Detects the operating system and launches the appropriate installer.

# ── Language selection ────────────────────────────────────────────────────────
# INSTNONINTER1118: --non-interactive asks nothing; ALFRED_LANG or the default (hu).
for __a in "$@"; do [ "$__a" = --non-interactive ] && ALFRED_LANG="${ALFRED_LANG:-hu}"; done
if [[ -z "${ALFRED_LANG:-}" ]]; then
  echo ""
  echo "  🌍  1. Magyar (HU)    2. English (EN)"
  read -rp "  Language / Nyelv [1/2, default: 1]: " _LANG_CHOICE
  case "${_LANG_CHOICE:-1}" in
    2|en|EN) ALFRED_LANG=en ;;
    *) ALFRED_LANG=hu ;;
  esac
fi
export ALFRED_LANG
# Save language choice for update.sh and other scripts
echo "$ALFRED_LANG" > "$(dirname "$0")/.lang"
# ─────────────────────────────────────────────────────────────────────────────

case "$(uname -s)" in
  Darwin)
    exec "$(dirname "$0")/install-macos.sh" "$@"
    ;;
  Linux)
    exec "$(dirname "$0")/install-linux.sh" "$@"
    ;;
  *)
    if [[ "${ALFRED_LANG:-hu}" == "en" ]]; then
      echo "Unsupported operating system: $(uname -s)"
      echo "Supported: macOS (Darwin), Linux (Ubuntu/Debian + Fedora/Nobara/RHEL)"
    else
      echo "Nem támogatott operációs rendszer: $(uname -s)"
      echo "Támogatott: macOS (Darwin), Linux (Ubuntu/Debian + Fedora/Nobara/RHEL)"
    fi
    exit 1
    ;;
esac
