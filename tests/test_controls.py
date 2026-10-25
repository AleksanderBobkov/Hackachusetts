"""Physical controls: POST /controls → backend effects + ``control`` events on /ws."""

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from companion.api.app import app
from companion.controls import KeyMapper


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("COMPANION_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PROVIDER", "mock")
    with TestClient(app) as c:
        clock = [0.0]
        c.app.state.keys = KeyMapper(clock=lambda: clock[0])
        c.clock = clock
        yield c


def control(action, speaker=None, value=None):
    return {"type": "control", "action": action, "speaker": speaker, "value": value}


def test_key_presses_are_debounced_and_relayed_to_screens(client):
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_json()["type"] == "state"  # initial snapshot
        assert client.post("/controls", json={"key": "1"}).json() == {
            "ok": True, "relayed": control("START_TURN", "resident")}
        assert ws.receive_json() == control("START_TURN", "resident")
        assert client.post("/controls", json={"key": "1"}).json()["relayed"] is None  # bounce
        client.clock[0] = 1.0
        client.post("/controls", json={"key": "2"})
        assert ws.receive_json() == control("START_TURN", "visitor")
        client.post("/controls", json={"key": "space"})
        assert ws.receive_json() == control("START_TURN", "resident")
        client.post("/controls", json={"key": "+"})
        assert ws.receive_json() == control("SET_VOLUME", value=0.8)
        assert client.app.state.orch.volume == 80
        assert client.post("/controls", json={"key": "x"}).json()["relayed"] is None


def test_stop_all_mutes_the_backend_and_every_screen(client):
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        client.post("/controls", json={"key": "m"})
        assert ws.receive_json()["state"] == "muted"
        assert ws.receive_json() == control("STOP_ALL")
        client.post("/controls", json={"key": "m"})  # never debounced
        assert ws.receive_json()["state"] == "muted"
        assert ws.receive_json() == control("STOP_ALL")
    assert client.get("/health").json()["state"] == "muted"


def test_direct_actions_from_a_hardware_bridge(client):
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        client.post("/controls", json={"action": "WAKE"})
        assert ws.receive_json() == control("WAKE")
        client.post("/controls", json={"action": "SET_VOLUME", "value": 0.3})
        assert ws.receive_json() == control("SET_VOLUME", value=0.3)
        assert client.app.state.orch.volume == 30


@pytest.mark.parametrize("body", [
    {},
    {"key": "1", "action": "WAKE"},
    {"action": "SET_VOLUME"},
    {"action": "SET_VOLUME", "value": 2},
    {"action": "LAUNCH"},
    {"action": "START_TURN", "speaker": "a"},
    {"key": ""},
])
def test_invalid_controls_are_rejected(client, body):
    assert client.post("/controls", json=body).status_code == 422


def test_cross_site_pages_cannot_press_buttons_or_listen(client):
    assert client.post("/controls", json={"key": "m"},
                       headers={"Origin": "https://evil.example"}).status_code == 403
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws", headers={"Origin": "https://evil.example"}):
            pass
    with client.websocket_connect("/ws", headers={"Origin": "http://testserver"}) as ws:
        assert ws.receive_json()["type"] == "state"
