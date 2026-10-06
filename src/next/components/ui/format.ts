/**
 * Number and time formatting for the HUD and panels. Kept from the turn-based
 * game (pct, compact, signed) plus the real-time helpers.
 */
export { formatClock, formatDuration } from '@/next/game/clock';

/** Percentages that never claim a certainty the dice do not give. */
export function pct(chance: number): string {
  if (chance <= 0) return '0%';
  if (chance >= 1) return '100%';
  if (chance < 0.01) return '<1%';
  if (chance > 0.99) return '>99%';
  return `${Math.round(chance * 100)}%`;
}

/** A win chance as the forecast shows it: rounded to the nearest 5% (§5.10). */
export function pct5(chance: number): string {
  const rounded = Math.round(chance * 20) * 5;
  if (rounded >= 100 && chance < 1) return '>95%';
  if (rounded <= 0 && chance > 0) return '<5%';
  return `${rounded}%`;
}

export function compact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${Math.round(value)}`;
}

export function signed(value: number): string {
  const rounded = Math.round(value);
  return `${rounded >= 0 ? '+' : ''}${rounded}`;
}

/** Whole numbers with thousands separators: 1,534. */
export function whole(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** A signed amount on the compact scale: "+976", "−12", "+12k". */
export function signedCompact(value: number): string {
  const sign = value > 0.5 ? '+' : value < -0.5 ? '−' : '';
  return `${sign}${compact(Math.abs(value))}`;
}

/** A per-day rate: "+976/d", "−12/d", compact above ten thousand. */
export function formatRate(perDay: number): string {
  return `${signedCompact(perDay)}/d`;
}

/** Days as the chips say them: "1d 6h", "9h", "12d". */
export function formatDays(days: number): string {
  const hours = Math.max(0, Math.round(days * 24));
  if (hours < 24) return `${hours}h`;
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h === 0 || d >= 10 ? `${d}d` : `${d}d ${h}h`;
}

/** Game hours as a duration: "about 9 h". */
export function formatHours(hours: number): string {
  const h = Math.max(0, Math.round(hours));
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  const rest = h % 24;
  return rest === 0 ? `${d} d` : `${d} d ${rest} h`;
}

/** Real time played: "42 min", "1 h 05 min". */
export function formatPlayed(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}
