#!/bin/bash
# Supervises one dispatcher lane on the Vast GPU host and restarts it after a crash.
# Usage (as root): vast-dispatcher.sh foreground|background
lane="$1"
case "$lane" in foreground|background) ;; *) echo "lane required" >&2; exit 2 ;; esac
exec 9>"/run/fury-dispatch-$lane.lock"; flock -n 9 || exit 0
set -a; . /etc/fury/dispatcher.env; set +a
while true; do
  build=$(cat /etc/fury/dispatch-build)
  PATH=/usr/local/node/bin:/usr/local/bin:/usr/bin:/bin HOME=/root \
  PYTHONPATH=/opt/host:/opt/fury-dispatch/$build/render-server \
    /usr/local/bin/python -u /opt/host/hosted_dispatcher.py --lane "$lane" \
      --root "/opt/fury-dispatch/$build" --work "/var/lib/fury-dispatch/$lane" 9>&-
  sleep 3
done
