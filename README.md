# Hackachusetts — tabletop AI companion

Backend and screen UI for a tabletop companion for older adults in care facilities: Translate, Companion and
Contribute modes on one turn engine. Design: [`docs/architecture.md`](docs/architecture.md) ·
build plan: [`docs/plan.md`](docs/plan.md). The UI connects via the contract in architecture §6.

## Run

```bash
python3.11 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
uvicorn companion.api.app:app --port 8000      # PROVIDER=mock (default) | openai | aws
pytest
```

### Raspberry Pi 4B (target host)

Target is **Raspberry Pi OS Lite 64-bit** (Bookworm, headless). It ships Python 3.11, and every
dependency has a prebuilt aarch64 wheel. 32-bit armv7 has no PyPI wheels and is not supported.
There's no desktop, so buttons and keys are read through `/dev/input` (evdev, Phase 1). The
screen UI needs its own kiosk setup.

```bash
sudo apt install -y git python3-venv python3-pip   # + libportaudio2 once audio lands (Phase 1)
python3 -m venv .venv && . .venv/bin/activate
pip install -e .                          # optional: pip install -e ".[speed]"
uvicorn companion.api.app:app --host 0.0.0.0 --port 8000
```

Speech, translation and LLM run on hosted providers; no local models on the Pi.

#### Kiosk screen (no desktop)

The UI is plain HTML/CSS/JS served by the backend, so there's no Node or build step. On the Pi,
[cage](https://github.com/cage-kiosk/cage) (a single-app Wayland compositor) runs Chromium full
screen on tty1. The units assume the checkout is at `/home/<user>/Hackachusetts`.

```bash
sudo apt install -y cage chromium-browser curl fonts-dejavu-core   # newer images: chromium
sudo cp deploy/pi/companion-backend@.service deploy/pi/companion-kiosk@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl disable getty@tty1          # cage takes over tty1
sudo systemctl set-default graphical.target
sudo systemctl enable --now companion-backend@$USER companion-kiosk@$USER
```

Logs: `journalctl -u companion-kiosk@$USER -u companion-backend@$USER -f`. With `cage -s`,
Ctrl+Alt+F2 switches to a text console.

The backend binds `127.0.0.1` only. To open the setup screen from a laptop, tunnel it:

```bash
ssh -L 8000:localhost:8000 <user>@<pi-host>    # then browse http://localhost:8000/setup
```

The setup API has no sign-in. Switching the unit to `--host 0.0.0.0` lets anyone on that network
add, change or remove people and photos, so only do it on a network you trust.

## Screens

- `/` — resident companion screen (kiosk). Photo slideshow, status, captions, TALK/MUTE.
  - `/?mock=1` plays the scripted demo (labelled "Demo replay. Not a live conversation.").
    `&speed=2` plays it faster.
  - `/?keys=1` enables the laptop dev keys below in the browser. Off by default, because on the
    Pi the backend reads the keys itself and the browser would fire them twice.
- `/setup` — family/staff setup: add a person (name + photos only), choose the mode, start the
  companion. Photos are resized in the browser (max 1920 px) before upload.

Runtime data (people, photos) lives in `data/runtime/` (`COMPANION_DATA_DIR` to move it). It's
plain JSON plus image files, written with fsync + atomic rename.

Fonts: `design/tokens.css` imports DM Sans from Google Fonts, which fails offline, and Georgia
isn't installed on Linux. The UI falls back to system fonts until DM Sans is vendored locally
and a Georgia substitute is installed on the Pi.

### Known gaps

- Unmute: the backend has no unmute command, so the screen's Mute button (when muted) calls
  `POST /session/reset`, which also clears the session history.
- TALK while speaking sends `start_turn` (backend barge-in). The design table says it should stop
  playback and return to Ready.
- The screen ignores TALK while muted, but a hardware TALK press still starts listening in the
  backend.
- Family story mode shows the proposed claims as read-only ("Not saved to the family notes yet").
  There are no approve/edit buttons, because the design system rules out memory editors. The
  review step from the plan still needs a home.

## For the UI builder

- `ws://localhost:8000/ws?mock=1` — scripted demo stream of every event type (translate both
  ways, companion answer + MUTE, unknown fact, STT error, contribute review card), then closes.
  Options: `&loop=1` repeat forever, `&speed=2` play 2× faster (`speed=0` = no delays).
  Commands sent on the mock socket are ignored.
- `ws://localhost:8000/ws` — live orchestrator. Send commands such as
  `{"cmd":"start_turn","speaker":"a"}`, `{"cmd":"end_turn"}`, `{"cmd":"stop_all"}`.
  On connect the server sends the current `state` event.
- REST: `GET /health`, `GET /config`, `POST /session/reset`.
- People and photos: `GET /profiles`, `GET /profiles/active`, `POST /profiles`,
  `PUT /profiles/{id}`, `POST /profiles/{id}/activate` (`{"mode": ...}`),
  `POST /profiles/{id}/photos?filename=...` (raw image bytes as the body, not multipart; JPEG,
  PNG or WebP, detected from the bytes), `DELETE /profiles/{id}/photos/{photo_id}`,
  `GET /photos/{filename}`. Create and upload accept an `Idempotency-Key` header so retries
  don't make duplicates.

Dev keys standing in for buttons: `1` TALK A · `2` TALK B · `space` TALK resident/contributor ·
`m` STOP_ALL · `+`/`-` volume. Press TALK again to finish the turn.
