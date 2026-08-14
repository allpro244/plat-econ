import { useState } from "react";
import { useStore } from "@/state/store";
import { OPS_SERVICE, OPS_PLAN } from "@/engine/types";
import { resolveRec } from "@/engine/value";
import { isCommercial } from "@/engine/leasing";
import { Row } from "@/ui/panels/shared";

export function HousePolicy() {
  const game = useStore((s) => s.game)!;
  const { opsPolicy } = useStore.getState();
  const cur = game.opsPolicy ?? { service: 0 as const, plan: 1 as const, stance: 0 as const };
  const [svc, setSvc] = useState<-1 | 0 | 1>(cur.service);
  const [pln, setPln] = useState<0 | 1 | 2>(cur.plan);
  const [stn, setStn] = useState<-1 | 0 | 1>(cur.stance ?? 0);
  // resolveRec — delivered stock lives on game.built; parcels[].class stays
  // "land" for lots you developed, which made this card undercount the book
  // and disable whole-book exclusives on a developer portfolio.
  const parcels = useStore.getState().parcels;
  const built = Object.values(game.holdings).filter((h) => {
    if (h.groundLeased) return false;
    const rec = parcels ? resolveRec(parcels, game, h.bbl) : null;
    return rec && rec.class !== "land" && (rec.bldgArea ?? 0) > 0;
  });
  const off = built.filter((h) => (h.stance ?? 0) !== stn || (h.service ?? 0) !== svc || (h.plan ?? 1) !== pln).length;
  const commercial = built.filter((h) => {
    const rec = parcels ? resolveRec(parcels, game, h.bbl) : null;
    return rec && isCommercial(rec);
  });
  const commercialN = commercial.length;
  const onHouse = commercial.filter((h) => h.broker).length;
  const dirty = svc !== cur.service || pln !== cur.plan || stn !== (cur.stance ?? 0);
  const Seg = <T extends number>(
    { label, value, set, opts, hint }:
    { label: string; value: T; set: (v: T) => void; opts: { k: T; label: string; title: string }[]; hint: string },
  ) => (
    <>
      <div className="grid"><Row k={label} v={opts.find((o) => o.k === value)?.label ?? "—"} /></div>
      <div className="btn-row">
        {opts.map((o) => (
          <button key={String(o.k)} className={"btn" + (value === o.k ? " btn-on" : "")}
            title={o.title} onClick={() => set(o.k)}>{o.label}</button>
        ))}
      </div>
      <div className="hint">{hint}</div>
    </>
  );
  return (
    <div className="page-section">
      <div className="page-section-head">
        How the house runs buildings · {built.length} propert{built.length === 1 ? "y" : "ies"}
      </div>
      <div className="hint" style={{ marginTop: 0 }}>
        Set it once. It applies to every deed you close from here on, and to the book you already own.
        A building that needs different treatment is still set on its own card, and that override stands.
      </div>
      <Seg label="The ask on new leases" value={stn} set={setStn}
        opts={[
          { k: -1 as const, label: "Fill space", title: "−8% asking rents, and the letters come faster" },
          { k: 0 as const, label: "Market", title: "ask what the market is asking" },
          { k: 1 as const, label: "Push rents", title: "+8% asking rents, and fewer letters arrive" },
        ]}
        hint="Eight per cent either way on the ask, and the traffic moves against you harder than the rent moves for you — that is the trade, and it is why pushing rents into a soft market empties a building." />
      <Seg label="Service" value={svc} set={setSvc}
        opts={OPS_SERVICE.map((o) => ({ k: o.key, label: o.label, title: o.blurb }))}
        hint="Free to change and slow to matter: the saving lands next month and the tenants have not noticed for three years — which is exactly why cutting it is a trap rather than a lever." />
      <Seg label="Capital plan" value={pln} set={setPln}
        opts={OPS_PLAN.map((o) => ({ k: o.key, label: o.label, title: o.blurb }))}
        hint="Deferring is free today and ruinous over a twenty-year hold. It is sometimes right — for a flip, or for a building you are emptying to knock down." />
      <div className="btn-row">
        <button className="btn btn-buy" disabled={!dirty && off === 0}
          onClick={() => opsPolicy({ service: svc, plan: pln, stance: stn })}>
          {off > 0 ? `Apply to all ${built.length} buildings` : "Applied"}
        </button>
      </div>
      {/* WHO WORKS THE PHONES, ALSO ONCE. Same argument as the three above: an
          exclusive is a standing decision about how the book is run, and it was
          twenty clicks for one policy. Flats are skipped rather than refused —
          a mixed book is the normal case and the engine already says a broker
          does not work multifamily. */}
      <div className="grid" style={{ marginTop: 8 }}>
        <Row k="Leasing exclusive" v={`${onHouse} of ${commercialN} commercial building${commercialN === 1 ? "" : "s"} with the house`} />
      </div>
      <div className="btn-row">
        <button className="btn" disabled={commercialN === 0 || onHouse === commercialN}
          onClick={() => useStore.getState().brokerAll(true)}>
          Put the whole book on the house
        </button>
        <button className="btn" disabled={onHouse === 0}
          onClick={() => useStore.getState().brokerAll(false)}>
          End every exclusive
        </button>
      </div>
      <div className="hint">
        No retainer and nothing while the space sits — they are paid 6% of the base rent over the term of
        everything they sign, at the signing, against the 4% on a new lease and 2% on a renewal your own people
        cost. Cheap to hold, expensive when it works, and the right answer changes with how much of the book is
        empty.
      </div>
      <div className="hint">
        {off === 0
          ? "Every building on the book is running this policy."
          : `${off} of ${built.length} ${off === 1 ? "building is" : "buildings are"} running something else — either an override you set deliberately, or a policy you changed after you bought them.`}
      </div>
    </div>
  );
}
