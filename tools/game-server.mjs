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
if (!existsSync(bundle)) {
  console.error("no engine bundle — run `pnpm engine` first");
  process.exit(1);
}
const E = await import(bundle);

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
} else {
  console.error("usage: game-server.mjs new|advance --dir=D [--seed --size --density --months]");
  process.exit(1);
}
