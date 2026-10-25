# Touchscreen integration fixes and test results

October 24, 2026. Patched working copy: `C:\Career\Hackachusetts`.
The original Desktop repository and the supplied API key file were not edited.
This report supersedes the pre-fix findings in REVIEW.md.

## What changed

- **Touch-only operation:** production needs no physical buttons or hardware input reader. Start, Finish speaking, Pause, replay, language selection and sound controls work on screen. Added a touch keyboard for names and typed messages using Latin letters, common accents, numbers and punctuation. Fixed its focus handling so the keyboard cannot move a modal between pointer-down and pointer-up and swallow the Translate tap.
- **Session communication:** reset, person activation and mode changes now emit explicit events to browser-recording screens. These stop local microphone capture, pending HTTP calls and playback. WebSocket loss also stops the browser session; reconnection refreshes capabilities and the shared active person without automatically recording again.
- **Shared people/media:** kiosk selections update the backend's active person. Staff `/setup` activation reaches an already-open Care kiosk; rename/upload/remove notifications refresh its library. Reload restores the shared active person. Open settings drafts remain in place during ordinary library refreshes.
- **1280 x 720 layout:** combined secondary navigation with the identity row and reduced secondary spacing. The default welcome content fits without overflow. Short translations, Read again, disclosures, and the primary speaking controls fit simultaneously, including the tested large-text setting. Long captions keep their own scroll area.
- **Pi Lite deployment:** added `deploy/pi/setup-touch-kiosk.sh`, including Cage, Chromium, PipeWire/PulseAudio compatibility, WirePlumber, D-Bus user session, audio session persistence and Noto fonts. The kiosk's audio/video/render permissions and session environment are configured. The backend no longer claims to own physical input or speaker playback.
- **Boot recovery:** readiness checks have bounded curl timeouts and return failure when the backend stays unavailable, allowing systemd to retry instead of opening a permanent Chromium error page. The real readiness script was tested for success and failure under a POSIX shell.
- **Browser persistence:** the kiosk retains its local browser profile so microphone permission can survive reboot. Static modules/styles explicitly revalidate so a retained profile does not keep old application code after deployment.

## Results

| Validation | Result |
|---|---|
| Backend suite, Python 3.11 | 122 passed (including slideshow import/persistence) |
| JavaScript unit suite | 39 passed |
| JavaScript syntax | Passed, including the touch keyboard |
| Mock touch browser flow at 1280 x 720 | 14 checks passed, no browser errors |
| Real OpenAI voice/transcription/translation flow | Passed, simulated=false |
| Visible in-app browser | Real Spanish-to-English translation displayed successfully |

The touch browser suite exercised person selection, touch keyboard typing/deletion, typed translation, actual MediaRecorder multipart upload, voice playback, Pause during recording, reset during recording and playback, Pause during a delayed translation, staff person switching, rename synchronization, disconnect/reconnect, restored selection after reload, and automatic silence detection followed by voice playback and resumed listening.

Measured at 1280 x 720: welcome pane 371px content in 371px available; translated pane 298px content in 298px available. The tested default and large-text views had no horizontal or vertical document overflow. Before the fix, the welcome and short-translation views overflowed their panes.

### Live provider check

The key was read from the user-supplied local file into the backend process environment. It was never sent to the browser, printed, or saved in this repo or deployment ZIP.

1. `POST /api/speak` generated real Spanish MP3 audio from a short synthetic phrase. HTTP 200.
2. That known speech was injected as a test microphone stream in Chromium. Touch Speak and Finish produced a real MediaRecorder upload to `/api/turn`.
3. Live transcription returned **"Hola, me alegra mucho verte. ¿Cómo estás hoy?"**, detected Spanish, with `simulated=false`. HTTP 200.
4. The UI requested English translation: **"Hello, I’m so happy to see you. How are you today?"**. HTTP 200. The UI then requested real voice audio and played it through to completion.
5. Typed English **"I'm happy to see you. How are you today?"** was detected and translated to **"Me alegra verte. ¿Cómo estás hoy?"**, then read aloud. All calls returned HTTP 200.
6. Read again started another live voice request; Pause canceled preparation/playback without leaving audio running.

The visible in-app browser was also driven through Type instead -> Translate with **"Hola, me alegra verte."**. It displayed **"Hi, I’m glad to see you."**, returned to Conversation paused, and showed no audio error.

These checks establish real provider integration and button-to-HTTP behavior using synthetic speech. They do not establish microphone acoustics, speaker loudness or touch calibration on the Raspberry Pi. The saved MP3 and JSON test evidence contain only synthetic test content.

Evidence:

- [Mock browser results](C:/Career/Hackachusetts/review/fixed/results.json)
- [Live API results](C:/Career/Hackachusetts/review/live/results.json)
- [Live recorded speech screenshot](C:/Career/Hackachusetts/review/live/recorded-translation.png)
- [Visible browser screenshot](C:/Career/Hackachusetts/review/live/visible-preview.png)

## Run and deploy

The live preview for this session is [http://127.0.0.1:18765/](http://127.0.0.1:18765/). It uses the real provider. The API key remains only in that running server's environment; it is not a permanent service installation.

To restart that local review server from the workspace copy:

```powershell
.\.review-venv\Scripts\python.exe review\run-live-backend.py --key-file <path-to-your-key-file> --port 18765
```

Deploy the source checkout to `~/Hackachusetts` on **64-bit Raspberry Pi OS Lite**, then:

```sh
cd ~/Hackachusetts
sh deploy/pi/setup-touch-kiosk.sh
```

Configure `PROVIDER=openai` and `OPENAI_API_KEY` in `~/Hackachusetts/.env` with permissions 600. Select the actual audio input/output with the `pactl` commands printed by the installer and documented in README.md, then reboot. Set the panel's native mode to 1280 x 720 and display scale 1. Tap Allow for microphone access on first use.

Installer shell syntax and readiness behavior were tested here; the installer itself was not run against Windows or a Pi. A fresh ARM dependency install, systemd/Cage startup, cold boot, actual USB microphone/speaker routing, video performance and panel touch coordinates still need a physical Pi 4B check. The intended baseline is Bookworm/Python 3.11; other OS Lite releases need their own acceptance run.

Browser test scripts live in `tests/browser/`. They use an isolated mock backend for the general suite and require explicit use of a live backend for paid provider checks. `PLAYWRIGHT_MODULE`, `CHROMIUM_PATH` and `TEST_BASE_URL` can override this machine's runtime paths. Normal app runtime still needs no Node/build step.

## Bundled standby pictures

Imported all 20 pictures from the user's OneDrive `Hackathon Families` folders into the live app through its own photo upload UI. The folders had generated filenames without identifying labels; the assignment uses folder order: Family #1 -> María Elena (8), Family #2 -> James (7), Family #3 -> Amina (5).

The app-prepared JPEGs are bundled in `data/slideshows/`, with a maximum image dimension of 1600px and a combined size of 8,066,168 bytes. `manifest.json` defines the people and picture order. `companion/seed.py` imports them once into a fresh empty library, resumes an interrupted initial import, and respects later user renames/removals. Existing nonempty libraries are not modified. `COMPANION_SEED_SLIDESHOWS=0` disables initial import. Include this directory and the seed module when committing or deploying the app.

All 20 JPEGs were decoded/validated locally, all three standby screens were checked in the visible 1280 x 720 browser, and the backend tests verify fresh-install image serving and persistence across application lifespans. The OneDrive originals were left unchanged.
