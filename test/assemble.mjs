// Land assembly: contiguous owned lots become one site; chain merges reparent.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertFreshBundle } from "./fresh.mjs";
assertFreshBundle();

const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));
const { parcels, bbls, adjacency } = loadCity(0, E.normalizeParcels);

function own(g, bbl) {
  const rec = parcels[bbl];
  const price = Math.round(E.landValue(rec, g.econ) * 1.02);
  const next = structuredClone(g);
  next.cash -= price;
  next.holdings[bbl] = {
    bbl, boughtM: 0, costBasis: price, condition: "average",
    tenants: [], loan: null, assessed: price, condIdx: 0.55, svcIdx: 0.55,
    service: 0, stance: 0, plan: 1, cfHistory: [],
  };
  return next;
}

function findStrip() {
  // Three mutually owned-able vacant lots in a line: A-B-C.
  for (const a of bbls) {
    const ra = parcels[a];
    if (!ra || ra.class !== "land" || ra.lotArea < 2000) continue;
    for (const b of adjacency[a] ?? []) {
      const rb = parcels[b];
      if (!rb || rb.class !== "land" || rb.lotArea < 2000) continue;
      for (const c of adjacency[b] ?? []) {
        if (c === a) continue;
        const rc = parcels[c];
        if (!rc || rc.class !== "land" || rc.lotArea < 2000) continue;
        // A and C must not be required to touch — strip through B.
        return [a, b, c];
      }
    }
  }
  return null;
}

const strip = findStrip();
if (!strip) {
  console.error("no vacant strip in city");
  process.exit(1);
}
const [A, B, C] = strip;
console.log("strip", strip.map((b) => `${b}:${parcels[b].lotArea}`));

let g = E.firstListings(E.newGame(7, parcels), parcels, bbls);
g = { ...g, cash: g.cash + 50e6 };
g = own(g, A); g = own(g, B); g = own(g, C);

// From the END lot, contiguousOwnedRoots must see all three.
const fromEnd = E.contiguousOwnedRoots(g, adjacency, A).sort();
if (fromEnd.length < 3 || !fromEnd.includes(B) || !fromEnd.includes(C)) {
  console.error("FAIL contiguous from end", fromEnd);
  process.exit(1);
}

// Assemble A+B first.
let r = E.assembleLots(g, parcels, adjacency, [A, B]);
if (r.err) { console.error("FAIL first assemble", r.err); process.exit(1); }
g = r.s;
const parent1 = E.siteRoot(g, A);
const area1 = E.resolveRec(parcels, g, parent1).lotArea;
const expect1 = parcels[A].lotArea + parcels[B].lotArea;
if (Math.abs(area1 - expect1) > 1) {
  console.error("FAIL area after A+B", { area1, expect1, parent1, merged: g.merged });
  process.exit(1);
}

// Chain: fold C into the assemblage from the end that only touches via child.
// Contiguity must use site-aware adjacency (C touches B; B may be child).
r = E.assembleLots(g, parcels, adjacency, [parent1, C]);
if (r.err) { console.error("FAIL chain assemble", r.err, { parent1, merged: g.merged }); process.exit(1); }
g = r.s;
const parent2 = E.siteRoot(g, parent1);
const area2 = E.resolveRec(parcels, g, parent2).lotArea;
const expect2 = parcels[A].lotArea + parcels[B].lotArea + parcels[C].lotArea;
if (Math.abs(area2 - expect2) > 1) {
  console.error("FAIL area after +C", { area2, expect2, parent2, merged: g.merged });
  process.exit(1);
}
const deeds = E.siteDeeds(g, parent2);
if (deeds.length !== 3) {
  console.error("FAIL deed count", deeds, g.merged);
  process.exit(1);
}
// Flat tree — no parent-of-parent.
for (const [child, parent] of Object.entries(g.merged ?? {})) {
  if (g.merged[parent]) {
    console.error("FAIL nested merge", { child, parent, up: g.merged[parent] });
    process.exit(1);
  }
}

// Two separate pairs then merge the assemblages together.
let g2 = E.firstListings(E.newGame(11, parcels), parcels, bbls);
g2 = { ...g2, cash: g2.cash + 50e6 };
// Find two adjacent pairs that touch: reuse A-B-C — assemble A+B and... need D adjacent to C only.
// Simpler: assemble A+B, assemble nothing else; buy another path.
// Merge-of-assemblages: create AB and then if we had DE touching — use A-B and then
// treat B-C as second assemble of two singles first differently:
//   1) assemble A+B -> P
//   2) That already tested chain.
// For two parents: own four lots in a square if possible, or line of 4.

function findLine4() {
  for (const a of bbls) {
    if (parcels[a]?.class !== "land") continue;
    for (const b of adjacency[a] ?? []) {
      if (parcels[b]?.class !== "land" || b === a) continue;
      for (const c of adjacency[b] ?? []) {
        if (parcels[c]?.class !== "land" || c === a || c === b) continue;
        for (const d of adjacency[c] ?? []) {
          if (parcels[d]?.class !== "land" || [a, b, c].includes(d)) continue;
          return [a, b, c, d];
        }
      }
    }
  }
  return null;
}
const line = findLine4();
if (line) {
  const [w, x, y, z] = line;
  g2 = own(g2, w); g2 = own(g2, x); g2 = own(g2, y); g2 = own(g2, z);
  let r2 = E.assembleLots(g2, parcels, adjacency, [w, x]);
  if (r2.err) { console.error("FAIL pair1", r2.err); process.exit(1); }
  g2 = r2.s;
  r2 = E.assembleLots(g2, parcels, adjacency, [y, z]);
  if (r2.err) { console.error("FAIL pair2", r2.err); process.exit(1); }
  g2 = r2.s;
  const pW = E.siteRoot(g2, w);
  const pY = E.siteRoot(g2, y);
  r2 = E.assembleLots(g2, parcels, adjacency, [pW, pY]);
  if (r2.err) { console.error("FAIL merge assemblages", r2.err, g2.merged); process.exit(1); }
  g2 = r2.s;
  const root = E.siteRoot(g2, pW);
  if (E.siteDeeds(g2, root).length !== 4) {
    console.error("FAIL 4-deed site", E.siteDeeds(g2, root), g2.merged);
    process.exit(1);
  }
  for (const [child, parent] of Object.entries(g2.merged ?? {})) {
    if (g2.merged[parent]) {
      console.error("FAIL nested after two-parent merge", { child, parent });
      process.exit(1);
    }
  }
  console.log("merge-of-assemblages ok", { root, area: E.resolveRec(parcels, g2, root).lotArea });
} else {
  console.log("skip merge-of-assemblages — no 4-lot line");
}

console.log(JSON.stringify({
  ok: true,
  strip: strip.length,
  finalArea: area2,
  deeds: deeds.length,
  parent: parent2,
}, null, 2));
