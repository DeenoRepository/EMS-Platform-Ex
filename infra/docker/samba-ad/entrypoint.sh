#!/usr/bin/env bash
set -euo pipefail

SAMBA_REALM="${SAMBA_REALM:-CORP.LOCAL}"
SAMBA_DOMAIN="${SAMBA_DOMAIN:-CORP}"
SAMBA_ADMIN_PASSWORD="${SAMBA_ADMIN_PASSWORD:-Admin_Secret_Pass123!}"

echo "=== Starting Samba Active Directory Domain Controller ==="
echo "Realm:  $SAMBA_REALM"
echo "Domain: $SAMBA_DOMAIN"

# Setup TLS directory
mkdir -p /var/lib/samba/private/tls
if [[ -f /etc/samba/certs/ldap.key && -f /etc/samba/certs/ldap.crt ]]; then
    echo "Copying mounted TLS certificates into private directory..."
    cp /etc/samba/certs/ldap.key /var/lib/samba/private/tls/ldap.key
    cp /etc/samba/certs/ldap.crt /var/lib/samba/private/tls/ldap.crt
    if [[ -f /etc/samba/certs/TestRootCA.crt ]]; then
        cp /etc/samba/certs/TestRootCA.crt /var/lib/samba/private/tls/TestRootCA.crt
        chmod 644 /var/lib/samba/private/tls/TestRootCA.crt
    fi
    chmod 600 /var/lib/samba/private/tls/ldap.key
    chmod 644 /var/lib/samba/private/tls/ldap.crt
else
    echo "WARNING: Mounted certificates not found. Generating ephemeral self-signed certificate..."
    openssl req -x509 -newkey rsa:2048 -nodes -keyout /var/lib/samba/private/tls/ldap.key \
        -out /var/lib/samba/private/tls/ldap.crt -days 365 \
        -subj "/CN=ldap.${SAMBA_REALM,,}"
    cp /var/lib/samba/private/tls/ldap.crt /var/lib/samba/private/tls/TestRootCA.crt
    chmod 600 /var/lib/samba/private/tls/ldap.key
    chmod 644 /var/lib/samba/private/tls/ldap.crt /var/lib/samba/private/tls/TestRootCA.crt
fi

configure_tls() {
    if ! grep -q "tls enabled" /etc/samba/smb.conf; then
        echo "Adding TLS settings to /etc/samba/smb.conf..."
        sed -i '/\[global\]/a \
\ttls enabled = yes\n\ttls keyfile = /var/lib/samba/private/tls/ldap.key\n\ttls certfile = /var/lib/samba/private/tls/ldap.crt\n\ttls cafile = /var/lib/samba/private/tls/TestRootCA.crt\n\tnsupdate command = /bin/true' /etc/samba/smb.conf
    fi
}

# Check if AD database already exists
if [[ ! -f /var/lib/samba/private/sam.ldb ]]; then
    echo "Database not found. Provisioning fresh AD DC domain..."
    rm -f /etc/samba/smb.conf

    samba-tool domain provision \
        --realm="$SAMBA_REALM" \
        --domain="$SAMBA_DOMAIN" \
        --server-role=dc \
        --dns-backend=SAMBA_INTERNAL \
        --adminpass="$SAMBA_ADMIN_PASSWORD" \
        --use-rfc2307

    configure_tls

    # Copy kerberos config
    if [[ -f /var/lib/samba/private/krb5.conf ]]; then
        cp /var/lib/samba/private/krb5.conf /etc/krb5.conf
    fi

    echo "Seeding synthetic test users..."
    /usr/local/bin/seed-users.sh
else
    echo "Existing AD database detected..."
    configure_tls
    /usr/local/bin/seed-users.sh || true
fi

echo "=== Launching Samba AD DC daemon ==="
exec samba -i
