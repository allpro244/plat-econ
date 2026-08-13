// Playthrough bot that exercises private credit (lend, borrow, notes, mezz).
// Writes a short story per seed under artifacts/.
//
//   pnpm engine && node tools/private-credit-play.mjs
//   SEEDS=3 HORIZON=240 node tools/private-credit-play.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const E = await import(join(ROOT, "test/.engine.mjs"));
const { loadCity } = await import(join(ROOT, "test/city.mjs"));

const HORIZON = Number(process.env.HORIZON ?? 240); // 20 years default
const N_SEEDS = Number(process.env.SEEDS ?? 3);
const START_CASH = 8_000_000;
const CITY_SEED = Number(process.env.CITY_SEED ?? 0);
const { parcels, adjacency, bbls } = loadCity(CITY_SEED, E.normalizeParcels);

const M = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${Math.round(n)}`;
};
const YR = (m) => 2000 + Math.floor(m / 12);

function play(seed) {
  let g = E.firstListings(E.newGame(seed, parcels, START_CASH), parcels, bbls);
  g.citySize = "city";
  const story = [];
  const push = (text) => story.push({ m: g.month, y: YR(g.month), text });
  const st = {
    fundedAsks: 0, declinedAsks: 0, borrowed: 0, notesBought: 0,
    mezz: 0, coupons: 0, workouts: 0, bugs: [],
  };

  push(`Opened with ${M(START_CASH)}. Hunting paper and writing bridges.`);

  for (let i = 0; i < HORIZON; i++) {
    // ---- act on private asks (lend) ----------------------------------------
    for (const a of [...(g.privateAsks ?? [])]) {
      const sleeve = E.privateSleeveCapacity(g, parcels);
      if (a.face <= sleeve && g.cash > a.face + 600_000 && a.ratePct >= 11) {
        const r = E.fundPrivateAsk(g, parcels, a.id);
        if (r.err) st.bugs.push(`fundAsk ${a.id}: ${r.err}`);
        else {
          g = r.s; st.fundedAsks++;
          push(`Funded ${a.rivalName} ${M(a.face)} @ ${a.ratePct.toFixed(1)}% on ${a.address}.`);
        }
      } else if (a.expiresM - g.month <= 0) {
        /* let tick expire */
      } else if (a.ratePct < 11 || a.face > sleeve) {
        const r = E.declinePrivateAsk(g, a.id);
        if (!r.err) { g = r.s; st.declinedAsks++; }
      }
    }

    // ---- private borrow when balloon / quote -------------------------------
    for (const q of [...(g.privateBorrowQuotes ?? [])]) {
      const payoff = g.holdings[q.bbl]?.loan?.balance ?? 0;
      const net = q.principal - payoff - Math.round(q.principal * q.points);
      if (net > -200_000 || g.workouts?.[q.bbl]?.cause === "balloon") {
        const r = E.acceptPrivateBorrowQuote(g, parcels, q.id);
        if (r.err) st.bugs.push(`borrow ${q.id}: ${r.err}`);
        else {
          g = r.s; st.borrowed++;
          push(`Borrowed ${M(q.principal)} from ${q.lenderName} on ${q.address} @ ${q.ratePct.toFixed(1)}%.`);
        }
      }
    }

    // ---- buy cheap notes ---------------------------------------------------
    for (const o of [...(g.noteOffers ?? [])]) {
      const px = Math.round(o.face * o.askPct);
      const room = E.creditBookRoom(g, parcels);
      if (px <= room && g.cash > px + 500_000 && o.askPct < 0.85) {
        const r = E.buyNote(g, parcels, o.id);
        if (r.err) st.bugs.push(`buyNote ${o.id}: ${r.err}`);
        else {
          g = r.s; st.notesBought++;
          push(`Bought ${o.perf} paper on ${o.address} at ${(100 * o.askPct).toFixed(0)}¢ — ${M(px)}.`);
        }
      }
    }

    // ---- place mezz when room behind bank senior ---------------------------
    for (const h of Object.values(g.holdings)) {
      if (st.mezz >= 2) break;
      const mq = E.mezzQuote(g, parcels, h.bbl);
      if (mq.available && mq.principal >= 400_000 && g.cash > 1_000_000) {
        const r = E.placeMezz(g, parcels, h.bbl);
        if (r.err) st.bugs.push(`mezz ${h.bbl}: ${r.err}`);
        else {
          g = r.s; st.mezz++;
          push(`Stacked Cordage mezz ${M(mq.principal)} behind senior on ${E.resolveRec(parcels, g, h.bbl)?.address ?? h.bbl}.`);
        }
      }
    }

    // ---- light landlord bot: buy a listing, accept LOIs --------------------
    if (Object.keys(g.holdings).length < 4 && (g.listings?.length ?? 0) > 0) {
      const L = g.listings.find((l) => {
        const rec = E.resolveRec(parcels, g, l.bbl);
        return rec && rec.class !== "land" && l.ask < g.cash * 0.55;
      });
      if (L) {
        const r = E.buyListing(g, parcels, L.bbl, "harbor", 0.9);
        if (!r.err) {
          g = r.s;
          if (i % 36 === 0) push(`Bought ${E.resolveRec(parcels, g, L.bbl)?.address} with Harbor paper.`);
        } else {
          const r2 = E.buyListing(g, parcels, L.bbl, "cash");
          if (!r2.err) g = r2.s;
        }
      }
    }
    for (const loi of [...(g.lois ?? [])].slice(0, 3)) {
      const r = E.respondLOI(g, parcels, loi.id, "accept", true);
      if (!r.err) g = r.s;
    }

    // refi into cheaper desks when available
    for (const h of Object.values(g.holdings)) {
      if (!h.loan || h.loan.maturityM - g.month > 18) continue;
      const { quotes, payoff } = E.refiQuotes(g, parcels, h.bbl);
      const best = quotes.filter((q) => q.available && q.maxProceeds >= payoff)
        .sort((a, b) => a.ratePct - b.ratePct)[0];
      if (best && best.ratePct + 0.4 < h.loan.ratePct) {
        const r = E.refinance(g, parcels, h.bbl, best.id, 1);
        if (!r.err) g = r.s;
      }
    }

    const beforeNotes = (g.notes ?? []).reduce((a, n) => a + n.collected, 0);
    g = E.advanceMonth(g, parcels, bbls, adjacency);
    const afterNotes = (g.notes ?? []).reduce((a, n) => a + n.collected, 0);
    if (afterNotes > beforeNotes) st.coupons++;
    st.workouts = Object.keys(g.workouts ?? {}).length;

    // sanity: NW finite, cash finite, no negative obligor debt from our paper
    if (!Number.isFinite(E.netWorth(g, parcels))) st.bugs.push(`NW non-finite at m${g.month}`);
    if (!Number.isFinite(g.cash)) st.bugs.push(`cash non-finite at m${g.month}`);
    for (const n of g.notes ?? []) {
      if (n.privateOriginated && n.face <= 0) st.bugs.push(`bad private note face ${n.id}`);
    }
  }

  const nw = E.netWorth(g, parcels);
  const privateFace = E.privateBookFace(g);
  const creditFace = E.creditBookFace(g);
  push(`Close: NW ${M(nw)}, private book ${M(privateFace)}, credit book ${M(creditFace)}, `
    + `funded ${st.fundedAsks} asks, borrowed ${st.borrowed}, notes ${st.notesBought}, mezz ${st.mezz}.`);

  return { seed, nw, story, st, privateFace, creditFace, month: g.month };
}

const outDir = join(ROOT, "../artifacts");
mkdirSync(outDir, { recursive: true });

const seeds = Array.from({ length: N_SEEDS }, (_, i) => 12007 + i * 97);
const runs = [];
for (const seed of seeds) {
  console.log(`\n=== seed ${seed} (${HORIZON} mo) ===`);
  const r = play(seed);
  runs.push(r);
  console.log(`  NW ${M(r.nw)} · funded ${r.st.fundedAsks} · borrowed ${r.st.borrowed} · notes ${r.st.notesBought} · mezz ${r.st.mezz} · bugs ${r.st.bugs.length}`);
  for (const line of r.story.slice(0, 12)) console.log(`  ${line.y}: ${line.text}`);
  if (r.story.length > 12) console.log(`  … ${r.story.length - 12} more beats`);
  if (r.st.bugs.length) console.log("  BUGS:", r.st.bugs.slice(0, 8).join(" | "));
}

const report = {
  horizon: HORIZON,
  citySeed: CITY_SEED,
  runs: runs.map((r) => ({
    seed: r.seed,
    nw: r.nw,
    privateFace: r.privateFace,
    creditFace: r.creditFace,
    stats: r.st,
    story: r.story,
  })),
};
writeFileSync(join(outDir, "private-credit-play.json"), JSON.stringify(report, null, 2));
console.log(`\nWrote artifacts/private-credit-play.json`);
const bugN = runs.reduce((a, r) => a + r.st.bugs.length, 0);
process.exit(bugN ? 1 : 0);
