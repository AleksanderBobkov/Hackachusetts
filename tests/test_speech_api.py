"""HTTP speech adapter used by the Companion / Care screen (/api/capabilities, /api/turn, /api/speak)."""

import asyncio
import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from companion.api.app import app, lifespan
from companion.speech.stt import MOCK_SCRIPT

WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 2048  # EBML header + padding; the mock ignores content
SILENCE = b"\x1a\x45\xdf\xa3" + b"\x00" * 16  # under 1 KB: the mock hears nothing


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("COMPANION_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("PROVIDER", "mock")
    monkeypatch.setenv("MOCK_DELAY_S", "0")
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    return monkeypatch


@pytest.fixture()
def client(env):
    with TestClient(app) as c:
        yield c


def metadata(stage="detect", **extra):
    return json.dumps({"turn_id": "turn-1", "person_id": "person-1", "stage": stage,
                       "source_language": "auto",
                       "preferred_output_languages": {"resident": "es", "visitor": "en"}, **extra})


def turn_files(stage="detect", audio=None, text=None, **extra):
    """Multipart exactly like the screen's FormData (fields without a filename are text)."""
    files = {"metadata": (None, metadata(stage, **extra))}
    if text is not None:
        files["text"] = (None, text)
    if audio is not None:
        files["audio"] = ("turn.webm", audio, "audio/webm;codecs=opus")
    return files


def post_turn(client, stage="detect", audio=None, text=None, headers=None, **extra):
    return client.post("/api/turn", files=turn_files(stage, audio, text, **extra), headers=headers)


def test_capabilities_report_a_simulated_service(client):
    caps = client.get("/api/capabilities").json()
    assert caps["speech"] and caps["translation"] and caps["auto_detect"] and caps["tts"]
    assert caps["simulated"] is True and caps["remote"] is False and caps["provider"] == "mock"
    assert caps["machine_translation"] is True
    assert {"en", "es", "pl"} <= set(caps["output_languages"])
    assert not any("key" in k.lower() for k in caps)


def test_detect_audio_routes_by_language_and_one_word_replies_ask(client):
    results = [post_turn(client, audio=WEBM).json() for _ in MOCK_SCRIPT]
    assert [(r["detected_language"], r["detection_certain"]) for r in results] == [
        ("es", True), ("en", True), ("pl", True), ("en", False)]  # "Okay." → Who is this for?
    assert results[0]["transcript"] == MOCK_SCRIPT[0][1]
    assert all(r["turn_id"] == "turn-1" and r["person_id"] == "person-1" for r in results)
    assert all(r["simulated"] is True for r in results)


@pytest.mark.parametrize("text,language,certain", [
    ("Je suis heureux de vous voir.", "fr", True),
    ("Tengo frío. ¿Me puede traer una manta?", "es", True),
    ("Okay.", "en", False),
    ("Hmm", None, False),
])
def test_detect_typed_words(client, text, language, certain):
    body = post_turn(client, text=text).json()
    assert body["transcript"] == text
    assert body["detected_language"] == language and body["detection_certain"] is certain


def test_translate_echoes_ids_and_target_and_labels_the_result(client):
    r = post_turn(client, "translate", text="Me alegra mucho que estés aquí.",
                  recipient="visitor", target_language="en")
    assert r.status_code == 200
    assert r.json() == {
        "turn_id": "turn-1", "person_id": "person-1", "target_language": "en",
        "transcript": "Me alegra mucho que estés aquí.", "translation": "I'm so glad you're here.",
        "pronunciation": "", "machine_translation": True, "simulated": True,
    }


def test_translate_romanized_target_and_marked_fallbacks(client):
    ko = post_turn(client, "translate", text="I'm happy to see you too, Grandma.",
                   recipient="resident", target_language="ko").json()
    assert ko["translation"] == "저도 만나서 반가워요, 할머니." and ko["pronunciation"]
    unknown = post_turn(client, "translate", text="Good morning, everyone.", target_language="es").json()
    assert unknown["translation"] == "[es] Good morning, everyone."  # visibly not a translation
    same = post_turn(client, "translate", text="Good morning, everyone.", target_language="en").json()
    assert same["translation"] == "Good morning, everyone."


def test_unsupported_output_language_keeps_the_original_words(client):
    r = post_turn(client, "translate", text="Hola", target_language="de")
    assert r.status_code == 422
    assert r.json() == {"error": "Translation isn't available for this language yet.",
                        "turn_id": "turn-1", "person_id": "person-1", "transcript": "Hola"}


def test_no_speech_is_an_error_not_an_empty_transcript(client):
    r = post_turn(client, audio=SILENCE)
    assert r.status_code == 422
    assert r.json() == {"error": "I didn't catch that. Please try again.",
                        "turn_id": "turn-1", "person_id": "person-1"}


def test_malformed_turns_are_rejected_with_readable_errors(client):
    def status(**kwargs):
        return client.post("/api/turn", **kwargs).status_code

    assert status(files={"text": (None, "Hola")}) == 400  # no metadata
    assert status(files={"metadata": (None, "{not json")}) == 400
    assert status(files={"metadata": (None, metadata())}) == 400  # neither audio nor text
    assert status(json={"metadata": metadata(), "text": "Hola"}) == 415  # must be multipart
    assert post_turn(client, audio=b"not audio at all" * 100).status_code == 415
    assert post_turn(client, "translate", audio=WEBM, target_language="en").status_code == 400
    assert post_turn(client, text="x" * 2001).status_code == 413
    assert post_turn(client, text="   ").status_code == 400
    long_id = json.dumps({"turn_id": "t" * 500, "person_id": "p", "stage": "detect"})
    assert status(files={"metadata": (None, long_id), "text": (None, "Hola")}) == 400


def test_cross_site_requests_are_blocked(client):
    evil = post_turn(client, text="Hola", headers={"Origin": "https://evil.example"})
    assert evil.status_code == 403
    same = post_turn(client, text="Hola", headers={"Origin": "http://testserver"})
    assert same.status_code == 200
    blocked_speak = client.post("/api/speak", json={"text": "Hola", "language": "es"},
                                headers={"Origin": "null"})
    assert blocked_speak.status_code == 403


def test_speak_returns_playable_audio(client):
    r = client.post("/api/speak", json={"text": "Hola", "language": "es"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav" and r.content[:4] == b"RIFF"
    assert r.headers["x-simulated"] == "1" and r.headers["cache-control"] == "no-store"
    assert client.post("/api/speak", json={"text": "  ", "language": "es"}).status_code == 422
    assert client.post("/api/speak", json={"text": "a" * 4097, "language": "es"}).status_code == 413
    assert client.post("/api/speak", json={"text": "Hola", "language": "123"}).status_code == 422


def test_slow_provider_becomes_a_network_error(env):
    env.setenv("MOCK_DELAY_S", "1")
    env.setenv("PROVIDER_TIMEOUT_S", "0.05")
    with TestClient(app) as c:
        r = post_turn(c, audio=WEBM)
    assert r.status_code == 504
    assert r.json()["error"] == "The service took too long to respond. Please try again."


def test_openai_without_a_key_is_reported_as_not_connected(env):
    env.setenv("PROVIDER", "openai")
    with TestClient(app) as c:
        caps = c.get("/api/capabilities").json()
        assert not any(caps[k] for k in ("speech", "translation", "auto_detect", "tts"))
        assert caps["remote"] is True
        r = post_turn(c, audio=WEBM)
        assert r.status_code == 503 and "not connected" in r.json()["error"]
        assert c.post("/api/speak", json={"text": "Hola", "language": "es"}).status_code == 503


async def _wait_in_flight(n: int = 1) -> None:
    for _ in range(200):
        if app.state.speech.in_flight >= n:
            return
        await asyncio.sleep(0.01)
    raise AssertionError("speech request never started")


@pytest.mark.parametrize("stop", ["controls", "reset"])
async def test_stop_all_and_reset_cancel_an_in_flight_request(env, stop):
    env.setenv("MOCK_DELAY_S", "5")
    async with lifespan(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as c:
            turn = asyncio.create_task(c.post("/api/turn", files=turn_files(audio=WEBM)))
            await _wait_in_flight()
            t0 = time.perf_counter()
            if stop == "controls":
                assert (await c.post("/controls", json={"action": "STOP_ALL"})).status_code == 200
            else:
                assert (await c.post("/session/reset")).json() == {"ok": True}
            response = await asyncio.wait_for(turn, 2)
            assert time.perf_counter() - t0 < 1.0
            assert response.status_code == 409
            assert response.json()["turn_id"] == "turn-1" and "Stopped" in response.json()["error"]
            assert app.state.speech.in_flight == 0
            expected = "muted" if stop == "controls" else "idle"
            assert (await c.get("/health")).json()["state"] == expected
