#!/usr/bin/env bash
# Runs ON THE SERVER as the deploy user, called by .github/workflows/deploy.yml.
#   usage: bash -s <release-id> < deploy/remote-deploy.sh
# Expects the release tarball at /var/www/aiko-api/releases/<release-id>.tgz
set -euo pipefail

APP_NAME="aiko-api"
APP_DIR="/var/www/${APP_NAME}"
RELEASE_ID="${1:?release id required}"
RELEASE_DIR="${APP_DIR}/releases/${RELEASE_ID}"
TARBALL="${APP_DIR}/releases/${RELEASE_ID}.tgz"
KEEP_RELEASES=5

PORT="$(grep -E '^PORT=' "${APP_DIR}/shared/.env" | cut -d= -f2 | tr -d '"' || true)"
PORT="${PORT:-3000}"
PREVIOUS="$(readlink -f "${APP_DIR}/current" 2>/dev/null || true)"

echo "==> Unpacking ${RELEASE_ID}"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"
tar -xzf "$TARBALL" -C "$RELEASE_DIR"
rm -f "$TARBALL"
ln -sfn "${APP_DIR}/shared/.env" "${RELEASE_DIR}/.env"

cd "$RELEASE_DIR"
echo "==> Installing dependencies"
npm ci --no-audit --no-fund --loglevel=error

echo "==> Generating Prisma client and running migrations"
npx prisma generate
npx prisma migrate deploy

echo "==> Switching current -> ${RELEASE_ID}"
ln -sfn "$RELEASE_DIR" "${APP_DIR}/current.tmp"
mv -Tf "${APP_DIR}/current.tmp" "${APP_DIR}/current"
sudo systemctl restart "$APP_NAME"

echo "==> Health check on 127.0.0.1:${PORT}"
healthy=false
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api" || true)"
  if [[ "$code" != "000" && "$code" -lt 500 ]]; then healthy=true; break; fi
  sleep 2
done

if ! $healthy; then
  echo "!! App did not come up. Recent logs:"
  journalctl -u "$APP_NAME" -n 60 --no-pager 2>/dev/null || sudo systemctl status "$APP_NAME" --no-pager || true
  if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
    echo "!! Rolling back to $(basename "$PREVIOUS")"
    ln -sfn "$PREVIOUS" "${APP_DIR}/current.tmp"
    mv -Tf "${APP_DIR}/current.tmp" "${APP_DIR}/current"
    sudo systemctl restart "$APP_NAME"
  fi
  exit 1
fi
echo "==> Healthy (HTTP ${code})"

echo "==> Pruning old releases (keeping ${KEEP_RELEASES})"
cd "${APP_DIR}/releases"
ls -1dt */ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf
echo "==> Deployed ${RELEASE_ID}"
