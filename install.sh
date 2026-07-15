#!/usr/bin/env bash
set -euo pipefail

APP_NAME="ForBrokers Plugin Config Console"
SERVICE_NAME="forbrokers-plugin-console"
SERVICE_USER="forbrokers-console"
INSTALL_DIR="${INSTALL_DIR:-/opt/forbrokers-plugin-console}"
DATA_DIR="${DATA_DIR:-/opt/forbrokers-plugin-console-data}"
PORT="${PORT:-3100}"
DOMAIN="${DOMAIN:-}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
INSTALL_NGINX=1
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERACTIVE_MODE=0
ASSUME_YES=0
PROGRESS_CURRENT=0
PROGRESS_TOTAL=11
[[ $# -eq 0 && -t 0 ]] && INTERACTIVE_MODE=1

info() { printf '[INFO] %s\n' "$*"; }
ok() { printf '[OK] %s\n' "$*"; }
fail() { printf '[ERROR] %s\n' "$*" >&2; exit 1; }

progress() {
  local label="$1"
  local width=28
  local filled
  local empty
  local percent
  local filled_bar
  local empty_bar
  PROGRESS_CURRENT=$((PROGRESS_CURRENT + 1))
  filled=$((PROGRESS_CURRENT * width / PROGRESS_TOTAL))
  empty=$((width - filled))
  percent=$((PROGRESS_CURRENT * 100 / PROGRESS_TOTAL))
  printf -v filled_bar '%*s' "$filled" ''
  printf -v empty_bar '%*s' "$empty" ''
  filled_bar="${filled_bar// /#}"
  empty_bar="${empty_bar// /-}"
  printf '[%s%s] %3d%%  %s\n' "$filled_bar" "$empty_bar" "$percent" "$label"
}

usage() {
  cat <<'EOF'
Usage: sudo ./install.sh [options]

Options:
  --domain HOST           Public hostname, for example config.example.com
  --port PORT             Local backend port (default: 3100)
  --install-dir PATH      Program directory
  --data-dir PATH         Persistent data directory
  --admin-user USER       First administrator username (default: admin)
  --admin-password PASS   First administrator password (minimum 12 characters)
  --no-nginx              Do not install or configure nginx
  --interactive           Run the guided installation wizard
  --yes                   Accept defaults without a confirmation prompt
  --help                  Show this help

Re-run this script from a newer package to upgrade the program. Existing
configuration files, users, feedback records, secrets, and active UUIDs are
stored in DATA_DIR and are never replaced by an upgrade.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
    --admin-user) ADMIN_USERNAME="${2:-}"; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="${2:-}"; shift 2 ;;
    --no-nginx) INSTALL_NGINX=0; shift ;;
    --interactive) INTERACTIVE_MODE=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --help) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  sudo_args=(
    --domain "$DOMAIN"
    --port "$PORT"
    --install-dir "$INSTALL_DIR"
    --data-dir "$DATA_DIR"
    --admin-user "$ADMIN_USERNAME"
  )
  [[ -n "$ADMIN_PASSWORD" ]] && sudo_args+=(--admin-password "$ADMIN_PASSWORD")
  [[ $INSTALL_NGINX -eq 0 ]] && sudo_args+=(--no-nginx)
  [[ $INTERACTIVE_MODE -eq 1 ]] && sudo_args+=(--interactive)
  [[ $ASSUME_YES -eq 1 ]] && sudo_args+=(--yes)
  exec sudo -E bash "$0" "${sudo_args[@]}"
fi

for required in admin.html VERSION reset-password.sh apply-upgrade.sh backend/server.js backend/reset-password.js backend/package.json backend/package-lock.json; do
  [[ -f "$SOURCE_DIR/$required" ]] || fail "Package is missing $required"
done

ENV_FILE="/etc/${SERVICE_NAME}.env"
if [[ $INTERACTIVE_MODE -eq 1 && -f "$ENV_FILE" ]]; then
  saved_port="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -n 1)"
  saved_data_dir="$(sed -n 's/^DATA_DIR=//p' "$ENV_FILE" | tail -n 1)"
  saved_install_dir="$(sed -n 's/^INSTALL_DIR=//p' "$ENV_FILE" | tail -n 1)"
  saved_domain="$(sed -n 's/^PUBLIC_DOMAIN=//p' "$ENV_FILE" | tail -n 1)"
  saved_admin="$(sed -n 's/^ADMIN_USERNAME=//p' "$ENV_FILE" | tail -n 1)"
  [[ -n "$saved_port" ]] && PORT="$saved_port"
  [[ -n "$saved_data_dir" ]] && DATA_DIR="$saved_data_dir"
  [[ -n "$saved_install_dir" ]] && INSTALL_DIR="$saved_install_dir"
  [[ -n "$saved_domain" ]] && DOMAIN="$saved_domain"
  [[ -n "$saved_admin" ]] && ADMIN_USERNAME="$saved_admin"
fi

if [[ $INTERACTIVE_MODE -eq 1 && -z "$DOMAIN" && -f "/etc/nginx/sites-available/$SERVICE_NAME" ]]; then
  detected_domain="$(awk '$1 == "server_name" { gsub(";", "", $2); if ($2 != "_") print $2; exit }' "/etc/nginx/sites-available/$SERVICE_NAME")"
  [[ -n "$detected_domain" ]] && DOMAIN="$detected_domain"
fi

PACKAGE_VERSION="$(tr -d '[:space:]' < "$SOURCE_DIR/VERSION")"
CURRENT_VERSION=""
[[ -f "$INSTALL_DIR/VERSION" ]] && CURRENT_VERSION="$(tr -d '[:space:]' < "$INSTALL_DIR/VERSION")"
FIRST_INSTALL=0
[[ -f "$DATA_DIR/state.json" ]] || FIRST_INSTALL=1

if [[ $INTERACTIVE_MODE -eq 1 ]]; then
  printf '\n============================================================\n'
  printf '  %s Setup\n' "$APP_NAME"
  printf '============================================================\n'
  if [[ -n "$CURRENT_VERSION" ]]; then
    printf '  Mode:    Upgrade v%s -> v%s\n' "$CURRENT_VERSION" "$PACKAGE_VERSION"
  else
    printf '  Mode:    New installation v%s\n' "$PACKAGE_VERSION"
  fi
  printf '  Program: %s\n' "$INSTALL_DIR"
  printf '  Data:    %s\n\n' "$DATA_DIR"

  if [[ -n "$DOMAIN" ]]; then
    read -r -p "Public domain [$DOMAIN]: " input_domain
    DOMAIN="${input_domain:-$DOMAIN}"
  else
    read -r -p "Public domain (leave blank to use the server IP): " DOMAIN
  fi

  read -r -p "Backend port [$PORT]: " input_port
  PORT="${input_port:-$PORT}"

  if [[ $FIRST_INSTALL -eq 1 ]]; then
    read -r -p "Administrator username [$ADMIN_USERNAME]: " input_user
    ADMIN_USERNAME="${input_user:-$ADMIN_USERNAME}"
    if [[ -z "$ADMIN_PASSWORD" ]]; then
      while true; do
        read -r -s -p "Administrator password (minimum 12 characters): " ADMIN_PASSWORD
        printf '\n'
        read -r -s -p "Confirm administrator password: " confirm_password
        printf '\n'
        if [[ ${#ADMIN_PASSWORD} -lt 12 ]]; then
          printf 'Password is too short. Please try again.\n' >&2
        elif [[ "$ADMIN_PASSWORD" != "$confirm_password" ]]; then
          printf 'Passwords do not match. Please try again.\n' >&2
        else
          break
        fi
      done
    fi
  fi

  read -r -p "Configure nginx reverse proxy? [Y/n]: " nginx_answer
  case "${nginx_answer:-y}" in
    n|N|no|NO|No) INSTALL_NGINX=0 ;;
    *) INSTALL_NGINX=1 ;;
  esac

  DOMAIN="${DOMAIN#http://}"
  DOMAIN="${DOMAIN#https://}"
  DOMAIN="${DOMAIN%/}"
  [[ "$PORT" =~ ^[0-9]+$ && "$PORT" -ge 1 && "$PORT" -le 65535 ]] || fail "Port must be between 1 and 65535"
  [[ -z "$DOMAIN" || "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || fail "Domain contains unsupported characters"

  printf '\nInstallation summary\n'
  printf '  Version:       %s\n' "$PACKAGE_VERSION"
  printf '  Domain:        %s\n' "${DOMAIN:-Server IP}"
  printf '  Backend port:  %s\n' "$PORT"
  if [[ $FIRST_INSTALL -eq 1 ]]; then
    printf '  Administrator: %s\n' "$ADMIN_USERNAME"
  else
    printf '  Administrator: Preserve existing accounts\n'
  fi
  printf '  nginx:         %s\n' "$([[ $INSTALL_NGINX -eq 1 ]] && printf 'Yes' || printf 'No')"
  printf '  Existing data: %s\n\n' "$([[ $FIRST_INSTALL -eq 1 ]] && printf 'New data directory' || printf 'Preserve all existing data')"

  if [[ $ASSUME_YES -ne 1 ]]; then
    read -r -p "Start installation now? [Y/n]: " confirm_install
    case "${confirm_install:-y}" in
      n|N|no|NO|No) printf 'Installation cancelled.\n'; exit 0 ;;
    esac
  fi
fi

DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN%/}"

[[ "$PORT" =~ ^[0-9]+$ && "$PORT" -ge 1 && "$PORT" -le 65535 ]] || fail "Port must be between 1 and 65535"
[[ -z "$DOMAIN" || "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || fail "Domain contains unsupported characters"
[[ "$ADMIN_USERNAME" =~ ^[A-Za-z0-9._@-]{1,80}$ ]] || fail "Administrator username contains unsupported characters"
[[ "$INSTALL_DIR" = /* ]] || fail "Install directory must be an absolute path"
[[ "$DATA_DIR" = /* ]] || fail "Data directory must be an absolute path"
[[ "$INSTALL_DIR" != "$DATA_DIR" ]] || fail "Install and data directories must be different"
case "${DATA_DIR}/" in
  "${INSTALL_DIR}/"*) fail "Data directory must not be inside the program directory" ;;
esac

if [[ $FIRST_INSTALL -eq 1 ]]; then
  if [[ -z "$ADMIN_PASSWORD" ]]; then
    if [[ -t 0 ]]; then
      read -r -p "Administrator username [${ADMIN_USERNAME}]: " input_user
      ADMIN_USERNAME="${input_user:-$ADMIN_USERNAME}"
      while true; do
        read -r -s -p "Administrator password (minimum 12 characters): " ADMIN_PASSWORD
        printf '\n'
        read -r -s -p "Confirm administrator password: " confirm_password
        printf '\n'
        [[ ${#ADMIN_PASSWORD} -ge 12 && "$ADMIN_PASSWORD" == "$confirm_password" ]] && break
        printf 'Password must contain at least 12 characters and both entries must match.\n' >&2
      done
    else
      fail "Set ADMIN_PASSWORD or use --admin-password for non-interactive installation"
    fi
  fi
  [[ ${#ADMIN_PASSWORD} -ge 12 ]] || fail "Administrator password must contain at least 12 characters"
fi

progress "Package verified"
info "Installing ${APP_NAME} v${PACKAGE_VERSION}"
info "Checking system prerequisites"

packages=()
command -v node >/dev/null 2>&1 || packages+=(nodejs)
command -v npm >/dev/null 2>&1 || packages+=(npm)
command -v curl >/dev/null 2>&1 || packages+=(curl)
command -v openssl >/dev/null 2>&1 || packages+=(openssl)
command -v unzip >/dev/null 2>&1 || packages+=(unzip)
if [[ ${#packages[@]} -gt 0 ]]; then
  info "Installing required system packages"
  apt-get update -qq
  apt-get install -y -qq ca-certificates "${packages[@]}"
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
[[ "$NODE_MAJOR" -ge 18 ]] || fail "Node.js 18 or newer is required"

if [[ $INSTALL_NGINX -eq 1 ]] && ! command -v nginx >/dev/null 2>&1; then
  info "Installing nginx"
  apt-get update -qq
  apt-get install -y -qq nginx
fi
progress "System prerequisites ready"

info "Preparing the persistent data directory"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

mkdir -p "$DATA_DIR/configs" "$DATA_DIR/upgrades"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR" "$DATA_DIR/configs" "$DATA_DIR/upgrades"
progress "Persistent data directory ready"

CONFIG_SNAPSHOT_BEFORE="$(mktemp)"
CONFIG_SNAPSHOT_AFTER="$(mktemp)"
cleanup() { rm -f "$CONFIG_SNAPSHOT_BEFORE" "$CONFIG_SNAPSHOT_AFTER"; }
trap cleanup EXIT

snapshot_configs() {
  if [[ -d "$DATA_DIR/configs" ]]; then
    find "$DATA_DIR/configs" -type f -name '*.json' -print0 | sort -z | xargs -0 sha256sum 2>/dev/null || true
  fi
}

if systemctl list-unit-files "${SERVICE_NAME}.service" >/dev/null 2>&1; then
  systemctl stop "${SERVICE_NAME}.service" || true
fi
snapshot_configs > "$CONFIG_SNAPSHOT_BEFORE"

if [[ -d "$INSTALL_DIR" && -f "$INSTALL_DIR/VERSION" ]]; then
  BACKUP_DIR="${INSTALL_DIR}.program-backup-$(date +%Y%m%d-%H%M%S)"
  cp -a "$INSTALL_DIR" "$BACKUP_DIR"
  ok "Program backup created: $BACKUP_DIR"
fi
progress "$([[ -n "$CURRENT_VERSION" ]] && printf 'Previous program backed up' || printf 'New program directory ready')"

info "Copying program files"
mkdir -p "$INSTALL_DIR/backend" "$INSTALL_DIR/docs"
install -m 0644 "$SOURCE_DIR/admin.html" "$INSTALL_DIR/admin.html"
install -m 0644 "$SOURCE_DIR/VERSION" "$INSTALL_DIR/VERSION"
install -m 0755 "$SOURCE_DIR/reset-password.sh" "$INSTALL_DIR/reset-password.sh"
install -m 0755 "$SOURCE_DIR/apply-upgrade.sh" "$INSTALL_DIR/apply-upgrade.sh"
install -m 0644 "$SOURCE_DIR/backend/server.js" "$INSTALL_DIR/backend/server.js"
install -m 0644 "$SOURCE_DIR/backend/reset-password.js" "$INSTALL_DIR/backend/reset-password.js"
install -m 0644 "$SOURCE_DIR/backend/package.json" "$INSTALL_DIR/backend/package.json"
install -m 0644 "$SOURCE_DIR/backend/package-lock.json" "$INSTALL_DIR/backend/package-lock.json"
install -m 0644 "$SOURCE_DIR/docs/API_EN.md" "$INSTALL_DIR/docs/API_EN.md"
install -m 0644 "$SOURCE_DIR/docs/API_ZH.md" "$INSTALL_DIR/docs/API_ZH.md"
progress "Program files installed"

info "Installing Node.js dependencies"
cd "$INSTALL_DIR/backend"
npm ci --omit=dev --no-audit --no-fund --ignore-scripts
chown -R root:root "$INSTALL_DIR"
chmod -R go-w "$INSTALL_DIR"
progress "Application dependencies installed"

mkdir -p "/usr/local/lib/$SERVICE_NAME"
install -m 0755 "$SOURCE_DIR/apply-upgrade.sh" "/usr/local/lib/$SERVICE_NAME/apply-upgrade.sh"

cat > "$ENV_FILE" <<EOF
NODE_ENV=production
PORT=$PORT
DATA_DIR=$DATA_DIR
INSTALL_DIR=$INSTALL_DIR
PUBLIC_DOMAIN=$DOMAIN
PRIMARY_DOMAIN=
ADMIN_USERNAME=$ADMIN_USERNAME
EOF

if [[ $FIRST_INSTALL -eq 1 ]]; then
  ADMIN_PASSWORD_B64="$(printf '%s' "$ADMIN_PASSWORD" | base64 | tr -d '\n')"
  printf 'ADMIN_PASSWORD_B64=%s\n' "$ADMIN_PASSWORD_B64" >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

NODE_BIN="$(command -v node)"
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=ForBrokers Plugin Config Console
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$INSTALL_DIR/backend
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=4
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

cat > "/etc/systemd/system/${SERVICE_NAME}-upgrade.service" <<EOF
[Unit]
Description=ForBrokers Plugin Config Console Update Installer
After=network-online.target

[Service]
Type=oneshot
User=root
Environment="SERVICE_NAME=$SERVICE_NAME"
Environment="SERVICE_USER=$SERVICE_USER"
Environment="SERVICE_GROUP=$SERVICE_USER"
Environment="INSTALL_DIR=$INSTALL_DIR"
Environment="DATA_DIR=$DATA_DIR"
ExecStart=/usr/local/lib/$SERVICE_NAME/apply-upgrade.sh
EOF

cat > "/etc/systemd/system/${SERVICE_NAME}-upgrade.path" <<EOF
[Unit]
Description=Watch for ForBrokers Plugin Config Console Updates

[Path]
PathExists=$DATA_DIR/upgrades/pending.ready
Unit=${SERVICE_NAME}-upgrade.service

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}.service" >/dev/null
systemctl enable --now "${SERVICE_NAME}-upgrade.path" >/dev/null
progress "System services configured"

info "Starting the service and waiting for the health check"
systemctl restart "${SERVICE_NAME}.service"

READY=0
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

if [[ $READY -ne 1 ]]; then
  journalctl -u "${SERVICE_NAME}.service" --no-pager -n 60 || true
  fail "Backend did not become healthy"
fi

if [[ $FIRST_INSTALL -eq 1 ]]; then
  sed -i '/^ADMIN_PASSWORD_B64=/d' "$ENV_FILE"
  systemctl restart "${SERVICE_NAME}.service"
  READY=0
  for _ in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
      READY=1
      break
    fi
    sleep 1
  done
  [[ $READY -eq 1 ]] || fail "Backend did not restart after removing the bootstrap password"
fi
progress "Application service is healthy"

snapshot_configs > "$CONFIG_SNAPSHOT_AFTER"
if ! cmp -s "$CONFIG_SNAPSHOT_BEFORE" "$CONFIG_SNAPSHOT_AFTER"; then
  fail "Configuration integrity check failed: existing config files changed during installation"
fi
ok "Existing configuration files are unchanged"
progress "Persistent configurations verified"

if [[ $INSTALL_NGINX -eq 1 ]]; then
  NGINX_NAME="$SERVICE_NAME"
  SERVER_NAME="${DOMAIN:-_}"
  cat > "/etc/nginx/sites-available/$NGINX_NAME" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $SERVER_NAME;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }
}
EOF
  ln -sfn "/etc/nginx/sites-available/$NGINX_NAME" "/etc/nginx/sites-enabled/$NGINX_NAME"
  nginx -t
  systemctl reload nginx
  ok "nginx configured for $SERVER_NAME"
fi
progress "$([[ $INSTALL_NGINX -eq 1 ]] && printf 'nginx reverse proxy configured' || printf 'nginx configuration skipped')"

VERSION="$(tr -d '[:space:]' < "$INSTALL_DIR/VERSION")"
SERVER_ADDRESS="$(hostname -I 2>/dev/null | awk '{print $1}')"
PUBLIC_URL="http://${DOMAIN:-${SERVER_ADDRESS:-SERVER_IP}}"
progress "Installation complete"
printf '\n============================================================\n'
ok "${APP_NAME} v${VERSION} is installed"
printf 'URL: %s\n' "$PUBLIC_URL"
if [[ $FIRST_INSTALL -eq 1 ]]; then
  printf 'Administrator: %s\n' "$ADMIN_USERNAME"
else
  printf 'Administrator: Existing accounts preserved\n'
fi
printf 'Support: support@forbrokers.com\n'
printf 'Developer: https://forbrokers.com\n'
printf 'Service check: sudo systemctl status %s --no-pager -l\n' "$SERVICE_NAME"
if [[ -n "$DOMAIN" && $INSTALL_NGINX -eq 1 ]]; then
  printf 'HTTPS next step: sudo certbot --nginx -d %s\n' "$DOMAIN"
fi
printf '============================================================\n'
