# Architecture — AI Companion for Elderly Care

Status: **proposed** (v0.1, Oct 24 2026). The UI is built separately and connects through the
API contract in §6. Everything here is backend. The Companion / Care screen (`care/`) is served
by the backend and uses §6's speech adapter, controls relay and media store.

## 1. What the device does

One tabletop device, a touchscreen, a mic and a speaker. Three modes share the
same control layer and turn engine:

| Mode | Who talks | What happens on END_TURN | Uses memory? |
|---|---|---|---|
| **Companion** | Resident ↔ AI | STT → approved memory lookup → short grounded answer → captions + TTS | Reads approved memory only |
| **Translate** *(new scope)* | Resident ↔ visitor (e.g. grandmother ↔ grandchild) | STT in speaker's language → translate → original + translation on screen → TTS in listener's language | No (ephemeral by default) |
| **Contribute** | Authorized family member | STT → memory *proposal* with evidence → human review → approved memory | Writes proposals, never approved memory directly |

Non-goals (unchanged from the report): always-on listening, clinical/medication advice,
voice cloning/impersonation, multi-household, vector search.

## 2. Two loops, two stores

```
CONVERSATION LOOP (interactive, low latency)
  controls → capture → STT → [translate | context lookup → LLM] → captions → TTS → playback
                                   reads ▲
KNOWLEDGE LOOP (async, reviewed)       │ approved only
  contribution → evidence record → proposal agent → validation → human review → approved memory
```

- The conversation loop **never waits** on the knowledge loop and never writes approved memory.
- Session context (last few turns) is in-memory, per turn chain, and is discarded on reset/mode change.
  It never silently becomes long-term memory.

## 3. Components (Python package `companion/`)

| Module | Responsibility | Notes |
|---|---|---|
| `controls/` | Map hardware (USB HID keys / GPIO) to events: `START_TURN(speaker)`, `END_TURN`, `STOP_ALL`, `SET_VOLUME`, `SET_MODE`. Debounce. | Hardware-agnostic: a keyboard key works in dev. |
| `orchestrator/` | **Turn state machine** + cancellation. Owns `turn_id`. States: `idle, listening, transcribing, thinking, translating, speaking, muted, error`. | `STOP_ALL` always wins; any result whose `turn_id` ≠ current is dropped. |
| `audio/` | Mic capture (bounded buffer per turn, max duration timeout), playback queue that can be flushed instantly. | 16 kHz mono WAV in; no raw audio persisted by default. |
| `speech/stt.py` | `transcribe(audio, language_hint) -> Transcript{text, language, segments?, confidence?}` | Adapter. Candidates: hosted Whisper/gpt-4o-transcribe, AWS Transcribe, local Handy/whisper.cpp. Benchmark on real host. |
| `speech/tts.py` | `synthesize(text, language, voice) -> audio` | Adapter. Candidates: AWS Polly, OpenAI TTS, other. Must support every language in the pair. Disclosed AI voice only. |
| `translate/` | `translate(text, source, target) -> Translation{text, source, target}` | Adapter. Options: AWS Translate (MT) or LLM prompt (better tone/idiom, slower). Pick by benchmark. |
| `conversation/` | Builds bounded context packet, calls LLM, returns short answer. Rules: speak as AI, use only provided facts, say "I don't know" for unknowns, one question max, no medical advice. Answers in resident's language. | Prompt keeps instructions separate from quoted family content. |
| `memory/store.py` | SQLite (or JSON for day 1): profiles, photos, sources, claims, proposals, reviews. | Schema §5. |
| `memory/context.py` | `get_context(profile_id, photo_id) -> approved, non-withdrawn claims + known unknowns + source ids`. | Filtering is code, not prompt. |
| `memory/proposals.py` | Proposal agent: transcript → atomic candidate claims with evidence spans, uncertainty, conflicts vs existing claims. | Async. Output is `status=proposed`. LLM has no tool/write access. |
| `memory/review.py` | Approve / edit / reject / withdraw. Records actor, time, version. Withdraw removes from serving immediately. | |
| `api/` | FastAPI: REST for config/memory review, WebSocket for live events to the UI. | §6. |
| `config/` | Language pair, voices, provider keys (env only), timeouts. | Keys never sent to UI. |

## 4. Translate mode in detail (new)

**Scenario:** grandmother (e.g. Polish) and grandchild (English) in a care facility.

**Recommended control design: one TALK button per person**, each bound to a language
(`speaker_a = {label: "Babcia", lang: "pl"}`, `speaker_b = {label: "Me", lang: "en"}`).
Pressing a speaker's button tells the system the source language, so we don't depend on
language auto-detection (unreliable on short, soft, accented speech). Fallback if only one
button exists: a direction toggle, or STT auto-detect constrained to the two configured languages.

Flow per turn:

1. `START_TURN(speaker=a)` → state `listening`, UI shows "Listening — Babcia (Polish). Press again when done."
2. `END_TURN` → `transcribing`: STT with `language_hint=pl`.
3. Emit `transcript` event (original text, shown smaller on screen).
4. `translating` → translate pl→en. Emit `translation` event (large caption).
5. `speaking` → TTS in English, play through speaker. Emit `playback_started/finished`.
6. Back to `idle`. The other person presses their own button to reply (en→pl, same path).

Rules:
- `STOP_ALL`/MUTE interrupts any step; late results for the old `turn_id` are discarded.
- Show both original and translation; label "Machine translation — may be imperfect."
- Translate-mode transcripts are **ephemeral** (kept only for the on-screen history of the
  session, cleared on reset). Optional P1: "Save this as a family story?" → routes the
  transcript into the Contribute/proposal path, with explicit confirmation.
- Names: pass a per-profile glossary (family names, places) to STT/translation where supported,
  so "Arthur" doesn't become "author" and isn't translated.
- Same TTS/STT adapters as companion mode, so translation adds one module, not a new stack.

Companion mode also benefits: the resident can talk to the companion in her own language,
and memory claims can be stored in the contributor's language with a cached translation.

## 5. Data model (SQLite, synthetic data only for the demo)

```
profiles(profile_id, display_name, language, created_at)
photos(photo_id, profile_id, file_path, caption_hint)
sources(source_id, profile_id, kind[voice|text], contributor_id, language,
        transcript_text, sha256, created_at, raw_audio_retained BOOL default 0)
claims(claim_id, profile_id, photo_id NULL, text, language, attributed_to,
       source_id, locator, status[proposed|approved|disputed|withdrawn|rejected],
       version, supersedes NULL, created_at)
claim_translations(claim_id, language, text)
unknowns(profile_id, photo_id, field)          -- e.g. photo_year
reviews(review_id, claim_id, actor_id, decision, note, at)
permissions(profile_id, allowed_use, granted_by, at, withdrawn_at NULL)
```

Serving rule: `get_context` returns only `status='approved'` claims for the active
`profile_id`, filtered by `permissions`, in the resident's language.

## 6. API contract for the UI (freeze early)

WebSocket `ws://<host>:8000/ws` — server → UI events (JSON, all carry `turn_id` when relevant):

```
{type:"state", state:"listening", mode:"translate", speaker:"a", turn_id}
{type:"transcript", turn_id, speaker, language:"pl", text}
{type:"translation", turn_id, source:"pl", target:"en", text}
{type:"answer", turn_id, language, text, claim_ids:[...]}       // companion mode
{type:"playback", turn_id, status:"started"|"finished"|"stopped"}
{type:"proposal", proposal_id, claims:[...], unknowns:[...]}     // contribute mode
{type:"error", turn_id, code:"stt_failed"|"network"|"mic"|..., message}
{type:"photo", photo_id, url}
```

UI → server commands (same socket; hardware buttons produce the same commands):

```
{cmd:"start_turn", speaker:"a"|"b"|"resident"|"contributor"}
{cmd:"end_turn"}   {cmd:"stop_all"}   {cmd:"set_volume", value:0-100}
{cmd:"set_mode", mode:"companion"|"translate"|"contribute"}
{cmd:"set_photo", photo_id}
```

REST: `GET /config`, `PUT /config/languages`, `GET /profiles/{id}/photos`,
`POST /contributions {profile_id, photo_id, contributor_id}` (starts contribute mode),
`GET /proposals`, `POST /proposals/{id}/review {decision, claim_ids, note, actor_id}`,
`POST /claims/{id}/dispute`, `POST /claims/{id}/withdraw`, `DELETE /profiles/{id}`,
`POST /session/reset`. The `translation` event also carries `machine_translation: true`.

Implemented for the screen UI (`companion/api/profiles.py`, a JSON + files store until the
Phase 2 SQLite schema replaces it): `GET /profiles`, `GET /profiles/active`, `POST /profiles`,
`PUT /profiles/{id}`, `POST /profiles/{id}/activate {mode}` (sends `set_mode`),
`POST /profiles/{id}/photos`, `DELETE /profiles/{id}/photos/{photo_id}`, `GET /photos/{file}`.
`GET /profiles` returns the photo lists, standing in for `GET /profiles/{id}/photos`.

**Speech adapter** (`companion/api/speech.py`, for screens that record in the browser, such as
Companion / Care in `care/`). Each turn is two stages so a wrong listener can be corrected
without recording again. Every response echoes `turn_id` + `person_id`; the screen drops
anything else. Errors are `{error, turn_id, person_id, transcript?}` with an HTTP status, and keep
the original words whenever they exist.

```
GET  /api/capabilities → {speech, translation, auto_detect, tts, output_languages{code: name},
                          provider, simulated, remote, machine_translation}
POST /api/turn  multipart: metadata (JSON) + audio | text
     detect:    {turn_id, person_id, stage:"detect", source_language:"auto", ...}
              → {turn_id, person_id, transcript, detected_language, detection_certain, simulated}
     translate: {..., stage:"translate", recipient:"resident"|"visitor", target_language}
              → {turn_id, person_id, target_language, transcript, translation, pronunciation,
                 machine_translation:true, simulated}
POST /api/speak {text, language} → audio (mp3; wav for mock)
```

`detection_certain` is a rule in code (`companion/speech/language.py`): exactly one reliably
detected language and enough words to route on; otherwise the screen asks who should hear it.
Provider calls are registered in `SpeechService`; STOP_ALL, session reset and mode/person switch
cancel them (orchestrator `on_interrupt`), as does the browser aborting the request. Audio is
held in memory for one request and never written to disk.

**Shared UI state.** The production kiosk is touch-only. Its Start/Finish/Pause and replay
buttons drive `SpeechSession` and the HTTP speech adapter directly. The backend publishes
`{type:"session", reason:"reset"|"profile"|"mode"}` when another screen invalidates that session.
Care cancels local recording, playback and requests immediately. Profile activation changes
the kiosk's selected person; `{type:"library"}` refreshes people/media after edits. On WebSocket
loss Care stops capture/playback, then re-reads the active profile and capabilities on reconnect
without automatically recording again. Initial load restores the backend's active person.

**Development controls relay.** `POST /controls {key | action, speaker?, value?}` remains
available for optional external controls and dev keys. Keys go through `KeyMapper`. STOP_ALL also runs the
orchestrator's `stop_all`. Every press is published on `/ws` as
`{type:"control", action:"WAKE"|"START_TURN"|"END_TURN"|"STOP_ALL"|"SET_VOLUME", speaker:"resident"|"visitor"|null, value:0-1|null}`,
and a WS `stop_all` from any screen is relayed the same way. Writes and WebSocket handshakes
with a foreign `Origin` are rejected (`companion/api/security.py`).

**Media.** Profiles also hold short videos (MP4/WebM) for the slideshow. Profile responses list
`media[]` (`{photo_id, url, name, type:"image"|"video", bytes}`) and keep `photos[]` images-only.
`POST /profiles` accepts `example: true` for the fictional people the screen seeds on first run.

Wire details (implemented in `companion/events.py`, shapes above unchanged): `turn_id` is an
integer, increasing per START_TURN; `state` events always carry `speaker` and `turn_id` (`null`
when no turn is active, e.g. `idle`/`muted`/`error`); `error.turn_id` may be `null` for
command errors; extra error codes `invalid_command`, `not_implemented`, `internal`. The
server sends the current `state` on connect. Pressing TALK for the listening speaker again
ends the turn; another speaker's press interrupts (barge-in). Proposal `claims[]` items are
provisional until Phase 3: `{claim_id, action, kind, text, attributed_to, locator{start,end},
evidence, confidence, needs_review}`; `unknowns[]`: `{field, photo_id, evidence, locator}`.

## 7. Failure behavior

| Failure | Behavior |
|---|---|
| STT empty/unintelligible | `error:stt_failed`, "I didn't catch that — press TALK to try again." |
| Network/provider timeout | `error:network`, readable state, never a fabricated answer/translation |
| Unknown fact | Answer says it isn't in the family notes |
| STOP_ALL during any state | Flush capture + playback, cancel pending calls, drop late results |
| Proposal validation fails | Proposal stays unsaved; contributor sees "not saved" |

## 8. Trust & privacy (demo rules)

Synthetic profile and permissioned photos only. API keys server-side only. No raw audio
stored by default. Recording state always visible. Translation disclosed as machine
translation. Not a clinical device; no HIPAA claim.
