import { useEffect, useMemo, useState } from "react";
import { useStore } from "@/state/store";
import { CLASS_LABEL } from "@/data/types";
import { cityValueToReplacement } from "@/engine/dev";
import { portfolioIndustries } from "@/engine/comps";
import { INDUSTRY_LABEL, SECTORS } from "@/engine/market";
import { sf, pct } from "@/ui/format";
import { CompsSheet } from "@/ui/panels/CompsSheet";
import { TheStreet } from "@/ui/panels/StreetDesk";
import { Landlords } from "@/ui/panels/LandlordsDesk";
import { BuildingDatabase } from "@/ui/panels/MarketPage";
import { creditWord, pendingRTab, clearPendingRTab, Big } from "@/ui/panels/shared";
import { PersonCard, personAgeLine } from "@/ui/PersonCard";
import type { Person } from "@/engine/people";
import { monthLabel } from "@/engine/types";

// (The collapsible Fold component lived here. Research moved to sub-tabs —
// one section on screen at a time instead of a scroll of drawers — and no
// other page used it.)
export function ResearchPage() {
  const parcels = useStore((s) => s.parcels)!;
  const game = useStore((s) => s.game)!;
  const e = game.econ;
  void parcels;
  // SUB-TABS, NOT A SCROLL. Research had eight collapsible sections stacked in
  // one column, and finding the banks meant scrolling past everything above
  // them. Each section is a tab now; one is on screen at a time.
  // The register came out of this list because The street already answers who
  // owns what — firm by firm, every deed, inside the firm's own balance sheet
  // — and two lists of the same deeds is one list the player has to choose
  // between. "Stock" became "Properties" because the word meant the standing
  // building stock and reads as equities; the `stock` key is left alone
  // because nothing persists it and renaming it would only give one tab two
  // names in one file.
  // LAND AND BANKS LEFT THIS PAGE. They sit on the Economy page now, as two
  // more stances beside the four space markets — asked for directly, and right
  // for the same reason the tape left Research for Marketplace: land is an
  // input to every appraisal on the Economy page and the banks are the other
  // half of a cap rate, so reading them on a different screen from the rent
  // and vacancy they price against is how a site comes to look like it pencils.
  //
  // THE ONE CROSS-PAGE JUMP INTO THIS PAGE now lands where it always claimed
  // to. The comment here used to say it "goes to Research for the STREET tab,
  // which has not moved", and it did not: `setPage("research")` opened Research
  // and `rtab` initialised to "sectors", so clicking the owner's name on a
  // parcel card put you on a grid of sector rents with no sign of that firm
  // anywhere. Two tabs left this page in that pass and the tab this link wanted
  // moved position with them, which is presumably how it went unnoticed.
  // `pendingRTab` above is the fix — see the note on it for why the read and
  // the clear are separate.
  const [rtab, setRtab] = useState<string>(() => pendingRTab ?? "sectors");
  useEffect(() => { clearPendingRTab(); }, []);
  const RTABS: [string, string][] = [["sectors", "Sectors"], ["districts", "Districts"], ["trades", "Trades"],
    ["people", "People"], ["street", "The street"], ["landlords", "Landlords"], ["stock", "Properties"], ["comps", "Prints"]];
  return (
    <div>
      <div className="stat-strip">
        <Big label="Base rate" value={pct(e.indexRate)}
          title="Every loan in town prices off this benchmark: floating coupons reprice to it monthly, and new quotes are struck at this rate plus the lender's spread." />
        <Big label="Phase" value={e.phase + (e.rumoredPhase ? " ⚠" : "")} />
        <Big label="Cap · office" value={pct(e.capRate.office)} />
        <Big label="Cap · multifam" value={pct(e.capRate.multifamily)} />
        <Big label="Land index" value={e.landIdx.toFixed(2)} />
        <Big label="Cost index" value={e.costIdx.toFixed(2)} />
        <Big label="Credit" value={creditWord(e.creditIdx ?? 1)} bad={(e.creditIdx ?? 1) < 0.72} />
        <Big label="Employment" value={((e.employIdx ?? 1) * 100).toFixed(0)} />
        <Big
          label="Value vs replacement"
          value={`${cityValueToReplacement(game).toFixed(2)}×`}
          bad={cityValueToReplacement(game) < 0.95}
        />
      </div>
      {/* THE HINGE OF THE WHOLE DEVELOPMENT CYCLE, and it was nowhere. */}
      {(() => {
        const x = cityValueToReplacement(game);
        return (
          <div className="hint" style={{ marginTop: 6 }}>
            Finished buildings trade at <strong>{x.toFixed(2)}×</strong> what it costs to put them up.{" "}
            {x > 1.15
              ? "Above replacement cost, and comfortably — every developer in this city can see it, which is exactly how the next glut gets started. Build now and you will be delivering into their supply."
              : x > 1.0
                ? "Just above replacement cost. Building pencils, barely, and it does not pencil for anyone careless."
                : x > 0.85
                  ? "Below replacement cost. Nobody is starting anything, and the pipeline is emptying out — which is what eventually fixes a soft market. Buying is cheaper than building."
                  : "Far below replacement cost. Construction has stopped. Every building in this town is worth less than the bricks in it, and that is the best moment there is to be a buyer rather than a builder."}
          </div>
        );
      })()}

      <div className="btn-row" style={{ margin: "10px 0 6px", flexWrap: "wrap" }}>
        {RTABS.map(([id, label]) => (
          <button key={id} className={"btn" + (rtab === id ? " btn-on" : "")} onClick={() => setRtab(id)}>{label}</button>
        ))}
      </div>
      <div className="deals-grid">
        <div style={{ gridColumn: "1 / -1" }}>
        {rtab === "sectors" && (<div>
          <div className="hint">
            Classes do not move together. Momentum is where the sector is heading; demand is what the
            city's tenants actually did with their feet over the last twelve months, net of everything they
            handed back; the pipeline is what everyone <em>else</em> is building, and it lands on the rent
            about three years from now. A sector taking space in while nothing is under construction is
            where rent gets made — and a sector giving space back while the cranes are still up is the
            other half of that sentence.
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Sector</th><th className="num">Rent $/sf</th><th className="num">Cap rate</th>
                <th className="num">Momentum</th><th className="num">Demand · 12m</th><th className="num">Under construction</th>
                <th className="num">Delivering</th><th>Read</th>
              </tr>
            </thead>
            <tbody>
              {(["office", "retail", "multifamily", "industrial"] as const).map((k) => {
                const mom = e.sectorMom?.[k] ?? 0;
                const pipe = e.pipeline?.[k] ?? 0;
                const press = e.supplyPress?.[k] ?? 0;
                // WHAT THE TENANTS DID, as against what the market feels like.
                // Momentum is sentiment and it prices; this is the net
                // absorption the space market actually recorded over the last
                // twelve months — feet taken up less feet handed back — carried
                // against the standing stock, so a shed market and an office
                // market can be read on one scale. Measured across 2,400 months
                // of four seeds it runs from about −3% to +4% of stock with a
                // median near +0.5%, and it is negative 36% of the time, which
                // is the honest shape of a demand series: it spends real
                // stretches going backwards while the rent index is still
                // drifting up, and that gap is the trade.
                const abs12 = e.absorb12?.[k] ?? 0;
                const stk = e.stock?.[k] ?? 0;
                const dmd = stk > 0 ? abs12 / stk : 0;
                const dmdPct = +(dmd * 100).toFixed(1);
                const read = mom > 0.004 && press < 0.00035 ? "landlord's market"
                  : mom < -0.004 ? "tenants have the whip"
                  : press > 0.0006 ? "oversupplied — new stock coming"
                  : "balanced";
                return (
                  <tr key={k}>
                    <td>{CLASS_LABEL[k]}</td>
                    <td className="num">${e.rentIdx[k].toFixed(0)}</td>
                    <td className="num">{pct(e.capRate[k])}</td>
                    <td className={"num" + (mom < -0.002 ? " neg" : "")}>{(mom * 100).toFixed(2)}</td>
                    <td className={"num" + (dmd < -0.002 ? " neg" : "")}
                      title={abs12 >= 0
                        ? `${sf(Math.round(abs12))} taken up net over the last twelve months, against ${sf(Math.round(stk))} standing`
                        : `${sf(Math.round(-abs12))} handed back net over the last twelve months, against ${sf(Math.round(stk))} standing`}>
                      {(dmdPct > 0 ? "+" : "") + dmdPct.toFixed(1)}%
                    </td>
                    <td className="num">{sf(Math.round(pipe))}</td>
                    <td className="num">{sf(Math.round(pipe / 30))}</td>
                    <td className="dim">{read}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>)}
        {rtab === "districts" && (<div>
          <div className="hint">
            A rezoning is the largest single value event that can happen to a piece of dirt, and it lands on a
            whole district at once. This is the record: where each district's envelope sits against what it was
            generated with, and the last time the board moved it. You do not control it — you read it, and you
            own the dirt before it lands or you do not.
          </div>
          <table className="tbl">
            <thead>
              <tr><th>District</th><th className="num">Envelope vs start</th><th>Last rezoning</th><th>Direction</th></tr>
            </thead>
            <tbody>
              {(() => {
                const dists = [...new Set(Object.values(parcels).map((p) => p.district).filter(Boolean))].sort();
                return dists.map((d) => {
                  const adj = game.zoneAdj?.[d] ?? 1;
                  const log = game.zoneLog?.[d];
                  return (
                    <tr key={d}>
                      <td>{d}</td>
                      <td className={"num" + (adj < 1 ? " neg" : "")}>{(adj * 100).toFixed(0)}%</td>
                      <td className="dim">{log ? monthLabel(log.m) : "never"}</td>
                      <td className={log?.dir === -1 ? "neg" : "dim"}>
                        {log ? (log.dir === 1 ? "upzoned" : "downzoned") : "—"}
                      </td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
        </div>)}
        {/* THE TRADES. A separate cycle from the four asset classes above and
            the reason two identical office buildings are different assets: one
            let to insurers, one let to startups. */}
        {rtab === "trades" && (<div>
          <div className="hint">
            Industries run their own cycles, on their own volatility, independent of the property market that houses
            them. Office can be a landlord's market while finance is shedding staff — and the building let to five
            startups empties while the one across the street let to insurers does not.
          </div>
          <table className="tbl">
            <thead>
              <tr><th>Trade</th><th>Cycle</th><th className="num">Momentum</th><th className="num">Your exposure</th><th>Read</th></tr>
            </thead>
            <tbody>
              {(() => {
                const mine = portfolioIndustries(game);
                const byMe = new Map(mine.rows.map((r) => [r.sector, r.share]));
                return SECTORS.map((k) => {
                  const mom = game.econ.industryMom?.[k] ?? 0;
                  const ph = game.econ.industryPhase?.[k] ?? "steady";
                  const mySh = byMe.get(k) ?? 0;
                  return (
                    <tr key={k}>
                      <td>{INDUSTRY_LABEL[k]}</td>
                      <td className={ph === "bust" ? "neg" : "dim"}>
                        {ph === "boom" ? "hiring hard" : ph === "bust" ? "contracting" : "steady"}
                      </td>
                      <td className={"num" + (mom < -0.004 ? " neg" : "")}>{(mom * 100).toFixed(2)}</td>
                      <td className={"num" + (mySh > 0.4 ? " neg" : "")}>{mySh > 0 ? `${(mySh * 100).toFixed(0)}%` : "—"}</td>
                      <td className="dim">
                        {ph === "bust" && mySh > 0.25 ? "You are heavily exposed to a trade that is contracting."
                          : ph === "bust" ? "Anyone let to them is about to have a bad two years."
                          : ph === "boom" ? "They are expanding and they will pay to stay."
                          : "Nothing happening either way."}
                      </td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
        </div>)}
        {rtab === "street" && (<div>
          <TheStreet />
        </div>)}
        {rtab === "people" && (<PeopleLookup />)}
        {rtab === "landlords" && (<div>
          <Landlords />
        </div>)}
        {rtab === "stock" && (<div>
          <BuildingDatabase />
        </div>)}
        {/* THE PRINTS GO LAST. They are the reference you scroll to, not the
            thing you open the page for — sectors and land first, the record of
            what has actually traded underneath it. */}
        {rtab === "comps" && (<div>
          <CompsSheet />
        </div>)}
        </div>
      </div>
    </div>
  );
}

function PeopleLookup() {
  const game = useStore((s) => s.game)!;
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const rows = useMemo(() => {
    const out: { person: Person; role: string; firm?: string }[] = [];
    if (game.principal) out.push({ person: game.principal, role: "You", firm: game.firm?.name });
    for (const r of game.rivals ?? []) {
      const p = game.rivalPrincipals?.[r.id];
      if (p) out.push({ person: p, role: "Operating principal", firm: r.name });
    }
    for (const st of game.staff ?? []) {
      out.push({ person: st as Person, role: st.role ?? "Staff", firm: game.firm?.name });
    }
    return out;
  }, [game]);
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? rows.filter((r) =>
        r.person.name.toLowerCase().includes(needle)
        || (r.firm?.toLowerCase().includes(needle) ?? false)
        || r.role.toLowerCase().includes(needle))
    : rows;
  return (
    <div>
      <div className="hint" style={{ marginBottom: 8 }}>
        Principals, your staff, and rival operators — the people behind the firms on the street.
      </div>
      <input
        className="input"
        placeholder="Search by name, firm or role…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{ width: "100%", marginBottom: 10 }}
      />
      {shown.length === 0 ? (
        <div className="hint dim">No one matches.</div>
      ) : (
        <div className="inbox-list">
          {shown.map(({ person, role, firm }) => (
            <div key={person.id} className="deal" style={{ marginBottom: 8 }}>
              <button
                type="button"
                className="loi-addr"
                style={{ textAlign: "left", width: "100%" }}
                onClick={() => setOpenId((id) => (id === person.id ? null : person.id))}
              >
                {person.name}
                <span className="dim" style={{ fontWeight: 400 }}>
                  {" · "}{role}{firm ? ` · ${firm}` : ""}
                  {" · "}{personAgeLine(person, game.month)}
                </span>
              </button>
              {openId === person.id && (
                <div style={{ marginTop: 8 }}>
                  <PersonCard
                    person={person}
                    game={game}
                    title={role}
                    showAttrs={person.seat === "you"}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * THE BANKS — a balance sheet for every desk that quotes you.
 *
 * "Credit: tight" was a word derived from an index, and an index is weather:
 * it happens to you, you cannot see inside it, and there is nothing to do
 * about it but wait. The five lenders now carry real books — capital, loans
 * outstanding, what has stopped paying — and the appetite column below is
 * literally the multiplier applied to your next advance rate. A regional
 * whose delinquency has doubled and whose capital ratio is drifting toward its
 * floor will be rationing next quarter and shut the one after. That is a
 * decision you can act on a year early: refinance out of them while they will
 * still write it, or be the last borrower they say no to.
 */
/**
 * THE FULL STATEMENT — every loan this desk holds against a deed in town.
 *
 * The old book showed only YOUR paper, which answered "which of my balloons
 * is stranded at an impaired desk" and nothing else. The mortgage record in
 * engine/ledger.ts now carries the street's loans too, so a statement can
 * print what a statement prints: every loan against the property it is
 * written on — borrower, balance, coupon, maturity, LTV the day it was
 * written against LTV today, and whether it is paying. Your rows sit on top,
 * because the first question is still your own.
 */
