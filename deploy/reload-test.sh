#!/usr/bin/env bash
# Updates an existing staging worktree, rebuilds, runs `test:alfred`, and restarts `alfred-test`.

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

DRY_RUN=0
TARGET_BRANCH=""
for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then
    DRY_RUN=1
  elif [[ -z "$TARGET_BRANCH" ]]; then
    TARGET_BRANCH="$arg"
  else
    log_err "Unexpected argument: $arg"
    exit 1
  fi
done

if [[ -n "$TARGET_BRANCH" ]]; then
  validate_self_branch "$TARGET_BRANCH"
  configure_test_target "$TARGET_BRANCH" "1"
else
  configure_test_target "" "0"
fi

if [[ ! -d "$TEST_DIR" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    log_info "[DRY-RUN] Would reload staging worktree at $TEST_DIR (if provisioned)"
    exit 0
  fi
  log_err "Test worktree does not exist at '$TEST_DIR'. Run deploy/spinup-test.sh <branch> first."
  exit 1
fi

CURRENT_BRANCH="$(git -C "$TEST_DIR" rev-parse --abbrev-ref HEAD)"
validate_self_branch "$CURRENT_BRANCH"

if [[ -n "$(git -C "$TEST_DIR" status --porcelain --untracked-files=no)" ]]; then
  log_err "Test worktree '$TEST_DIR' has uncommitted changes to tracked files; refusing reload."
  exit 1
fi

log_info "Reloading staging worktree '$TEST_DIR' on branch '$CURRENT_BRANCH' (mode=$DEPLOY_MODE)"

if [[ "$DRY_RUN" == "1" ]]; then
  log_info "[DRY-RUN] git -C $TEST_DIR pull --ff-only"
  log_info "[DRY-RUN] (cd $TEST_DIR && npm run typecheck:alfred && $ALFRED_BUILD_CMD && npm run test:alfred)"
  restart_instance "test" "$TEST_DIR" "$TEST_SERVICE" "$TEST_PID_FILE" "1"
  verify_instance_alive "test" "$TEST_SERVICE" "$TEST_PID_FILE" 5 "1"
  exit 0
fi

if git -C "$TEST_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  git -C "$TEST_DIR" pull --ff-only
else
  log_info "No upstream tracking branch configured; syncing from $SOURCE_REPO/$CURRENT_BRANCH"
  LOCAL_SHA="$(git -C "$SOURCE_REPO" rev-parse --verify "$CURRENT_BRANCH")"
  git -C "$TEST_DIR" merge --ff-only "$LOCAL_SHA"
fi

ensure_node_modules "$TEST_DIR" "$SOURCE_REPO"

(
  cd "$TEST_DIR"
  npm run typecheck:alfred
  $ALFRED_BUILD_CMD
  if [[ -f tsconfig.web.build.json ]]; then
    npm run build:web
  fi
  npm run test:alfred
)

restart_instance "test" "$TEST_DIR" "$TEST_SERVICE" "$TEST_PID_FILE" "0"
verify_instance_alive "test" "$TEST_SERVICE" "$TEST_PID_FILE" 5 "0"
if [[ "$DEPLOY_MODE" == "systemd" ]]; then
  if [[ -n "$TEST_SLUG" || -f /etc/systemd/system/alfred-test-web.service ]]; then
    run_systemctl restart "$TEST_WEB_SERVICE" || true
  fi
fi
log_info "Staging environment reloaded cleanly on branch '$CURRENT_BRANCH'"
