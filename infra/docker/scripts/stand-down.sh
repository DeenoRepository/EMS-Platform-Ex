#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_DIR="$(dirname "$SCRIPT_DIR")"

PURGE_VOLUMES="${1:-}"

echo "=== EMS Platform: Stopping Local Docker Stand ==="
cd "$DOCKER_DIR"

if [[ "$PURGE_VOLUMES" == "--purge-volumes" || "$PURGE_VOLUMES" == "-v" ]]; then
    echo "Purging persistent data volumes (--purge-volumes specified)..."
    docker compose down -v
else
    echo "Preserving data volumes (use --purge-volumes or -v to wipe database/directory volumes)..."
    docker compose down
fi

echo "=== Docker Stand Successfully Stopped ==="
