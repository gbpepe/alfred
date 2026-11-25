#!/usr/bin/env bash
# Creates an isolated staging git worktree for a feature/fix branch (excluding `main`/`master`),
# copies `.env.test`, builds, runs `npm run test:alfred`, and boots `alfred-test`.

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

DRY_RUN=0
MULTI=0
BRANCH=""
for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then
    DRY_RUN=1
  elif [[ "$arg" == "--multi" ]]; then
    MULTI=1
  elif [[ -z "$BRANCH" ]]; then
    BRANCH="$arg"
  else
    log_err "Unexpected argument: $arg"
    exit 1
  fi
done

validate_self_branch "$BRANCH"
configure_test_target "$BRANCH" "$MULTI"

if [[ "$DRY_RUN" != "1" ]] && git -C "$SOURCE_REPO" remote get-url origin >/dev/null 2>&1; then
  if git -C "$SOURCE_REPO" fetch origin "$BRANCH" --quiet 2>/dev/null; then
    if ! git -C "$SOURCE_REPO" show-ref --verify --quiet "refs/heads/$BRANCH"; then
      git -C "$SOURCE_REPO" branch "$BRANCH" FETCH_HEAD
    elif [[ ! -e "$TEST_DIR" ]]; then
      CURRENT_SRC_BRANCH="$(git -C "$SOURCE_REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
      if [[ "$CURRENT_SRC_BRANCH" != "$BRANCH" ]]; then
        git -C "$SOURCE_REPO" branch -f "$BRANCH" FETCH_HEAD || true
      fi
    fi
  fi
fi

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
if [[ -n "$TEST_SLUG" ]]; then
  write_test_ports_file "$TEST_DIR" "$BRANCH" "$TEST_SLUG"
fi

ensure_node_modules "$TEST_DIR" "$SOURCE_REPO"

log_info "Running typecheck, build, and isolated tests in $TEST_DIR..."
(
  cd "$TEST_DIR"
  npm run typecheck:alfred
  $ALFRED_BUILD_CMD
  if [[ -f tsconfig.web.build.json ]]; then
    npm run build:web
  fi
  npm run test:alfred
)

start_instance "test" "$TEST_DIR" "$TEST_SERVICE" "$TEST_PID_FILE" "0"
verify_instance_alive "test" "$TEST_SERVICE" "$TEST_PID_FILE" 5 "0"
if [[ "$DEPLOY_MODE" == "systemd" ]]; then
  if [[ -n "$TEST_SLUG" || -f "/etc/systemd/system/${TEST_WEB_SERVICE}.service" ]]; then
    run_systemctl restart "$TEST_WEB_SERVICE" || true
  fi
fi
if [[ -n "$TEST_SLUG" && -f "$TEST_DIR/.env.ports" ]]; then
  WEB_PORT_VAL="$(awk -F= '/^WEB_PORT=/{print $2}' "$TEST_DIR/.env.ports")"
  node "$SCRIPT_DIR/cf-test-route.mjs" up "$BRANCH" "$WEB_PORT_VAL" || true
fi
log_info "Staging environment is UP on branch '$BRANCH' at $TEST_DIR"
