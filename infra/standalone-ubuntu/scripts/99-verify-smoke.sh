#!/usr/bin/env bash
# ==============================================================================
# EMS Platform: Acceptance Smoke Verification Gate (Level 2 Stand)
# ==============================================================================
set -euo pipefail

echo "=== [99] EMS Platform: Running Acceptance Smoke Verification ==="

FAILED=0

fail() {
    echo "  [FAIL] $1" >&2
    FAILED=1
}

pass() {
    echo "  [PASS] $1"
}

# 1. Air-Gap Verification
echo "1. Verifying Air-Gap Isolation..."
if ping -c 1 -W 2 8.8.8.8 >/dev/null 2>&1; then
    fail "External egress detected (ping to 8.8.8.8 succeeded)."
else
    pass "No external IP egress detected."
fi

# 2. Systemd Services Verification
echo "2. Verifying Systemd Services..."
for svc in "postgresql" "nginx" "ems-web"; do
    if systemctl is-active --quiet "$svc"; then
        pass "Service '$svc' is active."
    else
        fail "Service '$svc' is NOT active."
    fi
done

# 3. Nginx Ingress & Security Headers Verification
echo "3. Verifying Nginx Ingress and TLS..."
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1/healthz || echo "000")
if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "301" ]]; then
    pass "Port 80 responded with HTTP $HTTP_CODE."
else
    fail "Port 80 healthcheck failed (HTTP $HTTP_CODE)."
fi

HTTPS_HEADERS=$(curl -k -s -I https://127.0.0.1/healthz || true)
if echo "$HTTPS_HEADERS" | grep -iq "X-Content-Type-Options: nosniff"; then
    pass "Header X-Content-Type-Options: nosniff present."
else
    fail "Header X-Content-Type-Options: nosniff MISSING."
fi

if echo "$HTTPS_HEADERS" | grep -iq "X-Frame-Options: SAMEORIGIN"; then
    pass "Header X-Frame-Options: SAMEORIGIN present."
else
    fail "Header X-Frame-Options: SAMEORIGIN MISSING."
fi

# 4. Database Least Privilege Verification
echo "4. Verifying PostgreSQL Least Privilege (ADR-0003, NFR-007)..."
DB_CREDS="/etc/ems/db-credentials.env"
if [[ -f "$DB_CREDS" ]]; then
    source "$DB_CREDS"
    # Runtime user should be able to query
    if PGPASSWORD="$EMS_RUNTIME_PASSWORD" psql -h 127.0.0.1 -U "$EMS_RUNTIME_USER" -d "$EMS_DB_NAME" -c "SELECT 1;" >/dev/null 2>&1; then
        pass "Runtime user can connect and execute DML/SELECT."
    else
        fail "Runtime user cannot connect to database."
    fi

    # Runtime user MUST NOT be allowed to execute DDL (CREATE TABLE)
    DDL_ATTEMPT=$(PGPASSWORD="$EMS_RUNTIME_PASSWORD" psql -h 127.0.0.1 -U "$EMS_RUNTIME_USER" -d "$EMS_DB_NAME" -c "CREATE TABLE ems_core.__forbidden_table (id INT);" 2>&1 || true)
    if echo "$DDL_ATTEMPT" | grep -iq "permission denied"; then
        pass "Runtime user DDL blocked as expected: 'permission denied'."
    else
        fail "SECURITY VIOLATION: Runtime user was able to execute DDL (or unexpected error: $DDL_ATTEMPT)."
    fi
else
    fail "Database credentials file $DB_CREDS not found."
fi

# 5. LDAP / LDAPS Connectivity Verification
echo "5. Verifying Directory Service LDAPS Connectivity..."
LDAP_HOST="${LDAP_HOST:-127.0.0.1}"
LDAP_PORT="${LDAP_PORT:-636}"
if nc -z -w 3 "$LDAP_HOST" "$LDAP_PORT" 2>/dev/null; then
    pass "Directory service port $LDAP_PORT is open on $LDAP_HOST."
else
    echo "  [INFO] Directory service not detected on $LDAP_HOST:$LDAP_PORT (skip if AD is on a separate host)."
fi

echo ""
if [[ $FAILED -eq 0 ]]; then
    echo "=== [99] PASS: All acceptance smoke checks succeeded! ==="
    exit 0
else
    echo "=== [99] FAIL: One or more smoke checks failed! ===" >&2
    exit 1
fi
