#!/usr/bin/env bash
# The Floor — one-command install on a Debian/Ubuntu host.
#
#   sudo ./deploy.sh
#   sudo DOMAIN=floor.example.com ./deploy.sh     # also writes an nginx vhost
#
# Installs to /opt/the-floor, runs as the unprivileged user "the-floor",
# listens on 127.0.0.1:8787, and health-checks the result.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/the-floor}"
PORT="${PORT:-8787}"
SERVICE="${SERVICE:-the-floor}"
RUN_USER="${RUN_USER:-the-floor}"
DOMAIN="${DOMAIN:-}"
BIND="${BIND:-127.0.0.1}"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root (sudo ./deploy.sh)." >&2
  exit 1
fi

command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
PYV=$(python3 -c 'import sys; print(sys.version_info[:2] >= (3,11))')
[ "$PYV" = "True" ] || { echo "Python 3.11+ is required" >&2; exit 1; }

say "Installing to $APP_DIR"
SRC="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$APP_DIR"
for f in app.py; do install -m 0644 "$SRC/$f" "$APP_DIR/$f"; done
rm -rf "$APP_DIR/web"
cp -R "$SRC/web" "$APP_DIR/web"
chmod -R a+rX "$APP_DIR/web"
mkdir -p "$APP_DIR/data"

if ! id "$RUN_USER" >/dev/null 2>&1; then
  say "Creating user $RUN_USER"
  useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$RUN_USER"
fi
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR/data"
chown "$RUN_USER:$RUN_USER" "$APP_DIR"

say "Writing /etc/systemd/system/$SERVICE.service"
cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=The Floor — a live read of the Taskmarket market
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/python3 $APP_DIR/app.py --serve --port $PORT --bind $BIND
Environment=FLOOR_REFRESH_SECONDS=300
Restart=always
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$APP_DIR/data
MemoryMax=256M

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

say "Waiting for the first fetch"
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo "Service did not become healthy — see: journalctl -u $SERVICE -n 50" >&2
  exit 1
fi
say "Healthy on http://127.0.0.1:$PORT"

if [ -n "$DOMAIN" ]; then
  say "Writing nginx vhost for $DOMAIN"
  if [ ! -d /etc/nginx/sites-enabled ]; then echo "nginx not found; skipping vhost" >&2; exit 0; fi
  cat > "/etc/nginx/sites-available/the-floor.conf" <<NGINX
server {
    listen 80;
    server_name $DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        add_header Cache-Control "public, max-age=60" always;
    }
}
NGINX
  ln -sf /etc/nginx/sites-available/the-floor.conf /etc/nginx/sites-enabled/the-floor.conf
  nginx -t && systemctl reload nginx
  say "nginx serving $DOMAIN (add a TLS certificate in front, e.g. certbot --nginx -d $DOMAIN)"
fi

say "Done. Logs: journalctl -u $SERVICE -f"
