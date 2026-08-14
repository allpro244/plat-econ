import type { ReactNode } from "react";
import { useStore } from "@/state/store";
import { useHeldGame } from "@/ui/heldGame";
import { CLASS_LABEL } from "@/data/types";
import type { ParcelRecord } from "@/data/types";
import type { GameState, Holding } from "@/engine/types";
import { resolveRec, appraise, physicalOcc as physicalOccupancy, inPlace } from "@/engine/value";
import { blockReport } from "@/engine/demand";
import { isMixedUse, uses as usesOf } from "@/engine/mix";
import { usd, sf } from "@/ui/format";

/** What to call a building: its dominant use, or "Mixed-Use" when it has none. */
export function useLabel(rec: { class: string; bbl: string; floors: number; unitsRes: number; bldgArea: number; mix?: Record<string, number> }): string {
  if (rec.class === "land") return CLASS_LABEL.land;
  return isMixedUse(rec as never) ? "Mixed-Use" : CLASS_LABEL[dominantOf(rec as never)];
}
export function dominantOf(rec: never): "office" | "retail" | "multifamily" | "industrial" {
  return usesOf(rec)[0] ?? "office";
}
export const devUseLabel = (u: string) => (u === "mixed" ? "Mixed-Use" : CLASS_LABEL[u as "office"]);

/**
 * Physical occupancy of the WHOLE building. It used to be implemented here;
 * it now lives in value.ts, because the engine records it every quarter and
 * one quantity does not get two implementations. The `never` shim keeps the
 * ~7 existing call sites in this file, which pass `rec as never`, untouched.
 */
export function physicalOcc(rec: never, h: { tenants: { sf: number }[]; occ?: number }): number {
  return physicalOccupancy(rec as never as ParcelRecord, h as never as Holding);
}

/**
 * WHY THERE IS NO `disclosed()` HELPER HERE ANY MORE.
 *
 * There used to be one: it wrapped the seller's disclosure in the shape
 * `holdingNOIYr` expects, so a building on the tape could be priced with the
 * same functions as one you own. Three call sites used it and six did not, and
 * the six went on quoting `noiAfterTaxYr` — the class model, which takes a
 * ParcelRecord and structurally cannot see a rent roll. A helper that half the
 * panel ignores is not a fix; it is a second opinion.
 *
 * So it moved into the engine, where the lender and the comps sheet can reach
 * it too: `disclosureFor` finds what the seller has shown, `asIfOwned` puts it
 * in the shape of a holding, and `inPlace` returns the going-in NOI and the
 * in-place occupancy together with a flag saying whether they are facts or an
 * estimate. `goingIn` below is the thin panel wrapper that resolves the record.
 */

/**
 * THE GOING-IN NUMBERS FOR A BUILDING THE PLAYER IS LOOKING AT, and the flag
 * that says whether they are facts or an estimate.
 *
 * One call, so a panel cannot accidentally quote the market's read on income
 * beside the roll's read on occupancy. `disclosed === false` means nobody has
 * shown you anything, and every label that renders it says so.
 */
export function goingIn(game: GameState, bbl: string, price: number) {
  const parcels = useStore.getState().parcels;
  const rec = parcels ? resolveRec(parcels, game, bbl) : null;
  if (!rec) return { noi: 0, occ: 0, disclosed: false, h: null, rec: null };
  return { ...inPlace(rec, game, bbl, price), rec };
}

// Appraisals are opinions with a range, not the true number.
export function band(bbl: string, value: number): string {
  const a = appraise(bbl, value);
  return `${usd(a.lo)} – ${usd(a.hi)}`;
}
export function apMid(bbl: string, value: number): number {
  return appraise(bbl, value).mid;
}

export function NWChart({ data, height = 120 }: { data: number[]; height?: number }) {
  if (!data || data.length < 2) return null;
  const W = 720, H = height, PAD = 6;
  const step = Math.max(1, Math.floor(data.length / 360));
  const pts: number[] = [];
  for (let i = 0; i < data.length; i += step) pts.push(data[i]);
  if (pts[pts.length - 1] !== data[data.length - 1]) pts.push(data[data.length - 1]);
  const lo = Math.min(0, ...pts), hi = Math.max(1, ...pts);
  const x = (i: number) => PAD + (i / (pts.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - lo) / (hi - lo)) * (H - 2 * PAD);
  const line = pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const zero = y(0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="nw-chart" role="img" aria-label="Net worth over time">
      <polygon points={`${x(0)},${zero} ${line} ${x(pts.length - 1)},${zero}`} className="nw-fill" />
      {lo < 0 && <line x1={PAD} x2={W - PAD} y1={zero} y2={zero} className="nw-zero" />}
      <polyline points={line} className="nw-line" fill="none" />
    </svg>
  );
}

// ---------------------------------------------------------------- parcel card
/**
 * THE DESKS A BUILDING HAS. The property page grew until it was one scroll of
 * eleven unrelated cards — a rent roll, a mortgage, a wrecking bill and a bid
 * list, all in a column. These are the same cards, sorted by which question
 * you opened the page to ask. The docked panel passes no tab and still gets
 * the lot, because there you are glancing rather than working.
 */

export type PropTab = "summary" | "leasing" | "money" | "ops" | "deal" | "build" | "history";

export function annualPayment(principal: number, ratePct: number, years: number): number {
  const r = ratePct / 100 / 12;
  const n = years * 12;
  if (r <= 0) return principal / years;
  return (principal * r) / (1 - Math.pow(1 + r, -n)) * 12;
}

// Counter an off-market ask at YOUR number. One shot; the deeper the cut,
// the likelier they hang up instead of grumbling.

// The credit window, in words rather than an index nobody can calibrate.
export function creditWord(ci: number): string {
  return ci >= 1.08 ? "loose" : ci >= 0.92 ? "open" : ci >= 0.78 ? "selective" : ci >= 0.62 ? "tight" : "shut";
}

export const real = (nom: number | undefined, cpi: number | undefined) => (nom ?? 1) / (cpi || 1);

/**
 * WHICH RESEARCH TAB A LINK FROM SOMEWHERE ELSE WANTED.
 *
 * `rtab` is state inside `ResearchPage`, and `ResearchPage` does not exist
 * until `setPage("research")` mounts it — so a caller cannot set the tab
 * directly and there is nothing on the store to set either. This is the
 * handoff: the link drops a tab name, the page reads it in its `useState`
 * initialiser on the first render, and an effect clears it once that render has
 * committed.
 *
 * READING AND CLEARING ARE TWO STEPS FOR A REASON, and the reason is
 * StrictMode. `main.tsx` wraps the app in it, and StrictMode invokes a lazy
 * `useState` initialiser TWICE — so a `take()` that cleared as it read would
 * hand the tab to the first invocation and hand `null` to the second, which is
 * the one React keeps. The link would have worked in a production build and
 * silently done nothing in dev, which is the worst of the two directions.
 * Reading is idempotent; the clear is in the effect, where being run twice is
 * harmless.
 *
 * It clears at all because a deep link that permanently changes a page's home
 * is not a deep link: without this, closing Research and reopening it from the
 * nav would put you back on the street table for the rest of the session. One
 * shot, and if nobody follows a link the page opens exactly as it did before
 * this existed.
 *
 * Module scope for the same reason `brokerCallsSeen` above is: it is a fact
 * about the click you just made in this browser, and it has no business
 * travelling in a save.
 */
export let pendingRTab: string | null = null;
export const openResearchOn = (tab: string) => { pendingRTab = tab; };
/** Clear after ResearchPage reads the handoff (cannot assign through an import binding). */
export const clearPendingRTab = () => { pendingRTab = null; };

export function Big({ label, value, bad, title }: { label: string; value: string; bad?: boolean; title?: string }) {
  return (
    <div className="big-stat" title={title}>
      <div className="big-label">{label}</div>
      <div className={"big-value mono" + (bad ? " v-bad" : "")}>{value}</div>
    </div>
  );
}

// Why a corner is getting better, in the terms a principal actually thinks in:
// how many people work here, how many live here, how much of it is open to the
// street — and which of the three is missing. The demand number on the card is
// downstream of exactly these; nothing here is decoration.
// The engine probes the block with a test floorplate of each use and reports
// which one moves it most, so the copy says exactly that — a marginal claim,
// not an assertion about what the block does or doesn't have.
export const WANTS_LABEL: Record<string, string> = {
  office: "Per square foot, offices would lift this block further than any other use.",
  industrial: "Per square foot, industrial would lift this block further than any other use.",
  multifamily: "Per square foot, housing would lift this block further than any other use.",
  retail: "Per square foot, retail would lift this block further than any other use.",
  mixed: "Per square foot, mixed use would lift this block further than any other use.",
};
export function Neighbourhood({ bbl, block }: { bbl: string; block: string }) {
  const game = useHeldGame(bbl);
  const parcels = useStore((s) => s.parcels);
  // block drift moves without touching the holding — keep this readout live
  useStore((s) => s.game?.blockD?.[block] ?? 0);
  if (!parcels) return null;
  const r = blockReport(game, parcels, block);
  if (!r) return null;
  const n = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v));
  const moved = Math.abs(r.drift) >= 0.5;
  return (
    <div className="deal" key={bbl}>
      <div className="deal-head">The neighbourhood · within a five-minute walk</div>
      <div className="grid">
        <Row k="Jobs" v={n(r.jobs)} />
        <Row k="Residents" v={n(r.residents)} />
        <Row k="Storefront" v={sf(r.amenitySf)} />
        <Row
          k="Since 2000"
          v={moved ? `${r.drift > 0 ? "+" : ""}${r.drift.toFixed(0)} demand` : "unchanged"}
          strong={r.drift > 0.5}
          bad={r.drift < -0.5}
        />
        <Row
          k="Hiring"
          v={Math.abs(r.hiring) < 0.5 ? "in line with the city" : `${r.hiring > 0 ? "+" : ""}${r.hiring.toFixed(0)} demand`}
          strong={r.hiring > 0.5}
          bad={r.hiring < -0.5}
        />
        <Row k="The work here" v={r.trades.map((t) => `${Math.round(t.share * 100)}% ${t.label.toLowerCase()}`).join(", ")} />
        {r.line ? (
          <Row
            k="Transit"
            v={r.line.monthsOut > 0
              ? `${r.line.name} station, ${Math.max(1, Math.round(r.line.monthsOut / 12))} yrs out`
              : `${r.line.name} station, open`}
            strong
          />
        ) : null}
      </div>
      <div className="deal-note">
        {r.balanced
          ? "Jobs, housing and street life are in balance here — every added foot compounds."
          : WANTS_LABEL[r.wants]}
      </div>
    </div>
  );
}

export function Row({ k, v, strong, bad, title }: {
  k: ReactNode; v: string; strong?: boolean; bad?: boolean; title?: string;
}) {
  return (
    <>
      <div className="k" title={title}>{k}</div>
      <div className={"v mono" + (strong ? " v-strong" : "") + (bad ? " v-bad" : "")} title={title}>{v}</div>
    </>
  );
}
