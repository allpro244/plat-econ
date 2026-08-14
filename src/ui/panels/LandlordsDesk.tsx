import { useMemo } from "react";
import { useStore } from "@/state/store";
import { assetValue, resolveRec } from "@/engine/value";
import { holderOf, relOf, isCold, standingWith } from "@/engine/owners";
import { gradeOf } from "@/engine/rivals";
import { usd, sf } from "@/ui/format";

/**
 * THE LANDLORDS — the names behind the nine buildings in ten that no firm owns.
 *
 * The complaint that produced this was that the owners of the fifty biggest
 * buildings in town all read "private", which is not a fact about a city, it is
 * a missing one. `The street` lists the operating firms you compete with; this
 * lists the people you BUY FROM, which in any real market is a different and
 * much larger set. Sorted by square footage, because that is the order in which
 * they matter to you.
 *
 * Every column is a fact you can act on: how much they hold, how long they have
 * been here, what kind of counterparty they are — and where you stand with
 * them, which is the one that decides whether the phone gets answered.
 */
export function Landlords() {
  const game = useStore((s) => s.game)!;
  const parcels = useStore((s) => s.parcels)!;
  const rows = useMemo(() => {
    const by = new Map<string, { h: ReturnType<typeof holderOf>; n: number; sf: number; val: number }>();
    for (const bbl of Object.keys(parcels)) {
      const held = holderOf(game, parcels, bbl);
      if (!held) continue;
      const rec = resolveRec(parcels, game, bbl);
      if (!rec) continue;
      const e = by.get(held.id) ?? { h: held, n: 0, sf: 0, val: 0 };
      e.n++;
      e.sf += rec.bldgArea ?? 0;
      e.val += assetValue(rec, game.econ, gradeOf(game, rec));
      by.set(held.id, e);
    }
    return [...by.values()].sort((a, b) => b.sf - a.sf);
  }, [game, parcels]);
  const totSf = rows.reduce((a, r) => a + r.sf, 0);
  const top10 = rows.slice(0, 10).reduce((a, r) => a + r.sf, 0);

  return (
    <div>
      <div className="hint">
        {rows.length} private holders own {sf(totSf)} between them — the ten biggest hold{" "}
        {totSf > 0 ? ((top10 / totSf) * 100).toFixed(0) : 0}% of it. These are not your competitors;
        they are who you buy from, and most of them have been here longer than you have.
      </div>
      <div className="scroll-x">
        <table className="tbl">
          <thead>
            <tr>
              <th>Holder</th><th>Kind</th><th className="num">Buildings</th><th className="num">Square feet</th>
              <th className="num">Est. value</th><th className="num">Since</th><th>Where you stand</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 40).map((r) => {
              const cold = isCold(game, r.h!.id);
              const rel = relOf(game, r.h!.id);
              return (
                <tr key={r.h!.id} title={r.h!.note}>
                  <td>{r.h!.name}</td>
                  <td className="dim">{r.h!.kind}</td>
                  <td className="num">{r.n}</td>
                  <td className="num">{sf(r.sf)}</td>
                  <td className="num">{usd(r.val)}</td>
                  <td className="num dim">{r.h!.since}</td>
                  <td className={cold ? "neg" : (rel.deals ?? 0) > 0 ? "" : "dim"}>
                    {standingWith(game, r.h!.id)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="hint">
        An offer somebody finds insulting is not filed against the building — it is filed against THEM, and
        they own the other four. That is what the last column is for.
      </div>
    </div>
  );
}
