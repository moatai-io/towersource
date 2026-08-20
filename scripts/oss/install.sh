#!/usr/bin/env bash
set -Eeuo pipefail

# Tower OSS single-host installer for Ubuntu 22.04/24.04.
# Installs Node.js, PostgreSQL + extensions, nginx, Tower systemd service,
# and optionally Let's Encrypt when --domain is provided.

APP_DIR="${TOWER_APP_DIR:-/opt/tower}"
DATA_DIR="${TOWER_DATA_DIR:-/var/lib/tower}"
PORT="${TOWER_PORT:-32364}"
PUBLIC_URL=""
DOMAIN=""
CERTBOT_EMAIL=""
SOURCE_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE="minimal"
SKIP_SOURCE_COPY=false

usage() {
  cat <<'EOF'
Tower OSS installer

Usage:
  sudo bash scripts/oss/install.sh [options]

Options:
  --public-url <url>     Public URL for IP/HTTP installs, e.g. http://203.0.113.10
  --domain <fqdn>        Configure nginx and Let's Encrypt HTTPS for this domain
  --email <email>        Email for Let's Encrypt (required with --domain)
  --source-dir <path>    Tower source checkout (default: current repository)
  --app-dir <path>       Installed application path (default: /opt/tower)
  --data-dir <path>      Persistent data/workspace path (default: /var/lib/tower)
  --profile <name>       minimal or recommended (default: minimal)
  --skip-source-copy     Use source directory in place instead of copying to /opt
  -h, --help             Show help

Examples:
  sudo bash scripts/oss/install.sh --public-url http://203.0.113.10
  sudo bash scripts/oss/install.sh --domain tower.example.com --email admin@example.com
EOF
}

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok() { printf '\033[0;32m[OK]\033[0m %s\n' "$*"; }
fail() { printf '\033[0;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-url) PUBLIC_URL="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) CERTBOT_EMAIL="$2"; shift 2 ;;
    --source-dir) SOURCE_DIR="$(cd "$2" && pwd)"; shift 2 ;;
    --app-dir) APP_DIR="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --skip-source-copy) SKIP_SOURCE_COPY=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || fail "Run with sudo: sudo bash scripts/oss/install.sh ..."
[[ -f "$SOURCE_DIR/package.json" ]] || fail "Tower source not found at $SOURCE_DIR"
[[ "$PROFILE" == "minimal" || "$PROFILE" == "recommended" ]] || fail "--profile must be minimal or recommended"

if [[ -n "$DOMAIN" ]]; then
  [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || fail "Invalid domain: $DOMAIN"
  [[ -n "$CERTBOT_EMAIL" ]] || fail "--email is required with --domain"
  PUBLIC_URL="https://$DOMAIN"
elif [[ -z "$PUBLIC_URL" ]]; then
  fail "Provide --public-url http://SERVER_IP, or --domain plus --email"
fi
PUBLIC_URL="${PUBLIC_URL%/}"

. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || fail "This installer currently supports Ubuntu only"
case "${VERSION_ID:-}" in 22.04|24.04) ;; *) fail "Ubuntu 22.04 or 24.04 required (found ${VERSION_ID:-unknown})" ;; esac

export DEBIAN_FRONTEND=noninteractive
log "Installing base packages"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg lsb-release git build-essential nginx python3 openssl rsync

if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; then
  log "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
ok "Node.js $(node -v)"

log "Installing PostgreSQL 18 and pgvector"
install -d /usr/share/postgresql-common/pgdg
if [[ ! -f /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc ]]; then
  curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
fi
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list
apt-get update -qq
apt-get install -y -qq postgresql-18 postgresql-18-pgvector
systemctl enable --now postgresql >/dev/null
PG_PORT=$(pg_lsclusters -h | awk '$1=="18" && $2=="main" {print $3; exit}')
[[ -n "$PG_PORT" ]] || fail "PostgreSQL 18 cluster was not created"

install -d -m 700 "$DATA_DIR/secrets"
PG_PASSWORD_FILE="$DATA_DIR/secrets/postgres-password"
if [[ ! -s "$PG_PASSWORD_FILE" ]]; then
  openssl rand -hex 32 > "$PG_PASSWORD_FILE"
  chmod 600 "$PG_PASSWORD_FILE"
fi
PG_PASSWORD=$(cat "$PG_PASSWORD_FILE")
PG_PASSWORD_SQL=${PG_PASSWORD//\'/\'\'}
PG_PASSWORD_URL=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$PG_PASSWORD")
sudo -u postgres psql -p "$PG_PORT" -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='tower') THEN
    CREATE ROLE tower LOGIN PASSWORD '$PG_PASSWORD_SQL';
  ELSE
    ALTER ROLE tower LOGIN PASSWORD '$PG_PASSWORD_SQL';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE tower OWNER tower' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname='tower')\gexec
SQL
sudo -u postgres psql -p "$PG_PORT" -d tower -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
SQL
ok "PostgreSQL 18 ready on port $PG_PORT"

log "Installing Tower application"
if [[ "$SKIP_SOURCE_COPY" == true ]]; then
  APP_DIR="$SOURCE_DIR"
else
  install -d "$APP_DIR"
  rsync -a --delete --exclude='.git' --exclude='.env' --exclude='node_modules' --exclude='dist' "$SOURCE_DIR/" "$APP_DIR/"
fi
cd "$APP_DIR"
if ! npm ci --no-audit --no-fund; then
  printf '\033[1;33m[WARN]\033[0m package-lock.json is not synchronized; falling back to npm install.\n' >&2
  printf '\033[1;33m[WARN]\033[0m Public releases should fix the lockfile so npm ci succeeds.\n' >&2
  npm install --no-audit --no-fund
fi
npm run build

# Production ESM imports resolve @tower/shared from node_modules, while the
# build emits the package under dist/runtime-packages. Link the runtime package
# explicitly so systemd and other process managers behave the same way.
mkdir -p "$APP_DIR/node_modules/@tower"
ln -sfn "$APP_DIR/dist/runtime-packages/@tower/shared" "$APP_DIR/node_modules/@tower/shared"
# Backend workspace dependencies can be nested under packages/backend.
if [[ -d "$APP_DIR/packages/backend/node_modules" ]]; then
  mkdir -p "$APP_DIR/dist/backend/packages/backend"
  ln -sfn "$APP_DIR/packages/backend/node_modules" "$APP_DIR/dist/backend/packages/backend/node_modules"
fi

install -d -m 755 "$DATA_DIR/workspace" "$DATA_DIR/app-data"
if [[ -d templates/workspace ]]; then
  cp -rn templates/workspace/. "$DATA_DIR/workspace/" || true
fi

ENV_FILE="$DATA_DIR/tower.env"
JWT_SECRET=$(openssl rand -hex 32)
MASTER_KEY=$(openssl rand -hex 32)
if [[ -f "$ENV_FILE" ]]; then
  EXISTING_JWT=$(sed -n 's/^JWT_SECRET=//p' "$ENV_FILE" | head -1)
  EXISTING_MASTER=$(sed -n 's/^SECRET_STORE_MASTER_KEY=//p' "$ENV_FILE" | head -1)
  [[ -n "$EXISTING_JWT" ]] && JWT_SECRET="$EXISTING_JWT"
  [[ -n "$EXISTING_MASTER" ]] && MASTER_KEY="$EXISTING_MASTER"
fi
cat > "$ENV_FILE" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=$PORT
PUBLIC_URL=$PUBLIC_URL
WORKSPACE_ROOT=$DATA_DIR/workspace
DEFAULT_CWD=$DATA_DIR/workspace
TOWER_DATA_DIR=$DATA_DIR/app-data
DATABASE_URL=postgresql://tower:${PG_PASSWORD_URL}@127.0.0.1:${PG_PORT}/tower
JWT_SECRET=$JWT_SECRET
SECRET_STORE_MASTER_KEY=$MASTER_KEY
PI_ENABLED=true
DEFAULT_ENGINE=pi
CLAUDE_ENABLED=false
TOWER_AGENT_FIRST_ENABLED=true
WORKSPACE_LANGUAGE=en
EOF
chmod 600 "$ENV_FILE"

cat > /etc/systemd/system/tower.service <<EOF
[Unit]
Description=Tower AI Workspace
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) $APP_DIR/dist/backend/packages/backend/index.js
Restart=on-failure
RestartSec=5
User=root
Group=root
NoNewPrivileges=true
PrivateTmp=true
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now tower

log "Configuring nginx"
NGINX_NAME=tower
SERVER_NAME="_"
[[ -n "$DOMAIN" ]] && SERVER_NAME="$DOMAIN"
cat > "/etc/nginx/sites-available/$NGINX_NAME" <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name $SERVER_NAME;
    client_max_body_size 220m;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
rm -f /etc/nginx/sites-enabled/default
ln -sfn "/etc/nginx/sites-available/$NGINX_NAME" "/etc/nginx/sites-enabled/$NGINX_NAME"
nginx -t
systemctl enable --now nginx
systemctl reload nginx

if [[ -n "$DOMAIN" ]]; then
  log "Checking DNS and configuring HTTPS"
  RESOLVED_IP=$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')
  [[ -n "$RESOLVED_IP" ]] || fail "DNS for $DOMAIN does not resolve yet. Point it to this server and rerun."
  apt-get install -y -qq certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$CERTBOT_EMAIL" --redirect
  systemctl enable --now certbot.timer >/dev/null 2>&1 || true
fi

if [[ "$PROFILE" == "recommended" ]]; then
  log "Installing recommended document tools"
  apt-get install -y -qq poppler-utils ffmpeg imagemagick fonts-noto-cjk fonts-noto-color-emoji
fi

log "Running Tower doctor"
bash "$APP_DIR/scripts/oss/doctor.sh" --app-dir "$APP_DIR" --data-dir "$DATA_DIR" --url "$PUBLIC_URL"

cat <<EOF

Tower is ready.

Open: $PUBLIC_URL
Next: create the first administrator account in your browser.
AI models: open Settings > Connections and connect OpenRouter or an OpenAI-compatible provider.

Useful commands:
  sudo systemctl status tower
  sudo journalctl -u tower -f
  sudo bash $APP_DIR/scripts/oss/doctor.sh --url $PUBLIC_URL
EOF
