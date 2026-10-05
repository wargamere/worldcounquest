import { Icon } from './Icon';

/** − value + with bounds; used for split counts and trade-policy days. */
export function Stepper({
  value,
  min,
  max,
  step = 1,
  label,
  format = (v: number) => String(v),
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  label: string;
  format?: (v: number) => string;
  onChange: (value: number) => void;
}) {
  const set = (v: number): void => onChange(Math.min(max, Math.max(min, v)));
  return (
    <div className="inline-flex items-center gap-1" role="group" aria-label={label}>
      <button
        type="button"
        aria-label={`Less ${label}`}
        disabled={value <= min}
        onClick={() => set(value - step)}
        className="grid h-7 w-7 place-items-center rounded border border-slate-700 text-slate-300 hover:border-slate-500 disabled:opacity-30"
      >
        <Icon name="minus" size={14} />
      </button>
      <span className="min-w-[2.5rem] text-center text-xs tabular-nums text-slate-100" aria-live="polite">
        {format(value)}
      </span>
      <button
        type="button"
        aria-label={`More ${label}`}
        disabled={value >= max}
        onClick={() => set(value + step)}
        className="grid h-7 w-7 place-items-center rounded border border-slate-700 text-slate-300 hover:border-slate-500 disabled:opacity-30"
      >
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}
