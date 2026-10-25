#!/bin/sh
set -eu
for attempt in $(seq 1 "${COMPANION_WAIT_ATTEMPTS:-30}"); do
  if curl --connect-timeout 1 --max-time 2 -sf "${COMPANION_HEALTH_URL:-http://127.0.0.1:8000/health}" >/dev/null; then
    exit 0
  fi
  sleep 1
done
exit 1
