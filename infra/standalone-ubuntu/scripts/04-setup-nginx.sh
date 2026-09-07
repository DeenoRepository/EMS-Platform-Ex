#!/usr/bin/env bash
# ==============================================================================
# EMS Platform: Configure Nginx Ingress on Ubuntu 24.04 Standalone Host
# ==============================================================================
set -euo pipefail

CERT_SRC="${1:-}"
KEY_SRC="${2:-}"

echo "=== [04] EMS Platform: Configuring Nginx Reverse Proxy ==="

if [[ $EUID -ne 0 ]]; then
    echo "ERROR: This script must be run as root." >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIGS_DIR="$SCRIPT_DIR/../configs"

# 1. Locate TLS certificate and key
if [[ -z "$CERT_SRC" || -z "$KEY_SRC" ]]; then
    ALT_CERT="$SCRIPT_DIR/../../certs/web.crt"
    ALT_KEY="$SCRIPT_DIR/../../certs/web.key"
    if [[ -f "$ALT_CERT" && -f "$ALT_KEY" ]]; then
        CERT_SRC="$ALT_CERT"
        KEY_SRC="$ALT_KEY"
    else
        echo "ERROR: Web TLS certificate and key must be provided." >&2
        echo "Usage: sudo $0 /path/to/web.crt /path/to/web.key" >&2
        exit 1
    fi
fi

# 2. Deploy TLS credentials
echo "Deploying TLS certificates to /etc/ssl/..."
cp "$CERT_SRC" /etc/ssl/certs/ems-web.crt
chmod 644 /etc/ssl/certs/ems-web.crt

cp "$KEY_SRC" /etc/ssl/private/ems-web.key
chmod 600 /etc/ssl/private/ems-web.key

# 3. Deploy Nginx Virtual Host
echo "Deploying Nginx site configuration..."
if [[ -f "$CONFIGS_DIR/nginx-ems.conf" ]]; then
    cp "$CONFIGS_DIR/nginx-ems.conf" /etc/nginx/sites-available/ems
    ln -sf /etc/nginx/sites-available/ems /etc/nginx/sites-enabled/ems
    rm -f /etc/nginx/sites-enabled/default
else
    echo "ERROR: $CONFIGS_DIR/nginx-ems.conf not found." >&2
    exit 1
fi

# 4. Test and restart Nginx
echo "Testing Nginx syntax..."
nginx -t

echo "Enabling and restarting Nginx service..."
systemctl enable nginx
systemctl restart nginx

if systemctl is-active --quiet nginx; then
    echo "[OK] Nginx is running and listening on ports 80 and 443."
else
    echo "ERROR: Nginx failed to start." >&2
    exit 1
fi

echo "=== [04] Nginx Configuration Complete ==="
