#!/bin/sh
set -eu
[ "${RENEWED_LINEAGE:-}" = /etc/letsencrypt/live/iiif.mused.com ] || exit 0
/usr/sbin/nginx -t
systemctl reload nginx
