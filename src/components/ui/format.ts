/** Percentages that never claim a certainty the dice do not give. */
export function pct(chance: number): string {
  if (chance <= 0) return '0%';
  if (chance >= 1) return '100%';
  if (chance < 0.01) return '<1%';
  if (chance > 0.99) return '>99%';
  return `${Math.round(chance * 100)}%`;
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
