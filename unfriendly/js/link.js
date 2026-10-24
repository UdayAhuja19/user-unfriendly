// The big screen's and host panel's connection: the same laptop, so it just tries again every
// second, forever. Whatever was last on screen stays there while the server is stopped.
import { newOpId } from "./net.js";

export function connectLocal(role, { onMessage, onStatus }) {
  let ws = null;
  let offset = 0;
  let online = false;
  const pending = new Map();

  function open() {
    const url = new URL("/ws", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => {
      sock.send(JSON.stringify({ t: "hello", role }));
      sock.send(JSON.stringify({ t: "sync", c: Date.now() }));
      online = true;
      onStatus(true);
    };
    sock.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.t === "sync") {
        offset = msg.s + (Date.now() - msg.c) / 2 - Date.now();
        return;
      }
      if (typeof msg.serverNow === "number" && Math.abs(msg.serverNow - (Date.now() + offset)) > 2000) offset = msg.serverNow - Date.now();
      if (msg.t === "result" && pending.has(msg.op)) {
        pending.get(msg.op)(msg);
        pending.delete(msg.op);
      }
      onMessage(msg);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      if (online) onStatus(false);
      online = false;
      // Commands that never got an answer: say so rather than hang.
      for (const resolve of pending.values()) resolve({ t: "result", error: "THE SERVER IS STOPPED. START IT AND TRY AGAIN." });
      pending.clear();
      setTimeout(open, 1000);
    };
  }
  open();

  return {
    serverNow: () => Date.now() + offset,
    online: () => online,
    // A host command: resolves with the server's { ok } or { error }.
    command(t, payload = {}) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.resolve({ error: "THE SERVER IS STOPPED. START IT AND TRY AGAIN." });
      const op = newOpId();
      return new Promise((resolve) => {
        pending.set(op, resolve);
        ws.send(JSON.stringify({ t, op, ...payload }));
      });
    },
  };
}
