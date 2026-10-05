'use client';

import { useCallback, useState } from 'react';
import type { Sim, StockKey } from '@/next/game/types';
import { hudView } from '@/next/game/views';
import { useGameStore, useSimView } from '@/next/store/gameStore';
import { BattleChip } from './BattleChip';
import { IncomingChip } from './IncomingChip';
import { ResourceChip } from './ResourceChip';
import { ResourcePopover } from './ResourcePopover';

/** The five stock chips, plus Incoming and battles on phones; scrolls sideways when narrow (§8.6). */
export function ChipRow({ withAlerts = false }: { withAlerts?: boolean }) {
  const showAll = useGameStore((s) => s.prefs.showAllArmies);
  const hud = useSimView(useCallback((sim: Sim) => hudView(sim, showAll), [showAll]));
  const [open, setOpen] = useState<StockKey | null>(null);
  const close = useCallback(() => setOpen(null), []);
  if (hud === null) return null;
  return (
    <div className="relative flex min-w-0 items-center gap-1" data-coach="economy">
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
        {hud.chips.map((chip) => (
          <span key={chip.key} data-chip>
            <ResourceChip chip={chip} open={open === chip.key} onToggle={() => setOpen(open === chip.key ? null : chip.key)} />
          </span>
        ))}
        {withAlerts && <IncomingChip count={hud.incoming} />}
        {withAlerts && <BattleChip count={hud.battles} />}
      </div>
      {open !== null && <ResourcePopover stock={open} onClose={close} />}
    </div>
  );
}
