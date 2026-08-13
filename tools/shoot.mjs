// Screenshot the running game. Drives a headless Chromium over the DevTools
// protocol (Node 22 has a WebSocket client built in, so there is no driver
// dependency to install).
//
//   node tools/shoot.mjs <url> <out.png> [--wait 9000] [--w 1600] [--h 1000]
//   node tools/shoot.mjs <url> <out.png> --eval "__map.setBearing(20)"
//
// A fresh profile directory per run, so IndexedDB from the previous city's
// autosave can't come back and load the wrong map.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const argv = process.argv.slice(2);
const url = argv[0];
const out = argv[1];
const flag = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const wait = Number(flag("wait", 9000));
const W = Number(flag("w", 1600));
const H = Number(flag("h", 1000));
const evalJs = flag("eval", null);
if (!url || !out) { console.error("usage: shoot.mjs <url> <out.png> [--wait ms] [--w px] [--h px] [--eval js] [--profile dir] [--verbose]"); process.exit(1); }

// A FIXED PROFILE, FOR WHEN TWO SHOTS HAVE TO BE THE SAME TOWN.
//
// A fresh profile per run is the default and it is the right default — see
// above. But `startRun` rerolls the city seed, so a fresh profile is a
// DIFFERENT CITY, and every before/after comparison made across two of them
// is comparing two towns. Point both runs at one directory and the second one
// resumes the first one's autosave: same seed, same parcels, same camera, and
// the only thing that changed is the code.
const keepProfile = flag("profile", null);
const verbose = argv.includes("--verbose");
const port = 9300 + Math.floor((Date.now() / 7) % 400);
const profile = keepProfile || mkdtempSync(join(tmpdir(), "shoot-"));
// A killed run leaves its SingletonLock behind, and Chromium then REFUSES the
// profile rather than reusing it — "Aborting now to avoid profile corruption",
// which reads like a bug in your probe and is not one. Nothing else is holding
// it; this tool runs one browser at a time.
if (keepProfile) for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
  try { rmSync(join(profile, f), { force: true }); } catch { /* not there */ }
}
const chrome = spawn(CHROME, [
  "--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
  "--hide-scrollbars", "--disable-lcd-text",
  "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
  `--window-size=${W},${H}`, `--user-data-dir=${profile}`,
  `--remote-debugging-port=${port}`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
let chromeErr = "";
chrome.stderr.on("data", (d) => { chromeErr += d.toString(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targetWs() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error("chrome never came up\n" + chromeErr.slice(-800));
}

const ws = new WebSocket(await targetWs());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    errors.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
  }
  if (msg.method === "Runtime.exceptionThrown") {
    errors.push(msg.params.exceptionDetails.text + " " + (msg.params.exceptionDetails.exception?.description ?? ""));
  }
};
const send = (method, params = {}) => new Promise((res) => {
  const n = ++id;
  pending.set(n, (m) => res(m.result ?? m));
  ws.send(JSON.stringify({ id: n, method, params }));
});

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });
await sleep(wait);
if (evalJs) {
  await send("Runtime.evaluate", { expression: evalJs, awaitPromise: true });
  await sleep(Number(flag("settle", 2500)));
}
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
if (!shot?.data) throw new Error("no screenshot data; console: " + errors.join(" | "));
writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log(`${out}  ${(Buffer.from(shot.data, "base64").length / 1024).toFixed(0)} KB` +
  // --verbose prints every console line in full: a probe that reports its
  // measurement through console.error is unreadable through the 200-character
  // summary, and the summary is what you want when you are only asking
  // whether the shader compiled.
  (errors.length
    ? (verbose ? `\n${errors.join("\n")}` : `  [${errors.length} console errors: ${errors.slice(0, 2).join(" | ").slice(0, 200)}]`)
    : ""));

ws.close();
chrome.kill("SIGKILL");
// Chromium is still flushing its profile as we delete it, so a failed rmdir
// here is normal and must not fail the run — the screenshot is already written.
try {
  if (!keepProfile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
} catch { /* a temp dir; the OS will collect it */ }
process.exit(0);
