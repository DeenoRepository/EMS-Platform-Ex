#!/usr/bin/env bash
# ==============================================================================
# EMS Platform: Install Internal Trusted Root CA Certificate
# ==============================================================================
set -euo pipefail

CA_CERT_SOURCE="${1:-/opt/ems/certs/TestRootCA.crt}"

echo "=== [01] EMS Platform: Installing Internal Trusted Root CA ==="

if [[ $EUID -ne 0 ]]; then
    echo "ERROR: This script must be run as root." >&2
    exit 1
fi

if [[ ! -f "$CA_CERT_SOURCE" ]]; then
    # Fallback search in relative infra directory
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    ALT_PATH="$SCRIPT_DIR/../../certs/TestRootCA.crt"
    if [[ -f "$ALT_PATH" ]]; then
        CA_CERT_SOURCE="$ALT_PATH"
    else
        echo "ERROR: Root CA certificate not found at '$CA_CERT_SOURCE' or '$ALT_PATH'." >&2
        echo "Usage: sudo $0 /path/to/TestRootCA.crt" >&2
        exit 1
    fi
fi

TARGET_DIR="/usr/local/share/ca-certificates"
TARGET_FILE="$TARGET_DIR/ems-test-root-ca.crt"

echo "Copying $CA_CERT_SOURCE to $TARGET_FILE..."
mkdir -p "$TARGET_DIR"
cp "$CA_CERT_SOURCE" "$TARGET_FILE"
chmod 644 "$TARGET_FILE"

echo "Updating system CA certificates trust store..."
update-ca-certificates --fresh

# Ensure NODE_EXTRA_CA_CERTS is exported globally for Node.js
mkdir -p /etc/ems
CONFIGURED_ENV="/etc/ems/ems.env"
if [[ -f "$CONFIGURED_ENV" ]]; then
    if ! grep -q "NODE_EXTRA_CA_CERTS" "$CONFIGURED_ENV"; then
        echo "NODE_EXTRA_CA_CERTS=$TARGET_FILE" >> "$CONFIGURED_ENV"
    fi
fi

if ! grep -q "NODE_EXTRA_CA_CERTS" /etc/environment 2>/dev/null; then
    echo "NODE_EXTRA_CA_CERTS=$TARGET_FILE" >> /etc/environment
fi

echo "[OK] Internal CA installed and trusted by system & Node.js."
echo "=== [01] CA Installation Complete ==="
