#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== EMS Platform: Generation of Test CA and Certificates ==="

OPENSSL_BIN="${OPENSSL_BIN:-openssl}"
if ! command -v "$OPENSSL_BIN" &>/dev/null; then
    echo "ERROR: OpenSSL binary '$OPENSSL_BIN' not found in PATH." >&2
    exit 1
fi

DAYS_CA=3650
DAYS_CERT=1095
CONFIG_FILE="openssl.cnf"

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "ERROR: Configuration file $CONFIG_FILE not found in $SCRIPT_DIR." >&2
    exit 1
fi

# 1. Root CA
echo "1. Generating Test Root CA (valid for $DAYS_CA days)..."
"$OPENSSL_BIN" req -x509 -new -nodes -sha256 \
    -newkey rsa:4096 \
    -keyout TestRootCA.key \
    -out TestRootCA.crt \
    -days "$DAYS_CA" \
    -config "$CONFIG_FILE" \
    -extensions v3_ca \
    -subj "/C=RU/ST=Moscow/L=Moscow/O=EMS Platform/OU=Security/CN=EMS Test Root CA"

# 2. LDAP Certificate
echo "2. Generating LDAP Server certificate (valid for $DAYS_CERT days)..."
"$OPENSSL_BIN" req -new -nodes -sha256 \
    -newkey rsa:2048 \
    -keyout ldap.key \
    -out ldap.csr \
    -subj "/C=RU/ST=Moscow/L=Moscow/O=EMS Platform/OU=Directory/CN=ldap.corp.local"

"$OPENSSL_BIN" x509 -req -sha256 \
    -in ldap.csr \
    -CA TestRootCA.crt \
    -CAkey TestRootCA.key \
    -CAcreateserial \
    -out ldap.crt \
    -days "$DAYS_CERT" \
    -extfile "$CONFIG_FILE" \
    -extensions ldap_ext

# 3. Web / Ingress Certificate
echo "3. Generating Web Server certificate (valid for $DAYS_CERT days)..."
"$OPENSSL_BIN" req -new -nodes -sha256 \
    -newkey rsa:2048 \
    -keyout web.key \
    -out web.csr \
    -subj "/C=RU/ST=Moscow/L=Moscow/O=EMS Platform/OU=Web/CN=ems.local"

"$OPENSSL_BIN" x509 -req -sha256 \
    -in web.csr \
    -CA TestRootCA.crt \
    -CAkey TestRootCA.key \
    -CAcreateserial \
    -out web.crt \
    -days "$DAYS_CERT" \
    -extfile "$CONFIG_FILE" \
    -extensions web_ext

# Clean up CSR and serial files
rm -f ldap.csr web.csr TestRootCA.srl

# Set permissions
chmod 600 TestRootCA.key ldap.key web.key || true
chmod 644 TestRootCA.crt ldap.crt web.crt || true

echo "=== Certificate Generation Complete ==="
echo "Artifacts generated in: $SCRIPT_DIR"
echo "  - TestRootCA.crt, TestRootCA.key (Root CA)"
echo "  - ldap.crt, ldap.key             (Samba 4 / AD LDAPS)"
echo "  - web.crt, web.key               (Nginx HTTPS Ingress)"
echo ""
echo "To use in Node.js applications with LDAPS:"
echo "  export NODE_EXTRA_CA_CERTS=\"$SCRIPT_DIR/TestRootCA.crt\""
