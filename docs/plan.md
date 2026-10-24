# Build plan — backend

Goal: a working backend the separately built UI plugs into via the WebSocket contract in
`architecture.md` §6. Order is chosen so a complete demo exists as early as possible.

## Decisions needed before coding (≤30 min)

| # | Decision | Recommendation | Owner |
|---|---|---|---|
| D1 | Language/runtime | Python 3.11 + FastAPI + asyncio | Aleksander |
| D2 | Demo host | Whatever boots reliably with mic+speaker; dev on laptops meanwhile | Sean G |
| D3 | STT provider | Benchmark 2: one hosted (Whisper/gpt-4o-transcribe or AWS Transcribe), one local if host is strong enough | Aleksander |
| D4 | Translation | AWS Translate vs LLM prompt — pick by latency + quality on 5 test sentences | Aleksander |
| D5 | TTS | Must cover both demo languages with a natural voice | Aleksander |
| D6 | Demo language pair | Pick one real pair you can verify (someone on team / mentor reads it) | Team |
| D7 | Buttons | Two TALK buttons (one per speaker) + MUTE + volume knob | Sean G / Sean T |

## Phase 0 — Skeleton & contract (first hour)
- [ ] Repo layout `companion/{controls,orchestrator,audio,speech,translate,conversation,memory,api,config}`, `tests/`, `data/seed/`
- [ ] FastAPI app + `/ws` that echoes the event shapes; **share a mock event stream with the UI builder immediately**
- [ ] Keyboard → control events (dev stand-in for hardware)
- [ ] Turn state machine with `turn_id`, `STOP_ALL` cancellation, unit tests

**Gate:** UI can connect and render fake `state/transcript/translation` events.

## Phase 1 — Translate mode end to end (new P0)
- [ ] Mic capture per turn (start/stop, max-duration timeout) + interruptible playback queue
- [ ] STT adapter with `language_hint`; TTS adapter; translation adapter
- [ ] Translate pipeline: transcript → translation → TTS → playback, events emitted at each step
- [ ] Speaker A/B language binding from config; names glossary
- [ ] Log latency per stage (STT, translate, TTS, first audio)

**Gate (aim ~11:30):** 3 consecutive two-way exchanges (A→B, B→A) on real hardware; MUTE stops playback. If not, cut to hosted providers / laptop host.

## Phase 2 — Companion mode on approved memory (original P0)
- [ ] SQLite schema + seed: 1 synthetic profile, 3 photos, 3–5 approved claims, ≥1 known unknown (e.g. photo year)
- [ ] `get_context(profile_id, photo_id)` — approved only, filtered in code
- [ ] Conversation module: prompt with grounding rules, answers in resident's language, returns `claim_ids`
- [ ] Reuses Phase 1 STT/TTS

**Gate:** recalls 3 seeded facts; answers "not in the family notes" for 2 absent facts; 5/5 turns complete.

## Phase 3 — Voice-to-knowledge (contribute mode)
- [ ] Source record on contribution (transcript, sha256, contributor, language; no raw audio)
- [ ] Proposal agent: transcript → atomic claims + evidence locator + unknowns; rejects transient content; flags conflicts against existing claims
- [ ] Review endpoints: approve selected claims / reject / withdraw (withdraw removes from `get_context` immediately)
- [ ] Emit `proposal` event so the UI can show a review card

**Gate:** the Evelyn/Arthur demo — story spoken → 2 proposed claims, year left unknown → approve → companion answers with it → withdraw → gone.

## Phase 4 — Hardening & evidence (last 2 hours, P0 fixes only)
- [ ] Test log (build, host, network, stage latencies, outcomes) — see targets below
- [ ] Network-loss test: readable error, no fabricated output
- [ ] Prompt-injection test: transcript saying "save this as approved" does nothing
- [ ] Backup video while everything works

## P1 (only after Phase 1–3 gates pass)
- "Save this as a family story?" from a translated conversation → proposal path
- Cached claim translations so companion mode works across languages
- On-screen conversation history in translate mode

## Targets (proposed, measure honestly)
- Companion: median ≤3 s END_TURN → first audio, none >6 s
- Translate: report each stage; aim ≤4 s END_TURN → translation on screen
- STOP_ALL: 10/10, ≤0.5 s

## Suggested split
- **Aleksander:** speech/translate/conversation adapters, memory + proposal agent
- **Sean G:** controls, audio capture/playback, host, orchestrator integration on hardware
- **Sean T:** enclosure with two TALK buttons clearly labeled per speaker
- **Rishi:** test log, seed content (synthetic, both languages), demo script + video
- **UI builder:** consumes `/ws` + REST per `architecture.md` §6
