/** A horizontal bar for a share (HP, stability, progress). Colour is never the only signal: a label goes with it. */
export function Meter({
  value,
  max,
  colour = '#38bdf8',
  label,
  height = 6,
  track = '#1e293b',
}: {
  value: number;
  max: number;
  colour?: string;
  label: string;
  height?: number;
  track?: string;
}) {
  const share = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(value)}
      className="w-full overflow-hidden rounded-full"
      style={{ height, background: track }}
    >
      <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${share * 100}%`, background: colour }} />
    </div>
  );
}
