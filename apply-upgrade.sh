#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_NAME="${SERVICE_NAME:-forbrokers-plugin-console}"
SERVICE_USER="${SERVICE_USER:-forbrokers-console}"
SERVICE_GROUP="${SERVICE_GROUP:-$SERVICE_USER}"
INSTALL_DIR="${INSTALL_DIR:-/opt/forbrokers-plugin-console}"
DATA_DIR="${DATA_DIR:-/opt/forbrokers-plugin-console-data}"
UPGRADE_DIR="$DATA_DIR/upgrades"
ZIP_FILE="$UPGRADE_DIR/pending.zip"
READY_FILE="$UPGRADE_DIR/pending.ready"
RESULT_FILE="$UPGRADE_DIR/last-result.json"
LOCK_FILE="${LOCK_FILE:-/run/${SERVICE_NAME}-upgrade.lock}"
PROGRAM_OWNER="${PROGRAM_OWNER:-root:root}"
STAGE_DIR=""
BACKUP_DIR=""
SNAPSHOT_BEFORE=""
SNAPSHOT_AFTER=""
TARGET_VERSION="unknown"
SERVICE_STOPPED=0
SUCCESS=0

REQUIRED_FILES=(
  admin.html
  VERSION
  install.sh
  reset-password.sh
  apply-upgrade.sh
  README.md
  backend/server.js
  backend/reset-password.js
  backend/package.json
  backend/package-lock.json
  docs/API_EN.md
  docs/API_ZH.md
)

fail() { printf '[ERROR] %s\n' "$*" >&2; exit 1; }

is_required_file() {
  local candidate="$1"
  local required
  for required in "${REQUIRED_FILES[@]}"; do
    [[ "$required" == "$candidate" ]] && return 0
  done
  return 1
}

is_seen_file() {
  local candidate="$1"
  local item
  for item in "${seen_files[@]}"; do
    [[ "$item" == "$candidate" ]] && return 0
  done
  return 1
}

write_result() {
  local state="$1"
  local message="$2"
  local completed_at
  local temporary_file
  completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  temporary_file="$RESULT_FILE.tmp"
  cat > "$temporary_file" <<EOF
{
  "state": "$state",
  "target_version": "$TARGET_VERSION",
  "completed_at": "$completed_at",
  "message": "$message"
}
EOF
  chown "$SERVICE_USER:$SERVICE_GROUP" "$temporary_file"
  chmod 640 "$temporary_file"
  mv -f "$temporary_file" "$RESULT_FILE"
}

snapshot_data() {
  find "$DATA_DIR" -type f ! -path "$UPGRADE_DIR/*" -print0 \
    | sort -z \
    | xargs -0 -r sha256sum
}

rollback_program() {
  [[ -n "$BACKUP_DIR" && -d "$BACKUP_DIR" ]] || return 0
  local failed_dir="${INSTALL_DIR}.failed-$(date +%Y%m%d-%H%M%S)"
  [[ -d "$INSTALL_DIR" ]] && mv "$INSTALL_DIR" "$failed_dir"
  cp -a "$BACKUP_DIR" "$INSTALL_DIR"
}

finish() {
  local code=$?
  if [[ $SUCCESS -ne 1 ]]; then
    [[ $code -ne 0 ]] || code=1
    if [[ $SERVICE_STOPPED -eq 1 ]]; then
      systemctl stop "${SERVICE_NAME}.service" || true
      rollback_program || true
    fi
    rm -f "$READY_FILE" "$ZIP_FILE"
    write_result failed "Update failed; the previous program was restored." || true
    systemctl start "${SERVICE_NAME}.service" || true
  fi
  [[ -n "$STAGE_DIR" ]] && rm -rf "$STAGE_DIR"
  [[ -n "$SNAPSHOT_BEFORE" ]] && rm -f "$SNAPSHOT_BEFORE"
  [[ -n "$SNAPSHOT_AFTER" ]] && rm -f "$SNAPSHOT_AFTER"
  exit "$code"
}

exec 9> "$LOCK_FILE"
flock -n 9 || exit 0
[[ -f "$READY_FILE" && -f "$ZIP_FILE" ]] || exit 0
trap finish EXIT
command -v unzip >/dev/null 2>&1 || fail "unzip is required"
command -v zipinfo >/dev/null 2>&1 || fail "zipinfo is required"
sleep 2

if zipinfo -l "$ZIP_FILE" | grep -Eq '^l[rwx-]{9}[[:space:]]'; then
  fail "Symbolic links are not allowed in update packages"
fi

entries=()
while IFS= read -r entry; do entries+=("$entry"); done < <(unzip -Z1 "$ZIP_FILE")
[[ ${#entries[@]} -gt 0 && ${#entries[@]} -le 40 ]] || fail "Invalid update package contents"
PREFIX="${entries[0]%%/*}"
[[ "$PREFIX" =~ ^forbrokers-plugin-console-v([0-9]+\.[0-9]+\.[0-9]+)$ ]] || fail "Invalid update package directory"
TARGET_VERSION="${BASH_REMATCH[1]}"

seen_files=("__none__")

for entry in "${entries[@]}"; do
  [[ "$entry" != *'\'* && "$entry" != /* ]] || fail "Unsafe ZIP path"
  [[ "$entry" != *'/../'* && "$entry" != '../'* && "$entry" != *'/..' ]] || fail "Unsafe ZIP path"
  if [[ "$entry" == "$PREFIX/" || "$entry" == "$PREFIX/backend/" || "$entry" == "$PREFIX/docs/" ]]; then
    continue
  fi
  [[ "$entry" == "$PREFIX/"* && "$entry" != */ ]] || fail "Unsupported ZIP entry: $entry"
  relative="${entry#"$PREFIX/"}"
  is_required_file "$relative" || fail "Unsupported update file: $relative"
  is_seen_file "$relative" && fail "Duplicate update file: $relative"
  seen_files+=("$relative")
done

for relative in "${REQUIRED_FILES[@]}"; do
  is_seen_file "$relative" || fail "Update package is missing $relative"
done

STAGE_DIR="$(mktemp -d)"
total_bytes=0
for relative in "${REQUIRED_FILES[@]}"; do
  target="$STAGE_DIR/$relative"
  mkdir -p "$(dirname "$target")"
  unzip -p "$ZIP_FILE" "$PREFIX/$relative" > "$target"
  file_bytes="$(wc -c < "$target")"
  [[ $file_bytes -le 2097152 ]] || fail "Update file is too large: $relative"
  total_bytes=$((total_bytes + file_bytes))
done
[[ $total_bytes -le 8388608 ]] || fail "Update package contents are too large"

[[ "$(tr -d '[:space:]' < "$STAGE_DIR/VERSION")" == "$TARGET_VERSION" ]] || fail "Update package versions do not match"
node -e '
const fs = require("fs");
const version = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const lock = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
if (pkg.version !== version || lock.version !== version || lock.packages?.[""]?.version !== version) process.exit(1);
' "$TARGET_VERSION" "$STAGE_DIR/backend/package.json" "$STAGE_DIR/backend/package-lock.json" || fail "Update package versions do not match"

CURRENT_VERSION="$(tr -d '[:space:]' < "$INSTALL_DIR/VERSION")"
[[ "$CURRENT_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Installed version is invalid"
latest_version="$(printf '%s\n%s\n' "$CURRENT_VERSION" "$TARGET_VERSION" | sort -V | tail -n 1)"
[[ "$latest_version" == "$TARGET_VERSION" && "$TARGET_VERSION" != "$CURRENT_VERSION" ]] || fail "Update version must be newer than $CURRENT_VERSION"

systemctl stop "${SERVICE_NAME}.service"
SERVICE_STOPPED=1

SNAPSHOT_BEFORE="$(mktemp)"
SNAPSHOT_AFTER="$(mktemp)"
snapshot_data > "$SNAPSHOT_BEFORE"

BACKUP_DIR="${INSTALL_DIR}.program-backup-$(date +%Y%m%d-%H%M%S)"
cp -a "$INSTALL_DIR" "$BACKUP_DIR"

for relative in "${REQUIRED_FILES[@]}"; do
  mode=0644
  case "$relative" in
    install.sh|reset-password.sh|apply-upgrade.sh) mode=0755 ;;
  esac
  destination="$INSTALL_DIR/$relative"
  mkdir -p "$(dirname "$destination")"
  install -m "$mode" "$STAGE_DIR/$relative" "$destination.new"
  mv -f "$destination.new" "$destination"
done

cd "$INSTALL_DIR/backend"
npm ci --omit=dev --no-audit --no-fund --ignore-scripts
chown -R "$PROGRAM_OWNER" "$INSTALL_DIR"
chmod -R go-w "$INSTALL_DIR"

snapshot_data > "$SNAPSHOT_AFTER"
cmp -s "$SNAPSHOT_BEFORE" "$SNAPSHOT_AFTER" || fail "Persistent data changed during update"
write_result installing "Installing update and restarting the service."
rm -f "$SNAPSHOT_BEFORE" "$SNAPSHOT_AFTER" "$READY_FILE" "$ZIP_FILE"

systemctl start "${SERVICE_NAME}.service"
for _ in $(seq 1 20); do
  systemctl is-active --quiet "${SERVICE_NAME}.service" && break
  sleep 1
done
systemctl is-active --quiet "${SERVICE_NAME}.service" || fail "Updated service did not start"
sleep 2
systemctl is-active --quiet "${SERVICE_NAME}.service" || fail "Updated service did not remain active"

write_result success "Update installed successfully."
SUCCESS=1
SERVICE_STOPPED=0
trap - EXIT
[[ -n "$STAGE_DIR" ]] && rm -rf "$STAGE_DIR"
printf '[OK] Updated %s to v%s\n' "$SERVICE_NAME" "$TARGET_VERSION"
