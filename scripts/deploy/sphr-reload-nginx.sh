#!/bin/sh
# Certbot deploy hook: validate and reload Nginx after certificate renewal.
set -eu
/usr/sbin/nginx -t
systemctl reload nginx
