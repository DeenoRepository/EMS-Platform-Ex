#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_DIR="$(dirname "$SCRIPT_DIR")"
INFRA_DIR="$(dirname "$DOCKER_DIR")"
ROOT_DIR="$(dirname "$INFRA_DIR")"

if [[ -z "${EMS_TEST_PG_MIGRATION_URL:-}" || -z "${EMS_TEST_PG_RUNTIME_URL:-}" ]]; then
    echo "ERROR: Set EMS_TEST_PG_MIGRATION_URL and EMS_TEST_PG_RUNTIME_URL before running acceptance tests." >&2
    exit 1
fi

MIGRATION_URL="$EMS_TEST_PG_MIGRATION_URL"
RUNTIME_URL="$EMS_TEST_PG_RUNTIME_URL"

echo "=== EMS Platform: Running PostgreSQL Real Acceptance Tests ==="

# 1. Check PostgreSQL port 5432
if ! nc -z 127.0.0.1 5432 >/dev/null 2>&1; then
    echo "ERROR: PostgreSQL is not reachable on localhost:5432. Please start the stand first: bash $SCRIPT_DIR/stand-up.sh" >&2
    exit 1
fi

# 2. Export environment variables
export EMS_TEST_PG_INTEGRATION=true
export EMS_TEST_PG_MIGRATION_URL="$MIGRATION_URL"
export EMS_TEST_PG_RUNTIME_URL="$RUNTIME_URL"

if [[ -f "$INFRA_DIR/certs/TestRootCA.crt" ]]; then
    export NODE_EXTRA_CA_CERTS="$INFRA_DIR/certs/TestRootCA.crt"
    echo "Loaded root CA for TLS: $NODE_EXTRA_CA_CERTS"
fi

echo "Executing pnpm --filter @ems/core run test:pg..."
cd "$ROOT_DIR"
pnpm --filter @ems/core run test:pg

echo "=== PostgreSQL Acceptance Tests PASSED Successfully! ==="
