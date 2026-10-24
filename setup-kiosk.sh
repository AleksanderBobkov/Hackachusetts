#!/usr/bin/env bash
# Run once on the Raspberry Pi as user "rishi" after copying this folder there.
set -euo pipefail

APP_DIR="$HOME/elder-interface"
AUTOSTART="$HOME/.config/labwc/autostart"
KIOSK_LINE='sleep 8 && chromium http://127.0.0.1:8000 --kiosk --noerrdialogs --disable-infobars --no-first-run --start-maximized --ozone-platform=wayland --password-store=basic --incognito &'

if [[ ! -f "$APP_DIR/app.py" ]]; then
  echo "Expected $APP_DIR/app.py. Copy the project to the Pi first."
  exit 1
fi

if ! python3 -m venv --help >/dev/null 2>&1; then
  sudo apt update
  sudo apt install -y python3-venv
fi
if [[ ! -x "$APP_DIR/.venv/bin/python" ]]; then
  python3 -m venv "$APP_DIR/.venv"
fi
"$APP_DIR/.venv/bin/python" -m pip install --upgrade pip openai

mkdir -p "$(dirname "$AUTOSTART")"
touch "$AUTOSTART"
if ! grep -Fqx "$KIOSK_LINE" "$AUTOSTART"; then
  printf '\n# Hear & Read touchscreen kiosk\n%s\n' "$KIOSK_LINE" >> "$AUTOSTART"
fi

sudo tee /etc/systemd/system/elder-interface.service >/dev/null <<EOF
[Unit]
Description=Hear and Read local audio interface
After=sound.target network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/elder-interface.env
Environment=AUDIO_INPUT_DEVICE=plughw:CARD=II,DEV=0
ExecStart=$APP_DIR/.venv/bin/python $APP_DIR/app.py
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable elder-interface.service
sudo systemctl restart elder-interface.service
echo "Kiosk setup is complete. Reboot with: sudo reboot"
