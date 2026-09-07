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

# 2. Apply PostgreSQL Migrations using ems_migration role
echo "Applying database migrations as role 'ems_migration'..."
if [[ -f "$DB_CREDS" ]]; then
    source "$DB_CREDS"
else
    echo "ERROR: $DB_CREDS not found. Please run 02-setup-postgres.sh first." >&2
    exit 1
fi

MIGRATIONS_DIR="$APP_DIR/packages/core/migrations"
if [[ ! -d "$MIGRATIONS_DIR" ]]; then
    # Fallback to local source tree if running in repo context
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    ALT_MIGRATIONS="$SCRIPT_DIR/../../../packages/core/migrations"
    if [[ -d "$ALT_MIGRATIONS" ]]; then
        MIGRATIONS_DIR="$ALT_MIGRATIONS"
    fi
fi

if [[ -d "$MIGRATIONS_DIR" ]]; then
    echo "Running migrations from $MIGRATIONS_DIR..."
    # Ensure migration table exists
    PGPASSWORD="$EMS_MIGRATION_PASSWORD" psql -h 127.0.0.1 -U "$EMS_MIGRATION_USER" -d "$EMS_DB_NAME" <<EOF
CREATE SCHEMA IF NOT EXISTS ems_core;
CREATE TABLE IF NOT EXISTS ems_core.schema_migrations (
    version VARCHAR(64) PRIMARY KEY,
    checksum VARCHAR(128),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
EOF

    # Apply 001 and 002 if not applied
    for mig in "001_core_schema" "002_core_security_remediation"; do
        SQL_FILE="$MIGRATIONS_DIR/${mig}.sql"
        if [[ -f "$SQL_FILE" ]]; then
            APPLIED=$(PGPASSWORD="$EMS_MIGRATION_PASSWORD" psql -h 127.0.0.1 -U "$EMS_MIGRATION_USER" -d "$EMS_DB_NAME" -t -A -c "SELECT COUNT(1) FROM ems_core.schema_migrations WHERE version = '$mig';")
            if [[ "$APPLIED" == "0" ]]; then
                echo "  Applying migration $mig..."
                CHECKSUM=$(sha256sum "$SQL_FILE" | awk '{print $1}')
                PGPASSWORD="$EMS_MIGRATION_PASSWORD" psql -h 127.0.0.1 -U "$EMS_MIGRATION_USER" -d "$EMS_DB_NAME" \
                    -v ON_ERROR_STOP=1 --single-transaction <<MIG_EOF
\i $SQL_FILE
INSERT INTO ems_core.schema_migrations (version, checksum) VALUES ('$mig', '$CHECKSUM');
MIG_EOF
            else
                echo "  Migration $mig already applied."
            fi
        fi
    done

    # Clean stand provisioning: if no platform administrator exists yet, ensure bootstrap_state is 'ready' for initial admin setup
    ADMIN_EXISTS=$(PGPASSWORD="$EMS_MIGRATION_PASSWORD" psql -h 127.0.0.1 -U "$EMS_MIGRATION_USER" -d "$EMS_DB_NAME" -t -A -c "
        SELECT COUNT(1) FROM ems_core.employee_roles er
        JOIN ems_core.employees e ON e.id = er.employee_id
        WHERE er.role_id = 'role.platform.admin' AND e.status = 'ACTIVE';")
    if [[ "$ADMIN_EXISTS" == "0" ]]; then
        echo "Clean stand detected (no active admins). Initializing bootstrap_state to 'ready'..."
        PGPASSWORD="$EMS_MIGRATION_PASSWORD" psql -h 127.0.0.1 -U "$EMS_MIGRATION_USER" -d "$EMS_DB_NAME" -v ON_ERROR_STOP=1 -c "
            INSERT INTO ems_core.bootstrap_state (id, status)
            VALUES (1, 'ready')
            ON CONFLICT (id) DO UPDATE SET status = 'ready', updated_at = NOW();"
    fi
else
    echo "WARNING: Migrations directory not found at $MIGRATIONS_DIR. Skipping direct SQL application."
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
