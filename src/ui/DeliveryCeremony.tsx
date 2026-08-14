import { useStore } from "@/state/store";
import { usd, sf } from "@/ui/format";

/**
 * Non-blocking delivery moment — offers to fly to the building on the map.
 * Does not stop Advance; dismiss if you are not interested.
 */
export default function DeliveryCeremony() {
  const ceremony = useStore((s) => s.deliveryCeremony);
  const popupsOff = useStore((s) => s.popupsOff);
  const dismiss = useStore((s) => s.dismissDeliveryCeremony);
  const focus = useStore((s) => s.focus);

  if (!ceremony || popupsOff) return null;

  const viewBuilding = () => {
    focus(ceremony.bbl, true);
    dismiss();
  };

  return (
    <div
      className="delivery-ceremony"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delivery-title"
      onClick={() => dismiss()}
    >
      <div className="delivery-stamp" onClick={(e) => e.stopPropagation()}>
        <div className="delivery-kicker">
          {ceremony.rival ? "Delivered · the street" : "Delivered · your tower"}
        </div>
        <div className="delivery-title" id="delivery-title">{ceremony.address}</div>
        <div className="delivery-meta mono">
          {ceremony.use} · {sf(ceremony.sf)}
          {ceremony.value ? ` · ${usd(ceremony.value)}` : ""}
        </div>
        <div className="btn-row" style={{ marginTop: 14, justifyContent: "center", flexWrap: "wrap" }}>
          <button type="button" className="btn btn-primary" onClick={viewBuilding}>
            View building
          </button>
          <button type="button" className="btn" onClick={() => dismiss()}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
