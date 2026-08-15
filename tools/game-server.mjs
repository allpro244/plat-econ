// THE CAMPAIGN RUNNER — the process plat's game view drives.
//
//   node tools/game-server.mjs new --seed=1928 --density=village --dir=camp/
//   node tools/game-server.mjs advance --dir=camp/ --months=3
//
// A campaign directory holds the whole game on disk:
//   campaign.json ... seed / size / density (city identity — never changes)
//   state.json ...... the engine GameState, JSON round-trip proven safe
//   city.json ....... plat-city/1 doc with live occupancy (what plat renders)
//   hud.json ........ firm, date, cash, book — the game view's HUD line
//
// Same architecture as everything else here: the sim owns quantities, and it
// runs HERE, in node — the renderer (plat, the web app, anything) reads the
// files and issues commands. Deterministic: same campaign + same commands,
// byte-identical files.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeCity, PROCEDURAL, DEFAULT_SIZE } from "../src/citygen/index.mjs";
import { buildCityDoc, hudOf } from "./citydoc.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const bundle = join(HERE, "..", "test", ".engine.mjs");
if (!globalThis.__PLAT_ENGINE && !existsSync(bundle)) {
  console.error("no engine bundle — run `pnpm engine` first");
  process.exit(1);
}
const E = globalThis.__PLAT_ENGINE ?? await import(bundle);

const cmd = process.argv[2];
const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
};
const dir = arg("dir", "campaign");

function buildParcels(meta) {
  const city = makeCity(PROCEDURAL, meta.seed, { size: meta.size, density: meta.density });
  E.normalizeParcels(city.parcels);
  return city;
}

function writeAll(meta, city, g) {
  writeFileSync(join(dir, "state.json"), JSON.stringify(g));
  // A century is long and mistakes are permanent: every write keeps a
  // dated snapshot too (docs/GAME-PLAN.md phase 5).
  mkdirSync(join(dir, "saves"), { recursive: true });
  writeFileSync(join(dir, "saves", `m${String(g.month).padStart(4, "0")}.json`), JSON.stringify(g));
  writeFileSync(join(dir, "city.json"),
    JSON.stringify(buildCityDoc(E, city, g, { months: g.month })));
  const hud = hudOf(E, city, g);
  writeFileSync(join(dir, "hud.json"), JSON.stringify(hud));
  console.log(`${meta.seed}@${city.name} month=${g.month} cash=$${(g.cash / 1e6).toFixed(2)}M ` +
    `holdings=${hud.holdings} occ=${hud.occ ?? "—"} -> ${dir}/`);
}

if (cmd === "new") {
  const meta = {
    seed: (parseInt(arg("seed", String(((Math.random() * 0xffffffff) >>> 0) || 1)), 10) >>> 0) || 1,
    size: arg("size", DEFAULT_SIZE),
    density: arg("density", "village"),
  };
  mkdirSync(dir, { recursive: true });
  // The runner records its own location so a front-end that only knows the
  // campaign directory (plat's game view) can find the sim to drive it.
  meta.runner = fileURLToPath(import.meta.url);
  writeFileSync(join(dir, "campaign.json"), JSON.stringify(meta));
  const city = buildParcels(meta);
  const bbls = Object.keys(city.parcels);
  let g = E.firstListings(E.newGame(7000 + meta.seed, city.parcels), city.parcels, bbls);
  writeAll(meta, city, g);
} else if (cmd === "advance") {
  const meta = JSON.parse(readFileSync(join(dir, "campaign.json"), "utf8"));
  const months = Math.max(1, parseInt(arg("months", "3"), 10) || 3);
  const city = buildParcels(meta);
  const bbls = Object.keys(city.parcels);
  let g = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  for (let m = 0; m < months && !g.gameOver; m++) {
    g = E.advanceMonth(g, city.parcels, bbls, city.adjacency);
  }
  writeAll(meta, city, g);
} else if (cmd === "buy") {
  // BUY AT ASK (docs/GAME-PLAN.md phase 3.2): the canonical price rule,
  // then the engine's purchase path decides. The engine's err string is
  // the whole result contract — plat shows it verbatim.
  const meta = JSON.parse(readFileSync(join(dir, "campaign.json"), "utf8"));
  const bbl = arg("bbl", "");
  const city = buildParcels(meta);
  const bbls = Object.keys(city.parcels);
  let g = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  const li = (g.listings ?? []).find((l) => l.bbl === bbl);
  const approach = g.approaches?.[bbl];
  const rec = E.resolveRec(city.parcels, g, bbl);
  const price = li?.ask ?? approach?.ask ??
    (rec ? (rec.class === "land" ? E.landValue(rec, g.econ)
          : E.assetValue(rec, g.econ, E.gradeOf(g, rec))) : 0);
  const r = E.executePurchase(g, city.parcels, bbl, price, "cash", !li, 1);
  const result = { op: "buy", bbl, price: Math.round(price), ok: !r.err, err: r.err ?? null };
  writeFileSync(join(dir, "result.json"), JSON.stringify(result));
  if (r.err) {
    console.error("BUY FAILED: " + r.err);
    writeAll(meta, city, g);
    process.exit(2);
  }
  g = r.s;
  writeAll(meta, city, g);
  console.log(`BOUGHT ${bbl} for $${(price / 1e6).toFixed(2)}M`);
} else if (cmd === "develop-options") {
  // What pencils on this lot: the engine underwrites candidate designs.
  const meta = JSON.parse(readFileSync(join(dir, "campaign.json"), "utf8"));
  const bbl = arg("bbl", "");
  const city = buildParcels(meta);
  const g = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  const options = [];
  for (const use of ["office", "multifamily", "retail", "industrial"]) {
    for (const floors of [3, 6, 10, 16, 24]) {
      try {
        const uw = E.underwriteDevelopment(g, city.parcels, bbl, use, floors);
        if (uw?.plan) options.push({
          use, floors, sf: Math.round(uw.plan.sf), cost: Math.round(uw.plan.costTotal),
          clears: !!uw.clears, financeable: !!uw.financeable, why: uw.why ?? null,
        });
      } catch { /* infeasible */ }
    }
  }
  writeFileSync(join(dir, "options.json"), JSON.stringify({ bbl, options }));
  console.log(`${options.length} designs underwritten for ${bbl} -> options.json`);
} else if (cmd === "develop") {
  const meta = JSON.parse(readFileSync(join(dir, "campaign.json"), "utf8"));
  const bbl = arg("bbl", "");
  const use = arg("use", "multifamily");
  const floors = parseInt(arg("floors", "6"), 10) || 6;
  const city = buildParcels(meta);
  let g = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  const r = E.startDevelopment(g, city.parcels, bbl, use, floors);
  const result = { op: "develop", bbl, use, floors, ok: !r.err, err: r.err ?? null };
  writeFileSync(join(dir, "result.json"), JSON.stringify(result));
  if (r.err) {
    console.error("DEVELOP FAILED: " + r.err);
    writeAll(meta, city, g);
    process.exit(2);
  }
  g = r.s;
  writeAll(meta, city, g);
  console.log(`DEVELOPING ${bbl}: ${floors}-floor ${use}`);
} else {
  console.error("usage: game-server.mjs new|advance|buy|develop-options|develop --dir=D [--seed --size --density --months --bbl --use --floors]");
  process.exit(1);
}
