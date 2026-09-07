#!/usr/bin/env bash
# ==============================================================================
# EMS Platform: Setup PostgreSQL 16 on Ubuntu 24.04 Standalone Host
# ==============================================================================
set -euo pipefail

echo "=== [02] EMS Platform: Setting up PostgreSQL 16 ==="

if [[ $EUID -ne 0 ]]; then
    echo "ERROR: This script must be run as root." >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIGS_DIR="$SCRIPT_DIR/../configs"
CRED_FILE="/etc/ems/db-credentials.env"
DB_NAME="${EMS_DB_NAME:-ems_stand}"

mkdir -p /etc/ems
chmod 700 /etc/ems

# 1. Generate or load passwords
if [[ -f "$CRED_FILE" ]]; then
    echo "Loading existing credentials from $CRED_FILE..."
    source "$CRED_FILE"
else
    echo "Generating secure database credentials..."
    MIGRATION_PASS=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 24)
    RUNTIME_PASS=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 24)

    cat <<EOF > "$CRED_FILE"
# EMS Platform Database Credentials (Auto-generated)
EMS_MIGRATION_USER=ems_migration
EMS_MIGRATION_PASSWORD=$MIGRATION_PASS
EMS_RUNTIME_USER=ems_runtime
EMS_RUNTIME_PASSWORD=$RUNTIME_PASS
EMS_DB_NAME=$DB_NAME
EMS_DATABASE_URL=postgresql://ems_runtime:$RUNTIME_PASS@127.0.0.1:5432/$DB_NAME
EMS_MIGRATION_URL=postgresql://ems_migration:$MIGRATION_PASS@127.0.0.1:5432/$DB_NAME
EOF
    chmod 600 "$CRED_FILE"
    source "$CRED_FILE"
fi

# 2. Ensure PostgreSQL 16 is active
systemctl enable postgresql
systemctl start postgresql

# 3. Provision PostgreSQL roles & database
echo "Provisioning roles and database '$DB_NAME'..."
su - postgres -c "psql -v ON_ERROR_STOP=1" <<EOF
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$EMS_MIGRATION_USER') THEN
        CREATE ROLE $EMS_MIGRATION_USER WITH LOGIN PASSWORD '$EMS_MIGRATION_PASSWORD' CREATEDB;
    ELSE
        ALTER ROLE $EMS_MIGRATION_USER WITH LOGIN PASSWORD '$EMS_MIGRATION_PASSWORD' CREATEDB;
    END IF;

    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$EMS_RUNTIME_USER') THEN
        CREATE ROLE $EMS_RUNTIME_USER WITH LOGIN PASSWORD '$EMS_RUNTIME_PASSWORD';
    ELSE
        ALTER ROLE $EMS_RUNTIME_USER WITH LOGIN PASSWORD '$EMS_RUNTIME_PASSWORD';
    END IF;
END
\$\$;

SELECT 'CREATE DATABASE $DB_NAME OWNER $EMS_MIGRATION_USER'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB_NAME')\gexec

\connect $DB_NAME

-- Revoke public creation
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Grants for runtime user
GRANT CONNECT ON DATABASE $DB_NAME TO $EMS_RUNTIME_USER;
GRANT USAGE ON SCHEMA public TO $EMS_RUNTIME_USER;

-- Default privileges for objects created by migration role
ALTER DEFAULT PRIVILEGES FOR ROLE $EMS_MIGRATION_USER GRANT USAGE ON SCHEMAS TO $EMS_RUNTIME_USER;
ALTER DEFAULT PRIVILEGES FOR ROLE $EMS_MIGRATION_USER GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $EMS_RUNTIME_USER;
ALTER DEFAULT PRIVILEGES FOR ROLE $EMS_MIGRATION_USER GRANT USAGE, SELECT ON SEQUENCES TO $EMS_RUNTIME_USER;
EOF

# 4. Install configuration snippets
PG_CONF_DIR="/etc/postgresql/16/main"
if [[ -d "$PG_CONF_DIR/conf.d" && -f "$CONFIGS_DIR/postgresql.conf.snippet" ]]; then
    echo "Installing PostgreSQL performance & timeout settings..."
    cp "$CONFIGS_DIR/postgresql.conf.snippet" "$PG_CONF_DIR/conf.d/99-ems.conf"
    chown postgres:postgres "$PG_CONF_DIR/conf.d/99-ems.conf"
fi

if [[ -f "$PG_CONF_DIR/pg_hba.conf" && -f "$CONFIGS_DIR/pg_hba.conf.snippet" ]]; then
    if ! grep -q "ems_stand,ems_prod" "$PG_CONF_DIR/pg_hba.conf"; then
        echo "Applying pg_hba.conf access control rules..."
        cat "$CONFIGS_DIR/pg_hba.conf.snippet" >> "$PG_CONF_DIR/pg_hba.conf"
    fi
fi

# 5. Reload PostgreSQL configuration
echo "Reloading PostgreSQL configuration..."
systemctl restart postgresql

# 6. Verify connection
echo "Verifying local connections..."
PGPASSWORD="$EMS_MIGRATION_PASSWORD" psql -h 127.0.0.1 -U "$EMS_MIGRATION_USER" -d "$DB_NAME" -c "SELECT 1 AS migration_ok;" >/dev/null
PGPASSWORD="$EMS_RUNTIME_PASSWORD" psql -h 127.0.0.1 -U "$EMS_RUNTIME_USER" -d "$DB_NAME" -c "SELECT 1 AS runtime_ok;" >/dev/null

echo "[OK] PostgreSQL roles and permissions configured successfully."
echo "=== [02] PostgreSQL Setup Complete ==="
