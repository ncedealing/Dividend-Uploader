#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Dividend Uploader"
DEFAULT_SERVICE_NAME="dividend-uploader"
DEFAULT_SERVICE_USER="dividend"
DEFAULT_INSTALL_DIR="/opt/dividend-uploader"
DEFAULT_DATA_DIR="/opt/dividend-uploader-data"
DEFAULT_DOMAIN="test.appcdn002.com"
DEFAULT_PORT="4173"
DEFAULT_HOST="127.0.0.1"
ENV_FILE="/etc/dividend-uploader.env"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

need_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Please run with sudo or as root:"
    echo "  sudo bash website/install/install-linux.sh"
    exit 1
  fi
}

ask() {
  local prompt="$1"
  local default_value="$2"
  local answer
  read -r -p "${prompt} [${default_value}]: " answer
  echo "${answer:-$default_value}"
}

ask_secret() {
  local prompt="$1"
  local answer
  read -r -s -p "${prompt}: " answer
  echo
  echo "$answer"
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 48 | tr -d '\n'
  else
    python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(48), end="")
PY
  fi
}

install_node_if_needed() {
  local major="0"
  if command -v node >/dev/null 2>&1; then
    major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  fi

  if [ "${major}" -ge 24 ] 2>/dev/null; then
    echo "Node.js $(node -v) is ready."
    return
  fi

  echo "Installing Node.js 24..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y ca-certificates curl gnupg
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
    apt-get update
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y nodejs npm
  elif command -v yum >/dev/null 2>&1; then
    yum install -y nodejs npm
  else
    echo "Cannot install Node.js automatically on this system."
    echo "Please install Node.js 24+ manually, then rerun this script."
    exit 1
  fi
}

ensure_rsync() {
  if command -v rsync >/dev/null 2>&1; then
    return
  fi
  echo "Installing rsync..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y rsync
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y rsync
  elif command -v yum >/dev/null 2>&1; then
    yum install -y rsync
  else
    echo "rsync is required to copy website files. Please install rsync and rerun this script."
    exit 1
  fi
}

copy_source_if_needed() {
  local install_dir="$1"
  if [ "${SOURCE_DIR}" = "${install_dir}" ]; then
    return
  fi
  ensure_rsync
  mkdir -p "${install_dir}"
  rsync -a --delete \
    --exclude ".git/" \
    --exclude ".env" \
    --exclude "runtime/data/" \
    --exclude "runtime/logs/" \
    --exclude "runtime/portal-data/" \
    --exclude "website/runtime/data/" \
    --exclude "website/runtime/logs/" \
    --exclude "website/runtime/portal-data/" \
    --exclude "packages/" \
    "${SOURCE_DIR}/" "${install_dir}/"
}

write_env_file() {
  local data_dir="$1"
  local admin_user="$2"
  local admin_password="$3"
  local jwt_secret="$4"
  local host="$5"
  local port="$6"
  local domain="$7"
  local public_base_url="${domain}"
  if [[ ! "${public_base_url}" =~ ^https?:// ]]; then
    public_base_url="https://${domain}"
  fi

  cat > "${ENV_FILE}" <<EOF_ENV
DIVIDEND_UPLOADER_PORTAL_DATA_DIR=${data_dir}/portal-data
DIVIDEND_UPLOADER_DB=${data_dir}/runtime/dividend-uploader.db
DIVIDEND_UPLOADER_ADMIN_USER=${admin_user}
DIVIDEND_UPLOADER_ADMIN_PASSWORD=${admin_password}
DIVIDEND_UPLOADER_JWT_SECRET=${jwt_secret}
DIVIDEND_UPLOADER_HOST=${host}
DIVIDEND_UPLOADER_PUBLIC_BASE_URL=${public_base_url}
PORT=${port}
EOF_ENV
  chmod 600 "${ENV_FILE}"
}

write_systemd_service() {
  local install_dir="$1"
  local service_name="$2"
  local service_user="$3"

  cat > "/etc/systemd/system/${service_name}.service" <<EOF_SERVICE
[Unit]
Description=Dividend Uploader Web Service
After=network.target

[Service]
Type=simple
WorkingDirectory=${install_dir}
EnvironmentFile=${ENV_FILE}
ExecStart=$(command -v npm) start
Restart=always
RestartSec=3
User=${service_user}
Group=${service_user}

[Install]
WantedBy=multi-user.target
EOF_SERVICE
}

configure_nginx() {
  local domain="$1"
  local port="$2"
  local conf="/etc/nginx/sites-available/dividend-uploader.conf"

  if ! command -v nginx >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
      apt-get install -y nginx
    else
      echo "Nginx is not installed. Skipping Nginx config."
      return
    fi
  fi

  mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
  cat > "${conf}" <<EOF_NGINX
server {
    listen 80;
    server_name ${domain};

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF_NGINX

  ln -sf "${conf}" /etc/nginx/sites-enabled/dividend-uploader.conf
  nginx -t
  systemctl reload nginx || systemctl restart nginx
}

main() {
  need_root

  echo "== ${APP_NAME} one-click Linux installer =="
  echo
  local install_dir data_dir domain port host service_name service_user admin_user admin_password jwt_secret setup_nginx
  install_dir="$(ask "Install directory" "${DEFAULT_INSTALL_DIR}")"
  data_dir="$(ask "Persistent data directory" "${DEFAULT_DATA_DIR}")"
  domain="$(ask "Website domain" "${DEFAULT_DOMAIN}")"
  port="$(ask "Backend port" "${DEFAULT_PORT}")"
  host="$(ask "Backend bind host" "${DEFAULT_HOST}")"
  service_name="$(ask "System service name" "${DEFAULT_SERVICE_NAME}")"
  service_user="$(ask "Linux service user" "${DEFAULT_SERVICE_USER}")"
  admin_user="$(ask "First admin username" "admin")"

  admin_password="$(ask_secret "First admin temporary password, leave blank to generate")"
  if [ -z "${admin_password}" ]; then
    admin_password="$(random_secret | cut -c1-24)"
    echo "Generated temporary admin password: ${admin_password}"
  fi

  jwt_secret="$(ask_secret "JWT secret, leave blank to generate")"
  if [ -z "${jwt_secret}" ]; then
    jwt_secret="$(random_secret)"
    echo "Generated JWT secret."
  fi

  install_node_if_needed

  if ! id "${service_user}" >/dev/null 2>&1; then
    useradd --system --home "${install_dir}" --shell /usr/sbin/nologin "${service_user}"
  fi

  mkdir -p "${install_dir}" "${data_dir}/portal-data" "${data_dir}/runtime" "${data_dir}/logs"
  copy_source_if_needed "${install_dir}"
  chown -R root:"${service_user}" "${install_dir}"
  chmod -R g+rX "${install_dir}"
  chown -R "${service_user}:${service_user}" "${data_dir}"

  write_env_file "${data_dir}" "${admin_user}" "${admin_password}" "${jwt_secret}" "${host}" "${port}" "${domain}"
  write_systemd_service "${install_dir}" "${service_name}" "${service_user}"

  systemctl daemon-reload
  systemctl enable "${service_name}.service"
  systemctl restart "${service_name}.service"

  read -r -p "Create or update Nginx reverse proxy for ${domain}? [y/N]: " setup_nginx
  if [ "${setup_nginx}" = "y" ] || [ "${setup_nginx}" = "Y" ]; then
    configure_nginx "${domain}" "${port}"
  fi

  echo
  echo "Installation complete."
  echo "Service:"
  echo "  systemctl status ${service_name}.service --no-pager -l"
  echo
  echo "Admin login:"
  echo "  URL: https://${domain}"
  echo "  User: ${admin_user}"
  echo "  Temporary password: ${admin_password}"
  echo
  echo "After login:"
  echo "  1. Change the temporary password."
  echo "  2. Open Dividend Uploader configuration."
  echo "  3. Select platform, server, and effective time."
  echo "  4. Upload website/config/import-templates/overnight-interest-settings.csv or fill values on the page."
  echo "  5. Save configuration and confirm the UUID changes."
  echo
  echo "Public plugin URLs:"
  echo "  https://${domain}/admin-api/dividend-uploader-public/active-meta.json"
  echo "  https://${domain}/admin-api/dividend-uploader-public/active.json"
  echo "  https://${domain}/admin-api/dividend-uploader-feedback"
  echo
  echo "Persistent data is outside the website code:"
  echo "  ${data_dir}"
}

main "$@"
