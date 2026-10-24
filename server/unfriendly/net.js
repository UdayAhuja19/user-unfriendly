// Small web-server helpers, first written for the club's PICTIONARY game and copied here rather
// than shared, so a change here can never break PICTIONARY.
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLocalHost(hostHeader) {
  try {
    return LOCAL_HOSTS.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

export function sameOrigin(req) {
  try {
    return new URL(req.headers.origin).host === req.headers.host;
  } catch {
    return false;
  }
}

// pages: { "/": "phone.html", "/host": "host.html" } served from unfriendly/
export function webApp({ pages, localOnly, routes }) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    // The big screen only answers to localhost, so another website can't reach it through a DNS trick.
    if (localOnly && !isLocalHost(req.headers.host)) return res.status(403).type("text").send("FORBIDDEN");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    res.set("Cache-Control", "no-cache");
    next();
  });
  const serve = (...dir) => express.static(path.join(root, ...dir), { index: false });
  app.use("/unfriendly/css", serve("unfriendly", "css"));
  app.use("/unfriendly/js", serve("unfriendly", "js"));
  app.use("/unfriendly/brand", serve("unfriendly", "brand"));
  app.use("/public/js/shared", serve("public", "js", "shared"));
  for (const [route, page] of Object.entries(pages)) {
    app.get(route, (req, res) => res.sendFile(page, { root: path.join(root, "unfriendly") }));
  }
  routes?.(app);
  app.use((req, res) => res.status(404).type("text").send("NOT FOUND"));
  // Never show a stack trace (with this laptop's paths) on the public port.
  app.use((err, req, res, next) => {
    res.status(err.status ?? 500).type("text").send(err.status === 404 ? "NOT FOUND" : "SOMETHING WENT WRONG");
  });
  return app;
}

export function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

export function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

// A token bucket: `rate` per second, holding at most `burst`.
export function bucket(rate, burst, now) {
  return { rate, burst, tokens: burst, at: now };
}

export function take(b, now) {
  b.tokens = Math.min(b.burst, b.tokens + ((now - b.at) / 1000) * b.rate);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// A bug in one message mustn't stop the event for a hundred people: log it and carry on.
export function safely(fn) {
  try {
    return fn();
  } catch (err) {
    console.error("USER UNFRIENDLY: something went wrong handling a message:", err);
    return undefined;
  }
}
