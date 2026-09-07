#!/usr/bin/env bash
set -euo pipefail

REALM="${SAMBA_REALM:-CORP.LOCAL}"
DOMAIN="${SAMBA_DOMAIN:-CORP}"
BASE_DN="DC=${REALM//./,DC=}"

echo "=== Seeding synthetic users into Samba AD ($REALM) ==="

create_or_update_user() {
    local username="$1"
    local password="$2"
    local given_name="$3"
    local surname="$4"
    local display_name="$5"
    local upn="${username}@${REALM,,}"

    echo "Provisioning user: $username ($upn)..."
    if samba-tool user list | grep -q -E "^${username}$"; then
        echo "  User $username already exists. Resetting password..."
        samba-tool user setpassword "$username" --newpassword="$password"
    else
        samba-tool user create "$username" "$password" \
            --userou="CN=Users" \
            --mail-address="$upn" \
            --given-name="$given_name" \
            --surname="$surname" \
            --description="$display_name"
    fi

    # Ensure password never expires for test stand
    samba-tool user setexpiry "$username" --noexpiry

    # Ensure displayName and userPrincipalName are explicitly set in LDB
    ldbmodify -H /var/lib/samba/private/sam.ldb >/dev/null 2>&1 <<EOF || true
dn: CN=${username},CN=Users,${BASE_DN}
changetype: modify
replace: displayName
displayName: ${display_name}
-
replace: userPrincipalName
userPrincipalName: ${upn}
EOF
}

# 1. Read-only service account for LDAP Bind
create_or_update_user "svc_ems_ldap" "Ldap_Service_Secret123!" "Service" "LDAP" "EMS LDAP Read-Only Service Account"

# 2. Bootstrap Administrator
create_or_update_user "bootstrap-admin" "Admin_Pass_Secret123!" "Администратор" "Платформы" "Администратор Платформы"

# 3. Regular active user
create_or_update_user "regular-user" "User_Pass_Secret123!" "Иван" "Иванов" "Иванов Иван Иванович"

# 4. Pending user (no roles yet)
create_or_update_user "pending-user" "Pending_Pass_Secret123!" "Петр" "Петров" "Петров Петр Сергеевич"

# 5. Blocked / Disabled user
create_or_update_user "blocked-user" "Blocked_Pass_Secret123!" "Сидор" "Сидоров" "Сидоров Сидор Сидорович"
echo "Disabling user: blocked-user..."
samba-tool user disable "blocked-user"

# 6. Groups
echo "Provisioning security groups..."
for grp in "EMS_Admins" "EMS_Users"; do
    if ! samba-tool group list | grep -q -E "^${grp}$"; then
        samba-tool group add "$grp" --description="Test group $grp"
    fi
done

samba-tool group addmembers "EMS_Admins" "bootstrap-admin" >/dev/null 2>&1 || true
samba-tool group addmembers "EMS_Users" "regular-user" "pending-user" >/dev/null 2>&1 || true

echo "=== Synthetic users seeded successfully ==="
