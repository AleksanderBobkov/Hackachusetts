# Hear & Read

The device records locally and, after the user taps Stop, sends the WAV to the
server-side OpenAI workflow for transcription and translation:

1. Tap **Tap to speak**.
2. Audio records from the RØDE USB mic (`CARD=II`).
3. Tap **Tap to stop**.
4. The screen shows the real transcript and Spanish translation.

The recorded WAV stays in `recordings/` until **Clear screen** is tapped. Audio
is uploaded only after the user taps Stop.

## Run on the Pi

Copy this `elder-interface` folder to `/home/rishi/elder-interface`, then run:

```bash
cd ~/elder-interface
./setup-kiosk.sh
```

Open Chromium at `http://127.0.0.1:8000`.

## Run without a Pi keyboard or mouse

From a **Windows PowerShell** window (not from the Pi SSH shell), copy the
project to the Pi:

```powershell
scp -r "C:\Rishi\Hackathon\elder-interface" rishi@192.168.1.104:/home/rishi/
```

Then SSH into the Pi and enable the local service and Chromium kiosk:

```bash
cd ~/elder-interface
chmod +x setup-kiosk.sh
./setup-kiosk.sh
sudo reboot
```

After every boot, the Python service starts and Chromium opens the interface
full-screen automatically. To recover from the kiosk remotely, use
`pkill chromium` over SSH; to change the kiosk command, edit
`~/.config/labwc/autostart` over SSH.

The selected input is the RØDE VideoMic GO II. To temporarily use the P10S microphone instead:

```bash
AUDIO_INPUT_DEVICE='plughw:CARD=P10S,DEV=0' python3 app.py
```

The browser never gets an API key and never talks directly to the audio hardware.
The local Python service does both, using the official OpenAI Python SDK from
`.venv/`. Keep `OPENAI_API_KEY=...` in `/etc/elder-interface.env`.
