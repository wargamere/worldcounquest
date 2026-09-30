'use client';

import { capitulatesOnCapture, provinces, troopsKept } from '@/game/capitulation';
import type { CountryId, GameState } from '@/game/types';

/** What falls with a capital: shown wherever the player sizes up or orders an attack on one. */
export function CapitalNote({ game, countryId }: { game: GameState; countryId: CountryId }) {
  if (!capitulatesOnCapture(game, countryId)) return null;
  const nation = game.nations[countryId];
  const rest = provinces(game, countryId);
  const troops = rest.reduce((sum, c) => sum + troopsKept(c.troops), 0);
  return (
    <p className="rounded border border-amber-800/70 bg-amber-950/40 px-2 py-1.5 text-[11px] leading-snug text-amber-100">
      <span className="font-semibold text-amber-300">★ Capital of {nation?.name}.</span> Take it and {nation?.name}{' '}
      capitulates: {rest.length} more {rest.length === 1 ? 'country' : 'countries'} and {troops} troops change
      sides.
    </p>
  );
}
