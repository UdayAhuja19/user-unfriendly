// Gives the phone port a public https link with a free Cloudflare quick tunnel
// (no account needed). The link changes on every start, which is fine because the
// big screen shows it as a QR code. If cloudflared stops, it restarts with a new link.
import { spawn } from "node:child_process";

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
// The link only works once cloudflared has connected to Cloudflare.
const READY_PATTERN = /Registered tunnel connection/;
const RESTART_MS = 5000;

// onChange(url, status): status is "starting", "live", "down" or "missing".
export function startTunnel(port, onChange) {
  let child = null;
  let stopped = false;
  let restartTimer = null;

  function run() {
    onChange(null, "starting");
    let url = null;
    let ready = false;

    child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const scan = (chunk) => {
      const text = String(chunk);
      url ??= text.match(URL_PATTERN)?.[0] ?? null;
      ready ||= READY_PATTERN.test(text);
      if (url && ready) {
        onChange(url, "live");
        child?.stdout.off("data", scan);
        child?.stderr.off("data", scan);
      }
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);

    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        stopped = true;
        onChange(null, "missing");
      }
    });
    child.on("exit", () => {
      child = null;
      if (stopped) return;
      onChange(null, "down");
      restartTimer = setTimeout(run, RESTART_MS);
    });
  }

  run();

  return {
    stop() {
      stopped = true;
      clearTimeout(restartTimer);
      child?.kill();
    },
  };
}
