#!/usr/bin/env bash
# ==============================================================================
# EMS Platform: Setup Systemd Service & Dedicated Unprivileged User
# ==============================================================================
set -euo pipefail

echo "=== [03] EMS Platform: Configuring Systemd Service ==="

if [[ $EUID -ne 0 ]]; then
    echo "ERROR: This script must be run as root." >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIGS_DIR="$SCRIPT_DIR/../configs"

# 1. Create dedicated unprivileged system user
if ! id -u ems &>/dev/null; then
    echo "Creating system user 'ems'..."
    useradd --system --no-create-home --user-group --shell /usr/sbin/nologin ems
else
    echo "[OK] System user 'ems' already exists."
fi

# 2. Setup application directories
echo "Creating application directories in /opt/ems and /etc/ems..."
mkdir -p /opt/ems/app /etc/ems
chown -R ems:ems /opt/ems
chmod 750 /opt/ems
chown -R root:ems /etc/ems
chmod 750 /etc/ems

# 3. Create initial environment configuration if missing
ENV_FILE="/etc/ems/ems.env"
DB_CREDS="/etc/ems/db-credentials.env"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "Creating environment configuration template in $ENV_FILE..."
    RUNTIME_URL="postgresql://ems_runtime:runtime_secret@127.0.0.1:5432/ems_stand"
    if [[ -f "$DB_CREDS" ]]; then
        source "$DB_CREDS"
        RUNTIME_URL="${EMS_DATABASE_URL:-$RUNTIME_URL}"
    fi

    cat <<EOF > "$ENV_FILE"
# ==============================================================================
# EMS Platform: Production Service Environment Variables
# ==============================================================================
NODE_ENV=production
PORT=3000
HOST=127.0.0.1

# Database Connection (Runtime DML Only)
DATABASE_URL=$RUNTIME_URL

# LDAP / Active Directory Configuration
LDAP_URL=ldaps://127.0.0.1:636
LDAP_BIND_DN=svc_ems_ldap@corp.local
LDAP_BIND_PASSWORD=Ldap_Service_Secret123!
LDAP_SEARCH_BASE=DC=corp,DC=local
LDAP_DOMAIN=corp.local

# Internal Root CA for Strict TLS Verification
NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/ems-test-root-ca.crt

# Session Security
SESSION_SECRET=$(openssl rand -hex 32)
EOF
    chown root:ems "$ENV_FILE"
    chmod 640 "$ENV_FILE"
fi

# 4. Install systemd unit
if [[ -f "$CONFIGS_DIR/ems-web.service" ]]; then
    echo "Installing systemd service file..."
    cp "$CONFIGS_DIR/ems-web.service" /etc/systemd/system/ems-web.service
    chmod 644 /etc/systemd/system/ems-web.service
    systemctl daemon-reload
    systemctl enable ems-web.service
    echo "[OK] ems-web.service enabled."
else
    echo "ERROR: $CONFIGS_DIR/ems-web.service not found." >&2
    exit 1
fi

echo "=== [03] Systemd Setup Complete ==="
