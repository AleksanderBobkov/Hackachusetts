# Hackachusetts — tabletop AI companion (backend)

Backend for a tabletop companion for older adults in care facilities: Translate, Companion and
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

Use **64-bit** Raspberry Pi OS (Bookworm). It ships Python 3.11, and every dependency has a
prebuilt aarch64 wheel. 32-bit armv7 has no PyPI wheels and is not supported.

```bash
sudo apt install -y python3-venv          # + libportaudio2 once audio lands (Phase 1)
python3 -m venv .venv && . .venv/bin/activate
pip install -e .                          # optional: pip install -e ".[speed]"
uvicorn companion.api.app:app --host 0.0.0.0 --port 8000
```

Speech, translation and LLM run on hosted providers; no local models on the Pi.

## For the UI builder

- `ws://localhost:8000/ws?mock=1` — scripted demo stream of every event type (translate both
  ways, companion answer + MUTE, unknown fact, STT error, contribute review card), then closes.
  Options: `&loop=1` repeat forever, `&speed=2` play 2× faster (`speed=0` = no delays).
  Commands sent on the mock socket are ignored.
- `ws://localhost:8000/ws` — live orchestrator. Send commands such as
  `{"cmd":"start_turn","speaker":"a"}`, `{"cmd":"end_turn"}`, `{"cmd":"stop_all"}`.
  On connect the server sends the current `state` event.
- REST: `GET /health`, `GET /config`, `POST /session/reset` (more as phases land).

Dev keys standing in for buttons: `1` TALK A · `2` TALK B · `space` TALK resident/contributor ·
`m` STOP_ALL · `+`/`-` volume. Press TALK again to finish the turn.
