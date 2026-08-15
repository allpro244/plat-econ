// THE plat-city/1 DOCUMENT, built from a generated city and a game state.
// Shared by the one-shot exporter (export-city.mjs) and the campaign runner
// (game-server.mjs) so both write byte-identical structure.
export function buildCityDoc(E, city, g, extra = {}) {
  const parcels = {};
  for (const [bbl, p] of Object.entries(city.parcels)) {
    let occ = 0, cond = null;
    const rec = E.resolveRec(city.parcels, g, bbl);
    if (rec && rec.class !== "land") {
      const h = g.holdings[bbl];
      occ = +(h ? E.physicalOcc(rec, h) : E.occupancy(rec, g.econ)).toFixed(3);
      if (h?.condIdx != null) cond = +h.condIdx.toFixed(3);
    }
    // THE MONEY LINES (docs/GAME-PLAN.md phase 3.1): appraisal by the
    // engine's own assetValue, asking price by the canonical rule the
    // acquisition desk uses (listing ask, else off-market approach ask,
    // else nothing — an unlisted parcel has no ask).
    let value = null, ask = null, listed = 0, distress = 0;
    if (rec && rec.class !== "land") {
      try { value = Math.round(E.assetValue(rec, g.econ, E.gradeOf(g, rec))); } catch { /* no read */ }
    } else if (rec) {
      try { value = Math.round(E.landValue(rec, g.econ)); } catch { /* no read */ }
    }
    const li = (g.listings ?? []).find((l) => l.bbl === bbl);
    if (li) { ask = Math.round(li.ask); listed = 1; distress = li.distress ? 1 : 0; }
    else if (g.approaches?.[bbl]?.ask) ask = Math.round(g.approaches[bbl].ask);
    parcels[bbl] = {
      occ,
      ...(cond != null ? { cond } : {}),
      ...(value != null ? { value } : {}),
      ...(ask != null ? { ask } : {}),
      ...(listed ? { listed: 1 } : {}),
      ...(distress ? { distress: 1 } : {}),
      // The player's deeds, marked: the renderer may celebrate them.
      ...(g.holdings[bbl] ? { held: 1 } : {}),
      class: p.class,
      ...(p.mix ? { mix: p.mix } : {}),
      floors: p.floors,
      lotArea: p.lotArea,
      bldgArea: p.bldgArea,
      yearBuilt: p.yearBuilt,
      district: p.district,
      demandScore: p.demandScore,
      shoreM: p.shoreM,
      corridorM: p.corridorM,
      corner: p.corner,
      centroid: p.centroid,
    };
  }
  return {
    format: "plat-city/1",
    id: city.id,
    seed: city.seed,
    size: city.size,
    name: city.name,
    manifest: city.manifest,
    stats: city.stats,
    context: city.context,
    stations: city.stations,
    buildings3d: city.buildings3d,
    parcels,
    ...extra,
  };
}

/** The line the game view prints: date, cash, book, occupancy. */
export function hudOf(E, city, g) {
  const year = 2000 + Math.floor(g.month / 12);
  const mo = g.month % 12;
  const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  let heldSf = 0, occSum = 0, occN = 0;
  for (const bbl of Object.keys(g.holdings)) {
    const rec = E.resolveRec(city.parcels, g, bbl);
    if (!rec) continue;
    heldSf += rec.bldgArea ?? 0;
    occSum += E.physicalOcc(rec, g.holdings[bbl]);
    occN++;
  }
  return {
    city: city.name,
    firm: g.firmName ?? "your firm",
    date: `${MONTHS[mo]} ${year}`,
    month: g.month,
    cash: g.cash,
    holdings: Object.keys(g.holdings).length,
    heldSf: Math.round(heldSf),
    occ: occN ? +(occSum / occN).toFixed(3) : null,
    baseRate: g.econ?.baseRateBps != null ? g.econ.baseRateBps / 100 : null,
    listings: (g.listings ?? []).length,
    // The inbox: what the engine says needs a decision.
    attention: (() => { try { return E.attentionItems(g).map((a) => a.label).slice(0, 6); } catch { return []; } })(),
  };
}
