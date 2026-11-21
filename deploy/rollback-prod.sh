#!/usr/bin/env bash
# Emergency rollback of production to `.last-good-prod-commit`, rebuild, restart, and 5s health check.

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

DRY_RUN=0
for arg in "$@"; do
  if [[ "$arg" == "--dry-run" ]]; then
    DRY_RUN=1
  else
    log_err "Unexpected argument: $arg"
    exit 1
  fi
done

ANCHOR_FILE="$PROD_DIR/store/.last-good-prod-commit"
if [[ ! -f "$ANCHOR_FILE" ]]; then
  log_err "Rollback anchor file not found: $ANCHOR_FILE"
  exit 1
fi

TARGET_SHA="$(tr -d ' \t\r\n' < "$ANCHOR_FILE")"
if [[ ! "$TARGET_SHA" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
  log_err "Invalid commit SHA in $ANCHOR_FILE: '$TARGET_SHA'"
  exit 1
fi

log_info "Rolling back production ($PROD_DIR) to commit $TARGET_SHA (mode=$DEPLOY_MODE)"

if [[ "$DRY_RUN" == "1" ]]; then
  log_info "[DRY-RUN] git -C $PROD_DIR reset --hard $TARGET_SHA"
  log_info "[DRY-RUN] (cd $PROD_DIR && $ALFRED_BUILD_CMD)"
  restart_instance "prod" "$PROD_DIR" "$PROD_SERVICE" "$PROD_PID_FILE" "1"
  verify_instance_alive "prod" "$PROD_SERVICE" "$PROD_PID_FILE" 5 "1"
  exit 0
fi

git -C "$PROD_DIR" reset --hard "$TARGET_SHA"
ensure_node_modules "$PROD_DIR" "$SOURCE_REPO"
(
  cd "$PROD_DIR"
  $ALFRED_BUILD_CMD
)

restart_instance "prod" "$PROD_DIR" "$PROD_SERVICE" "$PROD_PID_FILE" "0"
verify_instance_alive "prod" "$PROD_SERVICE" "$PROD_PID_FILE" 5 "0"
log_info "Rollback complete: production restored to $TARGET_SHA"
