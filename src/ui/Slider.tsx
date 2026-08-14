// A labelled range control. Groundwork ran on these: you set the dial and the
// consequence updates under your hand, instead of picking from three canned
// buttons. Every continuous decision in the game should be one of these.
import { useId } from "react";

/** Wide slider bounds — name any price when making a purchase offer. */
export function widePriceBounds(anchor: number, appraisal = anchor) {
  const a = Math.max(1, anchor);
  const m = Math.max(a, appraisal);
  return {
    min: Math.max(1, Math.round(m * 0.02)),
    max: Math.round(m * 8),
    step: Math.max(1000, Math.round(m / 800)),
  };
}

/** Counter bounds — stay in the ballpark of the deal (half to double the anchor). */
export function counterPriceBounds(anchor: number, context = anchor) {
  const a = Math.max(1, anchor);
  const c = Math.max(a, context);
  return {
    min: Math.max(1, Math.round(c * 0.5)),
    max: Math.round(c * 2),
    step: Math.max(1000, Math.round(c / 200)),
  };
}

export default function Slider({
  label, value, min, max, step = 1, onChange, format, hint, marks, disabled, editable,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  hint?: string;
  marks?: { at: number; label: string }[];
  disabled?: boolean;
  /** Show a number field; use "price" for $ / comma formatting. */
  editable?: boolean | "price";
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const valueText = format ? format(value) : String(value);
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  const commit = (raw: number) => {
    if (!Number.isFinite(raw)) return;
    onChange(Math.round(Math.max(min, Math.min(max, raw))));
  };
  const parsePrice = (s: string) => {
    const n = parseFloat(s.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : NaN;
  };
  return (
    <div className={"slider" + (disabled ? " slider-off" : "")}>
      <div className="slider-head">
        <span className="slider-label" id={labelId}>{label}</span>
        {editable ? (
          <input
            type={editable === "price" ? "text" : "number"}
            className="slider-value mono"
            value={editable === "price" ? valueText : value}
            inputMode={editable === "price" ? "decimal" : undefined}
            min={editable === "price" ? undefined : min}
            max={editable === "price" ? undefined : max}
            step={editable === "price" ? undefined : step}
            disabled={disabled}
            aria-labelledby={labelId}
            onChange={(e) => {
              const raw = editable === "price" ? parsePrice(e.target.value) : parseFloat(e.target.value);
              commit(raw);
            }}
          />
        ) : (
          <span className="slider-value mono">{valueText}</span>
        )}
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-labelledby={labelId}
        aria-valuetext={valueText}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ "--fill": `${pct}%` } as React.CSSProperties}
      />
      {marks && (
        <div className="slider-marks">
          {marks.map((m) => (
            <button
              key={m.at}
              className={"slider-mark" + (Math.abs(m.at - value) < step / 2 ? " on" : "")}
              onClick={() => onChange(m.at)}
              disabled={disabled}
              aria-label={`Set ${label} to ${m.label}`}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
      {hint && <div className="slider-hint">{hint}</div>}
    </div>
  );
}
