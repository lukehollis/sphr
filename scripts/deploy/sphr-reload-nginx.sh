#!/bin/sh
# Certbot deploy hook: reload only for this application's renewed certificate.
set -eu
[ "${RENEWED_LINEAGE:-}" = /etc/letsencrypt/live/app.mused.com ] || exit 0
/usr/sbin/nginx -t
systemctl reload nginx
