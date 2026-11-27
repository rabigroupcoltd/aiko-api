#!/usr/bin/env bash
# =============================================================================
# Aiko API — one-time server bootstrap (Ubuntu 24.04+/26.04, run as root)
#
# Installs: Node.js 24, PostgreSQL, Redis (or Valkey), Nginx, Certbot, UFW, swap
# Creates : postgres db/user, password-protected redis, a `deploy` user for
#           GitHub Actions, a systemd service for the API, the production .env,
#           and an Nginx site for API_DOMAIN (with Socket.IO WebSockets).
#           The admin frontend is hosted elsewhere (Render).
#
# Usage:
#   EMAIL=you@example.com bash server-setup.sh
#   (override the domain with API_DOMAIN=... if needed)
#
# API_DOMAIN needs an A record pointing at this server BEFORE running, or the
# HTTPS step is skipped (just rerun the script once DNS has propagated).
#
# Safe to re-run: existing passwords are reused from /root/aiko-credentials.env
# and an existing .env is never overwritten.
# =============================================================================
set -euo pipefail

APP_NAME="aiko-api"
APP_DIR="/var/www/${APP_NAME}"
APP_PORT="${APP_PORT:-3000}"
DEPLOY_USER="deploy"
DB_NAME="aiko"
DB_USER="aiko"
NODE_MAJOR="24"
API_DOMAIN="${API_DOMAIN:-api.nuriq.tech}"
EMAIL="${EMAIL:-}"
CREDS_FILE="/root/aiko-credentials.env"

log()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m[warn] %s\033[0m\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Run as root"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

# --------------------------------------------------------------- secrets ----
if [[ -f "$CREDS_FILE" ]]; then
  log "Reusing existing credentials from $CREDS_FILE"
  # shellcheck disable=SC1090
  source "$CREDS_FILE"
fi
DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -hex 24)}"
REDIS_PASSWORD="${REDIS_PASSWORD:-$(openssl rand -hex 24)}"
JWT_SECRET="${JWT_SECRET:-$(openssl rand -hex 48)}"
umask 077
cat > "$CREDS_FILE" <<EOF
DB_PASSWORD=${DB_PASSWORD}
REDIS_PASSWORD=${REDIS_PASSWORD}
JWT_SECRET=${JWT_SECRET}
EOF
umask 022

SERVER_IP="$(hostname -I | awk '{print $1}')"

# ------------------------------------------------------------ base system ----
log "Updating system packages"
apt-get update -y
apt-get upgrade -y
apt-get install -y curl ca-certificates gnupg git ufw nginx openssl rsync tar

# ------------------------------------------------------------------- swap ----
# npm ci on a small VPS can run out of memory without it.
if ! swapon --show | grep -q .; then
  log "Creating 2G swap file"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---------------------------------------------------------------- node.js ----
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" != "$NODE_MAJOR" ]]; then
  log "Installing Node.js ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
node -v && npm -v

# ------------------------------------------------------------- postgresql ----
log "Installing PostgreSQL"
apt-get install -y postgresql postgresql-contrib
systemctl enable --now postgresql

log "Creating database '${DB_NAME}' and role '${DB_USER}'"
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}';
  ELSE
    ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASSWORD}';
  END IF;
END
\$\$;
SQL
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
fi
sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" \
  -c "ALTER SCHEMA public OWNER TO ${DB_USER};" \
  -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"
# PostgreSQL listens on localhost only by default — leave it that way.

# ------------------------------------------------------------------ redis ----
log "Installing Redis"
if apt-cache show redis-server >/dev/null 2>&1; then
  apt-get install -y redis-server
  REDIS_SERVICE="redis-server"; REDIS_CONF_DIR="/etc/redis"; REDIS_MAIN_CONF="/etc/redis/redis.conf"
else
  warn "redis-server package not found, installing Valkey (Redis-compatible)"
  apt-get install -y valkey-server
  REDIS_SERVICE="valkey-server"; REDIS_CONF_DIR="/etc/valkey"; REDIS_MAIN_CONF="/etc/valkey/valkey.conf"
fi

# Overrides live in their own file, included last so they win.
cat > "${REDIS_CONF_DIR}/aiko.conf" <<EOF
bind 127.0.0.1 -::1
protected-mode yes
port 6379
requirepass ${REDIS_PASSWORD}
supervised systemd
# BullMQ requires noeviction — evicting keys silently loses jobs.
maxmemory-policy noeviction
appendonly yes
appendfsync everysec
EOF
chmod 640 "${REDIS_CONF_DIR}/aiko.conf"
chown root:"$(stat -c %G "$REDIS_MAIN_CONF")" "${REDIS_CONF_DIR}/aiko.conf"
grep -q "include ${REDIS_CONF_DIR}/aiko.conf" "$REDIS_MAIN_CONF" \
  || echo "include ${REDIS_CONF_DIR}/aiko.conf" >> "$REDIS_MAIN_CONF"
systemctl enable "$REDIS_SERVICE"
systemctl restart "$REDIS_SERVICE"
sleep 1
REDISCLI="$(command -v redis-cli || command -v valkey-cli)"
"$REDISCLI" -a "$REDIS_PASSWORD" --no-auth-warning ping | grep -q PONG \
  && echo "Redis OK" || { echo "Redis did not respond"; exit 1; }

# ------------------------------------------------------------ deploy user ----
log "Creating '${DEPLOY_USER}' user and SSH key for GitHub Actions"
id "$DEPLOY_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$DEPLOY_USER"
usermod -aG systemd-journal "$DEPLOY_USER"   # lets deploys print app logs on failure
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "${DEPLOY_HOME}/.ssh"
KEY="${DEPLOY_HOME}/.ssh/github_actions"
if [[ ! -f "$KEY" ]]; then
  sudo -u "$DEPLOY_USER" ssh-keygen -t ed25519 -N "" -C "github-actions@${APP_NAME}" -f "$KEY" >/dev/null
fi
touch "${DEPLOY_HOME}/.ssh/authorized_keys"
grep -qF "$(cat "${KEY}.pub")" "${DEPLOY_HOME}/.ssh/authorized_keys" \
  || cat "${KEY}.pub" >> "${DEPLOY_HOME}/.ssh/authorized_keys"
chown -R "$DEPLOY_USER:$DEPLOY_USER" "${DEPLOY_HOME}/.ssh"
chmod 600 "${DEPLOY_HOME}/.ssh/authorized_keys"

# Let the deploy user restart only this service, nothing else.
SYSTEMCTL="$(command -v systemctl)"
cat > /etc/sudoers.d/${APP_NAME} <<EOF
${DEPLOY_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL} restart ${APP_NAME}, ${SYSTEMCTL} status ${APP_NAME}, ${SYSTEMCTL} is-active ${APP_NAME}
EOF
chmod 440 /etc/sudoers.d/${APP_NAME}
visudo -cf /etc/sudoers.d/${APP_NAME}

# --------------------------------------------------------- app directories ----
log "Preparing ${APP_DIR}"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" \
  "$APP_DIR" "$APP_DIR/releases" "$APP_DIR/shared" "$APP_DIR/shared/uploads"

PUBLIC_BASE_URL="https://${API_DOMAIN}"

ENV_FILE="$APP_DIR/shared/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  log "Writing ${ENV_FILE}"
  cat > "$ENV_FILE" <<EOF
# ---- generated by server-setup.sh on $(date -u +%F) ----
NODE_ENV=production
PORT=${APP_PORT}
PUBLIC_BASE_URL=${PUBLIC_BASE_URL}
# Unset = any origin may call the API. To lock it to the admin on Render:
# CORS_ORIGIN=https://your-admin.onrender.com,https://api.admin.nuriq.tech

DATABASE_URL=postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}?schema=public
REDIS_URL=redis://:${REDIS_PASSWORD}@127.0.0.1:6379
JWT_SECRET=${JWT_SECRET}

STORAGE_PROVIDER=LOCAL
UPLOAD_DIR=${APP_DIR}/shared/uploads

# ---- FILL THESE IN (see .env.example in the repo for every option) ----
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=""
GOOGLE_MAPS_API_KEY=
EOF
else
  warn "${ENV_FILE} already exists, leaving it untouched"
fi
chown "$DEPLOY_USER:$DEPLOY_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ---------------------------------------------------------- systemd unit ----
log "Installing systemd service '${APP_NAME}'"
cat > /etc/systemd/system/${APP_NAME}.service <<EOF
[Unit]
Description=Aiko API (NestJS)
After=network-online.target postgresql.service ${REDIS_SERVICE}.service
Wants=network-online.target

[Service]
Type=simple
User=${DEPLOY_USER}
Group=${DEPLOY_USER}
WorkingDirectory=${APP_DIR}/current
Environment=NODE_ENV=production
ExecStart=$(command -v node) dist/main.js
Restart=always
RestartSec=5
LimitNOFILE=65535
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable ${APP_NAME}   # first start happens on the first deploy

# ------------------------------------------------------------------ nginx ----
log "Configuring Nginx"

# Shared proxy settings (WebSocket upgrade for Socket.IO included).
cat > /etc/nginx/snippets/aiko-proxy.conf <<EOF
proxy_pass http://127.0.0.1:${APP_PORT};
proxy_http_version 1.1;
proxy_set_header Upgrade \$http_upgrade;
proxy_set_header Connection \$connection_upgrade;
proxy_set_header Host \$host;
proxy_set_header X-Real-IP \$remote_addr;
proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto \$scheme;
proxy_read_timeout 300s;   # long-lived Socket.IO connections
proxy_send_timeout 300s;
EOF

cat > /etc/nginx/conf.d/aiko-upgrade-map.conf <<'EOF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
EOF

# --- API: api.nuriq.tech -> NestJS
cat > /etc/nginx/sites-available/${APP_NAME} <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${API_DOMAIN};

    client_max_body_size 25M;

    location / {
        include snippets/aiko-proxy.conf;
    }
}
EOF

ln -sfn /etc/nginx/sites-available/${APP_NAME} /etc/nginx/sites-enabled/${APP_NAME}
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl reload nginx

# --------------------------------------------------------------- firewall ----
log "Configuring UFW firewall"
for p in $(sshd -T 2>/dev/null | awk '/^port /{print $2}'); do ufw allow "${p}/tcp"; done
ufw allow OpenSSH || true
ufw allow 'Nginx Full'
ufw --force enable

# -------------------------------------------------------------------- tls ----
# Runs on every setup run: on a rerun it re-applies the existing certificate to
# the freshly rewritten Nginx configs instead of requesting a new one.
log "HTTPS certificates (Let's Encrypt)"
apt-get install -y certbot python3-certbot-nginx
if [[ -n "$EMAIL" ]]; then CERT_ACCOUNT=(-m "$EMAIL"); else CERT_ACCOUNT=(--register-unsafely-without-email); fi
certbot --nginx -d "$API_DOMAIN" --non-interactive --agree-tos "${CERT_ACCOUNT[@]}" \
  --redirect --keep-until-expiring \
  || warn "HTTPS for ${API_DOMAIN} failed. Point its A record at ${SERVER_IP}, wait for DNS, then rerun this script."
# certbot installs a systemd timer that renews certificates automatically.

# ---------------------------------------------------------------- summary ----
SSH_PORT="$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')"; SSH_PORT="${SSH_PORT:-22}"
# Public IP (hostname -I can return a private one on some VPSes).
PUBLIC_IP="$(curl -4 -fsS --max-time 5 https://ifconfig.me 2>/dev/null || echo "$SERVER_IP")"
SERVER_IP="$PUBLIC_IP"
# Built straight from the host key file, no network scan needed.
if [[ "$SSH_PORT" == "22" ]]; then KH_HOST="$SERVER_IP"; else KH_HOST="[$SERVER_IP]:$SSH_PORT"; fi
KNOWN_HOSTS="${KH_HOST} $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"

SUMMARY=/root/aiko-setup-summary.txt
umask 077
cat > "$SUMMARY" <<EOF
============================================================================
 AIKO API SERVER READY
============================================================================

 PostgreSQL
   host/port : 127.0.0.1:5432 (local only)
   database  : ${DB_NAME}
   user      : ${DB_USER}
   password  : ${DB_PASSWORD}
   URL       : postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}?schema=public

 Redis (${REDIS_SERVICE})
   host/port : 127.0.0.1:6379 (local only)
   password  : ${REDIS_PASSWORD}
   URL       : redis://:${REDIS_PASSWORD}@127.0.0.1:6379

 JWT_SECRET  : ${JWT_SECRET}

 App
   env file  : ${ENV_FILE}   <-- add Firebase / Google keys here
   service   : systemctl status ${APP_NAME} | journalctl -u ${APP_NAME} -f
   API       : https://${API_DOMAIN}

----------------------------------------------------------------------------
 GITHUB SECRETS (aiko-api repo -> Settings -> Secrets and variables -> Actions)
----------------------------------------------------------------------------
 DEPLOY_HOST        = ${SERVER_IP}
 DEPLOY_PORT        = ${SSH_PORT}
 DEPLOY_USER        = ${DEPLOY_USER}
 DEPLOY_KNOWN_HOSTS = ${KNOWN_HOSTS}
 DEPLOY_SSH_KEY     = (everything below, including the BEGIN/END lines)
$(cat "$KEY")
============================================================================
 Saved to ${SUMMARY} (root-only). Delete it once you have copied everything.
============================================================================
EOF
umask 022
cat "$SUMMARY"
