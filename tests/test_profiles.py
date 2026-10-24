import pytest
from fastapi.testclient import TestClient

from companion.api.app import app

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("COMPANION_DATA_DIR", str(tmp_path))
    with TestClient(app) as c:
        yield c


def test_ui_pages_and_assets_are_served(client):
    assert "Companion" in client.get("/").text
    assert "Companion setup" in client.get("/setup").text
    assert client.get("/ui/companion.js").status_code == 200
    assert client.get("/design/tokens.css").status_code == 200


def test_create_is_idempotent_and_name_is_validated(client):
    r1 = client.post("/profiles", json={"display_name": "  Évelyn Nowak-Kowalska "},
                     headers={"Idempotency-Key": "k1"})
    r2 = client.post("/profiles", json={"display_name": "Évelyn Nowak-Kowalska"},
                     headers={"Idempotency-Key": "k1"})
    assert r1.status_code == 201
    assert r1.json()["profile_id"] == r2.json()["profile_id"]
    assert r1.json()["display_name"] == "Évelyn Nowak-Kowalska"
    assert len(client.get("/profiles").json()["profiles"]) == 1

    bad = client.post("/profiles", json={"display_name": "   "})
    assert bad.status_code == 422
    assert "Enter a name to continue" in str(bad.json())


def test_photos_upload_serve_remove(client, tmp_path):
    pid = client.post("/profiles", json={"display_name": "Evelyn"}).json()["profile_id"]
    up = client.post(f"/profiles/{pid}/photos?filename=../../etc/beach.jpg", content=JPEG,
                     headers={"Content-Type": "image/jpeg", "Idempotency-Key": "p1"})
    assert up.status_code == 201
    photo = up.json()
    assert photo["name"] == "beach.jpg"  # display-only, path stripped
    again = client.post(f"/profiles/{pid}/photos", content=JPEG,
                        headers={"Content-Type": "image/jpeg", "Idempotency-Key": "p1"})
    assert again.json()["photo_id"] == photo["photo_id"]

    served = client.get(photo["url"])
    assert served.status_code == 200 and served.content == JPEG
    assert served.headers["content-type"] == "image/jpeg"

    not_image = client.post(f"/profiles/{pid}/photos", content=b"hello",
                            headers={"Content-Type": "image/jpeg"})
    assert not_image.status_code == 415

    assert client.delete(f"/profiles/{pid}/photos/{photo['photo_id']}").json() == {"ok": True}
    assert client.get(photo["url"]).status_code == 404
    assert not list((tmp_path / "photos").iterdir())


def test_photo_route_rejects_traversal(client):
    assert client.get("/photos/..%2Fprofiles.json").status_code == 404
    assert client.get("/photos/profiles.json").status_code == 404


def test_activate_sets_active_person_and_mode(client):
    a = client.post("/profiles", json={"display_name": "A"}).json()["profile_id"]
    b = client.post("/profiles", json={"display_name": "B"}).json()["profile_id"]
    client.post(f"/profiles/{b}/photos", content=PNG, headers={"Content-Type": "image/png"})
    assert client.get("/profiles/active").json() == {"profile": None}

    r = client.post(f"/profiles/{b}/activate", json={"mode": "companion"})
    assert r.status_code == 200 and r.json()["active"] is True
    active = client.get("/profiles/active").json()["profile"]
    assert active["profile_id"] == b and len(active["photos"]) == 1
    assert client.get("/health").json()["mode"] == "companion"

    listed = {p["profile_id"]: p["active"] for p in client.get("/profiles").json()["profiles"]}
    assert listed == {a: False, b: True}
    assert client.post("/profiles/person-000000000000/activate", json={}).status_code == 404


def test_store_survives_restart(tmp_path, monkeypatch):
    monkeypatch.setenv("COMPANION_DATA_DIR", str(tmp_path))
    with TestClient(app) as c:
        pid = c.post("/profiles", json={"display_name": "Evelyn"}).json()["profile_id"]
        c.post(f"/profiles/{pid}/activate", json={"mode": "translate"})
    with TestClient(app) as c:
        assert c.get("/profiles/active").json()["profile"]["display_name"] == "Evelyn"
