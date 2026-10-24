// The phone's connection to the event, shared by the participant and judge pages.
// It reconnects by itself, keeps the phone's id in localStorage (per address, so a new tunnel
// link means getting back in by name), measures the server's clock, and resends any action that
// wasn't answered before the connection dropped. The server ignores an action it already did.
// Testing on one laptop: add ?p=2, ?p=3 … to the address to be a different phone per window.

const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 4000;
// The server pings every 2s, so this much silence means the connection is stuck.
const STALE_OPEN_MS = 6000;
const STALE_CONNECTING_MS = 8000;

const SUFFIX = (new URLSearchParams(location.search).get("p") ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 8);

export function storeKey(name) {
  return `uu-${name}${SUFFIX ? `-${SUFFIX}` : ""}`;
}

export function readStore(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? {};
  } catch {
    return {};
  }
}

export function writeStore(key, patch) {
  try {
    localStorage.setItem(key, JSON.stringify({ ...readStore(key), ...patch }));
  } catch {
    // Private mode: the phone just won't remember.
  }
}

function randomId(bytes = 16) {
  if (globalThis.crypto?.randomUUID && bytes === 16) return crypto.randomUUID();
  // randomUUID needs https; the same-Wi-Fi mode runs over plain http.
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const newOpId = () => randomId(8);

/*
  connect({ key, onMessage, onStatus })
  onStatus(status, detail): "connecting" | "online" | "offline" | "moved" | "removed" | "restarting"
  Returns { send(msg), act(msg) → Promise<reply>, serverNow(), clientId, reconnect() }.
*/
export function connect({ key, onMessage, onStatus }) {
  const stored = readStore(key);
  const clientId = stored.id ?? randomId();
  writeStore(key, { id: clientId });

  let ws = null;
  let wantOnline = true;
  let retryMs = RETRY_MIN_MS;
  let retryTimer = 0;
  let lastHeardAt = performance.now();
  // Server clock: offset from Date.now(), from the quickest round trip (Date.now() keeps
  // counting while a phone is locked, unlike performance.now()).
  let offset = 0;
  let bestRtt = Infinity;
  const pending = new Map(); // op -> { msg, resolve }

  const isOpen = () => ws?.readyState === WebSocket.OPEN;

  function rawSend(msg) {
    if (!isOpen()) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  function sync() {
    bestRtt = Infinity;
    for (let i = 0; i < 3; i += 1) setTimeout(() => rawSend({ t: "sync", c: Date.now() }), i * 150);
  }

  function open() {
    clearTimeout(retryTimer);
    if (!wantOnline || (ws && ws.readyState <= WebSocket.OPEN)) return;
    const url = new URL("ws", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const sock = new WebSocket(url);
    ws = sock;
    lastHeardAt = performance.now();
    onStatus("connecting");
    sock.onopen = () => {
      if (ws !== sock) return sock.close();
      retryMs = RETRY_MIN_MS;
      lastHeardAt = performance.now();
      sock.send(JSON.stringify({ t: "hello", cid: clientId }));
      sync();
    };
    sock.onmessage = (event) => {
      if (ws !== sock) return;
      lastHeardAt = performance.now();
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.t === "ping") {
        rawSend({ t: "pong" });
        if (bestRtt === Infinity) offset = msg.s - Date.now();
        return;
      }
      if (msg.t === "sync") {
        const now = Date.now();
        const rtt = now - msg.c;
        if (rtt >= 0 && rtt < bestRtt) {
          bestRtt = rtt;
          offset = msg.s + rtt / 2 - now;
        }
        return;
      }
      if (msg.t === "hi") {
        if (bestRtt === Infinity) offset = msg.serverNow - Date.now();
        onStatus("online");
        // Anything not answered before the drop goes again; the server knows if it's done.
        for (const { msg: queued } of pending.values()) rawSend(queued);
      }
      if ((msg.t === "ok" || msg.t === "no" || msg.t === "found") && pending.has(msg.op)) {
        const { resolve } = pending.get(msg.op);
        pending.delete(msg.op);
        resolve(msg);
      }
      onMessage(msg);
    };
    sock.onclose = (event) => {
      if (ws !== sock) return;
      ws = null;
      if (!wantOnline) return;
      if (event.code === 4001) {
        wantOnline = false;
        onStatus("moved");
        return;
      }
      if (event.code === 4002) {
        wantOnline = false;
        onStatus("removed");
        return;
      }
      onStatus(event.code === 1012 ? "restarting" : "offline");
      retryTimer = setTimeout(open, retryMs * (0.6 + Math.random() * 0.8));
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    };
  }

  // A connection can hang without closing. No word from the server for a while: start again.
  setInterval(() => {
    if (!ws || !wantOnline || document.hidden) return;
    const limit = ws.readyState === WebSocket.OPEN ? STALE_OPEN_MS : STALE_CONNECTING_MS;
    if (performance.now() - lastHeardAt < limit) return;
    const stale = ws;
    ws = null;
    stale.close();
    onStatus("offline");
    retryMs = RETRY_MIN_MS;
    open();
  }, 1000);

  function reconnect() {
    wantOnline = true;
    retryMs = RETRY_MIN_MS;
    if (ws && ws.readyState > WebSocket.OPEN) ws = null;
    if (!ws) open();
    else if (isOpen()) sync();
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      lastHeardAt = performance.now();
      reconnect();
    }
  });
  window.addEventListener("pageshow", (event) => event.persisted && reconnect());
  window.addEventListener("online", () => reconnect());

  open();

  return {
    clientId,
    send: rawSend,
    // An action with an op id: resolves with the server's ok/no/found, even across a reconnect.
    act(msg) {
      const op = newOpId();
      const full = { ...msg, op };
      return new Promise((resolve) => {
        pending.set(op, { msg: full, resolve });
        rawSend(full);
      });
    },
    serverNow: () => Date.now() + offset,
    reconnect,
    online: isOpen,
  };
}
