import pytest
from fastapi.testclient import TestClient

from companion.api.app import app

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
MP4 = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 1024
WEBM_VIDEO = b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\x82\x84webm" + b"\x00" * 1024
HEIC = b"\x00\x00\x00\x18ftypheic" + b"\x00" * 64  # a still image in an MP4-like box
M4A = b"\x00\x00\x00\x18ftypM4A " + b"\x00" * 64  # audio only


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("COMPANION_DATA_DIR", str(tmp_path))
    with TestClient(app) as c:
        yield c


def test_ui_pages_and_assets_are_served(client):
    home = client.get("/")
    assert "<title>Companion / Care</title>" in home.text
    assert home.headers["cache-control"] == "no-cache"
    for asset in ("app.js", "db.js", "speech.js", "routing.js", "bridge.js", "styles.css",
                  "keyboard.js", "assets/DMSans-variable.ttf"):
        response = client.get(f"/care/{asset}")
        assert response.status_code == 200, asset
        assert response.headers['cache-control'] == 'no-cache'
    assert "<title>Companion</title>" in client.get("/classic").text  # §6 event screen
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


def test_videos_share_the_media_list_but_not_the_photos_list(client):
    pid = client.post("/profiles", json={"display_name": "Evelyn"}).json()["profile_id"]
    photo = client.post(f"/profiles/{pid}/photos?filename=beach.jpg", content=JPEG).json()
    mp4 = client.post(f"/profiles/{pid}/photos?filename=wave.mp4", content=MP4)
    webm = client.post(f"/profiles/{pid}/photos?filename=garden.webm", content=WEBM_VIDEO)
    assert mp4.status_code == 201 and webm.status_code == 201
    assert mp4.json()["type"] == "video" and mp4.json()["photo_id"].startswith("video-")
    assert photo["type"] == "image" and photo["bytes"] == len(JPEG)
    for still_or_audio in (HEIC, M4A):
        assert client.post(f"/profiles/{pid}/photos", content=still_or_audio).status_code == 415

    profile = client.get("/profiles").json()["profiles"][0]
    assert [m["type"] for m in profile["media"]] == ["image", "video", "video"]
    assert [p["photo_id"] for p in profile["photos"]] == [photo["photo_id"]]  # photo-only screens

    served = client.get(mp4.json()["url"])
    assert served.headers["content-type"] == "video/mp4" and served.content == MP4
    ranged = client.get(mp4.json()["url"], headers={"Range": "bytes=0-15"})
    assert ranged.status_code == 206 and ranged.content == MP4[:16]  # video seeking
    assert client.get(webm.json()["url"]).headers["content-type"] == "video/webm"
    assert client.delete(f"/profiles/{pid}/photos/{mp4.json()['photo_id']}").json() == {"ok": True}


def test_example_people_and_created_order(client):
    a = client.post("/profiles", json={"display_name": "María Elena", "example": True},
                    headers={"Idempotency-Key": "example-person-0"}).json()
    again = client.post("/profiles", json={"display_name": "María Elena", "example": True},
                        headers={"Idempotency-Key": "example-person-0"}).json()
    b = client.post("/profiles", json={"display_name": "Evelyn"}).json()
    assert a["profile_id"] == again["profile_id"]  # two screens seeding at once: one person
    assert a["example"] is True and b["example"] is False
    listed = client.get("/profiles").json()["profiles"]
    assert [p["profile_id"] for p in listed] == [a["profile_id"], b["profile_id"]]
    assert listed[0]["created_at"] <= listed[1]["created_at"]


def test_per_person_item_limit(client, monkeypatch):
    import companion.api.profiles as profiles

    monkeypatch.setattr(profiles, "MAX_ITEMS_PER_PERSON", 2)
    pid = client.post("/profiles", json={"display_name": "Evelyn"}).json()["profile_id"]
    for i in range(2):
        assert client.post(f"/profiles/{pid}/photos", content=JPEG,
                           headers={"Idempotency-Key": f"k{i}"}).status_code == 201
    full = client.post(f"/profiles/{pid}/photos", content=PNG)
    assert full.status_code == 409 and "Remove an item" in full.json()["detail"]
    # A retry of an upload that already succeeded still answers with that photo.
    assert client.post(f"/profiles/{pid}/photos", content=JPEG,
                       headers={"Idempotency-Key": "k0"}).status_code == 201


def test_glossary_is_the_person_s_name(client):
    pid = client.post("/profiles", json={"display_name": "Évelyn Nowak"}).json()["profile_id"]
    store = client.app.state.store
    assert store.glossary(pid) == ["Évelyn Nowak"]
    assert store.glossary("person-000000000000") == []
