import { usd } from "@/ui/format";
import { Row } from "@/ui/panels/shared";

/** Second beat before closing — irreversible, so ask once more in-game. */
export function SaleAcceptConfirm({
  address,
  price,
  net,
  exchange,
  onConfirm,
  onCancel,
}: {
  address: string;
  price: number;
  net: number;
  exchange?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="modal-backdrop modal-layer-decision">
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-kicker">Are you sure?</div>
        <div className="modal-title">Close at {usd(price)}</div>
        <div className="modal-sub">{address} — this cannot be undone once you confirm.</div>
        <div className="grid">
          <Row k="Sale price" v={usd(price)} strong />
          <Row k="Net to you" v={usd(net)} strong bad={net < 0} />
        </div>
        <div className="modal-actions">
          <button className="btn btn-buy" onClick={onConfirm}>
            {exchange ? "Yes — close into a 1031" : "Yes — close the sale"}
          </button>
          <button className="btn" onClick={onCancel}>Not yet</button>
        </div>
      </div>
    </div>
  );
}
