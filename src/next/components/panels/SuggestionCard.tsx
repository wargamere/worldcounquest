'use client';

import { useCallback } from 'react';
import type { Suggestion } from '@/next/game/ai/advisor';
import type { ProvinceIx, Sim } from '@/next/game/types';
import { suggestionText } from '@/next/game/views';
import { useGameStore, useSimView } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { Icon } from '../ui/Icon';

function focusOf(card: Suggestion): ProvinceIx | null {
  return card.kind === 'attack' ? card.plan.target : card.kind === 'market' ? null : card.province;
}

/** Suggest (A): the current card with Do it, Show and Next (§6.9). */
export function SuggestionCard() {
  const suggestions = useGameStore((s) => s.suggestions);
  const index = useGameStore((s) => s.suggestionIndex);
  const card = suggestions[index];
  const text = useSimView(useCallback((sim: Sim) => (card === undefined ? '' : suggestionText(sim, card)), [card]));
  if (card === undefined || text === null) return null;
  const p = focusOf(card);
  return (
    <div className="m-3 rounded-lg border border-sky-600/60 bg-sky-950/40 p-3 text-xs" role="region" aria-label="Suggestion">
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-sky-300">
        <span className="flex items-center gap-1">
          <Icon name="suggest" size={12} /> Suggestion {index + 1} of {suggestions.length}
        </span>
        <button type="button" aria-label="Close suggestions" onClick={() => act().closeSuggestions()} className="text-sky-400 hover:text-sky-100">
          <Icon name="close" size={14} />
        </button>
      </div>
      <p className="text-sm text-slate-100">{text}</p>
      <div className="mt-2 flex gap-2">
        <button type="button" onClick={() => act().acceptSuggestion()} className="rounded bg-sky-500 px-3 py-1.5 font-semibold text-slate-950 hover:bg-sky-400">
          Do it <kbd className="ml-1 text-[10px] opacity-70">Enter</kbd>
        </button>
        {p !== null && (
          <button type="button" onClick={() => act().focusProvinces([p])} className="rounded border border-sky-700 px-3 py-1.5 text-sky-100 hover:border-sky-500">
            Show
          </button>
        )}
        {suggestions.length > 1 && (
          <button type="button" onClick={() => act().nextSuggestion()} className="ml-auto rounded px-2 py-1.5 text-sky-200 hover:text-sky-50">
            Next <kbd className="text-[10px] opacity-70">A</kbd>
          </button>
        )}
      </div>
    </div>
  );
}
