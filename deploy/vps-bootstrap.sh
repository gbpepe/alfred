#!/usr/bin/env bash
# Idempotent Ubuntu/Debian VPS bootstrap script for Alfred:
# Sets up `alfred` user, `/opt/alfred-ops` + `/opt/alfred-prod`, builds `dist/alfred/run.js`,
# scaffolds `.env` / `.env.test` (non-destructively), installs systemd units & scoped sudoers,
# and enables `alfred-ops` + `alfred-prod` (keeping `alfred-test` on-demand).

set -euo pipefail

REPO_URL="${ALFRED_REPO_URL:-https://github.com/gbpepe/alfred.git}"
BRANCH="${ALFRED_BRANCH:-feat/alfred-core}"
ALFRED_USER="${ALFRED_SYSTEM_USER:-alfred}"
OPS_DIR="/opt/alfred-ops"
PROD_DIR="/opt/alfred-prod"
DRY_RUN=0
SKIP_START=0
FORCE_START=0

usage() {
  cat <<'EOF'
Usage: sudo bash deploy/vps-bootstrap.sh [options]

Options:
  --repo-url <url>    Git repository URL (default: https://github.com/gbpepe/alfred.git)
  --branch <name>     Git branch to bootstrap from (default: feat/alfred-core)
  --user <name>       Linux system user to own /opt/alfred-* (default: alfred)
  --skip-start        Install everything without starting systemd services
  --force-start       Start services even if .env files still contain placeholder values
  --dry-run           Print planned actions without modifying the system
  -h, --help          Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-url)
      REPO_URL="${2:-}"
      shift 2
      ;;
    --branch)
      BRANCH="${2:-}"
      shift 2
      ;;
    --user)
      ALFRED_USER="${2:-}"
      shift 2
      ;;
    --skip-start)
      SKIP_START=1
      shift
      ;;
    --force-start)
      FORCE_START=1
      shift
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

if [[ ! "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || [[ "$BRANCH" == *".."* ]] || [[ "$BRANCH" == -* ]]; then
  log_err "Invalid branch name: '$BRANCH'"
  exit 1
fi
if [[ ! "$ALFRED_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
  log_err "Invalid Linux username: '$ALFRED_USER'"
  exit 1
fi
if [[ -z "$REPO_URL" ]]; then
  log_err "--repo-url cannot be empty"
  exit 1
fi

run_cmd() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log_info "[DRY-RUN] $*"
  else
    "$@"
  fi
}

run_as_alfred() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log_info "[DRY-RUN] (as $ALFRED_USER) $*"
  else
    su -s /bin/bash "$ALFRED_USER" -c "$*"
  fi
}

if [[ "$DRY_RUN" != "1" ]]; then
  if [[ "$(id -u)" -ne 0 ]]; then
    log_err "This script must run as root (e.g. sudo bash deploy/vps-bootstrap.sh)."
    exit 1
  fi
  if [[ ! -d /run/systemd/system ]] || ! command -v systemctl >/dev/null 2>&1; then
    log_err "systemd is required on this host."
    exit 1
  fi
  for bin in git node npm visudo; do
    if ! command -v "$bin" >/dev/null 2>&1; then
      log_err "Missing required binary: $bin"
      exit 1
    fi
  done
  NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
  if [[ "$NODE_MAJOR" -lt 22 ]]; then
    log_err "Node.js >= 22 is required (found v$(node -v))."
    exit 1
  fi
  if ! command -v sqlite3 >/dev/null 2>&1; then
    log_warn "sqlite3 CLI not found; promote-to-prod.sh will fall back to file copy for backups (recommended: apt-get install -y sqlite3)."
  fi
fi

# 1. System user & directories
if ! id "$ALFRED_USER" >/dev/null 2>&1; then
  log_info "Creating system user '$ALFRED_USER'..."
  run_cmd useradd -r -m -s /bin/bash "$ALFRED_USER"
fi

log_info "Preparing $OPS_DIR and $PROD_DIR..."
run_cmd mkdir -p "$OPS_DIR/store" "$OPS_DIR/.claude" "$PROD_DIR/store" "$PROD_DIR/workspaces" "$PROD_DIR/.claude"
run_cmd chown -R "$ALFRED_USER:$ALFRED_USER" "$OPS_DIR" "$PROD_DIR"

# 2. Clone or update repositories and build dist/alfred/run.js
sync_and_build_repo() {
  local target_dir="$1"
  local target_branch="$2"
  local create_main="$3"

  if [[ ! -d "$target_dir/.git" ]]; then
    log_info "Cloning $REPO_URL ($BRANCH) into $target_dir..."
    run_as_alfred "git clone --branch '$BRANCH' '$REPO_URL' '$target_dir'"
    if [[ "$create_main" == "1" ]]; then
      run_as_alfred "cd '$target_dir' && git checkout -B '$target_branch'"
    fi
  else
    log_info "Repository already exists at $target_dir; skipping clone."
  fi

  log_info "Installing dependencies and building $target_dir..."
  run_as_alfred "cd '$target_dir' && npm ci && npm run build:alfred"
}

sync_and_build_repo "$OPS_DIR" "$BRANCH" "0"
sync_and_build_repo "$PROD_DIR" "main" "1"

# 3. Non-destructive .env scaffolding
write_env_if_missing() {
  local file_path="$1"
  local content="$2"
  if [[ -f "$file_path" ]]; then
    log_info "Keeping existing $file_path"
    return 0
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    log_info "[DRY-RUN] Create starter env file $file_path (0600)"
    return 0
  fi
  umask 077
  printf '%s\n' "$content" > "$file_path"
  chown "$ALFRED_USER:$ALFRED_USER" "$file_path"
  chmod 600 "$file_path"
  log_info "Created starter env file: $file_path (fill in real tokens before starting!)"
}

write_env_if_missing "$OPS_DIR/.env" "ALFRED_ENV=ops
ALFRED_ENABLED_AGENTS=alfred-ops
ALFRED_DB_PATH=store/alfred-ops.db
ALFRED_WORKSPACES_DIR=workspaces
ALFRED_BUDGET_MULTIPLIER=1.0
ALFRED_GLOBAL_DAILY_BUDGET_USD=5.0

ALLOWED_USER_IDS=REPLACE_WITH_DISCORD_USER_ID
DISCORD_BOT_TOKEN=REPLACE_WITH_OPS_BOT_TOKEN
DISCORD_CHANNEL_ALFRED_OPS=REPLACE_WITH_OPS_CHANNEL_ID

DEEPSEEK_API_KEY=REPLACE_WITH_DEEPSEEK_API_KEY
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1"

write_env_if_missing "$OPS_DIR/.env.test" "ALFRED_ENV=test
ALFRED_DB_PATH=store/alfred-test.db
ALFRED_WORKSPACES_DIR=workspaces-test
ALFRED_BUDGET_MULTIPLIER=0.2
ALFRED_GLOBAL_DAILY_BUDGET_USD=5.0

ALLOWED_USER_IDS=REPLACE_WITH_DISCORD_USER_ID
DISCORD_BOT_TOKEN=REPLACE_WITH_TEST_BOT_TOKEN
DISCORD_CHANNEL_ALFRED_HQ=REPLACE_WITH_TEST_HQ_CHANNEL_ID
DISCORD_CHANNEL_PROJ_HYPATIA=REPLACE_WITH_TEST_HYPATIA_CHANNEL_ID
DISCORD_CHANNEL_ALFRED_QA=REPLACE_WITH_TEST_QA_CHANNEL_ID
DISCORD_CHANNEL_ALFRED_SELF_DEV=REPLACE_WITH_TEST_SELF_DEV_CHANNEL_ID

DEEPSEEK_API_KEY=REPLACE_WITH_DEEPSEEK_API_KEY
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
VERTEX_EU_PROJECT_ID=REPLACE_WITH_GCP_EU_PROJECT_ID
VERTEX_EU_LOCATION=eu"

write_env_if_missing "$PROD_DIR/.env" "ALFRED_ENV=production
ALFRED_DB_PATH=store/alfred-prod.db
ALFRED_WORKSPACES_DIR=workspaces
ALFRED_BUDGET_MULTIPLIER=1.0
ALFRED_GLOBAL_DAILY_BUDGET_USD=15.0

ALLOWED_USER_IDS=REPLACE_WITH_DISCORD_USER_ID
DISCORD_BOT_TOKEN=REPLACE_WITH_PROD_BOT_TOKEN
DISCORD_CHANNEL_ALFRED_HQ=REPLACE_WITH_PROD_HQ_CHANNEL_ID
DISCORD_CHANNEL_PROJ_HYPATIA=REPLACE_WITH_PROD_HYPATIA_CHANNEL_ID
DISCORD_CHANNEL_ALFRED_QA=REPLACE_WITH_PROD_QA_CHANNEL_ID
DISCORD_CHANNEL_ALFRED_SELF_DEV=
DISCORD_CHANNEL_ALFRED_OPS=

DEEPSEEK_API_KEY=REPLACE_WITH_DEEPSEEK_API_KEY
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1
VERTEX_EU_PROJECT_ID=REPLACE_WITH_GCP_EU_PROJECT_ID
VERTEX_EU_LOCATION=eu"

# 4. Install systemd units & scoped sudoers
log_info "Installing systemd unit files..."
run_cmd cp "$OPS_DIR/deploy/alfred-ops.service" /etc/systemd/system/alfred-ops.service
run_cmd cp "$OPS_DIR/deploy/alfred-prod.service" /etc/systemd/system/alfred-prod.service
run_cmd cp "$OPS_DIR/deploy/alfred-test.service" /etc/systemd/system/alfred-test.service

log_info "Installing scoped sudoers rules (/etc/sudoers.d/alfred-ops)..."
run_cmd cp "$OPS_DIR/deploy/alfred-ops.sudoers.example" /etc/sudoers.d/alfred-ops
run_cmd chmod 0440 /etc/sudoers.d/alfred-ops
if [[ "$DRY_RUN" != "1" ]]; then
  visudo -cf /etc/sudoers.d/alfred-ops
fi

run_cmd systemctl daemon-reload
run_cmd systemctl enable alfred-ops.service alfred-prod.service

# 5. Start services only if tokens are configured (unless --skip-start or --force-start)
has_placeholders=0
for envf in "$OPS_DIR/.env" "$PROD_DIR/.env"; do
  if [[ -f "$envf" ]] && grep -q 'REPLACE_WITH_' "$envf"; then
    has_placeholders=1
  fi
done

if [[ "$SKIP_START" == "1" ]]; then
  log_info "Skipping service start (--skip-start)."
elif [[ "$has_placeholders" == "1" && "$FORCE_START" != "1" ]]; then
  log_warn "Placeholder values (REPLACE_WITH_*) detected in .env files."
  log_warn "Fill in real tokens in $OPS_DIR/.env, $OPS_DIR/.env.test, and $PROD_DIR/.env, then run:"
  log_warn "  sudo systemctl start alfred-ops alfred-prod"
else
  log_info "Starting alfred-ops and alfred-prod services..."
  run_cmd systemctl restart alfred-ops alfred-prod
  run_cmd su -s /bin/bash "$ALFRED_USER" -c "bash '$OPS_DIR/deploy/check-health.sh'"
fi

log_info "VPS bootstrap complete."
