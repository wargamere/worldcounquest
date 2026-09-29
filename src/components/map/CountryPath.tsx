'use client';

import { memo } from 'react';
import type { CountryId } from '@/game/types';

interface CountryPathProps {
  id: CountryId;
  /** Path geometry. Computed once per viewport size and never changes after. */
  d: string;
  fill: string;
  onSelect: (id: CountryId) => void;
  onHover: (id: CountryId | null) => void;
}

/**
 * One country's fill.
 *
 * Memoised on purpose: there are 175 of these and a turn touches a handful.
 * Selection, targets and danger are drawn as a separate overlay on top, so
 * selecting a country changes no props here — only ownership changes do.
 */
function CountryPathImpl({ id, d, fill, onSelect, onHover }: CountryPathProps) {
  return (
    <path
      data-country={id}
      d={d}
      fill={fill}
      stroke="#0b1120"
      strokeOpacity={0.55}
      strokeWidth={0.4}
      vectorEffect="non-scaling-stroke"
      className="cursor-pointer transition-[fill] duration-300 hover:brightness-125"
      onClick={(event) => {
        event.stopPropagation();
        onSelect(id);
      }}
      onMouseEnter={() => onHover(id)}
      onMouseLeave={() => onHover(null)}
    />
  );
}

export const CountryPath = memo(CountryPathImpl);
