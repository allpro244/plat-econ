// THE STYLE BOARD.
//
// Every facade family on the map at once, at identical height and plate, with
// a label pinned to each one. `pnpm styles` can prove a family is CHOSEN; only
// this can show whether it is DISTINGUISHABLE from the family beside it, which
// is a different question and one no counter can answer.
//
//   node tools/styleboard.mjs <url> <out-dir>
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ = process.argv[2] ?? "http://127.0.0.1:5210/";
const OUT = process.argv[3] ?? "/tmp/styleboard";
mkdirSync(OUT, { recursive: true });
const W = 2400, H = 1500;

// names, straight out of the registry
const bd = mkdtempSync(join(tmpdir(), "sb-"));
execFileSync("npx", ["esbuild", "src/map/styles.ts", "--bundle", "--format=esm",
  "--platform=neutral", "--outfile=" + join(bd, "s.mjs")], { stdio: ["ignore", "ignore", "inherit"] });
const S = await import(join(bd, "s.mjs"));
rmSync(bd, { recursive: true, force: true });
const NAME = {};
for (const [k, v] of Object.entries(S)) if (/^S_[A-Z_]+$/.test(k) && typeof v === "number") NAME[v] = k.slice(2).toLowerCase();
// surfaces, not facades — these never clad a wall
const SKIP = new Set([S.S_PLAIN, S.S_CORNICE, S.S_GREEN, S.S_LOT, S.S_GABLE, S.S_LAWN, S.S_PATH, S.S_POND]);
const FACADES = Object.keys(NAME).map(Number).filter((i) => !SKIP.has(i)).sort((a, b) => a - b);

const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const port = 9400 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(join(tmpdir(), "sb-prof-"));
const ch = spawn(CHROME, ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
  "--hide-scrollbars", "--disable-lcd-text", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
  `--window-size=${W},${H}`, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "about:blank"],
  { stdio: ["ignore", "ignore", "ignore"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsu;
for (let i = 0; i < 160; i++) {
  try {
    const j = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
    const pg = j.find((t) => t.type === "page");
    if (pg?.webSocketDebuggerUrl) { wsu = pg.webSocketDebuggerUrl; break; }
  } catch { /* not up */ }
  await sleep(200);
}
const sock = new WebSocket(wsu);
await new Promise((r) => { sock.onopen = r; });
let id = 0; const pend = new Map();
sock.onmessage = (m) => { const x = JSON.parse(m.data); if (x.id && pend.has(x.id)) { pend.get(x.id)(x); pend.delete(x.id); } };
const send = (method, params = {}) => new Promise((res) => { const n = ++id; pend.set(n, res); sock.send(JSON.stringify({ id: n, method, params })); });
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send("Runtime.enable"); await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: URL_ });
await sleep(38000);

const place = `(()=>{
  const m=window.__map,l=m.getLayer("bw-three-buildings"),impl=l&&(l.implementation||l);
  if(!impl) return "NO LAYER";
  const IDS=${JSON.stringify(FACADES)};
  const vols=impl.volumes||[];
  const byB=new Map();
  for(const v of vols){ if(v.d||v.k||!v.b) continue; if(!byB.has(v.b)) byB.set(v.b,v); }
  const area=r=>{let a=0;for(let i=0;i<r.length;i++){const p=r[i],q=r[(i+1)%r.length];a+=p[0]*q[1]-q[0]*p[1];}return Math.abs(a)/2;};
  const cen=r=>{let x=0,y=0;for(const p of r){x+=p[0];y+=p[1];}return [x/r.length,y/r.length];};
  const c=m.getCenter(), rows=[];
  byB.forEach((v,b)=>{ const mr=impl.ringByBBL.get(b); if(!mr) return; const a=area(mr);
    if(a<300||a>2400) return; const ll=cen(v.r);
    rows.push({b,ll,d:Math.hypot(ll[0]-c.lng,ll[1]-c.lat)}); });
  rows.sort((x,y)=>x.d-y.d);
  const picks=rows.slice(0,IDS.length);
  if(picks.length<IDS.length) return "ONLY "+picks.length+" LOTS for "+IDS.length+" styles";
  impl.setPlayerBuildings(picks.map((p,i)=>({bbl:p.b,cls:"office",floors:6,heightM:24,construction:false,styleOverride:IDS[i]})));
  let w=180,s2=90,e=-180,n=-90;
  for(const p of picks){ w=Math.min(w,p.ll[0]); e=Math.max(e,p.ll[0]); s2=Math.min(s2,p.ll[1]); n=Math.max(n,p.ll[1]); }
  m.jumpTo({pitch:48,bearing:0});
  m.fitBounds([[w,s2],[e,n]],{padding:90,duration:0,pitch:48,bearing:0});
  const rect=m.getContainer().getBoundingClientRect();
  return JSON.stringify(picks.map((p,i)=>{const q=m.project(p.ll);
    return [IDS[i], Math.round(q.x+rect.left), Math.round(q.y+rect.top)];}));
})()`;
const res = await evalJs(place);
if (typeof res !== "string" || res[0] !== "[") { console.error("PLACE FAILED:", res); process.exit(1); }
await sleep(9000);
const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
const png = Buffer.from(shot.data, "base64");
writeFileSync(join(OUT, "board.png"), png);
const pts = JSON.parse(res);
writeFileSync(join(OUT, "points.json"), JSON.stringify({ W, H, pts, NAME }, null, 1));
console.log(`board.png ${(png.length / 1024).toFixed(0)} KB   ${pts.length} styles placed`);
if (png.length < 200000) console.error("WARNING: frame looks black — check the dev server is actually up");
sock.close(); ch.kill("SIGKILL");
try { rmSync(profile, { recursive: true, force: true, maxRetries: 4 }); } catch { /* temp */ }
process.exit(0);
