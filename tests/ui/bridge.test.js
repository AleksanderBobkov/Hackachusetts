import test from 'node:test';
import assert from 'node:assert/strict';
import { controlDetail, socketUrl, startBridge } from '../../care/bridge.js';

class FakeSocket {
  static all = [];
  constructor(url) { this.url = url; this.readyState = 0; FakeSocket.all.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(data) { this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

function setup(options = {}) {
  FakeSocket.all = [];
  const target = new EventTarget();
  const doc = new EventTarget();
  target.document = doc;
  const received = [], posted = [];
  target.addEventListener('companion:control', event => received.push(event.detail));
  const fetchImpl = async (url, init) => { posted.push({ url, body: JSON.parse(init.body) }); return { ok: true }; };
  const bridge = startBridge({ target, WebSocketImpl: FakeSocket, fetchImpl, url: 'ws://device/ws', ...options });
  return { bridge, target, doc, received, posted, socket: () => FakeSocket.all.at(-1) };
}

function key(keyName, { target = null, ...rest } = {}) {
  let prevented = false;
  return { key: keyName, repeat: false, altKey: false, ctrlKey: false, metaKey: false, target, preventDefault() { prevented = true; }, get prevented() { return prevented; }, ...rest };
}

test('only well-formed control events become presses', () => {
  assert.deepEqual(controlDetail({ type: 'control', action: 'START_TURN', speaker: 'visitor', value: null }), { action: 'START_TURN', speaker: 'visitor' });
  assert.deepEqual(controlDetail({ type: 'control', action: 'SET_VOLUME', value: 0.4 }), { action: 'SET_VOLUME', value: 0.4 });
  assert.deepEqual(controlDetail({ type: 'control', action: 'STOP_ALL', speaker: 'a', value: 7 }), { action: 'STOP_ALL' });
  assert.equal(controlDetail({ type: 'state', state: 'muted' }), null);
  assert.equal(controlDetail({ type: 'control', action: 'LAUNCH' }), null);
  assert.equal(socketUrl({ protocol: 'https:', host: 'pi.local:8000' }), 'wss://pi.local:8000/ws');
});

test('relayed hardware presses are dispatched; other events and junk are ignored', () => {
  const { received, socket, bridge } = setup();
  socket().open();
  socket().receive({ type: 'state', state: 'idle', mode: 'translate', speaker: null, turn_id: null });
  socket().receive('not json');
  socket().receive({ type: 'control', action: 'START_TURN', speaker: 'resident', value: null });
  socket().receive({ type: 'control', action: 'STOP_ALL', speaker: null, value: null });
  assert.deepEqual(received, [{ action: 'START_TURN', speaker: 'resident' }, { action: 'STOP_ALL' }]);
  assert.equal(bridge.connected, true);
  bridge.stop();
});

test('the bridge reconnects with backoff after the device restarts', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { socket, bridge } = setup();
  const first = socket();
  first.close();
  assert.equal(FakeSocket.all.length, 1);
  t.mock.timers.tick(500);
  assert.equal(FakeSocket.all.length, 2);
  socket().close();
  t.mock.timers.tick(500);
  assert.equal(FakeSocket.all.length, 2); // backoff doubled
  t.mock.timers.tick(500);
  assert.equal(FakeSocket.all.length, 3);
  bridge.stop();
  socket().close();
  t.mock.timers.tick(10000);
  assert.equal(FakeSocket.all.length, 3); // stopped bridges stay stopped
});

test('dev keys go through the device service, never while typing', () => {
  const { bridge, posted } = setup({ keys: true });
  const field = { closest: selector => selector.includes('input') ? {} : null };
  const button = { closest: selector => selector.includes('button') && !selector.includes('input') ? {} : null };
  const plain = { closest: () => null };
  bridge.onKey(key('1', { target: plain }));
  bridge.onKey(key('M', { target: plain }));
  bridge.onKey(key('=', { target: plain }));
  bridge.onKey(key('1', { target: field }));             // typing a name
  bridge.onKey(key('1', { target: plain, repeat: true })); // held key
  bridge.onKey(key('2', { target: plain, ctrlKey: true }));
  bridge.onKey(key(' ', { target: button }));            // native button activation
  const space = key(' ', { target: plain });
  bridge.onKey(space);
  bridge.onKey(key('x', { target: plain }));
  assert.deepEqual(posted.map(p => p.body.key), ['1', 'm', '+', 'space']);
  assert.ok(posted.every(p => p.url === '/controls'));
  assert.equal(space.prevented, true);
  bridge.stop();
});

test('keys stay off unless asked for', () => {
  const { doc, posted, bridge } = setup();
  doc.dispatchEvent(Object.assign(new Event('keydown'), { key: '1' }));
  assert.equal(posted.length, 0);
  bridge.stop();
});

test('session invalidation, library updates and connection loss reach the touch UI', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { target, socket, bridge } = setup();
  const changes=[];
  for(const type of ['session','library','connection'])target.addEventListener(`companion:${type}`,event=>changes.push([type,event.detail]));
  const first=socket();first.open();
  first.receive({type:'session',reason:'reset'});
  first.receive({type:'session',reason:'profile'});
  first.receive({type:'session',reason:'invalid'});
  first.receive({type:'library'});
  first.close();
  t.mock.timers.tick(500);
  socket().open();
  first.receive({type:'session',reason:'reset'}); // stale socket cannot stop the new session
  assert.deepEqual(changes,[['connection',{connected:true}],['session',{reason:'reset'}],['session',{reason:'profile'}],['library',null],['connection',{connected:false}],['connection',{connected:true}]]);
  bridge.stop();
});
