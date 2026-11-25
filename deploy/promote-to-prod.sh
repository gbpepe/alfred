#!/usr/bin/env bash
# Safely promotes a tested feature/fix branch (excluding `main`/`master`) to production (`main`),
# runs quality gates, backs up prod state, restarts `alfred-prod`, verifies 5s health
# (auto-rolling back on failure), and tears down the staging environment on success.

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

DRY_RUN=0
BRANCH=""
for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then
    DRY_RUN=1
  elif [[ -z "$BRANCH" ]]; then
    BRANCH="$arg"
  else
    log_err "Unexpected argument: $arg"
    exit 1
  fi
done

validate_self_branch "$BRANCH"

if ! git -C "$SOURCE_REPO" rev-parse --verify --quiet "${BRANCH}^{commit}" >/dev/null; then
  log_err "Branch '$BRANCH' not found in $SOURCE_REPO"
  exit 1
fi

if [[ -n "$(git -C "$PROD_DIR" status --porcelain --untracked-files=no)" ]]; then
  log_err "Production directory '$PROD_DIR' has uncommitted changes to tracked files; aborting promote."
  exit 1
fi

log_info "Starting promote-to-prod for branch '$BRANCH' (mode=$DEPLOY_MODE, prod=$PROD_DIR)"

# 1. Verification gate
GATE_DIR=""
TEMP_GATE_WT=""
cleanup_gate_wt() {
  if [[ -n "$TEMP_GATE_WT" && -d "$TEMP_GATE_WT" ]]; then
    git -C "$SOURCE_REPO" worktree remove --force "$TEMP_GATE_WT" >/dev/null 2>&1 || rm -rf "$TEMP_GATE_WT"
    git -C "$SOURCE_REPO" worktree prune >/dev/null 2>&1 || true
  fi
}
trap cleanup_gate_wt EXIT

if [[ -d "$TEST_DIR" ]] && [[ "$(git -C "$TEST_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)" == "$BRANCH" ]]; then
  GATE_DIR="$TEST_DIR"
elif [[ "$(git -C "$SOURCE_REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || true)" == "$BRANCH" ]]; then
  GATE_DIR="$SOURCE_REPO"
fi

if [[ "$DRY_RUN" == "1" ]]; then
  log_info "[DRY-RUN] Would run npm run typecheck:alfred && npm run test:alfred for $BRANCH"
  log_info "[DRY-RUN] Would record .last-good-prod-commit and backup store/alfred-prod.db"
  log_info "[DRY-RUN] Would merge --no-ff $BRANCH into main in $PROD_DIR and run $ALFRED_BUILD_CMD"
  restart_instance "prod" "$PROD_DIR" "$PROD_SERVICE" "$PROD_PID_FILE" "1"
  verify_instance_alive "prod" "$PROD_SERVICE" "$PROD_PID_FILE" 5 "1"
  log_info "[DRY-RUN] On success would invoke deploy/teardown-test.sh; on failure deploy/rollback-prod.sh"
  exit 0
fi

if [[ -z "$GATE_DIR" ]]; then
  TEMP_GATE_WT="$(mktemp -d "${TMPDIR:-/tmp}/alfred-promote-gate.XXXXXX")"
  rmdir "$TEMP_GATE_WT"
  git -C "$SOURCE_REPO" worktree add --detach "$TEMP_GATE_WT" "$BRANCH"
  ensure_node_modules "$TEMP_GATE_WT" "$SOURCE_REPO"
  GATE_DIR="$TEMP_GATE_WT"
fi

log_info "Running pre-promote quality gate (typecheck:alfred + test:alfred) in $GATE_DIR..."
(
  cd "$GATE_DIR"
  npm run typecheck:alfred
  npm run test:alfred
)

# 2. Record rollback point & SQLite backup
mkdir -p "$PROD_DIR/store/backups"
PREV_PROD_SHA="$(git -C "$PROD_DIR" rev-parse HEAD)"
echo "$PREV_PROD_SHA" > "$PROD_DIR/store/.last-good-prod-commit"
log_info "Recorded rollback anchor: $PREV_PROD_SHA"

PROD_DB="$PROD_DIR/store/alfred-prod.db"
if [[ -f "$PROD_DB" ]]; then
  TS="$(date +%Y%m%d-%H%M%S)"
  BACKUP_PATH="$PROD_DIR/store/backups/alfred-prod-${TS}.db"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$PROD_DB" ".backup '$BACKUP_PATH'"
  else
    cp "$PROD_DB" "$BACKUP_PATH"
  fi
  chmod 600 "$BACKUP_PATH" || true
  log_info "Created SQLite backup at $BACKUP_PATH"
fi

# 3. Merge into main in PROD_DIR
BRANCH_SHA="$(git -C "$SOURCE_REPO" rev-parse --verify "$BRANCH")"
git -C "$PROD_DIR" checkout main
if git -C "$PROD_DIR" remote get-url origin >/dev/null 2>&1; then
  git -C "$PROD_DIR" pull --ff-only || true
fi
git -C "$PROD_DIR" merge --no-ff "$BRANCH_SHA" -m "chore(release): promote $BRANCH to main"

ensure_node_modules "$PROD_DIR" "$SOURCE_REPO"
(
  cd "$PROD_DIR"
  $ALFRED_BUILD_CMD
)

# 4. Restart production and run 5s health check (auto-rollback on failure)
restart_instance "prod" "$PROD_DIR" "$PROD_SERVICE" "$PROD_PID_FILE" "0"
if ! verify_instance_alive "prod" "$PROD_SERVICE" "$PROD_PID_FILE" 5 "0"; then
  log_err "Production health check failed! Triggering automatic rollback..."
  bash "$SCRIPT_DIR/rollback-prod.sh"
  exit 1
fi

# 5. Clean up staging environment on success to free VPS RAM
if [[ -d "$TEST_DIR" ]]; then
  log_info "Promotion verified! Tearing down staging environment to reclaim memory..."
  bash "$SCRIPT_DIR/teardown-test.sh"
fi

log_info "Promotion complete: '$BRANCH' ($BRANCH_SHA) is now live in production!"
