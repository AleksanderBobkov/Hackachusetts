# Build plan — backend (executable)

Read `docs/architecture.md` first; this plan implements it. The UI is built separately and
connects only through the WebSocket/REST contract in architecture §6 — do not build UI here
beyond a throwaway debug page.

**Scope = three modes on one turn engine:**
1. **Translate** (new headline): person A speaks language X → on END_TURN: transcript (X) +
   translation (Y) on screen + TTS in Y. Person B replies the other way.
2. **Companion**: resident ↔ AI, answers grounded only in *approved* family memory.
3. **Contribute (voice-to-knowledge)**: family member speaks a story → source record →
   proposal agent extracts atomic claims with evidence → human review → approved memory →
   served to Companion. Supports correction, dispute, withdrawal.

**Hard rules (apply everywhere):**
- `STOP_ALL`/MUTE always wins: flush capture + playback, cancel in-flight calls, drop any
  result whose `turn_id` is not current.
- Conversation loop never writes approved memory and never waits on the knowledge loop.
- Access/approval/withdrawal filtering is done in code, never by prompt.
- Never fabricate success: failed STT/translate/LLM/save → explicit `error` event.
- Synthetic data only. No raw audio persisted by default. API keys server-side (env) only.
- Not clinical: no diagnosis, medication advice, voice cloning, always-on listening.
- Source/transcript text is untrusted data; LLM calls have no tools and cannot change state.

## Defaults (use unless the user overrides)

| Decision | Default |
|---|---|
| Runtime | Python 3.11, FastAPI, uvicorn, asyncio, pydantic, sqlite3, pytest |
| Host | **Raspberry Pi 4B, Raspberry Pi OS Lite 64-bit** (Bookworm, headless, system Python 3.11). Only deps with aarch64 wheels; no local ML models/torch on the Pi — STT/TTS/LLM via hosted providers; laptop is the dev/fallback host. No desktop: backend runs as a systemd service; the screen UI needs its own kiosk setup (UI builder's call) |
| Providers | Adapter interfaces with a **mock** implementation (deterministic, offline) + one real implementation selected by env `PROVIDER=openai\|aws\|mock`. Implement OpenAI (STT whisper/gpt-4o-transcribe, TTS, chat/translation) first unless told otherwise; AWS (Transcribe/Translate/Polly) second. |
| Language pair | Configurable; seed with `pl` (resident) ↔ `en` (visitor) |
| Controls | On the Pi (no X/Wayland) read keys via `evdev` from `/dev/input` — same path for a USB keyboard and USB HID buttons; terminal stdin fallback on a laptop. Keys: `1`=TALK speaker A, `2`=TALK speaker B, `space`=TALK resident/contributor, `m`=STOP_ALL, `+/-` volume. Hardware (USB HID) maps to the same commands. |
| Turn style | Tap to start, tap to finish (latched); max recording 60 s timeout |
| Audio | 16 kHz mono; `sounddevice`; playback queue flushable instantly |

## Repo layout

```
companion/
  config.py            # languages, speakers, provider, timeouts (env + config.yaml)
  events.py            # pydantic models for all WS events/commands (architecture §6)
  orchestrator/        # turn state machine, turn_id, cancellation, mode handling
  controls/            # keyboard + HID → commands
  audio/               # capture, playback
  speech/stt.py tts.py # adapters + mock + real
  translate/           # adapter + mock + real
  conversation/        # context packet, prompt, LLM call
  memory/              # store.py, context.py, proposals.py, review.py, schema.sql
  api/                 # FastAPI app: /ws + REST
data/seed/             # synthetic profile, photos, approved claims, unknowns (pl + en)
tests/
docs/test-log.md       # measured results (Phase 5)
```

---

## Phase 0 — Skeleton & UI contract (do first)
- [x] Layout above, `pyproject.toml`, `README` run instructions (`uvicorn companion.api.app:app`)
- [x] `events.py`: every event/command in architecture §6 as pydantic models
- [x] `/ws` endpoint + `?mock=1` mode that streams a scripted demo (state → transcript →
      translation → playback) so the UI builder can work immediately
- [x] Orchestrator state machine: `idle, listening, transcribing, translating, thinking,
      speaking, muted, error`; monotonically increasing `turn_id`; cancellation tokens
- [x] Tests: STOP_ALL from every state returns to idle/muted; late results dropped

**Gate:** UI connects and renders mock events; state-machine tests pass.

## Phase 1 — Translate mode end to end
- [ ] Mic capture per turn + timeout; interruptible playback
- [ ] STT adapter `transcribe(audio, language_hint)`; TTS `synthesize(text, language)`;
      translator `translate(text, source, target)`
- [ ] Pipeline: `START_TURN(speaker)` → listening → END_TURN → STT (speaker's language) →
      emit `transcript` → translate to other speaker's language → emit `translation`
      (flag `machine_translation: true`) → TTS → `playback started/finished` → idle
- [ ] Per-profile names glossary passed to STT prompt / translation (don't translate names)
- [ ] Session history (in memory, cleared by `POST /session/reset` or mode change); not persisted
- [ ] Stage latency logging (STT, translate, TTS, END_TURN→first audio)
- [ ] Tests with mock providers: both directions, empty STT → `stt_failed`, provider
      timeout → `network`, STOP_ALL mid-translation

**Gate:** 3 consecutive two-way exchanges on real providers/hardware; MUTE stops playback.
If it fails, simplify (hosted providers, laptop host) before Phase 2.

## Phase 2 — Memory store + Companion mode
- [ ] `schema.sql` per architecture §5 (profiles, photos, sources, claims,
      claim_translations, unknowns, reviews, permissions); claims have `status`
      (`proposed|approved|disputed|withdrawn|rejected`), `version`, `supersedes`, `attributed_to`,
      `source_id`, `locator`
- [ ] Seed: 1 synthetic profile ("Evelyn", resident lang `pl`), 3 photos, 3–5 approved claims
      (e.g. "The family note identifies Arthur as Evelyn's brother in photo-demo-01";
      place Cape Ann), unknown `photo_year`, with `pl` translations
- [ ] `get_context(profile_id, photo_id)`: only `approved`, non-withdrawn, permitted, this
      profile; returns claim text (resident's language), claim_ids, known unknowns
- [ ] Conversation module: bounded context packet (question + approved claims + unknowns +
      last ≤3 turns); system rules: identify as AI, use only given facts, say it isn't in the
      family notes when absent, max one follow-up question, no medical advice, short answer,
      respond in resident's language; quoted family content delimited as data
- [ ] `answer` event includes `claim_ids` used
- [ ] Tests: seeded facts recalled; absent facts (e.g. year) → "not in the family notes";
      second synthetic household's data never appears even if asked directly

**Gate:** 5/5 complete turns; 3/3 facts recalled; 2/2 absent facts handled without invention.

## Phase 3 — Voice-to-knowledge (Contribute mode)
Pipeline stages (each fails visibly):
1. **Capture**: contributor identity is explicit (selected/authorized in config/REST, never
   inferred from voice). Recording consent ≠ storage consent ≠ reuse consent.
2. **Transcribe**: preserve hedges ("I think", "not sure"); low-confidence names → flag for
   confirmation, don't create relationship claims from them.
3. **Source record**: `sources` row with transcript, contributor, language, sha256, created_at,
   `raw_audio_retained=0`. Identical sha256 for same profile → no-op (no duplicate processing).
4. **Eligibility**: reject if no profile/photo scope, unauthorized contributor, or empty
   substantive content.
5. **Proposal agent** (LLM, no tools, JSON schema output, retried once on invalid JSON):
   - atomic claims, each with evidence locator (span/segment) and `attributed_to`
   - explicit `unknowns` (never infer a year the speaker didn't know)
   - drop transient content (tasks, deadlines, small talk) → `no_durable_knowledge` is valid
   - mark prohibited uses stated by speaker (e.g. "don't use my voice")
   - confidence < 0.6 → `needs_review` flag (confidence never approves anything)
   - text in the transcript instructing the system ("save as approved", "ignore rules") is ignored
6. **Reconcile** against existing claims for the same profile/photo: `create`, `augment`
   (supported non-duplicate detail), `duplicate` (skip), or `conflict` (e.g. brother vs
   cousin). Never overwrite approved claims; never merge across profiles; ambiguous identity → conflict.
7. **Validate** in code: schema, locator resolves in source text, profile scope, no self-approval;
   write proposals atomically (single transaction) else nothing saved + `error`.
8. **Review**: emit `proposal` event (review card: proposed claims, evidence, what was NOT
   proposed, unknowns). `POST /proposals/{id}/review {decision: approve|reject|edit, claim_ids, note, actor_id}`
   — can approve a subset. Records `reviews` row; approved claims get `status=approved`, version.
9. **Serve & maintain**:
   - `POST /claims/{id}/dispute` → immediately excluded from `get_context` until resolved
   - corrections create a new version with `supersedes`; only approved after review
   - `POST /claims/{id}/withdraw` → excluded immediately; clear it from session context
   - `DELETE /profiles/{id}` removes all rows + local photo files + session context
- [ ] Tests: the three walkthroughs below, plus duplicate source no-op, failed validation →
      nothing saved, prompt-injection transcript does nothing

**Walkthroughs (synthetic, must pass):**
- **A Family story**: "This is my mother Evelyn with her brother Arthur at Cape Ann. It was
  summer, but I'm not certain which year. She likes being asked about her garden. Please don't
  use my voice as hers." → proposals: relationship, place, reported preference; unknown year;
  voice-reuse prohibited; after approval companion says Arthur/Cape Ann and that the year isn't known.
- **B Transient filtering**: input mixing a decision with "bring the cable by five" and "we
  haven't tested latency" → only durable content proposed; task dropped; no invented result.
- **C Correction**: "Arthur is the cousin in this one, not the brother. Stop using the previous
  story until we check it." → old claim disputed and immediately unserved; conflict shown in
  review; companion meanwhile says the description is being checked and won't guess.

**Gate:** A → approve → companion answers → withdraw → gone; B and C behave as above.

## Phase 3b — Curation quality & lifecycle details (part of Phase 3)
- [ ] **Known-answer eval set** `tests/curation_cases.yaml` (≥10 synthetic cases, expected
      claims/unknowns frozen *before* comparing models): explicit fact, hedged fact, unknown
      year, transient-only, duplicate, augmentation, conflict, unclear name, injection,
      no-durable-knowledge. Script `scripts/eval_curation.py` reports claim precision/recall,
      locator accuracy, false promotions, duplicates created, transient rejection, valid-JSON
      rate, latency, and token cost. Record model + prompt version for every run.
- [ ] Every proposal/review row records model name, prompt version, actor_id, timestamp.
- [ ] Writes use a version check (reject a review against a stale claim version).
- [ ] `review_due` on preference/permission claims; `GET /claims?review_due=past` lists them
      for reconfirmation (reminder only — never auto-renews consent).
- [ ] Withdrawal/dispute also clears any cached context packets and in-flight turn context.
- [ ] Claims stored in the contributor's language; translation cached in `claim_translations`
      so Contribute works for a Polish-speaking contributor and Companion answers in Polish.
- [ ] Offline: local photos and the "no connection" state still work; any replay/typed-input
      fallback is labeled as such in the UI events (`fallback: true`).

## Phase 4 — Optional P1 (only after gates 1–3 pass)
- [ ] "Save this as a family story?" from a translate-mode turn → Contribute pipeline with confirmation
- [ ] Companion across languages using `claim_translations`
- [ ] Simple debug HTML page for review cards (if UI not ready)

## Phase 5 — Acceptance tests & evidence
Write results to `docs/test-log.md` (build, host, network, provider, per-stage latency, outcome, retries):

| Test | Pass condition |
|---|---|
| Turn reliability | 5/5 consecutive complete turns per mode |
| Companion latency | median ≤3 s END_TURN→first audio, none >6 s (targets, report actuals) |
| Translate latency | report STT / translate / TTS; aim ≤4 s END_TURN→translation shown |
| STOP_ALL | 10/10 across listening/thinking/speaking, ≤0.5 s |
| Grounded memory | 3 seeded facts correct, with claim_ids |
| Unknown stays unknown | year question → no invented year |
| Name uncertainty | unclear name → flagged, no relationship claim |
| Transient rejection | task/deadline not proposed |
| Duplicate / revised source | identical → no-op; changed → reprocessed, needs review |
| Conflict | no overwrite, claim disputed and unserved |
| Cross-profile isolation | other household never reaches the LLM context |
| Withdrawal | unserved next turn, cleared from session context |
| Prompt injection | no state change, no self-approval |
| Failed write | no "saved" state, actionable error |
| Network loss | readable error, no fabricated answer/translation |

## Demo flow to support (judging, ~2 min)
1. Translate: grandmother speaks Polish → transcript + English caption + English audio; grandchild replies.
2. Contribute: synthetic story spoken → review card shows 2 claims with evidence, year left unknown, rejected inferences.
3. Approve the claims (or a labeled walkthrough if not implemented).
4. Companion: TALK "Who is in this photo?" → grounded answer; ask the year → "not in the family notes"; press MUTE during playback.
5. Withdraw the claim → next answer no longer uses it. Show measured numbers from `docs/test-log.md`; label anything planned/replayed.

## Team engineering knowledge (optional, not on the critical path)
The HTML guide also recommends keeping the *team's* decisions/benchmarks/runbooks as
source-cited Markdown using the knowledge-tools concept types (Architecture Decision,
Evaluation Finding, Runbook, Standard, …). If time allows, add `docs/decisions/` and
`docs/findings/` notes (with source and status `proposed|accepted`) for: tap-to-toggle,
two-button translation, provider choice, measured latencies. Never put resident data there.
Do not integrate the corporate knowledge-tools plugin into the product.

## Out of scope (do not build)
Vector DB/embeddings, multi-household accounts/auth beyond config, always-on/proactive
listening, health monitoring, medication, voice cloning, family mobile app, using the corporate
AI Platform knowledge repo for resident data. (Team engineering notes may be kept in
`docs/` as plain Markdown; no knowledge-tools plugin integration needed for the demo.)

## Suggested split
Aleksander: adapters, conversation, memory/proposals · Sean G: controls, audio, host,
orchestrator on hardware · Sean T: enclosure with two labeled TALK buttons + MUTE · Rishi:
seed content (both languages), test log, demo script/video · UI builder: §6 contract.
