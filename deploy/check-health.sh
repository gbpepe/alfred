#!/usr/bin/env bash
# Read-only health, resource, Git, and SQLite status snapshot for all Alfred environments.

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

print_instance_status() {
  local label="$1"
  local dir="$2"
  local service="$3"
  local pid_file="$4"

  local state="inactive"
  if [[ "$DEPLOY_MODE" == "systemd" ]]; then
    if systemctl is-active --quiet "$service" 2>/dev/null; then
      state="active"
    fi
  else
    if is_local_pid_alive "$pid_file"; then
      state="active (pid=$(cat "$pid_file"))"
    fi
  fi

  local git_info="not provisioned"
  if [[ -d "$dir" ]] && git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    local br sha
    br="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
    sha="$(git -C "$dir" rev-parse --short HEAD 2>/dev/null || echo '?')"
    git_info="${br}@${sha}"
  fi

  echo "  - ${label}: state=${state} | dir=${dir} | git=${git_info}"
}

echo "=== Alfred Infrastructure Health (mode=${DEPLOY_MODE}) ==="
print_instance_status "ops" "$OPS_DIR" "$OPS_SERVICE" "$OPS_PID_FILE"
print_instance_status "prod" "$PROD_DIR" "$PROD_SERVICE" "$PROD_PID_FILE"
print_instance_status "test" "$TEST_DIR" "$TEST_SERVICE" "$TEST_PID_FILE"

echo ""
echo "=== Git Worktrees ==="
git -C "$SOURCE_REPO" worktree list || true

echo ""
echo "=== Memory & Disk ==="
if command -v free >/dev/null 2>&1; then
  free -h
else
  echo "(free utility not available on this OS)"
fi
if command -v df >/dev/null 2>&1; then
  df -h "$REPO_ROOT" || true
else
  echo "(df utility not available on this OS)"
fi

echo ""
echo "=== SQLite Databases ==="
seen_db_dirs=""
for db_dir in "$OPS_DIR/store" "$PROD_DIR/store" "$TEST_DIR/store"; do
  if [[ -d "$db_dir" ]] && [[ " $seen_db_dirs " != *" $db_dir "* ]]; then
    seen_db_dirs="$seen_db_dirs $db_dir"
    ls -lh "$db_dir"/alfred*.db* 2>/dev/null || true
  fi
done

if [[ "$DEPLOY_MODE" == "systemd" ]] && command -v journalctl >/dev/null 2>&1; then
  echo ""
  echo "=== Recent Errors (last 10 per service) ==="
  for svc in "$OPS_SERVICE" "$PROD_SERVICE" "$TEST_SERVICE"; do
    echo "--- $svc ---"
    journalctl -u "$svc" -p err -n 10 --no-pager 2>/dev/null || true
  done
fi
