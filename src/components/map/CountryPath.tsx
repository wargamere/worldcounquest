'use client';

import { memo } from 'react';
import type { CountryId } from '@/game/types';

interface CountryPathProps {
  id: CountryId;
  /** Path geometry. Computed once per viewport size and never changes after. */
  d: string;
  fill: string;
  selected: boolean;
  staging: boolean;
  onSelect: (id: CountryId) => void;
}

/**
 * One country outline.
 *
 * Memoised on purpose: there are 175 of these and a state change touches at most
 * a handful. Without this every troop movement re-renders the whole map. The `d`
 * string is referentially stable, so the comparison below is cheap.
 */
function CountryPathImpl({ id, d, fill, selected, staging, onSelect }: CountryPathProps) {
  return (
    <path
      d={d}
      fill={fill}
      stroke={selected ? '#facc15' : staging ? '#38bdf8' : '#0f172a'}
      strokeWidth={selected || staging ? 1.2 : 0.3}
      vectorEffect="non-scaling-stroke"
      className="cursor-pointer outline-none transition-[fill] duration-200"
      onClick={(event) => {
        event.stopPropagation();
        onSelect(id);
      }}
    />
  );
}

export const CountryPath = memo(CountryPathImpl);
