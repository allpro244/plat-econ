import { useState } from "react";
import { useStore } from "@/state/store";
import { monthLabel } from "@/engine/types";
import { NewsText } from "@/ui/panels/MarketPage";

export const NEWS_KINDS = [
  { k: "all", label: "Everything" },
  { k: "warn", label: "Warnings" },
  { k: "event", label: "Events" },
  { k: "deal", label: "Deals" },
  { k: "info", label: "Notices" },
] as const;

export function NewsPage() {
  const game = useStore((s) => s.game)!;
  const [kind, setKind] = useState<string>("all");
  const items = (game.news ?? []).filter((n) => kind === "all" || n.kind === kind);
  const byMonth: { q: number; rows: typeof items }[] = [];
  for (const n of items) {
    const last = byMonth[byMonth.length - 1];
    if (last && last.q === n.q) last.rows.push(n);
    else byMonth.push({ q: n.q, rows: [n] });
  }
  const counts: Record<string, number> = { all: (game.news ?? []).length };
  for (const n of game.news ?? []) counts[n.kind] = (counts[n.kind] ?? 0) + 1;

  return (
    <div>
      <div className="hint">
        The last {(game.news ?? []).length} items off the wire, newest first. Anything with a ✈ is about a
        specific building — click it and the camera goes there.
      </div>
      <div className="btn-row" style={{ marginBottom: 8, flexWrap: "wrap" }}>
        {NEWS_KINDS.map((t) => (
          <button
            key={t.k}
            className={"lens-btn" + (kind === t.k ? " lens-on" : "")}
            onClick={() => setKind(t.k)}
          >
            {t.label}{counts[t.k] ? ` · ${counts[t.k]}` : ""}
          </button>
        ))}
      </div>
      {!items.length && (
        <div className="deal">
          <div className="hint">Nothing under that heading yet.</div>
          {kind !== "all" && (
            <button className="btn" onClick={() => setKind("all")}>Show everything →</button>
          )}
        </div>
      )}
      {byMonth.map((g) => (
        <div key={g.q} className="page-section" style={{ marginTop: 6 }}>
          <div className="page-section-head">{monthLabel(g.q)}</div>
          <div className="news">
            {g.rows.map((n, i) => (
              <div
                key={i}
                className={"news-item news-" + n.kind + (n.bbl ? " news-clickable" : "")}
                onClick={n.bbl ? () => { useStore.getState().focus(n.bbl!, true); } : undefined}
              >
                <NewsText text={n.text} />{n.bbl ? " ✈" : ""}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

