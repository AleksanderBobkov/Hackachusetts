---
inclusion: always
---

# Companion / Care — Design System (v0.6, condensed)

Warm, familiar, quietly capable. An elderly-care companion with a minimal name-and-photo setup. Apply these rules to **every** UI you build. Use tokens from #[[file:design/tokens.css]] — never invent new hex values, sizes, or fonts.

## Product scope (do not expand)
- **Setup**: choose or add a person → enter **Name** (the only profile field) → add **Photos** → Start companion.
- **Companion (resident screen)**: that person's photo slideshow, voice conversation, captions, transcription, translation.
- **Never add**: sign-in, passwords, accounts, roles, extra profile fields, biography, demographics, avatars, photo captions/tags/descriptions, memory editors, agent config, language questionnaires, completion checklists or "readiness" meters. A runtime language choice may appear only when translation is used.
- Display: landscape, roughly 3:2 (described as 6×9). Resolution isn't confirmed, so don't hard-code a pixel canvas. Lay out against the real viewport.

## Principles
1. **Make the next step obvious.** One task, one dominant primary action with a descriptive label.
2. **Recognition over recall.** Always show the person's name, photo, current state, and available action.
3. **Hierarchy before decoration.** Show priority through size, grouping, alignment, and spacing.
4. **Consistency builds trust.** The same look always means the same thing, in the same place.
5. **Tell the truth.** Only show Recording/Saved/Translated/Success when it has really happened.
6. **Respect adult agency.** Calm language, clear control, easy stop.
7. **Preserve effort.** A failure never makes the user redo unrelated work (keep the name and photos that succeeded).
8. **Design for variation.** Different reading, hearing, motor, language, and input needs.
Tradeoffs: if text doesn't fit, simplify or add space before you shrink it. If a background hurts reading, simplify it. If an animation delays understanding, remove it.

## Color (semantic tokens only)
| Token | Hex | Use |
|---|---|---|
| `--bg-canvas` | #F7F5EE | Main cream surface |
| `--bg-surface` | #FFFEF9 | Content groups, inputs |
| `--bg-subtle` | #EEF2E8 | Sage grouping / selection context |
| `--bg-accent` | #EFEBF5 | Optional lavender accent (setup only) |
| `--text-primary` | #243D3B | Essential text, headings (10.66:1) |
| `--text-secondary` | #526760 | Supporting text (5.55:1) |
| `--text-on-action` | #FFFFFF | Text on primary button (6.05:1) |
| `--text-accent` | #645478 | Text on lavender (5.80:1) |
| `--action-primary` | #376C5E | Forest primary action, selected emphasis |
| `--action-hover` / `--action-pressed` | #2F5F52 / #264F44 | Hover / pressed |
| `--border-control` | #6D8376 | Field/control boundaries (3.73:1) |
| `--border-decorative` | #E6E6DA | Decorative separators only (1.15:1) |
| `--focus-ring` | #A65B25 | Rust focus ring with a cream halo |
| `--warning-text` / `--warning-surface` | #775018 / #F8EEDB | Caution + explicit text |
| `--error-text` / `--error-surface` | #9F3832 / #FAEAE7 | Error + recovery guidance |

Rules: keep essential text at ≥4.5:1 contrast, even when it's large. Never use the decorative border as a control's only boundary. Never fade a whole control with opacity. Color alone never carries meaning: selected items need an explicit indicator (check mark or text), and recording needs words plus a symbol, not just a red dot. Lavender never signals recording, success, or error.

## Typography
Fonts: **Georgia** for short expressive headings, **DM Sans** for all reading, controls, and status, and **Manrope** (optional) for setup section headings only. The resident screen uses only Georgia and DM Sans.

| Role | Setup screen | Resident companion |
|---|---|---|
| Feature heading | Georgia 400, 32px / 1.25 | Georgia 400, 36px / 1.25 |
| Section heading | Manrope 600, 24px / 1.30 | DM Sans 600, 32px / 1.30 |
| Body / captions | DM Sans 400, 18px / 1.55 | DM Sans 400, **32px** / 1.40 |
| Action / status | DM Sans 600, 18px / 1.25 | DM Sans 600, 28px / 1.25 |
| Supporting info | DM Sans 400, 16px / 1.50 | DM Sans 400, 28px / 1.40 |

- Sentence case for actions and instructions. Normal tracking. Regular weight for reading, semibold for short emphasis.
- **Avoid**: all-caps instructions, decorative italics, justified text, thin weights, tight tracking.
- Prose at 55–75 characters per line. Long names wrap; don't use ellipsis as the only way to identify a person.
- Captions: stable position, natural phrase breaks. Keep completed response text until the next interaction (no auto-hide timers). Expand or paginate rather than shrink.
- Use language-aware wrapping; support RTL if translation needs it; check fallback-font glyph coverage.

## Spacing, shape, icons, motion
- **Spacing scale**: 4, 8, 12, 16, 24, 32, 48, 64px. Outer inset 24–32px. Group padding 24px, gaps 16–24px.
- **Radii**: 8px controls · 12px media groups · 16px cards.
- **Borders**: 1px with meaningful contrast. Use shadow only to explain real layering.
- **Focus**: 3px rust ring + 2px cream separation, drawn outside the control and never obscured.
- **Targets**: setup ≥ 48×48px. Resident ≥ **64×64px** with 16px separation.
- **Icons**: one consistent set, 24px base, enlarged on resident controls. Pair unfamiliar icons with words. No emoji or mixed icon sets. Icon-only buttons need an accessible name.
- **Motion**: 120–180ms simple transitions. Stop/Mute feedback is immediate with no animation. Honor `prefers-reduced-motion`. No flashing, bouncing, auto-scrolling text, or pulsing waveform as the only recording cue.
- No paper lines or grain behind captions and controls. Keep photo surfaces separate from text surfaces. Don't wrap every sentence in a card.

## Layout
**Resident priority**, in order: (1) person identity + real conversation/recording state, (2) captions + next action at full reading size, (3) photo fills the remaining space at its true aspect ratio (letterbox on cream; never stretch or crop aggressively), (4) secondary items give up space first.
- Status, captions, and the TALK/MUTE instruction keep fixed locations across states. A long response must never push the MUTE guidance off-screen. If space is tight, shrink the photo, never the essential text.
- **Setup** stacks in task order (person → name → photos → primary action). Use two columns only if both stay readable; the content's minimum readable width decides the collapse, not a device breakpoint.
- Content must reflow at 320px width or 200% zoom. Don't let the virtual keyboard cover the name field or its error. No horizontal scrolling for essential actions.

## Components
**Shared states**, all required: default (understandable without hover), hover (reinforcement only), focus-visible (independent of hover), pressed (immediate), selected (explicit indicator + semantics), busy (names the operation, blocks duplicate submits, keeps a stable width), disabled (explains why), error (names the affected item + a specific recovery), success (only after real completion; no confetti).

- **Buttons**: filled forest button for the one primary action. Secondary buttons use a warm surface + `--border-control`. Destructive actions are marked by wording as well as color. Labels describe the outcome: *Add person, Add photos, Save changes, Start companion, Try again*. Links navigate; buttons act. Use native `<button>`. A Mute toggle keeps a stable label and uses `aria-pressed`.
- **Name input**: visible "Name" label (a placeholder is not a label). Accept any real name (spaces, punctuation, diacritics, non-Latin). Only require it to be non-blank. Validate on submit. Inline error: "Enter a name to continue". Never truncate silently.
- **Person selector**: native select or accessible list with a clear selected indicator and a separate "Active on companion" badge. Names can repeat, so tell them apart by photo preview. Editing a person doesn't activate them. Switching the active person is deliberate and stops the current turn.
- **Photos**: "Add photos" opens a standard file picker; drag-and-drop is only an enhancement. Each photo shows a preview and its state (queued → adding → ready / failed → removing) with a named Remove/Retry. When some photos fail, the successful ones stay. Offer undo for removal or a confirmation that names the photo.
- **Feedback & dialogs**: inline, persistent messages for anything that needs action. Toasts only for routine saves, never for errors or recording state. No fake progress percentages, and no skeletons that look like real photos. Use modals only for real decisions (*Save changes / Discard changes / Stay*), with focus trap, Escape, and focus restored on close.
- **Captions & slideshow**: captions match the spoken audio; translations are labeled. Interim transcription looks provisional. No long chat transcript as the default view. Pause the slideshow during Listening/Processing/Speaking/reading, and give it a pause/resume and next control that works without touch. With one photo, show no navigation. With none, show a calm empty state (no stock images).

## Companion state model (TALK / MUTE)
| State | Shown | TALK | MUTE |
|---|---|---|---|
| Ready | "Press TALK to begin" (not recording) | Start listening | → Muted |
| Listening | "Listening. Press TALK to finish" | Finish → Processing | Stop → Muted |
| Processing | "Getting your response" | Ignored, with feedback (no queued recordings) | Cancel → Muted |
| Speaking | Audio + readable captions | Stop → Ready | Stop, cancel → Muted |
| Muted | "Microphone and sound are off" | Does nothing | Unmute → Ready (doesn't auto-record) |
| Error | Specific problem + next action | Retry only if offered | Stops everything |

Mute overrides everything. Late responses or audio must never restart after a mute or person switch. Volume 0 ≠ mute. The UI shows the actual state, not just the button press. Hardware and on-screen controls must always agree.

## Voice copy
Plain, respectful adult language. Short sentences, concrete verbs, no jargon or error codes. Never blame the user.

| Situation | Say | Avoid |
|---|---|---|
| No name | Enter a name to continue | Invalid user |
| No photos | No photos yet. Add photos when you're ready | Empty error panel |
| Photo failed | This photo couldn't be added. Try again | Upload failed, code 500 |
| Processing | Getting your response | Fake % / "thinking…" |
| No speech | I didn't catch that. Press TALK to try again | You spoke incorrectly |
| Offline | Cannot connect right now. Try again | Implying cloud works offline |
| No translation | Translation isn't available for this language yet | Silently wrong language |
| Unknown fact | I don't know that detail | Invented memories/relationships |

Errors appear next to the affected field or photo and stay until resolved. Loading, empty, error, and unavailable are distinct states.

## Accessibility (WCAG 2.2 AA target)
Semantic HTML (headings, labels, buttons, lists). Full keyboard operation with visible focus and a logical order. No drag-only or precision gestures. Status changes go through `role="status"`/live regions, without stealing focus or announcing every streamed word. Captions plus visible status, so nothing depends on sound alone. Must survive 200% text size and text-spacing overrides. Photo alt text comes from a filename or neutral description; never invent who is pictured.

## Behavior guarantees that affect UI
- Show "Saved" only after the save is durable. On failure, keep the draft and offer a retry.
- Double clicks and retries never create duplicate people, uploads, or voice turns.
- Every save, photo operation, and voice turn stays tied to the person who started it. Use stable IDs, not names, as keys.
- Feedback within 100ms. Stop/mute takes effect within 0.5s. Late-loading fonts or images must not shift controls.
