import { useEffect, useState } from "react";
import { useStore } from "@/state/store";

const LS = "bw-primer-offered";

/**
 * Optional first-run literacy prompt — never blocks play.
 */
export default function PrimerOffer() {
  const phase = useStore((s) => s.phase);
  const month = useStore((s) => s.game?.month ?? 0);
  const setPage = useStore((s) => s.setPage);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (phase !== "playing" || month > 0) return;
    try {
      if (localStorage.getItem(LS) === "1") return;
    } catch { /* */ }
    setShow(true);
  }, [phase, month]);

  if (!show) return null;

  const dismiss = (openPrimer: boolean) => {
    try { localStorage.setItem(LS, "1"); } catch { /* */ }
    setShow(false);
    if (openPrimer) setPage("primer");
  };

  return (
    <div className="modal-backdrop" style={{ zIndex: 40 }}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal-title">New to the business?</div>
        <div className="modal-sub">Two minutes · optional</div>
        <div className="hint">
          The Primer explains NOI, cap rates and appraisals in plain words, using
          today&rsquo;s numbers from this city. Veterans can skip — nothing is simplified either way.
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-buy" onClick={() => dismiss(true)}>
            Open the Primer
          </button>
          <button type="button" className="btn" onClick={() => dismiss(false)}>
            I know this
          </button>
        </div>
      </div>
    </div>
  );
}
