#!/usr/bin/env bash
# Stops the on-demand `alfred-test` instance and deletes the temporary worktree and staging DB.

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

log_info "Tearing down staging environment (mode=$DEPLOY_MODE, dir=$TEST_DIR)"

stop_instance "test" "$TEST_SERVICE" "$TEST_PID_FILE" "$DRY_RUN"
if [[ "$DRY_RUN" == "0" && "$DEPLOY_MODE" == "systemd" ]]; then
  if [[ -n "$TEST_SLUG" || -f /etc/systemd/system/alfred-test-web.service ]]; then
    run_systemctl stop "$TEST_WEB_SERVICE" || true
  fi
fi
if [[ "$DRY_RUN" == "0" && -n "$TARGET_BRANCH" ]]; then
  node "$SCRIPT_DIR/cf-test-route.mjs" down "$TARGET_BRANCH" || true
fi

if [[ "$DRY_RUN" == "1" ]]; then
  log_info "[DRY-RUN] Remove $TEST_DIR/store/alfred-test.db* and $TEST_DIR/workspaces-test"
  log_info "[DRY-RUN] git -C $SOURCE_REPO worktree remove --force $TEST_DIR && git -C $SOURCE_REPO worktree prune"
  exit 0
fi

if [[ -d "$TEST_DIR" ]]; then
  rm -f "$TEST_DIR/store/alfred-test.db" "$TEST_DIR/store/alfred-test.db-wal" "$TEST_DIR/store/alfred-test.db-shm"
  rm -rf "$TEST_DIR/workspaces-test"
  if git -C "$SOURCE_REPO" worktree list --porcelain | grep -Fq "worktree $TEST_DIR"; then
    git -C "$SOURCE_REPO" worktree remove --force "$TEST_DIR"
  else
    rm -rf "$TEST_DIR"
  fi
fi

git -C "$SOURCE_REPO" worktree prune
log_info "Staging teardown complete."
if command -v free >/dev/null 2>&1; then
  free -m | awk 'NR==1 || NR==2 {print "[alfred-deploy] " $0}'
fi
