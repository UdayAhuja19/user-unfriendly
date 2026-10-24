// USER UNFRIENDLY's build clock without a server: a self-contained page, its state file for
// nudges, and caffeinate started only when it's needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeClock, keepAwake, clockState, CLOCK_FILE } from "../server/unfriendly/clock.js";

const ix = (extra = {}) => ({
  meta: { event_id: "ev1", build_start_at: 1000, build_end_at: 3_301_000, clock_version: 1, ...extra },
  teams: [
    { name: "Alpha", dealt_at: 1, cards: ["login", "captcha"] },
    { name: "</script><img src=x onerror=alert(1)>", dealt_at: 1, cards: ["qr", "terms"] },
  ],
});

test("the clock page has everything inside it and no way out of its script", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uu-clock-"));
  const file = writeClock(dir, ix());
  assert.equal(path.basename(file), CLOCK_FILE);
  const html = fs.readFileSync(file, "utf8");
  assert.ok(!/https?:\/\//.test(html.replace(/http:\/\/www\.w3\.org[^"]*/g, "")), "nothing loads from the network");
  assert.ok(html.includes("data:font/woff2;base64,"), "fonts are inside");
  assert.equal(html.match(/<\/script>/g).length, 1, "a team name can't close the script");
  assert.ok(html.includes("3301000"));
  assert.ok(html.includes("CAPTCHA") || html.includes("Captcha"));
  assert.ok(fs.statSync(file).size < 400_000);
  const state = fs.readFileSync(path.join(dir, "clock-state.js"), "utf8");
  assert.ok(state.startsWith("window.__uuClock && window.__uuClock("));
});

test("a nudge rewrites the state with a higher version for an open page to pick up", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uu-clock-"));
  writeClock(dir, ix());
  writeClock(dir, ix({ build_end_at: 3_601_000, clock_version: 2 }));
  const state = fs.readFileSync(path.join(dir, "clock-state.js"), "utf8");
  assert.ok(state.includes('"version":2') && state.includes("3601000"));
  assert.deepEqual(clockState(ix()).teams[0].cards, ["Login", "CAPTCHA"]);
});

test("caffeinate runs detached until the end, and isn't started twice", () => {
  const calls = [];
  const spawn = (cmd, args, options) => (calls.push({ cmd, args, options }), { pid: 4242, on() {}, unref() {} });
  const now = 1_000_000;
  const started = keepAwake(now + 60 * 60_000, null, { now, spawn });
  assert.deepEqual(started, { pid: 4242, until: now + 60 * 60_000 });
  assert.deepEqual(calls[0].args, ["-d", "-i", "-t", "3600"]);
  assert.equal(calls[0].options.detached, true, "Ctrl+C on the server doesn't stop it");
  assert.equal(keepAwake(now - 1, null, { now, spawn }), null, "nothing after the end");
});
