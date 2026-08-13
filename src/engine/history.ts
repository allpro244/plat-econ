// THE DEED REMEMBERS.
//
// News is intentionally a short rolling wire. Property history is sparse,
// structured and permanent: the handful of events that changed what a site
// was, who owned it, or who occupied a material share of it.
import type { GameState, PropertyEvent } from "./types";
import { monthLabel } from "./types";

export const PROPERTY_HISTORY_CAP = 24;

export function recordPropertyEvent(
  s: GameState, bbl: string, event: Omit<PropertyEvent, "m"> & { m?: number },
): void {
  if (!bbl) return;
  if (!s.propertyLog) s.propertyLog = {};
  const row: PropertyEvent = { ...event, m: event.m ?? s.month };
  const log = s.propertyLog[bbl] ?? [];
  // One engine path may report the same transfer through settlement and a
  // wrapper. Deduplicate exact event identities, not separate events in a busy
  // month (two major leases signed together are both history).
  const duplicate = log.some((x) =>
    x.m === row.m && x.kind === row.kind && x.party === row.party
    && x.otherParty === row.otherParty && x.amount === row.amount
    && x.outcome === row.outcome);
  if (!duplicate) log.push(row);
  if (log.length > PROPERTY_HISTORY_CAP) log.splice(0, log.length - PROPERTY_HISTORY_CAP);
  s.propertyLog[bbl] = log;
}

export function propertyTimeline(s: GameState, bbl: string): PropertyEvent[] {
  const out = [...(s.propertyLog?.[bbl] ?? [])];
  // Old saves have no propertyLog, but recent deed transfers already live in
  // the comps tape. Fold those facts in at read time without duplicating new
  // transfers that recordComp stamped into both structures.
  for (const c of s.comps ?? []) {
    if (c.bbl !== bbl) continue;
    if (out.some((e) => e.kind === "trade" && e.m === c.m && e.amount === c.price)) continue;
    out.push({
      m: c.m,
      kind: "trade",
      party: c.buyer,
      otherParty: c.seller,
      amount: c.price,
      outcome: c.distress ? "distress sale" : c.offMarket ? "off-market" : "marketed",
    });
  }
  return out.sort((a, b) => b.m - a.m);
}

const money = (n: number) =>
  Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1000)}K`;

export function describePropertyEvent(e: PropertyEvent): { when: string; title: string; detail: string } {
  const when = monthLabel(e.m);
  switch (e.kind) {
    case "trade":
      return {
        when,
        title: `Deed transferred${e.amount ? ` · ${money(e.amount)}` : ""}`,
        detail: `${e.otherParty ?? "Seller"} → ${e.party ?? "Buyer"}${e.outcome ? ` · ${e.outcome}` : ""}`,
      };
    case "build-start":
      return {
        when,
        title: `Ground broken · ${e.floors ?? "?"} floors`,
        detail: `${e.sf ? `${Math.round(e.sf).toLocaleString()} sf` : "Project"} of ${e.use ?? "mixed use"}${e.party ? ` · ${e.party}` : ""}`,
      };
    case "delivered":
      return {
        when,
        title: `Building opened · ${e.floors ?? "?"} floors`,
        detail: `${e.sf ? `${Math.round(e.sf).toLocaleString()} sf` : "New building"} of ${e.use ?? "mixed use"}${e.party ? ` · ${e.party}` : ""}`,
      };
    case "demolished":
      return { when, title: "Building demolished", detail: e.outcome ?? "The site was cleared for redevelopment." };
    case "default":
      return { when, title: "Default / enforcement", detail: e.outcome ?? e.party ?? "The secured party took control." };
    case "major-lease":
      return {
        when,
        title: `Major lease · ${e.party ?? "Tenant"}`,
        detail: `${e.sf ? `${Math.round(e.sf).toLocaleString()} sf` : "Material space"}${e.amount ? ` · ${money(e.amount)} annual rent` : ""}`,
      };
    case "planning":
      return { when, title: "Planning decision", detail: e.outcome ?? "The legal envelope changed." };
  }
}
