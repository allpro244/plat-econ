// Charts, in plain SVG, with no dependency and no canvas.
//
// A sparkline is a shape. A CHART has a scale, a zero, gridlines you can read
// values off, and a legend — and the difference matters here because the whole
// point of the economy page is that a player can look at supply and demand and
// know what to do. Three primitives cover everything that page needs: a line
// chart with optional reference bands, a grouped bar chart for flows, and a
// horizontal gauge for "where is this relative to normal".

import { useId } from "react";

export interface Series { label: string; color: string; pts: number[]; dashed?: boolean }
export interface RefBand { at: number; label?: string; color?: string }

const fmtNum = (v: number) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : v.toFixed(0));

/** Pick round gridline values that bracket the data. */
function ticks(lo: number, hi: number, want = 4): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / want;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((c) => c >= raw) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

export function LineChart({
  series, height = 132, yFmt = fmtNum, bands = [], xLabels, zeroBase = false, split,
}: {
  series: Series[];
  height?: number;
  yFmt?: (v: number) => string;
  bands?: RefBand[];
  xLabels?: [string, string];
  zeroBase?: boolean;
  /** index at which history ends and projection begins */
  split?: number;
}) {
  // Gradient ids have to be unique per mounted chart or the economy page's
  // second chart paints itself with the first one's fill.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const n = Math.max(...series.map((s) => s.pts.length), 0);
  if (n < 2) return <div className="hint">Not enough history yet — advance a few quarters.</div>;
  const PAD_L = 52, PAD_R = 10, PAD_T = 10, PAD_B = xLabels ? 20 : 8;
  const W = 480; // real pixels across; uniform scaling keeps text undistorted
  let lo = Infinity, hi = -Infinity;
  for (const s of series) for (const v of s.pts) { if (v < lo) lo = v; if (v > hi) hi = v; }
  for (const b of bands) { if (b.at < lo) lo = b.at; if (b.at > hi) hi = b.at; }
  if (zeroBase) lo = Math.min(lo, 0);
  if (!(hi > lo)) { hi = lo + 1; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;
  const ys = ticks(lo, hi, 4);
  const px = (i: number, len: number) => PAD_L + ((W - PAD_L - PAD_R) * i) / Math.max(1, len - 1);
  const py = (v: number) => PAD_T + (height - PAD_T - PAD_B) * (1 - (v - lo) / (hi - lo));

  return (
    <>
    <svg viewBox={`0 0 ${W} ${height}`} style={{ width: "100%", display: "block", overflow: "visible" }}>
      {/* A LINE ON A GRID IS A READING; A LINE OVER ITS OWN AREA IS A QUANTITY.
          The fill costs nothing, cannot mislead — it is bounded by the same
          points the stroke already draws — and it is most of the difference
          between a chart that looks measured and one that looks plotted. Held
          to two series, because four translucent washes over each other stop
          being areas and become mud. */}
      <defs>
        {series.map((s, i) => (
          <linearGradient key={s.label} id={`${uid}-f${i}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={s.color} stopOpacity={0.30} />
            <stop offset="70%" stopColor={s.color} stopOpacity={0.06} />
            <stop offset="100%" stopColor={s.color} stopOpacity={0} />
          </linearGradient>
        ))}
      </defs>
      {ys.map((v) => (
        <g key={v}>
          <line
            x1={PAD_L} x2={W - PAD_R} y1={py(v)} y2={py(v)}
            stroke="#b9b099" strokeWidth={0.7} strokeDasharray="2 4" opacity={0.75}
            vectorEffect="non-scaling-stroke"
          />
          <text x={PAD_L - 7} y={py(v) + 3.5} textAnchor="end" fontSize={10} fill="#8b8370" style={{ fontFamily: "var(--mono)" }}>{yFmt(v)}</text>
        </g>
      ))}
      {/* the plot's own floor and left edge, so the grid has a corner to sit in */}
      <line x1={PAD_L} x2={PAD_L} y1={PAD_T} y2={height - PAD_B} stroke="#b1a891" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <line x1={PAD_L} x2={W - PAD_R} y1={height - PAD_B} y2={height - PAD_B} stroke="#b1a891" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      {series.length <= 2 && series.map((s, i) => (
        <polygon
          key={"a" + s.label}
          points={
            `${px(0, s.pts.length)},${height - PAD_B} ` +
            s.pts.map((v, j) => `${px(j, s.pts.length)},${py(v)}`).join(" ") +
            ` ${px(s.pts.length - 1, s.pts.length)},${height - PAD_B}`
          }
          fill={`url(#${uid}-f${i})`}
          stroke="none"
        />
      ))}
      {bands.map((b, i) => (
        <g key={"b" + i}>
          <line x1={PAD_L} x2={W - PAD_R} y1={py(b.at)} y2={py(b.at)} stroke={b.color ?? "#a8402e"} strokeWidth={1.1} strokeDasharray="5 4" opacity={0.8} />
          {b.label && <text x={W - PAD_R} y={py(b.at) - 2.5} textAnchor="end" fontSize={10} fill={b.color ?? "#a8402e"}>{b.label}</text>}
        </g>
      ))}
      {split !== undefined && split > 0 && (
        <line x1={px(split, n)} x2={px(split, n)} y1={PAD_T} y2={height - PAD_B} stroke="#8b8370" strokeWidth={1} strokeDasharray="4 4" />
      )}
      {series.map((s) => (
        <polyline
          key={s.label}
          points={s.pts.map((v, i) => `${px(i, s.pts.length)},${py(v)}`).join(" ")}
          fill="none"
          stroke={s.color}
          strokeWidth={2.1}
          strokeDasharray={s.dashed ? "5 3.5" : undefined}
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
      {/* WHERE THE SERIES ENDS UP. The right-hand end of the line is the only
          point on it that is the answer to "so what is it now", and it was
          drawn exactly like the six hundred points behind it. A ringed dot
          costs two elements and makes the current value findable at a glance. */}
      {series.map((s) => {
        if (s.pts.length < 2) return null;
        const cx = px(s.pts.length - 1, s.pts.length), cy = py(s.pts[s.pts.length - 1]);
        return (
          <g key={"e" + s.label}>
            <circle cx={cx} cy={cy} r={4.2} fill="#f7f2e4" stroke="none" />
            <circle cx={cx} cy={cy} r={2.6} fill={s.color} stroke="none" />
          </g>
        );
      })}
      {xLabels && (
        <>
          <text x={PAD_L} y={height - 4} fontSize={10} fill="#8b8370">{xLabels[0]}</text>
          <text x={W - PAD_R} y={height - 4} fontSize={10} fill="#8b8370" textAnchor="end">{xLabels[1]}</text>
        </>
      )}
    </svg>
    {/* THE LEGEND THIS FILE'S OWN HEADER PROMISED.
        "A CHART has a scale, a zero, gridlines you can read values off, and a
        legend" — it had the first three. Every Series has carried a `label`
        since the day this was written, and every one of them was collected and
        thrown away: the economy page drew four coloured lines and told nobody
        which was which. Fixed here rather than at the one call site that got
        reported, because every chart in the game reads from this function and
        every one of them had it.
        Rendered as HTML beneath the SVG rather than as <text> inside it — the
        chart scales to the panel through its viewBox, and type inside a scaled
        viewBox does not stay the size you asked for. */}
    {series.length > 1 && (
      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.label} className="chart-legend-item">
            <span
              className="chart-legend-swatch"
              style={s.dashed
                ? { background: "none", borderTop: `3px dashed ${s.color}` }
                : { background: s.color }}
            />
            {s.label}
          </span>
        ))}
      </div>
    )}
    </>
  );
}

export interface BarGroup { label: string; bars: { v: number; color: string }[] }

/** Grouped bars around a real zero line — for flows, which can go negative. */
export function BarChart({ groups, height = 120, yFmt = fmtNum }: { groups: BarGroup[]; height?: number; yFmt?: (v: number) => string }) {
  if (!groups.length) return <div className="hint">Nothing to show yet.</div>;
  const PAD_L = 52, PAD_R = 8, PAD_T = 8, PAD_B = 20;
  const W = 480;
  let lo = 0, hi = 0;
  for (const g of groups) for (const b of g.bars) { if (b.v < lo) lo = b.v; if (b.v > hi) hi = b.v; }
  if (hi === lo) hi = lo + 1;
  const pad = (hi - lo) * 0.1;
  hi += pad; lo -= lo < 0 ? pad : 0;
  const ys = ticks(lo, hi, 3);
  const py = (v: number) => PAD_T + (height - PAD_T - PAD_B) * (1 - (v - lo) / (hi - lo));
  const gw = (W - PAD_L - PAD_R) / groups.length;
  const nb = Math.max(1, groups[0].bars.length);
  const bw = (gw * 0.72) / nb;

  return (
    <svg viewBox={`0 0 ${W} ${height}`} style={{ width: "100%", display: "block", overflow: "visible" }}>
      {ys.map((v) => (
        <g key={v}>
          <line
            x1={PAD_L} x2={W - PAD_R} y1={py(v)} y2={py(v)}
            stroke={v === 0 ? "#9b9384" : "#b9b099"}
            strokeWidth={v === 0 ? 1.2 : 0.7}
            strokeDasharray={v === 0 ? undefined : "2 4"}
            opacity={v === 0 ? 1 : 0.75}
            vectorEffect="non-scaling-stroke"
          />
          <text x={PAD_L - 7} y={py(v) + 3.5} textAnchor="end" fontSize={10} fill="#8b8370" style={{ fontFamily: "var(--mono)" }}>{yFmt(v)}</text>
        </g>
      ))}
      {groups.map((g, gi) => (
        <g key={g.label + gi}>
          {g.bars.map((b, bi) => {
            const x = PAD_L + gw * gi + gw * 0.14 + bw * bi;
            const y0 = py(0), y1 = py(b.v);
            const h = Math.max(0.6, Math.abs(y1 - y0));
            // Rounded on the end the bar grows toward, square on the zero line —
            // a bar rounded at both ends stops reading as a measured height.
            return (
              <rect
                key={bi} x={x} y={Math.min(y0, y1)} width={bw * 0.86} height={h}
                fill={b.color} rx={Math.min(2, bw * 0.28)}
              />
            );
          })}
          <text x={PAD_L + gw * gi + gw / 2} y={height - 4} fontSize={10} fill="#8b8370" textAnchor="middle">{g.label}</text>
        </g>
      ))}
    </svg>
  );
}

/**
 * Where a number sits against its normal range, as a bar with a marker. The
 * fastest way to answer "is this high or low" without reading an axis.
 */
export function Gauge({ value, natural, lo, hi, fmt }: { value: number; natural: number; lo: number; hi: number; fmt: (v: number) => string }) {
  const at = (v: number) => `${Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100)).toFixed(1)}%`;
  const tight = value < natural;
  return (
    <div className="gauge">
      <div className="gauge-track">
        <div className="gauge-fill" style={{ width: at(value), background: tight ? "linear-gradient(90deg,#4a7d5a,#6ea87c)" : "linear-gradient(90deg,#b58a3a,#b8563a)" }} />
        <div className="gauge-natural" style={{ left: at(natural) }} title={`natural rate ${fmt(natural)}`} />
      </div>
      <div className="gauge-legend">
        <span className="mono">{fmt(value)}</span>
        <span className="dim">natural {fmt(natural)}</span>
      </div>
    </div>
  );
}
