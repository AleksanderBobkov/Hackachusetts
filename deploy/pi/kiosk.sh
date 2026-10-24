#!/bin/sh
# Launch Chromium full screen inside cage. Run by companion-kiosk@.service on tty1.
# Raspberry Pi OS Bookworm ships the browser as `chromium-browser`; newer images use `chromium`.
set -eu

URL="${COMPANION_URL:-http://127.0.0.1:8000/}"
BROWSER="$(command -v chromium-browser || command -v chromium)"

# Fresh, throwaway profile each boot: no restore-session bubbles, no stale cache.
PROFILE_DIR="${XDG_RUNTIME_DIR:-/tmp}/companion-chromium"
rm -rf "$PROFILE_DIR"

# -d: no client-side window decorations. -s: allow VT switching (Ctrl+Alt+F2 for a shell).
exec /usr/bin/cage -d -s -- "$BROWSER" \
  --kiosk "$URL" \
  --user-data-dir="$PROFILE_DIR" \
  --ozone-platform=wayland \
  --noerrdialogs \
  --no-first-run \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-translate \
  --disable-features=Translate,TranslateUI,MediaRouter \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --check-for-update-interval=31536000 \
  --password-store=basic
