#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_DIR="$(dirname "$SCRIPT_DIR")"

KEEP_VOLUMES="${1:-}"

echo "=== EMS Platform: Stopping Local Docker Stand ==="
cd "$DOCKER_DIR"

if [[ "$KEEP_VOLUMES" == "--keep-volumes" ]]; then
    echo "Preserving data volumes..."
    docker compose down
else
    echo "Removing volumes for clean state..."
    docker compose down -v
fi

echo "=== Docker Stand Successfully Stopped ==="
