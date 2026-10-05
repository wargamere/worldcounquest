'use client';

import { useGameStore } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { Icon } from '../ui/Icon';
import { FEED_ICON, SEVERITY_BORDER, SEVERITY_TEXT } from '../ui/labels';

/** Toasts (§8.4): bad and critical player entries, plus order confirmations; 6 s each, 3 on desktop and 2 on phones. */
export function Toasts({ bottom = false }: { bottom?: boolean }) {
  const toasts = useGameStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className={`pointer-events-none absolute left-1/2 z-40 flex w-[min(24rem,calc(100%-1.5rem))] -translate-x-1/2 flex-col gap-1.5 ${bottom ? 'bottom-28' : 'top-14'}`} aria-live="polite">
      {toasts.map(({ id, entry }) => (
        <div key={id} className={`pointer-events-auto flex items-start gap-2 rounded-lg border bg-slate-950/95 px-3 py-2 text-xs shadow-lg ${SEVERITY_BORDER[entry.severity]}`} role={entry.severity === 'critical' ? 'alert' : 'status'}>
          <Icon name={FEED_ICON[entry.kind]} size={14} className={`mt-0.5 ${SEVERITY_TEXT[entry.severity]}`} />
          <p className="flex-1 text-slate-100">
            {entry.text}
            {entry.count > 1 && <span className="ml-1 text-slate-400">×{entry.count}</span>}
          </p>
          {(entry.province !== null || entry.army !== null) && (
            <button type="button" onClick={() => act().goToEntry(entry)} className="text-[11px] text-sky-300 hover:text-sky-100">
              Go
            </button>
          )}
          <button type="button" aria-label="Dismiss" onClick={() => act().dismissToast(id)} className="text-slate-500 hover:text-slate-200">
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
