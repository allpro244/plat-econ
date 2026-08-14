import { useEffect, useMemo, useState } from "react";
import { useStore } from "@/state/store";
import { cycleDigest } from "@/engine/cycleDigest";

const LS_KEY = "bw-digest-collapsed";

/**
 * Collapsible monthly cycle readout — phase, rates, caps, balloons.
 * Veterans can leave it collapsed; it remembers across sessions.
 */
export default function CycleDigest() {
  const game = useStore((s) => s.game);
  const prevEcon = useStore((s) => s.prevForDigest);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(LS_KEY) === "1"; } catch { return false; }
  });

  const dig = useMemo(() => {
    if (!game || game.gameOver) return null;
    return cycleDigest(game, prevEcon);
  }, [game, prevEcon]);

  useEffect(() => {
    try { localStorage.setItem(LS_KEY, collapsed ? "1" : "0"); } catch { /* */ }
  }, [collapsed]);

  if (!dig) return null;

  const rateBit = dig.dRateBp === null ? ""
    : dig.dRateBp === 0 ? " · flat"
    : dig.dRateBp > 0 ? ` · +${dig.dRateBp} bp`
    : ` · ${dig.dRateBp} bp`;

  return (
    <div className={"cycle-digest" + (collapsed ? " cycle-digest-collapsed" : "")}>
      <button
        type="button"
        className="cycle-digest-head"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
      >
        <span className="map-hud-kicker">Cycle · {dig.label}</span>
        <span className="cycle-digest-summary">
          {dig.phase}{dig.rumored ? ` ⚠→ ${dig.rumored}` : ""} · {dig.ratePct.toFixed(2)}%{rateBit}
        </span>
        <span className="cycle-digest-chev">{collapsed ? "▸" : "▾"}</span>
      </button>
      {!collapsed && (
        <div className="cycle-digest-body">
          <div className="hint">
            Cap rates · {dig.caps.map((c) =>
              `${c.cls.slice(0, 3)} ${c.pct.toFixed(2)}%${c.dBp ? (c.dBp > 0 ? ` (+${c.dBp}bp)` : ` (${c.dBp}bp)`) : ""}`
            ).join(" · ")}
          </div>
          <div className="hint">
            Vacancy · {dig.vac.map((v) =>
              `${v.cls.slice(0, 3)} ${v.pct.toFixed(1)}%${v.dPp != null && v.dPp !== 0 ? ` (${v.dPp > 0 ? "+" : ""}${v.dPp}pp)` : ""}`
            ).join(" · ")}
          </div>
          <div className="hint">
            Your book · {dig.balloons12} balloon{dig.balloons12 === 1 ? "" : "s"} in 12 mo
            {dig.floatingShare > 0 ? ` · ${(dig.floatingShare * 100).toFixed(0)}% floating` : ""}
            {" · "}{dig.underConstruction} crane{dig.underConstruction === 1 ? "" : "s"} citywide
          </div>
        </div>
      )}
    </div>
  );
}
