"""The browser owns recording/playback, so REST session changes must reach its socket."""

import pytest
from fastapi.testclient import TestClient

from companion.api.app import app
from companion.events import dump, parse_event


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("COMPANION_DATA_DIR", str(tmp_path))
    with TestClient(app) as c:
        yield c


def test_reset_and_mode_switch_invalidate_browser_session(client):
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_json()["type"] == "state"
        client.post("/session/reset")
        assert ws.receive_json()["state"] == "idle"
        event = ws.receive_json()
        assert event == {"type": "session", "reason": "reset"}
        assert dump(parse_event(event)) == event
        ws.send_json({"cmd": "set_mode", "mode": "translate"})
        assert ws.receive_json()["state"] == "idle"
        assert ws.receive_json() == {"type": "session", "reason": "mode"}


def test_profile_changes_notify_kiosk_and_activation_stops_its_session(client):
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        pid = client.post("/profiles", json={"display_name": "Test Person"}).json()["profile_id"]
        assert ws.receive_json() == {"type": "library"}
        client.post(f"/profiles/{pid}/activate", json={"mode": "translate"})
        assert ws.receive_json()["state"] == "idle"
        assert ws.receive_json() == {"type": "session", "reason": "profile"}
        assert client.get("/profiles/active").json()["profile"]["profile_id"] == pid
        client.put(f"/profiles/{pid}", json={"display_name": "Renamed Person"})
        assert ws.receive_json() == {"type": "library"}
        photo = client.post(f"/profiles/{pid}/photos", content=b"\xff\xd8\xff" + bytes(64)).json()
        assert ws.receive_json() == {"type": "library"}
        client.delete(f"/profiles/{pid}/photos/{photo['photo_id']}")
        assert ws.receive_json() == {"type": "library"}
