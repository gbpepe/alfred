#!/usr/bin/env bash
# Creates an isolated staging git worktree for a `feat/self-*` or `fix/self-*` branch,
# copies `.env.test`, builds, runs `npm run test:alfred`, and boots `alfred-test`.

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
  log_err "Branch '$BRANCH' does not exist in $SOURCE_REPO"
  exit 1
fi

if [[ -e "$TEST_DIR" ]]; then
  log_err "Test worktree already exists at '$TEST_DIR'. Use deploy/reload-test.sh or deploy/teardown-test.sh first."
  exit 1
fi

if [[ ! -f "$TEST_ENV_FILE" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    log_info "[DRY-RUN] Note: $TEST_ENV_FILE not present yet (required for live spinup)"
  else
    log_err "Missing staging env file: $TEST_ENV_FILE (create it from .env.example with ALFRED_ENV=test and staging bot token)"
    exit 1
  fi
fi

log_info "Spinning up staging environment (mode=$DEPLOY_MODE, branch=$BRANCH, dir=$TEST_DIR)"

if [[ "$DRY_RUN" == "1" ]]; then
  log_info "[DRY-RUN] git -C $SOURCE_REPO worktree add $TEST_DIR $BRANCH"
  log_info "[DRY-RUN] install -m 600 $TEST_ENV_FILE $TEST_DIR/.env"
  log_info "[DRY-RUN] (cd $TEST_DIR && npm run typecheck:alfred && $ALFRED_BUILD_CMD && npm run test:alfred)"
  start_instance "test" "$TEST_DIR" "$TEST_SERVICE" "$TEST_PID_FILE" "1"
  verify_instance_alive "test" "$TEST_SERVICE" "$TEST_PID_FILE" 5 "1"
  exit 0
fi

git -C "$SOURCE_REPO" worktree add "$TEST_DIR" "$BRANCH"
mkdir -p "$TEST_DIR/store"
cp "$TEST_ENV_FILE" "$TEST_DIR/.env"
chmod 600 "$TEST_DIR/.env" || true
rm -f "$TEST_DIR/store/alfred-test.db" "$TEST_DIR/store/alfred-test.db-wal" "$TEST_DIR/store/alfred-test.db-shm"

ensure_node_modules "$TEST_DIR" "$SOURCE_REPO"

log_info "Running typecheck, build, and isolated tests in $TEST_DIR..."
(
  cd "$TEST_DIR"
  npm run typecheck:alfred
  $ALFRED_BUILD_CMD
  npm run test:alfred
)

start_instance "test" "$TEST_DIR" "$TEST_SERVICE" "$TEST_PID_FILE" "0"
verify_instance_alive "test" "$TEST_SERVICE" "$TEST_PID_FILE" 5 "0"
log_info "Staging environment is UP on branch '$BRANCH' at $TEST_DIR"
