/** A tiny inline line chart (price history, battle HP). Several series share one scale. */
export function Sparkline({
  series,
  width = 96,
  height = 24,
  min,
  max,
  baseline,
  label,
}: {
  series: readonly { values: readonly number[]; colour: string }[];
  width?: number;
  height?: number;
  min?: number;
  max?: number;
  /** A dashed reference line, e.g. a price factor of 1. */
  baseline?: number;
  label: string;
}) {
  const all = series.flatMap((s) => s.values);
  if (all.length === 0) return <span className="text-[10px] text-slate-600">—</span>;
  const lo = min ?? Math.min(...all, baseline ?? Number.POSITIVE_INFINITY);
  const hi = max ?? Math.max(...all, baseline ?? Number.NEGATIVE_INFINITY);
  const span = hi - lo > 1e-9 ? hi - lo : 1;
  const y = (v: number): number => height - 2 - ((v - lo) / span) * (height - 4);
  const line = (values: readonly number[]): string =>
    values.map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / Math.max(1, values.length - 1)) * (width - 2) + 1).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return (
    <svg width={width} height={height} role="img" aria-label={label} className="shrink-0">
      {baseline !== undefined && <line x1={0} x2={width} y1={y(baseline)} y2={y(baseline)} stroke="#475569" strokeDasharray="2 2" strokeWidth={1} />}
      {series.map((s, i) => (
        <path key={i} d={line(s.values)} fill="none" stroke={s.colour} strokeWidth={1.5} strokeLinejoin="round" />
      ))}
    </svg>
  );
}
