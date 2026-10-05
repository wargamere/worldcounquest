'use client';

import { useEffect, useRef } from 'react';
import { Icon } from '../ui/Icon';

/** A modal drawer (§8.1): Economy, Exchange, Production, Help and Settings on desktop; a full sheet on phones. */
export function Drawer({ title, onClose, children, wide = false, full = false }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean; full?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);
  return (
    <div className="absolute inset-0 z-40 flex justify-end bg-slate-950/40" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex h-full flex-col border-l border-slate-800 bg-slate-950 shadow-2xl outline-none ${full ? 'w-full' : wide ? 'w-[min(40rem,100%)]' : 'w-[min(26rem,100%)]'}`}
      >
        <header className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="grid h-8 w-8 place-items-center rounded text-slate-400 hover:bg-slate-800 hover:text-slate-100">
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}
