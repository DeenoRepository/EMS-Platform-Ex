FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    samba \
    samba-ad-provision \
    samba-dsdb-modules \
    samba-vfs-modules \
    winbind \
    krb5-user \
    libpam-winbind \
    libnss-winbind \
    ldap-utils \
    openssl \
    gettext-base \
    netcat-openbsd \
    ca-certificates \
    procps \
    && rm -rf /var/lib/apt/lists/*

COPY seed-users.sh /usr/local/bin/seed-users.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /usr/local/bin/seed-users.sh /usr/local/bin/entrypoint.sh

EXPOSE 389 636 88

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
