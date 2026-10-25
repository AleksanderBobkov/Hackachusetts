import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore, uploadKey, newId, StoreError, OFFLINE_MESSAGE } from '../../care/db.js';

const PERSON = 'person-aaaaaaaaaaaa';
const profile = {
  profile_id: PERSON, display_name: 'Evelyn', created_at: 1700000000.25, example: false, active: false,
  photos: [{ photo_id: 'photo-bbbbbbbbbbbb', url: '/photos/photo-bbbbbbbbbbbb.jpg', name: 'beach.jpg', type: 'image', bytes: 1234 }],
  media: [
    { photo_id: 'photo-bbbbbbbbbbbb', url: '/photos/photo-bbbbbbbbbbbb.jpg', name: 'beach.jpg', type: 'image', bytes: 1234 },
    { photo_id: 'video-cccccccccccc', url: '/photos/video-cccccccccccc.mp4', name: 'wave.mp4', type: 'video', bytes: 5678 },
  ],
};

/** Fake device service: routes are "METHOD /path" → (init, url) => {status, body, blob}. */
function serve(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const handler = routes[`${init.method || 'GET'} ${url.split('?')[0]}`];
    if (!handler) return { ok: false, status: 404, json: async () => ({ detail: 'Not found' }) };
    const { status = 200, body = null, blob } = await handler(init, url);
    return { ok: status < 400, status, json: async () => { if (body === null) throw new SyntaxError('empty'); return body; }, blob: async () => blob };
  };
  return calls;
}
const listing = () => ({ body: { profiles: [profile], active_profile_id: null } });

test('shared active person is read and activated through the backend', async () => {
  const calls=serve({'GET /profiles':listing,'GET /profiles/active':()=>({body:{profile}}),[`POST /profiles/${PERSON}/activate`]:()=>({body:{...profile,active:true}})});
  const store=await openStore();
  assert.equal((await store.activePerson()).id,PERSON);
  assert.equal((await store.activatePerson(PERSON)).id,PERSON);
  assert.deepEqual(JSON.parse(calls.find(c=>c.init.method==='POST').init.body),{mode:'translate'});
});

test('people come from the device with server IDs, photos and videos', async () => {
  serve({ 'GET /profiles': listing });
  const store = await openStore();
  const [person] = await store.people();
  assert.equal(person.id, PERSON); assert.equal(person.name, 'Evelyn'); assert.equal(person.created, 1700000000250);
  assert.deepEqual(person.media.map(m => [m.id, m.type, m.size, m.display]), [
    ['photo-bbbbbbbbbbbb', 'image', 1234, '/photos/photo-bbbbbbbbbbbb.jpg'],
    ['video-cccccccccccc', 'video', 5678, '/photos/video-cccccccccccc.mp4'],
  ]);
  assert.equal((await store.media(PERSON)).length, 2);
  assert.equal((await store.allMedia()).length, 2);
});

test('creating a person sends the name once, keyed against duplicates', async () => {
  const calls = serve({ 'GET /profiles': listing, 'POST /profiles': init => ({ status: 201, body: { ...profile, profile_id: 'person-dddddddddddd', display_name: JSON.parse(init.body).display_name, media: [], photos: [] } }) });
  const store = await openStore();
  const saved = await store.savePerson({ name: 'Amina', example: true }, { key: 'k-1' });
  assert.equal(saved.id, 'person-dddddddddddd'); assert.equal(saved.name, 'Amina');
  const post = calls.find(c => c.init.method === 'POST');
  assert.deepEqual(JSON.parse(post.init.body), { display_name: 'Amina', example: true });
  assert.equal(post.init.headers['Idempotency-Key'], 'k-1');
});

test('renaming uses the stable ID, not the name', async () => {
  const calls = serve({ 'GET /profiles': listing, [`PUT /profiles/${PERSON}`]: init => ({ body: { ...profile, display_name: JSON.parse(init.body).display_name } }) });
  const store = await openStore();
  const saved = await store.savePerson({ id: PERSON, name: 'Evelyn Nowak' });
  assert.equal(saved.name, 'Evelyn Nowak');
  assert.ok(calls.some(c => c.init.method === 'PUT' && c.url === `/profiles/${PERSON}`));
});

test('uploads send the prepared bytes with their type, filename and key', async () => {
  const calls = serve({ 'GET /profiles': listing, [`POST /profiles/${PERSON}/photos`]: () => ({ status: 201, body: { photo_id: 'photo-eeeeeeeeeeee', url: '/photos/photo-eeeeeeeeeeee.jpg', name: 'Café.jpg', type: 'image', bytes: 3 } }) });
  const store = await openStore();
  const upload = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
  const stored = await store.saveMedia({ personId: PERSON, name: 'Café.jpg', upload }, { key: 'upload-1' });
  assert.deepEqual([stored.id, stored.personId, stored.size, stored.url], ['photo-eeeeeeeeeeee', PERSON, 3, '/photos/photo-eeeeeeeeeeee.jpg']);
  const post = calls.find(c => c.init.method === 'POST');
  assert.equal(post.url, `/profiles/${PERSON}/photos?filename=Caf%C3%A9.jpg`);
  assert.equal(post.init.body, upload);
  assert.equal(post.init.headers['Content-Type'], 'image/jpeg'); assert.equal(post.init.headers['Idempotency-Key'], 'upload-1');
});

test('removing keeps an in-memory copy so Undo can restore it', async () => {
  const bytes = new Blob(['jpeg-bytes'], { type: 'image/jpeg' });
  const calls = serve({ 'GET /profiles': listing, 'GET /photos/photo-bbbbbbbbbbbb.jpg': () => ({ blob: bytes }), [`DELETE /profiles/${PERSON}/photos/photo-bbbbbbbbbbbb`]: () => ({ body: { ok: true } }) });
  const store = await openStore();
  const [item] = await store.media(PERSON);
  const restorable = await store.removeMedia(item);
  assert.equal(restorable.upload, bytes); assert.equal(restorable.size, bytes.size); assert.ok(restorable.restoreKey);
  const order = calls.map(c => `${c.init.method || 'GET'} ${c.url}`).slice(-2);
  assert.deepEqual(order, ['GET /photos/photo-bbbbbbbbbbbb.jpg', `DELETE /profiles/${PERSON}/photos/photo-bbbbbbbbbbbb`]);
});

test('a file that cannot be copied first is not removed', async () => {
  const calls = serve({ 'GET /profiles': listing, 'GET /photos/photo-bbbbbbbbbbbb.jpg': () => ({ status: 404 }) });
  const store = await openStore();
  const [item] = await store.media(PERSON);
  await assert.rejects(store.removeMedia(item), /could not be removed/);
  assert.ok(!calls.some(c => c.init.method === 'DELETE'));
});

test('errors carry readable copy: validation text, generic 5xx, offline', async () => {
  serve({ 'GET /profiles': listing, 'POST /profiles': () => ({ status: 422, body: { detail: [{ msg: 'Value error, Enter a name to continue' }] } }) });
  let store = await openStore();
  await assert.rejects(store.savePerson({ name: ' ' }), err => err instanceof StoreError && err.message === 'Enter a name to continue' && err.status === 422);
  serve({ 'GET /profiles': listing, 'POST /profiles': () => ({ status: 500, body: { detail: 'Internal Server Error' } }) });
  store = await openStore();
  await assert.rejects(store.savePerson({ name: 'A' }), { message: 'Something went wrong. Please try again.' });
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(openStore(), err => err.message === OFFLINE_MESSAGE && err.status === 0);
});

test('upload keys are stable per person and file, and header-safe', () => {
  const file = { name: 'Zdjęcie z lata.jpg', size: 2048, lastModified: 1700000000000 };
  const key = uploadKey(PERSON, file);
  assert.equal(key, uploadKey(PERSON, { ...file }));
  assert.notEqual(key, uploadKey(PERSON, { ...file, lastModified: 1 }));
  assert.notEqual(key, uploadKey('person-ffffffffffff', file));
  assert.match(key, /^upload-[0-9a-f]{16}$/);
});

test('IDs work without a secure context (no randomUUID)', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues: a => { for (let i = 0; i < a.length; i++) a[i] = (i * 37) & 255; return a; } }, configurable: true });
  try { assert.match(newId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); }
  finally { Object.defineProperty(globalThis, 'crypto', original); }
});
