# Hackachusetts — tabletop AI companion

Backend and screen UI for a tabletop companion for older adults in care facilities: Translate, Companion and
Contribute modes on one turn engine. Design: [`docs/architecture.md`](docs/architecture.md) ·
build plan: [`docs/plan.md`](docs/plan.md). The UI connects via the contract in architecture §6.

The main screen is **Companion / Care** (`care/`): people, their photos and short videos, a
slideshow, and two-way spoken translation. It records in the browser and uses the backend for
storage, transcription, language detection, translation, the AI voice and shared session updates.

**Status (October 24, 2026):** reviewed and fixed for touch-only use on a 1280 × 720 Raspberry Pi
touchscreen. The changes and test results are in [`review/FIXES.md`](review/FIXES.md). Testing on
physical Pi hardware (microphone, speaker, touch calibration, cold boot) is still outstanding.

| Path | Contents |
|---|---|
| `companion/` | FastAPI backend: turn engine, speech adapter, people/photo store, providers |
| `care/` | Companion / Care kiosk screen (plain HTML/CSS/JS, bundled DM Sans font and license) |
| `ui/`, `design/` | Earlier `/setup` and `/classic` screens, design tokens |
| `data/slideshows/` | 20 bundled standby photos, imported once into a new, empty library |
| `deploy/pi/` | Raspberry Pi OS Lite installer, systemd units, kiosk and readiness scripts |
| `tests/` | Backend (pytest), screen unit (`node --test`) and 1280 × 720 browser checks |
| `app.py`, `web/`, `requirements.txt`, `setup-kiosk.sh` | Standalone Hear & Read prototype (last section) |

## Run

```bash
python3.11 -m venv .venv && . .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[dev,openai]"
uvicorn companion.api.app:app --port 8000          # PROVIDER=mock (default) | openai
```

Then open `http://localhost:8000/`. `PROVIDER=aws` is reserved and reports itself unavailable.

`PROVIDER=mock` is offline and deterministic: it plays a scripted conversation (Spanish,
English, Polish, then a one-word reply) and the screen labels every result **Simulated**. For
real speech, set `PROVIDER=openai` and `OPENAI_API_KEY` in the environment (on the Pi, in
`.env`, which the service unit loads and git ignores). Model overrides: `TRANSCRIBE_MODEL`
(default `gpt-transcribe`), `TRANSLATION_MODEL` (`gpt-6-luna`), `TTS_MODEL` (`gpt-4o-mini-tts`),
`TTS_VOICE` (`marin`), `PROVIDER_TIMEOUT_S` (25). The key never reaches the browser.

### Raspberry Pi 4B (target host)

Target is **Raspberry Pi OS Lite 64-bit** (Bookworm, headless). It ships Python 3.11, and every
dependency has a prebuilt aarch64 wheel. 32-bit armv7 has no PyPI wheels and is not supported.
The production device uses **only the touchscreen**: Start, Finish speaking, Pause, replay,
languages and volume are on screen. No GPIO, evdev reader or physical buttons are needed.
The Care screen includes a touch keyboard for names and typed messages (Latin letters,
common accented letters, numbers and punctuation).

```bash
sudo apt install -y git python3-venv python3-pip
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[openai]"                # optional: pip install -e ".[openai,speed]"
nano .env && chmod 600 .env               # PROVIDER=openai and OPENAI_API_KEY=<key>, one per line
set -a
. ./.env                                  # foreground run only; systemd loads this itself
set +a
uvicorn companion.api.app:app --host 127.0.0.1 --port 8000
```

Speech, translation and LLM run on hosted providers; no local models on the Pi.

#### Kiosk screen (no desktop)

The UI is plain HTML/CSS/JS served by the backend, so there's no Node or build step. On the Pi,
[cage](https://github.com/cage-kiosk/cage) (a single-app Wayland compositor) runs Chromium full
screen on tty1. The units assume the checkout is at `/home/<user>/Hackachusetts`.

```bash
sudo apt install -y git
git clone https://github.com/AleksanderBobkov/Hackachusetts.git ~/Hackachusetts
cd ~/Hackachusetts
sh deploy/pi/setup-touch-kiosk.sh
# Configure .env as above, then select the actual USB microphone and speaker output:
pactl list short sources
pactl list short sinks
pactl set-default-source <source-name>
pactl set-default-sink <sink-name>
sudo reboot
```

The installer adds PipeWire/PulseAudio compatibility, WirePlumber, the user D-Bus session,
and Noto fonts for the supported output languages. It enables the audio user session at boot.
These are needed on OS Lite because recording and playback happen in Chromium, not Python.
The kiosk waits for a healthy backend and retries if it is not ready; it does not open a
connection-error page after the wait expires. The default UI is tested at **1280 × 720,
landscape, display scale 1**. Confirm that native mode in the panel's display settings.

Logs: `journalctl -u companion-kiosk@$USER -u companion-backend@$USER -f`. With `cage -s`,
Ctrl+Alt+F2 switches to a text console.

The backend binds `127.0.0.1` only. To open the setup screen from a laptop, tunnel it:

```bash
ssh -L 8000:localhost:8000 <user>@<pi-host>    # then browse http://localhost:8000/
```

The API has no sign-in. Switching the unit to `--host 0.0.0.0` lets anyone on that network
add, change or remove people and photos, press the controls and run paid speech requests, so
only do it on a network you trust. Writes and the event socket do reject requests that come from
other websites (an `Origin` that isn't this server), so a page open in a browser can't drive it.

The kiosk keeps its Chromium profile under `~/.local/state/companion-chromium`, so a microphone
grant can survive reboot. Tap Allow on first use. People and photos live in the backend.
Connection loss, a backend reset, or a shared person change stops recording and playback.
Reconnection refreshes the shared person/library and speech capabilities without restarting
the microphone. Staff changes from `/setup` now reach the already-open kiosk.

## Test

```bash
pytest            # backend suite; Pi script tests need a POSIX sh (Git Bash on Windows) or skip
npm test          # screen unit tests: Node 21+ (test-runner globs), no packages
npm run check     # syntax check of every care/ module
```

The browser check drives the real kiosk in headless Chrome at 1280 × 720 with touch input.
Playwright is test tooling, not an app dependency, so install it outside the checkout:

```bash
npm install --prefix "$HOME/hk-test-tools" playwright@1.62.1
COMPANION_DATA_DIR="$(mktemp -d)" PROVIDER=mock uvicorn companion.api.app:app --port 8765 &
PLAYWRIGHT_MODULE="$HOME/hk-test-tools/node_modules/playwright" CHROMIUM_PATH=/usr/bin/chromium \
  node tests/browser/touch-flow.cjs
```

`PLAYWRIGHT_MODULE` must be an absolute path. `CHROMIUM_PATH` defaults to the standard Windows
Chrome location and `TEST_BASE_URL` to `http://127.0.0.1:8765`. The script needs a `PROVIDER=mock`
backend and writes screenshots and `results.json` to `review/fixed/`, which git ignores.
`tests/browser/live-speech.cjs` is the opt-in paid check against a `PROVIDER=openai` backend
(default port 18765). The key stays in the backend.

## Screens

- `/` — **Companion / Care** (kiosk): people → photo/video slideshow → conversation. Listening
  languages per person, automatic language detection, a "Who should hear this?" question when
  the language is unclear, original + translated captions, the translation read aloud by the
  device's AI voice (browser voices are the fallback), typed input, labeled examples.
  - `/?keys=1` — laptop dev keys, sent through the same path as hardware buttons:
    `1` TALK (resident) · `2` TALK (visitor) · `space` TALK · `m` STOP_ALL · `+`/`-` volume.
    TALK on the slideshow opens the conversation; TALK while listening finishes the turn; TALK
    while the voice plays stops it. Development only; off by default on the touch kiosk.
- `/setup` — earlier family/staff setup page (name + photos only, choose the mode, start the
  companion). It works on the same people and photos; it doesn't show videos.
- `/classic` — earlier resident screen that renders the §6 event stream. `/classic?mock=1`
  plays the scripted demo of every mode (labelled "Demo replay. Not a live conversation.").

Runtime data (people, photos, videos) lives in `data/runtime/` (`COMPANION_DATA_DIR` to move it).
It's plain JSON plus media files, written with fsync + atomic rename. Photos are stored as the
screen's display copy (longest side 1600 px); videos as chosen (MP4/WebM, 60 s, 50 MB).
The source bundle includes 20 standby photos in `data/slideshows/`: Family #1 is assigned to
María Elena (8), Family #2 to James (7), and Family #3 to Amina (5), by folder order. A new,
empty backend library imports these once as example profiles. Existing libraries and later
photo removals/renames are preserved. `COMPANION_SEED_SLIDESHOWS=0` disables initial import.
Recordings and transcripts are never written to disk: each recording is held in memory for one
request and sent to the provider only after the person finishes speaking.

Fonts: the Companion / Care screen bundles DM Sans (`care/assets`, OFL). `design/tokens.css`
(earlier screens) imports DM Sans from Google Fonts, which fails offline. Georgia isn't
installed on Linux, so headings use the serif fallback until a licensed substitute is installed.

### Known gaps

- Not yet tested on a physical Raspberry Pi 4B: USB microphone capture, speaker output and
  loudness, touchscreen calibration and touch coordinates, cold boot through systemd and cage,
  video playback performance, and a fresh aarch64 dependency install. The installer's shell
  syntax and the readiness script are tested on a PC only.
- The OpenAI path has fake-SDK unit coverage and an opt-in browser integration test at
  `tests/browser/live-speech.cjs`. See `review/FIXES.md` for this review's actual live results.
- Language routing uses an explicit rule, not a confidence score: the provider must report one
  reliable language and the words must have some substance (2+ words and 6+ letters, or 2+ CJK
  characters). One-word replies always ask "Who should hear this?". Tune it on real speech.
- `/controls` and `?keys=1` remain available for development; neither is needed for the
  production touchscreen. There is no deployed GPIO/USB button bridge.
- The turn engine's own pipelines (server-side microphone, Companion answers from family
  memory, Contribute proposals) are still Phase 1–3 work. The Companion / Care screen covers
  translation; `/classic` shows the other modes from the mock stream.
- On `/classic`: Unmute calls `POST /session/reset` (no unmute command), TALK while speaking is
  barge-in rather than stop, and family-story claims are read-only.

## For the UI builder

- `ws://localhost:8000/ws?mock=1` — scripted demo stream of every event type (translate both
  ways, companion answer + MUTE, unknown fact, STT error, contribute review card), then closes.
  Options: `&loop=1` repeat forever, `&speed=2` play 2× faster (`speed=0` = no delays).
  Commands sent on the mock socket are ignored.
- `ws://localhost:8000/ws` — live orchestrator. Send commands such as
  `{"cmd":"start_turn","speaker":"a"}`, `{"cmd":"end_turn"}`, `{"cmd":"stop_all"}`.
  On connect the server sends the current `state` event.
  A STOP_ALL from any screen is also relayed to every screen as a `control` event.
- REST: `GET /health`, `GET /config`, `POST /session/reset`.
- People and photos: `GET /profiles`, `GET /profiles/active`, `POST /profiles`
  (`{"display_name", "example"?}`), `PUT /profiles/{id}`, `POST /profiles/{id}/activate`
  (`{"mode": ...}`), `POST /profiles/{id}/photos?filename=...` (raw bytes as the body, not
  multipart; JPEG, PNG, WebP, MP4 or WebM, detected from the bytes; 50 items per person),
  `DELETE /profiles/{id}/photos/{photo_id}`, `GET /photos/{filename}` (supports `Range` for
  video). Each profile lists `photos` (images only, for photo-only screens) and `media` (photos
  and videos with `type` and `bytes`). Create and upload accept an `Idempotency-Key` header so
  retries don't make duplicates.
- Speech for screens that record in the browser (architecture §6 "Speech adapter"):
  `GET /api/capabilities`, `POST /api/turn` (multipart `metadata` + `audio` or `text`; stages
  `detect` and `translate`), `POST /api/speak` (`{"text", "language"}` → audio). STOP_ALL,
  `POST /session/reset` and a person/mode switch cancel requests in flight; a closed browser
  request cancels its own provider call.
- Physical controls: `POST /controls` with `{"key": "1"|"2"|"space"|"m"|"+"|"-"}` (debounced by
  `KeyMapper`) or `{"action": "WAKE"|"START_TURN"|"END_TURN"|"STOP_ALL"|"SET_VOLUME",
  "speaker"?, "value"?}`. Every press is relayed on `/ws` as
  `{"type":"control","action","speaker","value"}`; STOP_ALL also mutes the backend.

Dev keys standing in for buttons: `1` TALK A · `2` TALK B · `space` TALK resident/contributor ·
`m` STOP_ALL · `+`/`-` volume. Press TALK again to finish the turn.

## Hear & Read prototype

A standalone record-then-translate prototype, separate from the `companion` backend. Its files
live at the repo root: `app.py`, `web/`, `requirements.txt` and `setup-kiosk.sh`. It also
defaults to port 8000 (`INTERFACE_PORT` changes it), so don't run it alongside the companion
backend on the same port. Its OpenAI workflow (transcription, translation with a Latin-alphabet
pronunciation for Arabic, Hindi, Korean, Vietnamese and Chinese, and the warm AI voice) is also
built into the companion backend as `PROVIDER=openai`, which the Companion / Care screen uses.

The device records locally and, after the user taps Stop, sends the WAV to the
server-side OpenAI workflow for transcription and translation:

1. Tap **Tap to speak**.
2. Audio records from the RØDE USB mic (`CARD=II`).
3. Tap **Tap to stop**.
4. The screen shows the real transcript and Spanish translation.

The recorded WAV stays in `recordings/` until **Clear screen** is tapped. Audio
is uploaded only after the user taps Stop.

### Run on the Pi

Copy the prototype files into `/home/rishi/elder-interface` (`setup-kiosk.sh` expects
`~/elder-interface/app.py`), then run:

```bash
cd ~/elder-interface
./setup-kiosk.sh
```

Open Chromium at `http://127.0.0.1:8000`.

### Run without a Pi keyboard or mouse

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
