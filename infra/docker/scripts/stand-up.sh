#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_DIR="$(dirname "$SCRIPT_DIR")"
INFRA_DIR="$(dirname "$DOCKER_DIR")"
CERTS_DIR="$INFRA_DIR/certs"

echo "=== EMS Platform: Starting Local Docker Stand ==="

# 1. Check Docker
if ! docker info >/dev/null 2>&1; then
    echo "ERROR: Docker daemon is not running or current user lacks permissions." >&2
    exit 1
fi

# 2. Check and generate certificates if missing
REQUIRED_CERTS=("TestRootCA.crt" "ldap.crt" "ldap.key" "web.crt" "web.key")
MISSING_CERTS=0
for c in "${REQUIRED_CERTS[@]}"; do
    if [[ ! -f "$CERTS_DIR/$c" ]]; then
        MISSING_CERTS=1
        break
    fi
done

if [[ $MISSING_CERTS -eq 1 ]]; then
    echo "Missing certificates detected. Generating..."
    bash "$CERTS_DIR/generate-certs.sh"
fi

# 3. Check .env file
if [[ ! -f "$DOCKER_DIR/.env" && -f "$DOCKER_DIR/.env.example" ]]; then
    echo "Creating .env from .env.example..."
    cp "$DOCKER_DIR/.env.example" "$DOCKER_DIR/.env"
fi

# 4. Start Docker Compose
echo "Starting Docker containers..."
cd "$DOCKER_DIR"
docker compose up -d --build

# 5. Wait for healthy status
TIMEOUT=90
ELAPSED=0
SERVICES=("ems-postgres" "ems-samba-ad" "ems-nginx")

echo "Waiting for services to become healthy (timeout: ${TIMEOUT}s)..."
while true; do
    if [[ $ELAPSED -ge $TIMEOUT ]]; then
        echo "ERROR: Timeout waiting for services to become healthy after ${TIMEOUT}s." >&2
        docker compose ps
        exit 1
    fi

    ALL_HEALTHY=1
    for svc in "${SERVICES[@]}"; do
        STATUS=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$svc" 2>/dev/null || echo "missing")
        if [[ "$STATUS" != "healthy" && "$STATUS" != "running" ]]; then
            ALL_HEALTHY=0
            break
        fi
    done

    if [[ $ALL_HEALTHY -eq 1 ]]; then
        break
    fi

    sleep 3
    ELAPSED=$((ELAPSED + 3))
done

echo "=== All Services Are Up and Healthy! ==="
docker compose ps

echo ""
echo "Connection details:"
echo "  - PostgreSQL: localhost:5432 (dbs: ems_dev, ems_test)"
echo "  - Samba AD LDAPS: ldaps://localhost:636 (domain: CORP.LOCAL)"
echo "  - Nginx HTTPS Ingress: https://localhost (proxies to :3000)"
echo ""
echo "To run PostgreSQL acceptance tests:"
echo "  bash $SCRIPT_DIR/run-acceptance.sh"
