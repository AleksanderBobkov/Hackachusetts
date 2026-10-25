#!/bin/sh
# Run from the checkout as the normal Pi user: sh deploy/pi/setup-touch-kiosk.sh
set -eu
if [ "$(id -u)" -eq 0 ]; then
  echo 'Run this as your normal kiosk user, without sudo (the script uses sudo where needed).' >&2
  exit 1
fi
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
if [ "$ROOT" != "$HOME/Hackachusetts" ]; then
  echo 'Place this checkout at ~/Hackachusetts; the service units use that path.' >&2
  exit 1
fi
if [ "$(getconf LONG_BIT)" != 64 ]; then
  echo 'This app requires 64-bit Raspberry Pi OS Lite.' >&2
  exit 1
fi
sudo apt-get update
sudo apt-get install -y cage curl python3-venv python3-pip dbus-user-session \
  pipewire pipewire-pulse pipewire-audio pipewire-alsa wireplumber pulseaudio-utils \
  fonts-dejavu-core fonts-noto-core fonts-noto-cjk
if apt-cache show chromium >/dev/null 2>&1; then
  sudo apt-get install -y chromium
else
  sudo apt-get install -y chromium-browser
fi
python3 -m venv "$ROOT/.venv"
"$ROOT/.venv/bin/python" -m pip install -e "$ROOT[openai]"

# Keep the audio user session available during the system-level cage service and after boot.
sudo loginctl enable-linger "$(id -un)"
sudo systemctl start "user@$(id -u).service"
RUNTIME_DIR="/run/user/$(id -u)"
env XDG_RUNTIME_DIR="$RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="unix:path=$RUNTIME_DIR/bus" \
  systemctl --user enable --now pipewire.socket pipewire-pulse.socket wireplumber.service
sudo cp "$ROOT/deploy/pi/companion-backend@.service" "$ROOT/deploy/pi/companion-kiosk@.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl disable getty@tty1.service
sudo systemctl set-default graphical.target
sudo systemctl enable "companion-backend@$(id -un)" "companion-kiosk@$(id -un)"
echo 'Touch kiosk installed. Set PROVIDER and OPENAI_API_KEY in ~/Hackachusetts/.env for live speech.'
echo 'Use pactl list short sources / pactl list short sinks to inspect audio devices.'
echo 'Set defaults with pactl set-default-source NAME / pactl set-default-sink NAME, then reboot.'
