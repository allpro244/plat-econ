import { useStore } from "@/state/store";
import type { GameState } from "@/engine/types";

/**
 * Signature of everything a property desk needs for one BBL.
 *
 * Zustand notifies every `useStore(s => s.game)` subscriber on any mutation —
 * LOI counters, cash draws, news — so a docked parcel card and its child desks
 * used to re-render the whole file on every click in town. Components that call
 * `useHeldGame(bbl)` only re-render when THIS parcel's picture (or the city-wide
 * indices it prices off) actually moved.
 */
export function holdingDeskSig(g: GameState | null | undefined, bbl: string): string {
  if (!g || !bbl) return "";
  const h = g.holdings[bbl];
  const sale = h?.sale;
  const bids = sale?.bids?.map((b) =>
    `${b.name}:${b.price}:${b.countered ? 1 : 0}:${b.dropped ? 1 : 0}`).join(";") ?? "";
  const tenants = h?.tenants?.map((t) => `${t.sf}:${t.rentPsf}:${t.endM}:${t.credit}`).join(";") ?? "";
  const makeReady = h?.makeReady?.map((m) => `${m.sf}:${m.readyM}:${m.use}`).join(";") ?? "";
  const lois = g.lois
    .filter((l) => l.bbl === bbl)
    .map((l) => `${l.id}:${l.rentPsf}:${l.tiPsf}:${l.stage}:${l.expiresM}`)
    .join(",");
  const listing = g.listings.find((l) => l.bbl === bbl);
  const ap = g.approaches[bbl];
  const talk = g.talks?.[bbl];
  const dev = g.developments[bbl];
  const w = g.workouts?.[bbl];
  const gl = g.groundLeases?.[bbl];
  const varianceApp = g.varianceApps?.[bbl]
    ?? (g.varianceApp?.bbl === bbl ? g.varianceApp : undefined);
  const varianceLog = g.varianceLog?.[bbl];
  return [
    g.month,
    g.cash,
    g.econ.phase,
    g.econ.indexRate,
    g.econ.costIdx,
    g.econ.landIdx,
    g.econ.rentIdx?.office,
    g.econ.rentIdx?.retail,
    g.econ.rentIdx?.multifamily,
    g.econ.rentIdx?.industrial,
    g.econ.cycleDev,
    g.agent ? 1 : 0,
    g.teamLeasing ? 1 : 0,
    g.loc?.balance ?? 0,
    g.facility?.balance ?? 0,
    // Assemble / neighbour gates — another deed in the book can unlock the desk
    // without touching this holding's own fields.
    Object.keys(g.holdings).length,
    (g.facility?.bbls ?? []).join(","),
    h ? 1 : 0,
    h?.condition,
    h?.condIdx,
    h?.boughtM,
    h?.costBasis,
    h?.assessed,
    h?.taxAppeal ? `${h.taxAppeal.filedM}:${h.taxAppeal.decideM}:${h.taxAppeal.target}:${h.taxAppeal.odds}` : "",
    h?.lastTaxAppealM ?? "",
    h?.loan?.balance,
    h?.loan?.ratePct,
    h?.loan?.maturityM,
    h?.loan?.sweep ? 1 : 0,
    h?.renovatingUntilM,
    h?.broker ? 1 : 0,
    h?.leasingHold ? 1 : 0,
    h?.plan,
    h?.service,
    // Stance / capital-program toggles used to update the engine without
    // changing this signature — the docked card looked dead until something
    // else (cash, loan) moved and forced a re-render.
    h?.stance,
    h?.program ? `${h.program.id}:${h.program.untilM}` : "",
    // programsDone is id → completed month, not an array.
    Object.entries(h?.programsDone ?? {}).map(([k, v]) => `${k}:${v}`).join(","),
    sale?.ask,
    sale?.offer?.price,
    sale?.offer?.expiresM,
    sale?.unsolicited ? 1 : 0,
    sale?.round ?? "",
    sale?.callM ?? "",
    bids,
    h?.occ ?? "",
    makeReady,
    tenants,
    lois,
    listing?.ask ?? "",
    // Off-market conversations change shape without always moving ask/q —
    // a blind bid updates probes/lastBid, and "they finally named it" flips
    // mode+ask while q stays put. Missing any of these left the deal desk on
    // the previous sentence (toast said one thing; the panel another).
    ap?.ask ?? "",
    ap?.q ?? "",
    ap?.mode ?? "",
    ap?.reserve !== undefined ? 1 : 0,
    ap?.probes ?? 0,
    ap?.lastBid ?? "",
    ap?.named ? 1 : 0,
    ap?.countered ? 1 : 0,
    ap?.inbound ? 1 : 0,
    ap?.refused ? 1 : 0,
    // Purchase negotiation state. This was missing from the parcel signature,
    // so a seller's counter updated GameState without re-rendering the offer
    // desk. Moving the slider changed local React state and accidentally made
    // the counter appear, which is why the slider seemed required.
    talk?.theirPrice ?? "",
    talk?.yourPrice ?? "",
    talk?.round ?? "",
    talk?.final ? 1 : 0,
    talk?.agreed ? 1 : 0,
    talk?.agreedPrice ?? "",
    dev?.deliverM ?? "",
    dev?.startM ?? "",
    dev?.drawn ?? "",
    dev?.loanBalance ?? "",
    dev?.costTotal ?? "",
    dev?.equitySpent ?? "",
    dev?.repudiatedM ?? "",
    w?.stage ?? "",
    w?.cure ?? "",
    w?.servicing ? 1 : 0,
    w?.decideM ?? "",
    w?.saleM ?? "",
    gl ? `${gl.endM}:${gl.rentYr}:${gl.review ?? "fixed"}:${gl.builtM ?? ""}:${gl.floors ?? ""}` : "",
    varianceApp ? `${varianceApp.filedM}:${varianceApp.decideM}:${varianceApp.grant}:${varianceApp.odds}` : "",
    varianceLog ? `${varianceLog.m}:${varianceLog.granted ? 1 : 0}:${varianceLog.far}` : "",
    h?.groundOffer ? `${h.groundOffer.years}:${h.groundOffer.review ?? "fixed"}:${h.groundOffer.sinceM}` : "",
    h?.btsOffer ? `${h.btsOffer.use}:${h.btsOffer.floors}:${h.btsOffer.coverage}:${h.btsOffer.sinceM}` : "",
    g.btsProspects?.[bbl]
      ? `${g.btsProspects[bbl]!.name}:${g.btsProspects[bbl]!.use}:${g.btsProspects[bbl]!.sf}:${g.btsProspects[bbl]!.signedM}`
      : "",
    g.merged?.[bbl] ?? "",
    g.built?.[bbl] ? 1 : 0,
    (h?.hist?.length ?? 0),
    h?.hist?.length ? h.hist[h.hist.length - 1]!.join(":") : "",
  ].join("|");
}

/** Subscribe to one parcel's desk inputs; read the live game during render. */
export function useHeldGame(bbl: string): GameState {
  useStore((s) => holdingDeskSig(s.game, bbl));
  return useStore.getState().game!;
}
