'use client';

import { useCallback, useState } from 'react';
import { feedFor } from '@/next/game/feed';
import type { FeedEntry, FeedScope, Sim } from '@/next/game/types';
import { useSimView } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { formatClock } from '../ui/format';
import { Icon } from '../ui/Icon';
import { FEED_ICON, SEVERITY_TEXT } from '../ui/labels';

/** At most this many rows render (§9.6). */
const ROWS = 100;
const TABS: readonly { scope: FeedScope; label: string }[] = [
  { scope: 'mine', label: 'Mine' },
  { scope: 'nearby', label: 'Nearby' },
  { scope: 'world', label: 'World' },
];

/** The notifications feed (L, §8.4): Mine, Nearby and World, newest first, each with Go. */
export function FeedPanel() {
  const [scope, setScope] = useState<FeedScope>('mine');
  // Coalescing updates an entry in place, so each row is copied to let its new count render.
  const entries = useSimView(useCallback((sim: Sim) => feedFor(sim, scope, ROWS).map((e) => ({ ...e })), [scope]));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex gap-1 px-3 pt-2" role="tablist" aria-label="Feed">
        {TABS.map((t) => (
          <button
            key={t.scope}
            type="button"
            role="tab"
            aria-selected={scope === t.scope}
            onClick={() => setScope(t.scope)}
            className={`rounded px-2 py-1 text-[11px] font-semibold uppercase tracking-wider ${scope === t.scope ? 'bg-slate-800 text-slate-100' : 'text-slate-500 hover:text-slate-300'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <ol className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2" aria-live="off">
        {entries !== null && entries.length === 0 && <li className="p-2 text-xs text-slate-500">Nothing yet.</li>}
        {entries?.map((entry) => (
          <FeedRow key={entry.id} entry={entry} />
        ))}
      </ol>
    </div>
  );
}

export function FeedRow({ entry }: { entry: FeedEntry }) {
  const canGo = entry.province !== null || entry.army !== null;
  return (
    <li className="flex items-start gap-2 rounded px-1.5 py-1 text-xs hover:bg-slate-900">
      <Icon name={FEED_ICON[entry.kind]} size={14} className={`mt-0.5 ${SEVERITY_TEXT[entry.severity]}`} />
      <div className="min-w-0 flex-1">
        <p className={SEVERITY_TEXT[entry.severity]}>
          {entry.text}
          {entry.count > 1 && <span className="ml-1 rounded bg-slate-800 px-1 text-[10px] text-slate-300">×{entry.count}</span>}
        </p>
        <p className="text-[10px] tabular-nums text-slate-500">{formatClock(entry.tick)}</p>
      </div>
      {canGo && (
        <button type="button" onClick={() => act().goToEntry(entry)} className="shrink-0 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:border-slate-500" aria-label={`Go to: ${entry.text}`}>
          Go
        </button>
      )}
    </li>
  );
}
