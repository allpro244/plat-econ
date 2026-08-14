import { useMemo } from "react";
import { useStore, type MapFilter } from "@/state/store";
import { mapHudSnapshot } from "@/ui/mapHudData";
import { developableSites } from "@/ui/developable";
import { sf } from "@/ui/format";

/**
 * Persistent map overlay: next deliveries, balloon cliffs, desk count.
 * Click a row → focus the parcel (or open the inbox route).
 */
export default function MapHud() {
  const game = useStore((s) => s.game);
  const parcels = useStore((s) => s.parcels);
  const openAttention = useStore((s) => s.openAttention);
  const focus = useStore((s) => s.focus);
  const setPage = useStore((s) => s.setPage);
  const setLens = useStore((s) => s.setLens);
  const mapFilter = useStore((s) => s.mapFilter);
  const setMapFilter = useStore((s) => s.setMapFilter);

  const snap = useMemo(() => {
    if (!game || game.gameOver) return null;
    return mapHudSnapshot(game, parcels);
  }, [game, parcels]);

  const ready = useMemo(() => {
    if (!game || !parcels || game.gameOver) return [];
    return developableSites(game, parcels).filter((s) => s.pencils).slice(0, 2);
  }, [game, parcels]);

  if (!snap) return null;

  return (
    <aside className="map-hud" aria-label="City status">
      <div className="map-hud-kicker">City</div>

      {snap.attentionN > 0 && snap.firstAttention && (
        <button
          type="button"
          className="map-hud-row map-hud-attn"
          onClick={() => openAttention(snap.firstAttention!.key)}
          title={snap.firstAttention.label}
        >
          <span className="map-hud-label">Desk</span>
          <span className="map-hud-text">
            {snap.attentionN} waiting · {snap.firstAttention.label}
          </span>
        </button>
      )}

      {snap.deliveries.length > 0 && (
        <div className="map-hud-block">
          <div className="map-hud-label">Under construction</div>
          {snap.deliveries.map((d) => (
            <button
              key={d.bbl}
              type="button"
              className="map-hud-row"
              onClick={() => focus(d.bbl, true)}
              title={d.label}
            >
              {d.label}
            </button>
          ))}
        </div>
      )}

      {snap.balloons.length > 0 && (
        <div className="map-hud-block">
          <div className="map-hud-label">Balloons · 18 mo</div>
          {snap.balloons.map((b) => (
            <button
              key={b.bbl}
              type="button"
              className={"map-hud-row" + (b.months <= 6 ? " map-hud-urgent" : "")}
              onClick={() => { focus(b.bbl, false); setPage("debt"); }}
              title={b.label}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}

      {ready.length > 0 && (
        <div className="map-hud-block">
          <div className="map-hud-label">Sites ready</div>
          {ready.map((s) => (
            <button
              key={s.bbl}
              type="button"
              className="map-hud-row"
              onClick={() => { setLens("zoning"); focus(s.bbl, true); }}
              title={`${s.address} · residual $${s.residualPsf.toFixed(0)}/sf`}
            >
              {s.address} · pencils
            </button>
          ))}
        </div>
      )}

      {snap.deliveredSf > 0 && (
        <div className="map-hud-meta mono">
          Your deliveries · {sf(snap.deliveredSf)} built
        </div>
      )}

      <div className="map-hud-filters" role="group" aria-label="Map emphasis">
        {([
          ["all", "City"],
          ["owned", "Book"],
          ["construction", "Cranes"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={"map-hud-filter" + (mapFilter === id ? " on" : "")}
            onClick={() => setMapFilter(id as MapFilter)}
            title={
              id === "all" ? "Show the whole city"
                : id === "owned" ? "Emphasize your book (dim the rest)"
                  : "Emphasize jobs under construction"
            }
          >
            {label}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="map-hud-row map-hud-lens"
        onClick={() => setLens("zoning")}
        title="Shade lots by unbuilt zoning envelope"
      >
        Zoning lens →
      </button>
    </aside>
  );
}
