// WebSocket client for the backend contract (docs/architecture.md §6).
// Reconnects with backoff. The server is the source of truth for state; this only relays.

export class CompanionSocket {
  /**
   * @param {object} opts
   * @param {(event: object) => void} opts.onEvent
   * @param {(connected: boolean) => void} opts.onConnection
   * @param {string} [opts.query] extra query string, e.g. "mock=1&loop=1"
   */
  constructor({ onEvent, onConnection, query = "" }) {
    this.onEvent = onEvent;
    this.onConnection = onConnection;
    this.query = query;
    this.ws = null;
    this.retryMs = 500;
    this.connected = false;
    this._timer = null;
  }

  url() {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    return `${scheme}//${location.host}/ws${this.query ? `?${this.query}` : ""}`;
  }

  connect() {
    clearTimeout(this._timer);
    let ws;
    try {
      ws = new WebSocket(this.url());
    } catch {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retryMs = 500;
      this._setConnected(true);
    };
    ws.onmessage = (msg) => {
      let event;
      try {
        event = JSON.parse(msg.data);
      } catch {
        return; // ignore malformed frames; never invent state
      }
      this.onEvent(event);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this._setConnected(false);
      this._scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  _scheduleReconnect() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 5000);
  }

  _setConnected(value) {
    if (this.connected === value) return;
    this.connected = value;
    this.onConnection(value);
  }

  /** Send a command. Returns false when not connected (caller shows the offline state). */
  send(command) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(command));
    return true;
  }
}
