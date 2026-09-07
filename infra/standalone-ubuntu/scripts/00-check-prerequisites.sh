#!/usr/bin/env bash
# ==============================================================================
# EMS Platform: Standalone Host Prerequisites & Isolation Verification
# Target: Ubuntu Server 24.04 LTS (Air-Gapped Environment)
# ==============================================================================
set -euo pipefail

echo "=== [00] EMS Platform: Checking Host Prerequisites ==="

# 1. Root privileges check
if [[ $EUID -ne 0 ]]; then
    echo "ERROR: This script must be run as root (or via sudo)." >&2
    exit 1
fi

# 2. Operating system verification
if [[ ! -f /etc/os-release ]]; then
    echo "ERROR: /etc/os-release not found. Unknown OS." >&2
    exit 1
fi

source /etc/os-release
if [[ "$ID" != "ubuntu" || "${VERSION_ID:-}" != "24.04" ]]; then
    echo "ERROR: Target OS must be Ubuntu 24.04 LTS (Detected: ${NAME:-Unknown} ${VERSION_ID:-})." >&2
    exit 1
fi
echo "[OK] OS: Ubuntu 24.04 LTS verified."

# 3. Air-Gapped Network Isolation (Strict Egress Check)
echo "Checking network isolation (Air-Gapped guardrail)..."
EXTERNAL_EGRESS=0
if ping -c 1 -W 2 8.8.8.8 >/dev/null 2>&1; then
    EXTERNAL_EGRESS=1
fi
if nc -z -w 2 1.1.1.1 53 >/dev/null 2>&1; then
    EXTERNAL_EGRESS=1
fi

if [[ $EXTERNAL_EGRESS -eq 1 ]]; then
    echo "SECURITY ERROR: External Internet egress detected!" >&2
    echo "EMS Platform acceptance stand MUST be isolated without direct Internet access (AGENTS.md, NFR-006)." >&2
    echo "Please disable external gateway / routing before proceeding with acceptance testing." >&2
    exit 1
else
    echo "[OK] Air-gap verified: no external internet egress detected."
fi

# 4. Check required services and utilities
check_binary() {
    local bin="$1"
    local desc="$2"
    if ! command -v "$bin" &>/dev/null; then
        echo "ERROR: Required component '$desc' ($bin) is not installed." >&2
        exit 1
    fi
    echo "[OK] Found: $desc ($bin)"
}

check_binary "systemctl" "Systemd init system"
check_binary "psql" "PostgreSQL client"
check_binary "nginx" "Nginx web server"
check_binary "node" "Node.js runtime"
check_binary "openssl" "OpenSSL CLI"
check_binary "tar" "Archive utility"

# 5. Check Node.js version (must be >= 20)
NODE_MAJOR=$(node -v | cut -d'.' -f1 | tr -d 'v')
if [[ "$NODE_MAJOR" -lt 20 ]]; then
    echo "ERROR: Node.js version must be >= 20 LTS (Detected: $(node -v))." >&2
    exit 1
fi
echo "[OK] Node.js version $(node -v) meets requirement (>= 20 LTS)."

# 6. Check PostgreSQL version (must be 16)
PG_VER=$(psql --version | awk '{print $3}' | cut -d'.' -f1)
if [[ "$PG_VER" -ne 16 ]]; then
    echo "WARNING: Expected PostgreSQL version 16 (Detected: $(psql --version))."
else
    echo "[OK] PostgreSQL version 16 verified."
fi

echo "=== [00] All Prerequisites & Isolation Checks PASSED ==="
