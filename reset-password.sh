#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="forbrokers-plugin-console"
SERVICE_USER="forbrokers-console"
INSTALL_DIR="${INSTALL_DIR:-/opt/forbrokers-plugin-console}"
DATA_DIR="${DATA_DIR:-/opt/forbrokers-plugin-console-data}"
USERNAME="${ADMIN_USERNAME:-admin}"
PASSWORD="${ADMIN_PASSWORD:-}"

fail() { printf '[ERROR] %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: sudo ./reset-password.sh [options]

Options:
  --username USER       Administrator username (default: admin)
  --password PASS       New password (minimum 12 characters)
  --install-dir PATH    Program directory
  --data-dir PATH       Persistent data directory
  --help                Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --username) USERNAME="${2:-}"; shift 2 ;;
    --password) PASSWORD="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
    --help) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  sudo_args=(--username "$USERNAME" --install-dir "$INSTALL_DIR" --data-dir "$DATA_DIR")
  [[ -n "$PASSWORD" ]] && sudo_args+=(--password "$PASSWORD")
  exec sudo -E bash "$0" "${sudo_args[@]}"
fi

[[ -f "$INSTALL_DIR/backend/reset-password.js" ]] || fail "Reset utility not found in $INSTALL_DIR"
[[ -f "$DATA_DIR/state.json" ]] || fail "Administrator data not found in $DATA_DIR"

if [[ -z "$PASSWORD" ]]; then
  [[ -t 0 ]] || fail "Use --password for non-interactive reset"
  while true; do
    read -r -s -p "New password (minimum 12 characters): " PASSWORD
    printf '\n'
    [[ ${#PASSWORD} -ge 12 ]] && break
    printf 'Password is too short.\n' >&2
  done
fi

[[ ${#PASSWORD} -ge 12 ]] || fail "Password must contain at least 12 characters"
id -u "$SERVICE_USER" >/dev/null 2>&1 || fail "Service user not found: $SERVICE_USER"

WAS_ACTIVE=0
if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
  WAS_ACTIVE=1
  systemctl stop "${SERVICE_NAME}.service"
fi

restore_service() {
  [[ $WAS_ACTIVE -eq 1 ]] && systemctl start "${SERVICE_NAME}.service" || true
}
trap restore_service EXIT

BACKUP_FILE="$DATA_DIR/state.json.backup-$(date +%Y%m%d-%H%M%S)"
cp -a "$DATA_DIR/state.json" "$BACKUP_FILE"
PASSWORD_B64="$(printf '%s' "$PASSWORD" | base64 | tr -d '\n')"

runuser -u "$SERVICE_USER" -- env \
  DATA_DIR="$DATA_DIR" \
  RESET_USERNAME="$USERNAME" \
  RESET_PASSWORD_B64="$PASSWORD_B64" \
  node "$INSTALL_DIR/backend/reset-password.js"

restore_service
WAS_ACTIVE=0
trap - EXIT

printf 'Backup: %s\n' "$BACKUP_FILE"
printf 'Login: %s\n' "$USERNAME"
