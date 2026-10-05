'use client';

import { act } from '../ui/act';
import { Icon } from '../ui/Icon';

/** "2 battles": clicking cycles your battles (§8.2). */
export function BattleChip({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={() => act().nextBattle()}
      className="flex h-8 shrink-0 items-center gap-1 rounded border border-rose-500/60 bg-rose-950/40 px-2 text-xs font-semibold text-rose-200 hover:border-rose-400"
      aria-label={`${count} battles involve you; show the next`}
    >
      <Icon name="battle" size={14} />
      {count} {count === 1 ? 'battle' : 'battles'}
    </button>
  );
}
