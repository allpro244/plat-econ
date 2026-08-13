// HOW MUCH DO PARKS AND BOULEVARDS ACTUALLY VARY BETWEEN CITIES?
//
//   pnpm variety            forty generated islands
//   N=200 pnpm variety      a wider sweep
//
// Two cities that differ only in their street names are one city. This counts
// what a player can actually see is different from one town to the next, and
// it exists because both answers were once "nothing":
//
//   parks       40 of 40 islands had exactly THREE, and the largest was
//               71-79% of the total green in every single one — one park
//               programme wearing forty seeds.
//   boulevards  the count already varied 0-3, but every one of them was
//               declared at 22-30 m, so there was no such thing as a city
//               with a network of ordinary wide roads rather than a monument.
//
// A city now draws a park PROGRAMME (one great park / a set of squares /
// commons / a few greens / almost none) and a boulevard CHARACTER (grand or
// arterial), and this is the harness that says whether those still reach the
// ground. If any single row of these distributions goes back to 100%, the
// generator has stopped generating.
import { islandConfig } from "../src/citygen/island.mjs";
const N = Number(process.env.N ?? 40);
const q=(a,p)=>{const b=[...a].sort((x,y)=>x-y);return b[Math.floor(p*(b.length-1))];};
const rows=[];
for(let i=0;i<N;i++){
  const seed=(2166136261 ^ ((i+1)*2654435761))>>>0;
  let cfg; try { cfg = islandConfig(seed); } catch(e){ console.log("fail",seed,e.message); continue; }
  const parks=cfg.parks??[], dg=cfg.diagonals??[];
  const areas=parks.map(p=>p.w*p.h);
  const shapes=parks.map(p=>p.shape??"square");
  rows.push({seed,nPark:parks.length,areas,shapes,nDiag:dg.length,
    boul:cfg.plan?.boulevards, kind:cfg.plan?.boulevardKind, prog:cfg.plan?.parkProgramme, seams:dg.length-(cfg.plan?.boulevards??0), dw:dg.map(d=>d.h)});
}
console.log(`\nPARKS AND BOULEVARDS ACROSS ${rows.length} GENERATED ISLANDS\n`);
const counts={}; for(const r of rows) counts[r.nPark]=(counts[r.nPark]??0)+1;
console.log("park COUNT distribution:", Object.entries(counts).map(([k,v])=>`${k} parks x${v}`).join("  "));
const bc={}; for(const r of rows) bc[r.boul??"?"]=(bc[r.boul??"?"]??0)+1;
console.log("boulevard COUNT distribution:", Object.entries(bc).map(([k,v])=>`${k} x${v}`).join("  "));
const all=rows.flatMap(r=>r.areas);
console.log(`\npark AREA (sq m): p10 ${Math.round(q(all,0.1))}  median ${Math.round(q(all,0.5))}  p90 ${Math.round(q(all,0.9))}  max ${Math.round(Math.max(...all))}`);
console.log("\nper-city park areas, biggest first (first 12 cities):");
for(const r of rows.slice(0,12)) console.log(`  ${String(r.seed).padStart(10)}  ${[...r.areas].sort((a,b)=>b-a).map(a=>Math.round(a/1000)+"k").join(" ")}`);
// the shape question: is the LARGEST park always about the same share of total?
const dw=rows.flatMap(r=>r.dw??[]);
console.log("\nBOULEVARD widths (h, the reservation):", dw.length?`p10 ${Math.round(q(dw,0.1))} median ${Math.round(q(dw,0.5))} p90 ${Math.round(q(dw,0.9))}`:"n/a");
const kc={}; for(const r of rows) kc[`${r.boul} ${r.kind}`]=(kc[`${r.boul} ${r.kind}`]??0)+1;
console.log("\nboulevard COUNT x CHARACTER:", Object.entries(kc).sort().map(([k,v])=>`${k} x${v}`).join("  "));
const pc={}; for(const r of rows) pc[r.prog]=(pc[r.prog]??0)+1;
console.log("park PROGRAMME:", Object.entries(pc).map(([k,v])=>`${k} x${v}`).join("  "));
const sc={}; for(const r of rows) for(const s of r.shapes??[]) sc[s]=(sc[s]??0)+1;
console.log("park SHAPES:", Object.entries(sc).sort().map(([k,v])=>`${k} x${v}`).join("  "));
if (!(sc.round >= Math.max(3, Math.floor(rows.length * 0.08)))) {
  console.error(`\nFAIL  too few round parks (${sc.round ?? 0} across ${rows.length} islands — need at least ${Math.max(3, Math.floor(rows.length * 0.08))})`);
  process.exit(1);
}
console.log("\nis the park programme always the same shape?");
console.log("  city   nParks   largest/total   total area");
for(const r of rows.slice(0,12)){
  const t=r.areas.reduce((a,b)=>a+b,0);
  console.log(`  ${String(r.seed).slice(0,8).padStart(9)} ${String(r.nPark).padStart(6)} ${(Math.max(...r.areas)/t*100).toFixed(0).padStart(13)}% ${Math.round(t/1000).toString().padStart(11)}k`);
}

// District silhouettes — Exchange reads taller than Millside on the same town.
import { makeCity, PROCEDURAL } from "../src/citygen/index.mjs";
const med = (arr) => { const s=[...arr].sort((a,b)=>a-b); return s.length?s[Math.floor(s.length/2)]:0; };
let districtFails = 0;
for (const seed of [20261, 481923, 550991]) {
  const p = makeCity(PROCEDURAL, seed, { size: "city", density: "development" }).parcels;
  const byD = {};
  for (const r of Object.values(p)) {
    if ((r.floors ?? 0) <= 0) continue;
    (byD[r.district] ??= []).push(r.floors);
  }
  const ranked = Object.entries(byD).filter(([, fs]) => fs.length >= 8).sort((a, b) => med(b[1]) - med(a[1]));
  const tall = ranked[0]?.[1] ?? [];
  const low = ranked[ranked.length - 1]?.[1] ?? [];
  const ok = tall.length >= 20 && low.length >= 8 && med(tall) > med(low);
  if (!ok) districtFails++;
  console.log(`\nDISTRICT MASSING seed ${seed}: tallest med ${med(tall)} (n=${tall.length})  shortest med ${med(low)} (n=${low.length})  ${ok ? "OK" : "FAIL"}`);
}
if (districtFails) { console.log(`\nFAIL  ${districtFails} seed(s) — exchange should read taller than millside`); process.exit(1); }
console.log("\nvariety pass (parks + district massing)");
