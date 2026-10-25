import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechSession } from '../../care/speech.js';

class FakeAudio {
  static all = [];
  constructor(src) { this.src = src; this.volume = 1; this.paused = true; FakeAudio.all.push(this); }
  play() { this.paused = false; queueMicrotask(() => this.onplaying?.()); return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute() { this.src = ''; }
  load() {}
}

function harness({ voices = [] } = {}) {
  const states = [], results = [], errors = [], requests = [];
  FakeAudio.all = [];
  globalThis.Audio = FakeAudio;
  globalThis.SpeechSynthesisUtterance = class {};
  globalThis.speechSynthesis = { cancel() {}, getVoices: () => voices, speak() {} };
  const session = new SpeechSession(s => states.push(s), r => results.push(r), e => errors.push(e));
  session.serverVoice = true;
  return { session, states, results, errors, requests };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function audioResponse(requests, { ok = true, status = 200, body = {} } = {}) {
  return async (url, init) => {
    requests.push({ url, init });
    return { ok, status, blob: async () => new Blob(['RIFF....'], { type: 'audio/wav' }), json: async () => body };
  };
}

test('the device voice plays at the session volume and finishes cleanly', async () => {
  const h = harness(); h.session.volume = .6;
  globalThis.fetch = audioResponse(h.requests);
  const finished = h.session.speak('Hola', 'es');
  await tick();
  const [audio] = FakeAudio.all;
  assert.equal(audio.volume, .6); assert.equal(audio.paused, false);
  const request = h.requests[0];
  assert.equal(request.url, '/api/speak'); assert.equal(request.init.method, 'POST');
  assert.deepEqual(JSON.parse(request.init.body), { text: 'Hola', language: 'es' });
  assert.ok(h.states.includes('preparing') && h.states.includes('speaking'));
  audio.onended();
  assert.equal(await finished, true); assert.equal(h.session.state, 'ready'); assert.equal(h.errors.length, 0);
  assert.equal(h.session.audio, null);
});

test('pausing while the voice is prepared never plays late audio', async () => {
  const h = harness(); let respond;
  globalThis.fetch = (url, init) => new Promise(resolve => { respond = () => resolve({ ok: true, status: 200, blob: async () => new Blob(['x']) }); init.signal.addEventListener('abort', () => resolve({ ok: true, status: 200, blob: async () => new Blob(['late']) })); });
  const finished = h.session.speak('Hola', 'es');
  h.session.cancel(); respond?.();
  assert.equal(await finished, false); await tick();
  assert.equal(FakeAudio.all.length, 0); assert.equal(h.session.state, 'ready'); assert.equal(h.errors.length, 0);
});

test('pausing during playback stops the audio at once', async () => {
  const h = harness();
  globalThis.fetch = audioResponse(h.requests);
  const finished = h.session.speak('Hello', 'en');
  await tick();
  const [audio] = FakeAudio.all;
  h.session.cancel();
  assert.equal(await finished, false); assert.equal(audio.paused, true); assert.equal(audio.src, '');
  audio.onended?.(); // handlers were detached; a late 'ended' changes nothing
  assert.equal(h.session.state, 'ready');
});

test('a service error is shown when no browser voice can take over', async () => {
  const h = harness();
  globalThis.fetch = audioResponse(h.requests, { ok: false, status: 503, body: { error: 'Live translation is not connected. Try an example.' } });
  assert.equal(await h.session.speak('Hola', 'es'), false);
  assert.deepEqual(h.errors, ['Live translation is not connected. Try an example.']);
});

test('an installed browser voice for the same language takes over on failure', async () => {
  const spoken = [];
  const h = harness({ voices: [{ lang: 'es-ES' }] });
  globalThis.speechSynthesis.speak = utterance => spoken.push(utterance);
  globalThis.fetch = audioResponse(h.requests, { ok: false, status: 502, body: { error: 'Cannot connect right now.' } });
  const finished = h.session.speak('Hola', 'es');
  await tick();
  assert.equal(spoken.length, 1); assert.equal(spoken[0].lang, 'es-ES'); assert.equal(h.errors.length, 0);
  spoken[0].onend();
  assert.equal(await finished, true);
});

test('volume changes reach audio that is already playing', async () => {
  const h = harness();
  assert.equal(h.session.setVolume(.3), false); assert.equal(h.session.volume, .3);
  globalThis.fetch = audioResponse(h.requests);
  h.session.speak('Hola', 'es');
  await tick();
  assert.equal(h.session.setVolume(.9), true); assert.equal(FakeAudio.all[0].volume, .9);
  h.session.cancel();
});

test('a blocked autoplay pauses with a readable next step', async () => {
  const h = harness();
  globalThis.fetch = audioResponse(h.requests);
  FakeAudio.prototype.play = function () { return Promise.reject(new Error('NotAllowedError')); };
  try {
    assert.equal(await h.session.speak('Hola', 'es'), false);
    assert.match(h.errors[0], /Tap Read again/);
  } finally {
    FakeAudio.prototype.play = function () { this.paused = false; queueMicrotask(() => this.onplaying?.()); return Promise.resolve(); };
  }
});

test('detection results say when the service is simulated', async () => {
  const h = harness();
  const meta = { turn_id: 't', person_id: 'p', stage: 'detect', source_language: 'auto' };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ turn_id: 't', person_id: 'p', transcript: 'Hola, ¿cómo estás?', detected_language: 'es', detection_certain: true, simulated: true }) });
  await h.session.typed('Hola, ¿cómo estás?', meta);
  assert.equal(h.results[0].simulated, true); assert.equal(h.results[0].detection_certain, true);
});
