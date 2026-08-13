// THE PLAYER IS A STRING, AND THE STRING IS "You".
//
// Twelve rival firms have names — Calloway & Reed, Longwharf Realty, Kestrel
// Capital — with balance sheets, styles, a line on the league table and a
// paper trail of comps behind them. The player has a pronoun. Grep it: the
// comps sheet records "You" as the buyer, the league table sorts a row called
// "You", the news tape addresses "you" in the second person.
//
// That single fact is why thirty years in, the game still sounds like year
// one. Every sentence about a rival is written by a newspaper; every sentence
// about the player is written by a narrator who has never met them. The city
// has no idea who you are, and it never finds out.
//
// So: you get a name, and the game stops NARRATING you and starts REPORTING
// you. And then it goes further — it works out what to call you, from what
// you have actually done.
//
// Everything in this file is a pure function of state that is already on
// screen somewhere else. Nothing is invented. Every epithet has a number
// behind it the player could have looked up before the paper printed it,
// which is the whole difference between characterisation and flattery.
import type { ParcelTable } from "@/data/types";
import type { Epithet, GameState } from "./types";
import { START_YEAR } from "./types";
import { resolveRec, ownedHoldingValue } from "./value";
import { INDUSTRY_LABEL } from "./market";

// ---------------------------------------------------------------- the name
const FIRST = [
  "Ashgrove", "Bellhaven", "Corbin", "Draymore", "Eastbourne", "Fennimore",
  "Garrick", "Halloran", "Ingersoll", "Jessup", "Kelmscott", "Larkin",
  "Marchmont", "Nevison", "Oldbury", "Pemberton", "Quayle", "Rutherford",
  "Sandiford", "Thorndike", "Underhill", "Vance", "Wexford", "Yardley",
];
const SUFFIX = [
  "& Co.", "Partners", "Holdings", "Properties", "Estates", "Group",
  "& Sons", "Realty", "Capital", "Trust", "Development", "Associates",
];

/** A name for a firm that does not have one yet. */
export function generateFirmName(seed: number): { name: string; short: string } {
  const a = FIRST[Math.abs(Math.round(seed * 2654435761)) % FIRST.length];
  const b = SUFFIX[Math.abs(Math.round(seed * 40503)) % SUFFIX.length];
  return { name: `${a} ${b}`, short: a };
}

/** District ids arrive lowercase; a newspaper would not print them that way. */
function titleCase(d: string): string {
  return d.replace(/(^|[\s-])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}

export function firmName(s: GameState): string {
  return s.firm?.name ?? "You";
}
export function firmShort(s: GameState): string {
  return s.firm?.short ?? "You";
}

// ------------------------------------------------------------- the epithets
//
// What the city would say about you in an appositive clause. Each is a claim
// with a threshold and a date, so the game knows not just that a thing is true
// but HOW LONG it has been true — which is how you get "a position they have
// held for twenty-two years" rather than "currently the largest".

interface Claim {
  id: string;
  text: string;
  weight: number;   // how quotable; the headline is the heaviest live claim
}

/**
 * Work out everything true about this firm right now.
 *
 * Deliberately conservative: a claim only fires on a real threshold, so a
 * player with three buildings is not described as a titan. The city is not
 * flattering you, it is reporting.
 */
function claimsNow(s: GameState, parcels: ParcelTable): Claim[] {
  const out: Claim[] = [];
  const holds = Object.values(s.holdings);
  if (!holds.length) return out;

  // ---- scale, by district and by class ------------------------------------
  const byDistrict = new Map<string, number>();
  const byClass = new Map<string, number>();
  let total = 0, builtSf = 0;
  for (const h of holds) {
    const rec = resolveRec(parcels, s, h.bbl);
    if (!rec) continue;
    const v = ownedHoldingValue(s, parcels, h);
    total += v;
    if (!h.groundLeased && rec.class !== "land" && rec.bldgArea > 0) builtSf += rec.bldgArea;
    const d = rec.district ?? "";
    if (d) byDistrict.set(d, (byDistrict.get(d) ?? 0) + v);
    byClass.set(rec.class, (byClass.get(rec.class) ?? 0) + v);
  }

  // Are you the biggest owner in a district? Compare against the street, whose
  // holdings are already public on the Ownership Register.
  const rivalDistrict = new Map<string, Map<string, number>>();
  for (const r of s.rivals ?? []) {
    if (r.failedM !== undefined) continue;
    for (const b of r.bbls) {
      const rec = resolveRec(parcels, s, b);
      if (!rec?.district) continue;
      const m = rivalDistrict.get(rec.district) ?? new Map<string, number>();
      m.set(r.name, (m.get(r.name) ?? 0) + 1);
      rivalDistrict.set(rec.district, m);
    }
  }
  const myCountByDistrict = new Map<string, number>();
  for (const h of holds) {
    const rec = resolveRec(parcels, s, h.bbl);
    if (rec?.district) myCountByDistrict.set(rec.district, (myCountByDistrict.get(rec.district) ?? 0) + 1);
  }
  for (const [d, mine] of myCountByDistrict) {
    if (mine < 4) continue;
    const best = Math.max(0, ...[...(rivalDistrict.get(d)?.values() ?? [])]);
    if (mine > best) out.push({ id: `biggest-${d}`, text: `the largest landlord in ${titleCase(d)}`, weight: 0.9 });
  }

  // ---- a builder, or a buyer ----------------------------------------------
  const delivered = (s.delivered ?? 0);
  if (delivered >= 3) {
    out.push({
      id: "builder",
      text: delivered >= 10 ? "who has put up more of this city than anybody living" : "a developer rather than a buyer",
      weight: delivered >= 10 ? 0.95 : 0.6,
    });
  }

  // ---- the one that says the most about temperament ------------------------
  const lastSale = s.exits.length ? Math.max(...s.exits.map((e) => e.soldM)) : undefined;
  if (holds.length >= 5) {
    if (lastSale === undefined) {
      out.push({ id: "never-sold", text: "who has never sold a building", weight: 0.85 });
    } else if (s.month - lastSale >= 96) {
      out.push({
        id: "no-sales-since",
        text: `who has not sold a building since ${START_YEAR + Math.floor(lastSale / 12)}`,
        weight: 0.8,
      });
    }
  }
  if (s.exits.length >= 12) {
    const held = s.exits.reduce((a, e) => a + (e.soldM - e.boughtM), 0) / s.exits.length / 12;
    if (held < 4) out.push({ id: "trader", text: "who trades buildings the way other people trade paper", weight: 0.75 });
  }

  // ---- concentration, which is a character trait as much as a risk ---------
  const roll = new Map<string, number>();
  let rollTotal = 0;
  for (const h of holds) for (const t of h.tenants) {
    const a = t.rentPsf * t.sf;
    roll.set(t.sector, (roll.get(t.sector) ?? 0) + a);
    rollTotal += a;
  }
  if (rollTotal > 0) {
    const [sector, amt] = [...roll.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
    if (amt / rollTotal > 0.42 && holds.length >= 5) {
      out.push({
        id: "sector-" + sector,
        text: `whose rent roll is mostly ${INDUSTRY_LABEL[sector as never] ?? sector}`,
        weight: 0.7,
      });
    }
  }

  // ---- the class you are known for ----------------------------------------
  if (total > 0 && holds.length >= 6) {
    const [cls, amt] = [...byClass.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
    if (amt / total > 0.62 && cls !== "land") {
      out.push({ id: "class-" + cls, text: `an ${cls === "office" ? "office" : cls} house and nothing else`, weight: 0.55 });
    }
  }

  // ---- leverage, which the street can read off the public record -----------
  const debt = holds.reduce((a, h) => a + (h.loan?.balance ?? 0), 0);
  if (total > 0 && holds.length >= 5) {
    const lev = debt / total;
    if (lev > 0.72) out.push({ id: "levered", text: "levered to the eyeballs", weight: 0.8 });
    else if (lev < 0.18 && total > 20_000_000) out.push({ id: "unlevered", text: "who owns almost everything free and clear", weight: 0.7 });
  }

  // ---- and the mark nobody forgets ----------------------------------------
  const forced = s.exits.filter((e) => e.forced).length;
  if (forced >= 2) out.push({ id: "forced", text: `who has handed ${forced === 2 ? "two buildings" : `${forced} buildings`} back to the banks`, weight: 0.9 });

  void builtSf;
  return out;
}

/**
 * Recompute the live epithet set, preserving the month each claim first became
 * true. That date is the whole point: it turns "the largest landlord in
 * Harborside" into "who has been the largest landlord in Harborside since
 * 2014", which is a sentence about a career rather than a snapshot.
 */
export function tickFirm(s: GameState, parcels: ParcelTable) {
  if (!s.firm) return;
  const claims = claimsNow(s, parcels);
  const prev = new Map((s.firm.epithets ?? []).map((e) => [e.id, e]));
  s.firm.epithets = claims.map((c) => ({
    id: c.id,
    text: c.text,
    weight: c.weight,
    sinceM: prev.get(c.id)?.sinceM ?? s.month,
  }));
}

/** The single line the city would lead with. */
export function headlineEpithet(s: GameState): Epithet | undefined {
  const es = s.firm?.epithets ?? [];
  if (!es.length) return undefined;
  return [...es].sort((a, b) => b.weight - a.weight)[0];
}

/**
 * The firm, as a newspaper would introduce it — name plus the most quotable
 * true thing about it. This is what turns "You bought 118 Drydock Ave" into
 * "Corbin & Co., who has not sold a building since 2019, has paid $41.6M".
 */
export function describeFirm(s: GameState, opts: { withEpithet?: boolean } = {}): string {
  const name = firmName(s);
  if (opts.withEpithet === false) return name;
  const e = headlineEpithet(s);
  if (!e) return name;
  // A claim that has been true for years is worth dating; a fresh one is not.
  const yrs = Math.floor((s.month - e.sinceM) / 12);
  return yrs >= 8 ? `${name}, ${e.text} for ${yrs} years now,` : `${name}, ${e.text},`;
}
