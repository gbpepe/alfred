#!/usr/bin/env bash
# Idempotent Ubuntu 24.04 / Debian 12 VPS bootstrap script for Alfred:
# - Creates a 2 GB swapfile (if no active swap) and persists it in /etc/fstab
# - Installs base packages (git, curl, sqlite3, build-essential, ca-certificates, gnupg) + Node.js 22 LTS
# - Globally installs headless CLIs (@anthropic-ai/claude-code, @openai/codex, @google/gemini-cli)
# - Creates `alfred` system user and /opt/alfred-prod, /opt/alfred-ops, /opt/alfred-worktrees, /etc/alfred
# - Conditionally installs systemd service units & scoped sudoers when /opt/alfred-prod/deploy exists

set -euo pipefail

ALFRED_USER="${ALFRED_SYSTEM_USER:-alfred}"
OPS_DIR="/opt/alfred-ops"
PROD_DIR="/opt/alfred-prod"
WORKTREES_DIR="/opt/alfred-worktrees"
ETC_ALFRED_DIR="/etc/alfred"
SWAP_FILE="/swapfile"
CLIS_RAW="claude,codex,gemini"
SKIP_CLIS=0
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: sudo bash deploy/vps-bootstrap.sh [options]

Options:
  --skip-clis             Skip global npm installation of CLI providers
  --clis=<list>           Comma-separated CLIs to install (subset of: claude,codex,gemini)
                          Default: claude,codex,gemini
  --user <name>           Linux system user to own /opt/alfred-* (default: alfred)
  --dry-run               Print planned actions without modifying the system
  -h, --help              Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-clis)
      SKIP_CLIS=1
      shift
      ;;
    --clis=*)
      CLIS_RAW="${1#--clis=}"
      shift
      ;;
    --clis)
      CLIS_RAW="${2:-}"
      shift 2
      ;;
    --user)
      ALFRED_USER="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[vps-bootstrap][ERROR] Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

log_info() { echo "[vps-bootstrap] $*"; }
log_warn() { echo "[vps-bootstrap][WARN] $*" >&2; }
log_err()  { echo "[vps-bootstrap][ERROR] $*" >&2; }

if [[ ! "$ALFRED_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
  log_err "Invalid Linux username: '$ALFRED_USER'"
  exit 1
fi

SELECTED_CLIS=()
if [[ "$SKIP_CLIS" != "1" ]]; then
  if [[ -z "${CLIS_RAW// }" ]]; then
    log_err "--clis cannot be empty (use --skip-clis to skip CLI installation)"
    exit 1
  fi
  IFS=',' read -ra RAW_ITEMS <<< "$CLIS_RAW"
  for item in "${RAW_ITEMS[@]}"; do
    clean_item="${item//[[:space:]]/}"
    case "$clean_item" in
      claude|codex|gemini)
        SELECTED_CLIS+=("$clean_item")
        ;;
      *)
        log_err "Unsupported CLI name in --clis: '$clean_item' (allowed: claude, codex, gemini)"
        exit 1
        ;;
    esac
  done
fi

run_cmd() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log_info "[DRY-RUN] $*"
  else
    "$@"
  fi
}

if [[ "$DRY_RUN" != "1" && "$(id -u)" -ne 0 ]]; then
  log_err "This script must be run as root (e.g. sudo bash deploy/vps-bootstrap.sh)."
  exit 1
fi

# 1. Idempotent 2 GB swapfile
if [[ "$DRY_RUN" == "1" ]] || [[ -z "$(swapon --show --noheadings 2>/dev/null || true)" ]]; then
  log_info "Configuring 2 GB swap at $SWAP_FILE..."
  if [[ "$DRY_RUN" == "1" ]]; then
    log_info "[DRY-RUN] Create 2G $SWAP_FILE (chmod 600, mkswap, swapon) and add to /etc/fstab"
  else
    if [[ ! -f "$SWAP_FILE" ]]; then
      if command -v fallocate >/dev/null 2>&1; then
        fallocate -l 2G "$SWAP_FILE" || dd if=/dev/zero of="$SWAP_FILE" bs=1M count=2048
      else
        dd if=/dev/zero of="$SWAP_FILE" bs=1M count=2048
      fi
    fi
    chmod 600 "$SWAP_FILE"
    mkswap "$SWAP_FILE"
    swapon "$SWAP_FILE"
    if ! grep -qE "^[[:space:]]*${SWAP_FILE}[[:space:]]" /etc/fstab; then
      printf '%s none swap sw 0 0\n' "$SWAP_FILE" >> /etc/fstab
    fi
  fi
else
  log_info "Active swap already detected; skipping $SWAP_FILE creation."
fi

# 2. Base packages & Node.js 22 LTS
log_info "Installing base apt packages (git, curl, sqlite3, build-essential, ca-certificates, gnupg)..."
if [[ "$DRY_RUN" == "1" ]]; then
  log_info "[DRY-RUN] DEBIAN_FRONTEND=noninteractive apt-get update -y && apt-get install -y git curl sqlite3 build-essential ca-certificates gnupg"
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y git curl sqlite3 build-essential ca-certificates gnupg
fi

NEED_NODE22=0
if ! command -v node >/dev/null 2>&1; then
  NEED_NODE22=1
else
  NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
  if [[ "$NODE_MAJOR" -lt 22 ]]; then
    NEED_NODE22=1
  fi
fi

if [[ "$NEED_NODE22" == "1" ]]; then
  log_info "Installing Node.js 22 LTS via NodeSource..."
  if [[ "$DRY_RUN" == "1" ]]; then
    log_info "[DRY-RUN] curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs"
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  fi
else
  log_info "Node.js $(node -v) already satisfies >= 22."
fi

# 3. System user & directory structure (created BEFORE user-level CLI installs)
if [[ "$DRY_RUN" == "1" ]]; then
  log_info "[DRY-RUN] Ensure user '$ALFRED_USER' exists and prepare $PROD_DIR, $OPS_DIR, $WORKTREES_DIR, $ETC_ALFRED_DIR, and home dirs (~/.local, ~/.local/bin, ~/.claude, ~/.codex, ~/.gemini, ~/.config)"
  ALFRED_HOME="/home/$ALFRED_USER"
else
  if ! id "$ALFRED_USER" >/dev/null 2>&1; then
    log_info "Creating system user '$ALFRED_USER'..."
    useradd -r -m -s /bin/bash "$ALFRED_USER"
  else
    log_info "System user '$ALFRED_USER' already exists."
  fi

  ALFRED_HOME="$(getent passwd "$ALFRED_USER" | cut -d: -f6 || true)"
  if [[ -z "$ALFRED_HOME" ]]; then
    ALFRED_HOME="/home/$ALFRED_USER"
  fi
  mkdir -p "$ALFRED_HOME/.local/bin" "$ALFRED_HOME/.claude" "$ALFRED_HOME/.codex" "$ALFRED_HOME/.gemini" "$ALFRED_HOME/.config"
  chown -R "$ALFRED_USER:$ALFRED_USER" "$ALFRED_HOME/.local" "$ALFRED_HOME/.claude" "$ALFRED_HOME/.codex" "$ALFRED_HOME/.gemini" "$ALFRED_HOME/.config"
  chmod 700 "$ALFRED_HOME/.claude" "$ALFRED_HOME/.codex" "$ALFRED_HOME/.gemini"

  mkdir -p "$PROD_DIR/store" "$PROD_DIR/workspaces" "$PROD_DIR/.claude" "$PROD_DIR/logs" "$PROD_DIR/batch" \
    "$OPS_DIR/store" "$OPS_DIR/.claude" "$OPS_DIR/logs" "$WORKTREES_DIR"
  chown -R "$ALFRED_USER:$ALFRED_USER" "$PROD_DIR" "$OPS_DIR" "$WORKTREES_DIR"

  mkdir -p "$ETC_ALFRED_DIR"
  chown "root:$ALFRED_USER" "$ETC_ALFRED_DIR"
  chmod 750 "$ETC_ALFRED_DIR"
fi

# 4. User-level headless CLI installations into $ALFRED_HOME/.local (no sudo needed at runtime)
if [[ "$SKIP_CLIS" == "1" ]]; then
  log_info "Skipping user-level CLI installation (--skip-clis)."
else
  for cli in "${SELECTED_CLIS[@]}"; do
    case "$cli" in
      claude) pkg="@anthropic-ai/claude-code" ;;
      codex)  pkg="@openai/codex" ;;
      gemini) pkg="@google/gemini-cli" ;;
    esac
    log_info "Installing CLI package into $ALFRED_HOME/.local: $pkg..."
    if [[ "$DRY_RUN" == "1" ]]; then
      log_info "[DRY-RUN] su -s /bin/bash $ALFRED_USER -c \"NPM_CONFIG_PREFIX='$ALFRED_HOME/.local' npm install -g '$pkg'\""
    else
      su -s /bin/bash "$ALFRED_USER" -c "NPM_CONFIG_PREFIX='$ALFRED_HOME/.local' npm install -g '$pkg'"
    fi
  done
fi

# 5. Conditional systemd units & sudoers installation (if repo is already cloned in /opt/alfred-prod)
if [[ -d "$PROD_DIR/deploy" ]]; then
  log_info "Detected $PROD_DIR/deploy; installing systemd units and scoped sudoers..."
  if [[ "$DRY_RUN" == "1" ]]; then
    log_info "[DRY-RUN] cp $PROD_DIR/deploy/alfred-*.service /etc/systemd/system/ && systemctl daemon-reload"
    log_info "[DRY-RUN] cp $PROD_DIR/deploy/alfred-ops.sudoers.example /etc/sudoers.d/alfred-ops && chmod 0440 && visudo -cf"
  else
    shopt -s nullglob
    service_files=("$PROD_DIR/deploy"/alfred-*.service)
    shopt -u nullglob
    if [[ ${#service_files[@]} -gt 0 ]]; then
      cp "${service_files[@]}" /etc/systemd/system/
      systemctl daemon-reload
    fi

    if [[ -f "$PROD_DIR/deploy/alfred-ops.sudoers.example" ]]; then
      cp "$PROD_DIR/deploy/alfred-ops.sudoers.example" /etc/sudoers.d/alfred-ops
      chmod 0440 /etc/sudoers.d/alfred-ops
      visudo -cf /etc/sudoers.d/alfred-ops
    fi

    if [[ -f "$PROD_DIR/deploy/alfred-logrotate.conf" ]]; then
      cp "$PROD_DIR/deploy/alfred-logrotate.conf" /etc/logrotate.d/alfred
      chmod 0644 /etc/logrotate.d/alfred
    fi
  fi
else
  log_warn "$PROD_DIR/deploy not found yet; skipping systemd & sudoers installation (re-run after git clone)."
fi

# 6. Print remaining manual steps
cat <<EOF

[vps-bootstrap] Bootstrap complete. Remaining manual steps:
  1. GitHub SSH key & repository clone as '$ALFRED_USER':
     sudo -u $ALFRED_USER ssh-keygen -t ed25519 -C "alfred-vps"
     # Add the public key to GitHub, then clone into $PROD_DIR and $OPS_DIR, and run:
     #   cd $PROD_DIR && npm ci && npm run build:alfred
     #   cd $OPS_DIR && npm ci && npm run build:alfred
     # After cloning, re-run this script once so systemd units & sudoers are installed.

  2. Fill environment secrets in $ETC_ALFRED_DIR/*.env (and/or $PROD_DIR/.env, $OPS_DIR/.env):
     # Populate DISCORD_BOT_TOKEN, ALLOWED_USER_IDS, DEEPSEEK_API_KEY / VERTEX_EU_*, etc. (chmod 600).

  3. Perform one-time subscription CLI authentication as '$ALFRED_USER' (for enabled CLIs):
     sudo -u $ALFRED_USER -H claude login
     sudo -u $ALFRED_USER -H codex login
     sudo -u $ALFRED_USER -H gemini
     # Then enable & start services: sudo systemctl enable --now alfred-ops alfred-prod
EOF
