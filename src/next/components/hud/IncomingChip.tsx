'use client';

import { act } from '../ui/act';
import { Icon } from '../ui/Icon';

/** "Incoming 3": visible hostile armies on legs toward your land; clicking cycles through them (§8.2). */
export function IncomingChip({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={() => act().nextIncoming()}
      className="flex h-8 shrink-0 items-center gap-1 rounded border border-orange-500/60 bg-orange-950/40 px-2 text-xs font-semibold text-orange-200 hover:border-orange-400"
      aria-label={`${count} hostile armies incoming; show the next`}
    >
      <Icon name="incoming" size={14} />
      Incoming {count}
    </button>
  );
}
