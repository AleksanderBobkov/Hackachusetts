// Shared session/library updates and optional development controls from the backend.
// The production kiosk uses on-screen touch controls; no physical buttons are required.
//
// ?keys=1 (laptop dev only) sends the dev keys through that same path:
//   1 TALK (resident) · 2 TALK (visitor) · space TALK · m STOP_ALL · + / - volume
// Keys are off by default on the touch kiosk.

const ACTIONS = new Set(['WAKE', 'START_TURN', 'END_TURN', 'STOP_ALL', 'SET_VOLUME']);
const KEYS = new Map([['1', '1'], ['2', '2'], [' ', 'space'], ['m', 'm'], ['M', 'm'], ['+', '+'], ['=', '+'], ['-', '-'], ['_', '-']]);

/** Validate a relayed control event; returns the CustomEvent detail or null. */
export function controlDetail(message) {
  if (!message || message.type !== 'control' || !ACTIONS.has(message.action)) return null;
  const detail = { action: message.action };
  if (message.speaker === 'resident' || message.speaker === 'visitor') detail.speaker = message.speaker;
  if (typeof message.value === 'number' && message.value >= 0 && message.value <= 1) detail.value = message.value;
  return detail;
}

export function socketUrl(location = globalThis.location) {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
}

export function startBridge({ keys = false, target = globalThis, WebSocketImpl = globalThis.WebSocket, fetchImpl = (...args) => globalThis.fetch(...args), url = socketUrl() } = {}) {
  let socket = null, retryMs = 500, timer = null, stopped = false;
  const dispatch = detail => target.dispatchEvent(new CustomEvent('companion:control', { detail }));
  const connect = () => {
    if (stopped || !WebSocketImpl) return;
    let ws;
    try { ws = new WebSocketImpl(url); } catch { schedule(); return; }
    socket = ws;
    ws.onopen = () => {
      if (socket !== ws || stopped) return;
      retryMs = 500;
      target.dispatchEvent(new CustomEvent('companion:connection', { detail: { connected: true } }));
    };
    ws.onmessage = message => {
      if (socket !== ws || stopped) return;
      let data;
      try { data = JSON.parse(message.data); } catch { return; } // never invent a press
      const detail = controlDetail(data);
      if (detail) dispatch(detail);
      else if (data?.type === 'session' && ['reset', 'profile', 'mode'].includes(data.reason)) {
        target.dispatchEvent(new CustomEvent('companion:session', { detail: { reason: data.reason } }));
      } else if (data?.type === 'library') target.dispatchEvent(new CustomEvent('companion:library'));
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      socket = null;
      if (!stopped) target.dispatchEvent(new CustomEvent('companion:connection', { detail: { connected: false } }));
      schedule();
    };
    ws.onerror = () => ws.close();
  };
  const schedule = () => {
    if (stopped) return;
    clearTimeout(timer); timer = setTimeout(connect, retryMs); retryMs = Math.min(retryMs * 2, 5000);
  };
  const onKey = event => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    const key = KEYS.get(event.key);
    if (!key) return;
    const el = event.target;
    if (el?.closest?.('input, textarea, select, [contenteditable], dialog[open]')) return; // typing, or a dialog
    if (key === 'space' && el?.closest?.('button, a, [role="button"]')) return; // native activation
    if (key === 'space') event.preventDefault();
    fetchImpl('/controls', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) }).catch(() => {});
  };
  connect();
  if (keys) target.document?.addEventListener('keydown', onKey);
  return {
    get connected() { return socket?.readyState === 1; },
    stop() { stopped = true; clearTimeout(timer); target.document?.removeEventListener('keydown', onKey); socket?.close(); socket = null; },
    onKey,
  };
}
