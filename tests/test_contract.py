import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from companion.api.app import app
from companion.api.mock_script import demo_script
from companion.controls import KeyMapper
from companion.events import dump, parse_command, parse_event


@pytest.mark.parametrize(
    "raw",
    [
        {"cmd": "start_turn", "speaker": "a"},
        {"cmd": "start_turn", "speaker": "contributor"},
        {"cmd": "end_turn"},
        {"cmd": "stop_all"},
        {"cmd": "set_volume", "value": 40},
        {"cmd": "set_mode", "mode": "contribute"},
        {"cmd": "set_photo", "photo_id": "photo-demo-01"},
    ],
)
def test_every_command_parses(raw):
    assert parse_command(raw).model_dump() == raw


@pytest.mark.parametrize(
    "raw",
    [
        {"cmd": "start_turn", "speaker": "z"},
        {"cmd": "set_volume", "value": 101},
        {"cmd": "launch_rockets"},
        {"cmd": "stop_all", "extra": 1},
    ],
)
def test_bad_commands_rejected(raw):
    with pytest.raises(ValidationError):
        parse_command(raw)


def test_mock_script_covers_every_event_type_and_roundtrips():
    types = set()
    for _, ev in demo_script():
        payload = dump(ev)
        assert parse_event(payload) == ev
        types.add(payload["type"])
    assert types == {"state", "transcript", "translation", "answer", "playback",
                     "proposal", "error", "photo"}
    translations = [dump(e) for _, e in demo_script() if e.type == "translation"]
    assert all(t["machine_translation"] is True for t in translations)


def test_mock_proposal_locators_resolve():
    from companion.api.mock_script import STORY_A

    proposal = next(e for _, e in demo_script() if e.type == "proposal")
    for c in proposal.claims + proposal.unknowns:
        loc = c["locator"]
        assert STORY_A[loc["start"]:loc["end"]] == c["evidence"]


def test_ws_mock_streams_script():
    with TestClient(app) as client, client.websocket_connect("/ws?mock=1&speed=0") as ws:
        received = [ws.receive_json() for _ in range(len(demo_script()))]
    assert [r["type"] for r in received] == [dump(e)["type"] for _, e in demo_script()]
    assert received[1] == {"type": "state", "state": "listening", "mode": "translate",
                           "speaker": "a", "turn_id": 1}


def test_ws_live_commands_drive_orchestrator():
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        assert ws.receive_json()["state"] == "idle"
        ws.send_json({"cmd": "start_turn", "speaker": "a"})
        ev = ws.receive_json()
        assert ev["state"] == "listening" and ev["speaker"] == "a"
        assert isinstance(ev["turn_id"], int)
        ws.send_json({"cmd": "stop_all"})
        assert ws.receive_json()["state"] == "muted"
        ws.send_text("not json")
        assert ws.receive_json()["code"] == "invalid_command"
        ws.send_json({"cmd": "start_turn", "speaker": "nobody"})
        assert ws.receive_json()["code"] == "invalid_command"


def test_rest_config_and_reset():
    with TestClient(app) as client:
        cfg = client.get("/config").json()
        assert cfg["speakers"]["a"]["lang"] == "pl" and cfg["provider"] == "mock"
        assert not any("key" in k.lower() for k in cfg)
        assert client.post("/session/reset").json() == {"ok": True}
        assert client.get("/health").json()["state"] == "idle"


def test_key_mapping_and_debounce():
    t = [0.0]
    km = KeyMapper(clock=lambda: t[0])
    assert km.map("1").model_dump() == {"cmd": "start_turn", "speaker": "a"}
    assert km.map("1") is None  # bounce
    t[0] = 1.0
    assert km.map("2").speaker == "b"
    assert km.map("space").speaker == "resident"
    assert km.map("m").cmd == "stop_all"
    assert km.map("m").cmd == "stop_all"  # never debounced
    assert km.map("+").value == 80
    t[0] = 2.0
    assert km.map("-").value == 70
    assert km.map("x") is None
