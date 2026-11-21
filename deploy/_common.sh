#!/usr/bin/env bash
# Shared helper functions for Alfred On-Demand Test / Prod lifecycle scripts.
# Supports both Linux systemd VPS (/opt/alfred-prod, /opt/alfred-test, /opt/alfred-ops)
# and local worktree+PID mode for development/testing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ALFRED_BUILD_CMD="${ALFRED_BUILD_CMD:-npm run build:alfred}"
# Child build/test processes (tsc, vitest) must NOT inherit alfred-ops's 128 MB NODE_OPTIONS cap,
# and must use /tmp paths when systemd ProtectHome=true blocks /home/alfred.
export NODE_OPTIONS="${ALFRED_CHILD_NODE_OPTIONS:---max-old-space-size=512}"
export HOME="${ALFRED_CHILD_HOME:-/tmp/alfred-home}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
mkdir -p "$XDG_CONFIG_HOME/git" 2>/dev/null || true
export npm_config_cache="${npm_config_cache:-/tmp/alfred-npm-cache}"
export GIT_CONFIG_GLOBAL="${GIT_CONFIG_GLOBAL:-/dev/null}"
PROD_SERVICE="${ALFRED_PROD_SERVICE:-alfred-prod}"
TEST_SERVICE="${ALFRED_TEST_SERVICE:-alfred-test}"
OPS_SERVICE="${ALFRED_OPS_SERVICE:-alfred-ops}"

detect_deploy_mode() {
  local requested="${ALFRED_DEPLOY_MODE:-auto}"
  if [[ "$requested" == "systemd" || "$requested" == "local" ]]; then
    echo "$requested"
    return
  fi
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    if systemctl list-unit-files "${PROD_SERVICE}.service" >/dev/null 2>&1 || [[ -f "/etc/systemd/system/${PROD_SERVICE}.service" ]]; then
      echo "systemd"
      return
    fi
  fi
  echo "local"
}

DEPLOY_MODE="$(detect_deploy_mode)"

if [[ "$DEPLOY_MODE" == "systemd" ]]; then
  PROD_DIR="${ALFRED_PROD_DIR:-/opt/alfred-prod}"
  TEST_DIR="${ALFRED_TEST_DIR:-/opt/alfred-worktrees/alfred-test}"
  OPS_DIR="${ALFRED_OPS_DIR:-/opt/alfred-ops}"
else
  PROD_DIR="${ALFRED_PROD_DIR:-$REPO_ROOT}"
  TEST_DIR="${ALFRED_TEST_DIR:-$(dirname "$REPO_ROOT")/alfred-test}"
  OPS_DIR="${ALFRED_OPS_DIR:-$REPO_ROOT}"
fi

SOURCE_REPO="${ALFRED_SOURCE_REPO:-$REPO_ROOT}"
TEST_ENV_FILE="${ALFRED_TEST_ENV_FILE:-$SOURCE_REPO/.env.test}"
TEST_PID_FILE="${ALFRED_TEST_PID_FILE:-$TEST_DIR/store/alfred-test.pid}"
PROD_PID_FILE="${ALFRED_PROD_PID_FILE:-$PROD_DIR/store/alfred-prod.pid}"
OPS_PID_FILE="${ALFRED_OPS_PID_FILE:-$OPS_DIR/store/alfred-ops.pid}"

log_info() {
  echo "[alfred-deploy] $*"
}

log_err() {
  echo "[alfred-deploy][ERROR] $*" >&2
}

validate_self_branch() {
  local branch="${1:-}"
  if [[ -z "$branch" ]]; then
    log_err "Branch name is required (must match feat/self-* or fix/self-*)"
    return 1
  fi
  if [[ ! "$branch" =~ ^((feat|fix)/(self|core)-[a-z0-9._/-]{0,79}|core-[a-z0-9._/-]{1,79})$ ]]; then
    log_err "Invalid branch name '$branch': must match feat/self-*, fix/self-*, feat/core-*, or core-*"
    return 1
  fi
  if [[ "$branch" == *".."* || "$branch" == *"//"* || "$branch" == -* || "$branch" == *. || "$branch" == */ || "$branch" == *.lock ]]; then
    log_err "Unsafe branch name '$branch' rejected"
    return 1
  fi
  return 0
}

sha256_file() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo "missing"
    return
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    wc -c < "$file" | tr -d ' '
  fi
}

ensure_node_modules() {
  local target_dir="$1"
  local reference_dir="$2"
  local ref_lock="$reference_dir/package-lock.json"
  local tgt_lock="$target_dir/package-lock.json"

  if [[ -L "$target_dir/node_modules" ]]; then
    if [[ -d "$target_dir/node_modules/.bin" && "$(sha256_file "$ref_lock")" == "$(sha256_file "$tgt_lock")" ]]; then
      return 0
    fi
    rm -f "$target_dir/node_modules"
  fi

  if [[ -d "$target_dir/node_modules" && ! -L "$target_dir/node_modules" ]]; then
    local lock_marker="$target_dir/node_modules/.alfred-lock.sha256"
    local cur_hash
    cur_hash="$(sha256_file "$tgt_lock")"
    if [[ -f "$lock_marker" && "$(cat "$lock_marker")" == "$cur_hash" ]]; then
      return 0
    fi
  fi

  if [[ -d "$reference_dir/node_modules/.bin" && ! -e "$target_dir/node_modules" ]]; then
    if [[ "$(sha256_file "$ref_lock")" == "$(sha256_file "$tgt_lock")" ]]; then
      log_info "Linking node_modules from $reference_dir (package-lock.json unchanged)"
      ln -s "$reference_dir/node_modules" "$target_dir/node_modules"
      return 0
    fi
  fi

  log_info "Installing dependencies in $target_dir via npm ci..."
  (cd "$target_dir" && npm ci --no-audit --no-fund)
  if [[ -d "$target_dir/node_modules" && ! -L "$target_dir/node_modules" ]]; then
    sha256_file "$tgt_lock" > "$target_dir/node_modules/.alfred-lock.sha256" || true
  fi
}

run_systemctl() {
  local action="$1"
  local service="$2"
  if [[ "$(id -u)" -eq 0 ]]; then
    systemctl "$action" "$service"
  else
    sudo systemctl "$action" "$service"
  fi
}

is_local_pid_alive() {
  local pid_file="$1"
  if [[ ! -f "$pid_file" ]]; then
    return 1
  fi
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -z "$pid" || ! "$pid" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  kill -0 "$pid" 2>/dev/null
}

start_instance() {
  local role="$1" # test | prod
  local dir="$2"
  local service="$3"
  local pid_file="$4"
  local dry_run="${5:-0}"

  if [[ "$dry_run" == "1" ]]; then
    log_info "[DRY-RUN] Would start $role ($service / $dir)"
    return 0
  fi

  if [[ "$DEPLOY_MODE" == "systemd" ]]; then
    run_systemctl start "$service"
  else
    mkdir -p "$(dirname "$pid_file")" "$dir/store"
    local log_file="$dir/store/alfred-${role}.log"
    (
      cd "$dir"
      nohup node dist/alfred/run.js >> "$log_file" 2>&1 &
      echo $! > "$pid_file"
    )
  fi
}

restart_instance() {
  local role="$1"
  local dir="$2"
  local service="$3"
  local pid_file="$4"
  local dry_run="${5:-0}"

  if [[ "$dry_run" == "1" ]]; then
    log_info "[DRY-RUN] Would restart $role ($service / $dir)"
    return 0
  fi

  if [[ "$DEPLOY_MODE" == "systemd" ]]; then
    run_systemctl restart "$service"
  else
    stop_instance "$role" "$service" "$pid_file" "0"
    start_instance "$role" "$dir" "$service" "$pid_file" "0"
  fi
}

stop_instance() {
  local role="$1"
  local service="$2"
  local pid_file="$3"
  local dry_run="${4:-0}"

  if [[ "$dry_run" == "1" ]]; then
    log_info "[DRY-RUN] Would stop $role ($service)"
    return 0
  fi

  if [[ "$DEPLOY_MODE" == "systemd" ]]; then
    run_systemctl stop "$service" || true
  else
    if is_local_pid_alive "$pid_file"; then
      local pid
      pid="$(cat "$pid_file")"
      kill "$pid" 2>/dev/null || true
      sleep 1
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    fi
    rm -f "$pid_file"
  fi
}

verify_instance_alive() {
  local role="$1"
  local service="$2"
  local pid_file="$3"
  local wait_sec="${4:-5}"
  local dry_run="${5:-0}"

  if [[ "$dry_run" == "1" ]]; then
    log_info "[DRY-RUN] Would verify $role stays alive for ${wait_sec}s"
    return 0
  fi

  sleep "$wait_sec"
  if [[ "$DEPLOY_MODE" == "systemd" ]]; then
    if ! run_systemctl is-active "$service" >/dev/null 2>&1; then
      log_err "Health check FAILED: systemd service $service is not active after ${wait_sec}s"
      journalctl -u "$service" -n 30 --no-pager >&2 || true
      return 1
    fi
  else
    if ! is_local_pid_alive "$pid_file"; then
      log_err "Health check FAILED: local $role process (pidfile: $pid_file) died within ${wait_sec}s"
      return 1
    fi
  fi
  log_info "Health check PASSED: $role is active (${wait_sec}s liveness verified)"
}

branch_to_slug() {
  local branch="${1:-}"
  node "$SCRIPT_DIR/cf-test-route.mjs" slug "$branch"
}

multi_test_enabled() {
  if [[ "${ALFRED_MULTI_TEST:-0}" == "1" ]]; then
    return 0
  fi
  if [[ "$DEPLOY_MODE" == "systemd" && -f /etc/systemd/system/alfred-test@.service ]]; then
    return 0
  fi
  return 1
}

configure_test_target() {
  local branch="${1:-}"
  local force_multi="${2:-0}"
  TEST_SLUG=""
  TEST_WEB_SERVICE="alfred-test-web"
  if [[ -n "$branch" ]] && { [[ "$force_multi" == "1" ]] || multi_test_enabled; }; then
    TEST_SLUG="$(branch_to_slug "$branch")"
    if [[ "$DEPLOY_MODE" == "systemd" ]]; then
      TEST_DIR="/opt/alfred-worktrees/alfred-test-${TEST_SLUG}"
    else
      TEST_DIR="$(dirname "$REPO_ROOT")/alfred-test-${TEST_SLUG}"
    fi
    TEST_SERVICE="alfred-test@${TEST_SLUG}"
    TEST_WEB_SERVICE="alfred-test-web@${TEST_SLUG}"
    TEST_PID_FILE="$TEST_DIR/store/alfred-test.pid"
  fi
}

write_test_ports_file() {
  local dir="$1"
  local branch="$2"
  local slug="$3"
  local ports_file="$dir/.env.ports"
  if [[ -f "$ports_file" ]]; then
    return 0
  fi
  local worktree_base
  worktree_base="$(dirname "$dir")"
  local web_port=3430
  local sim_port=3530
  while grep -qs "WEB_PORT=${web_port}" "$worktree_base"/alfred-test*/.env.ports 2>/dev/null; do
    web_port=$((web_port + 1))
    sim_port=$((sim_port + 1))
  done
  local host
  host="$(node "$SCRIPT_DIR/cf-test-route.mjs" hostname "$branch")"
  cat > "$ports_file" <<EOF
WEB_PORT=${web_port}
ALFRED_WEB_PORT=${web_port}
ALFRED_SIM_PORT=${sim_port}
ALFRED_TEST_SLUG=${slug}
ALFRED_TEST_BRANCH=${branch}
ALFRED_TEST_HOST=${host}
EOF
  chmod 600 "$ports_file" || true
}
