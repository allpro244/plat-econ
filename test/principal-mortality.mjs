// Rival mortality + careers — Phase 3/4.
//   pnpm engine && node test/principal-mortality.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const E = await import(join(HERE, ".engine.mjs"));
const { loadCity } = await import(join(HERE, "city.mjs"));

let fails = 0;
const ok = (name, cond, detail = "") => {
  if (!cond) { fails++; console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`); }
  else console.log(`PASS  ${name}${detail ? " — " + detail : ""}`);
};

const { parcels, adjacency, bbls } = loadCity(0, E.normalizeParcels);

// Careers: unset → neutral load; specialist lighter than novice.
{
  ok("unset career load = 1.0", Math.abs(E.careerLoadMult(undefined, "office", "X") - 1) < 1e-9);
  const novice = E.emptyCareer();
  novice.classM.office = 0;
  // empty keys → treated neutral
  ok("empty career load = 1.0", Math.abs(E.careerLoadMult(novice, "office", "X") - 1) < 1e-9);
  const deep = E.emptyCareer();
  deep.classM.office = 120;
  deep.districtM.Exchange = 80;
  const mDeep = E.careerLoadMult(deep, "office", "Exchange");
  const mStrange = E.careerLoadMult(deep, "industrial", "Millside");
  ok("specialist lighter load than stranger", mDeep < mStrange, `${mDeep.toFixed(3)} < ${mStrange.toFixed(3)}`);
  ok("specialist below 1.0", mDeep < 1);
  ok("stranger above 1.0", mStrange > 1);
}

// Mortality: force diesM, tick, estate listings, heir, street cleared, no gameOver.
{
  const g = E.firstListings(E.newGame(4242, parcels), parcels, bbls);
  const live = (g.rivals ?? []).filter((r) => r.failedM === undefined && r.bbls.length >= 2);
  ok("have a firm with a book", live.length > 0, String(live.length));
  const r = live.sort((a, b) => b.bbls.length - a.bbls.length)[0];
  const p = g.rivalPrincipals[r.id];
  g.street = { [r.id]: { deals: 3, beats: 1, insults: 0, lastM: 0 } };
  const rng0 = g.rng;
  p.diesM = g.month; // die this month
  E.tickRivalMortality(g, parcels);
  ok("death processed", p.diedM === g.month);
  ok("heir seated", g.rivalPrincipals[r.id]?.id !== p.id && g.rivalPrincipals[r.id]?.seat === "rival");
  ok("heir is younger name", g.rivalPrincipals[r.id]?.name !== p.name);
  const estate = (g.listings ?? []).filter((l) => l.sellerId === r.id && l.reason === "estate");
  ok("estate listings on tape", estate.length > 0 && estate.length <= 6, String(estate.length));
  ok("estate asks are distress", estate.every((l) => l.distress));
  ok("street tie cleared", !g.street?.[r.id]);
  ok("firm still alive", r.failedM === undefined);
  ok("gameOver not set", g.gameOver == null);
  ok("s.rng untouched by mortality", g.rng === rng0);
  ok("news mentions death", (g.news ?? []).some((n) => /died/.test(n.text)));
}

// Careers accrue on principal float without touching s.rng.
{
  const g = E.firstListings(E.newGame(12007, parcels), parcels, bbls);
  // Give the player a building
  const bbl = bbls.find((b) => {
    const rec = E.resolveRec(parcels, g, b);
    return rec && rec.class === "office" && rec.bldgArea > 0;
  });
  ok("found office parcel", !!bbl);
  g.holdings[bbl] = { bbl, tenants: [], condition: "standard", boughtM: 0, costBasis: 1 };
  const before = g.principal.career.classM.office ?? 0;
  const rng0 = g.rng;
  E.tickCareers(g, parcels);
  const after = g.principal.career.classM.office ?? 0;
  ok("principal accrued office month", after === before + 1, `${before} -> ${after}`);
  ok("tickCareers leaves s.rng", g.rng === rng0);
}

// Advance a century fragment — deaths fire, game continues.
{
  const g = E.firstListings(E.newGame(33, parcels), parcels, bbls);
  // Force three old principals to die soon
  let forced = 0;
  for (const r of g.rivals) {
    if (r.failedM !== undefined) continue;
    const p = g.rivalPrincipals[r.id];
    if (!p) continue;
    p.diesM = g.month + 2;
    forced++;
    if (forced >= 3) break;
  }
  let cur = g;
  for (let i = 0; i < 6; i++) cur = E.advanceMonth(cur, parcels, bbls, adjacency);
  // Heirs replace — diedM is on the OLD person who is no longer in the map.
  // Count estate listings and news instead.
  const estates = (cur.listings ?? []).filter((l) => l.reason === "estate").length;
  const deathNews = (cur.news ?? []).filter((n) => /died/.test(n.text)).length;
  ok("deaths produced estate activity", estates > 0 || deathNews >= 3, `estates ${estates} news ${deathNews}`);
  ok("world still running", cur.gameOver == null && cur.month === 6);
}

console.log(`\n${fails === 0 ? "principal-mortality pass" : `${fails} principal-mortality failure(s)`}`);
process.exit(fails === 0 ? 0 : 1);
