#!/usr/bin/env bash
# ==============================================================================
# EMS Platform: Deploy Application Bundle & Apply Database Migrations
# ==============================================================================
set -euo pipefail

BUNDLE_ARCHIVE="${1:-}"

echo "=== [05] EMS Platform: Provisioning Application Bundle ==="

if [[ $EUID -ne 0 ]]; then
    echo "ERROR: This script must be run as root." >&2
    exit 1
fi

APP_DIR="/opt/ems/app"
DB_CREDS="/etc/ems/db-credentials.env"

# 1. Unpack archive if provided
if [[ -n "$BUNDLE_ARCHIVE" && -f "$BUNDLE_ARCHIVE" ]]; then
    echo "Unpacking $BUNDLE_ARCHIVE into $APP_DIR..."
    mkdir -p "$APP_DIR"
    tar -xzf "$BUNDLE_ARCHIVE" -C "$APP_DIR"
else
    echo "No bundle archive specified. Assuming application code already present in $APP_DIR."
    if [[ ! -d "$APP_DIR" ]]; then
        echo "ERROR: Application directory $APP_DIR does not exist." >&2
        exit 1
    fi
fi

# 2. Apply PostgreSQL migrations through the core migration CLI
echo "Applying database migrations through the core migration CLI..."
if [[ -f "$DB_CREDS" ]]; then
    source "$DB_CREDS"
else
    echo "ERROR: $DB_CREDS not found. Please run 02-setup-postgres.sh first." >&2
    exit 1
fi

if [[ -z "${EMS_MIGRATION_USER:-}" || -z "${EMS_MIGRATION_PASSWORD:-}" || -z "${EMS_DB_NAME:-}" ]]; then
    echo "ERROR: EMS_MIGRATION_USER, EMS_MIGRATION_PASSWORD and EMS_DB_NAME must be set in $DB_CREDS." >&2
    exit 1
fi

MIGRATION_URL="postgresql://${EMS_MIGRATION_USER}:${EMS_MIGRATION_PASSWORD}@127.0.0.1:5432/${EMS_DB_NAME}"
export EMS_MIGRATION_URL="$MIGRATION_URL"
CLI="$APP_DIR/packages/core/dist/cli/migrate.js"
if [[ ! -f "$CLI" ]]; then
    echo "ERROR: Migration CLI not found at $CLI." >&2
    exit 1
fi

SCHEMA_EXISTS=$(PGPASSWORD="$EMS_MIGRATION_PASSWORD" psql -h 127.0.0.1 -U "$EMS_MIGRATION_USER" -d "$EMS_DB_NAME" -t -A -v ON_ERROR_STOP=1 -c "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'ems_core');")
if [[ "$SCHEMA_EXISTS" == "t" ]]; then
    echo "Existing ems_core schema detected; running upgrade..."
    node "$CLI" upgrade
    BOOTSTRAP_STATUS=$(PGPASSWORD="$EMS_MIGRATION_PASSWORD" psql -h 127.0.0.1 -U "$EMS_MIGRATION_USER" -d "$EMS_DB_NAME" -t -A -v ON_ERROR_STOP=1 -c "SELECT status FROM ems_core.bootstrap_state WHERE id = 1;")
    if [[ "$BOOTSTRAP_STATUS" == "locked-legacy" ]]; then
        echo "ERROR: Existing database is locked-legacy. Follow the RUNBOOK locked-legacy procedure; no automatic unlock was performed." >&2
        exit 1
    fi
else
    echo "ems_core schema is absent; running clean provisioning..."
    node "$CLI" provision-clean
fi

# 3. Set file ownership
chown -R ems:ems /opt/ems/app

# 4. Restart ems-web service
echo "Starting ems-web systemd service..."
systemctl restart ems-web.service

sleep 2
if systemctl is-active --quiet ems-web.service; then
    echo "[OK] ems-web service is active and running."
else
    echo "ERROR: ems-web service failed to enter active state. Check logs with: journalctl -u ems-web -n 50" >&2
    exit 1
fi

echo "=== [05] Application Provisioning Complete ==="
