'use client';

import { useMemo, useState } from 'react';
import seedData from '@/data/countries.seed.json';
import { VICTORY } from '@/game/balance';
import type { CountryId, CountrySeed, Difficulty } from '@/game/types';

const DIFFICULTIES: { id: Difficulty; label: string; blurb: string }[] = [
  { id: 'relaxed', label: 'Relaxed', blurb: 'Cautious rivals on thin budgets, and a big war chest for you.' },
  { id: 'standard', label: 'Standard', blurb: 'Rival empires rise; one may reach hegemony in about ten years.' },
  { id: 'ruthless', label: 'Ruthless', blurb: 'Bold, rich rivals. You are racing an AI hegemon from day one.' },
];

const SUGGESTED: CountryId[] = ['826', '250', '276', '392', '840', '643', '356', '076', '710', '036'];

export function StartScreen({
  onStart,
  onResume,
  hasSavedGame,
}: {
  onStart: (countryId: CountryId, difficulty: Difficulty) => void;
  onResume: () => void;
  hasSavedGame: boolean;
}) {
  const seeds = seedData as CountrySeed[];
  const [query, setQuery] = useState('');
  const [countryId, setCountryId] = useState<CountryId>('826');
  const [difficulty, setDifficulty] = useState<Difficulty>('standard');

  const matches = useMemo(() => {
    const term = query.trim().toLowerCase();
    const pool = term
      ? seeds.filter((s) => s.name.toLowerCase().includes(term))
      : seeds.filter((s) => SUGGESTED.includes(s.id));
    return [...pool].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 40);
  }, [query, seeds]);

  const chosen = seeds.find((s) => s.id === countryId);

  return (
    <main className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center gap-6 p-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-50">Hegemon</h1>
        <p className="mt-1 text-sm text-slate-400">
          Take a nation, build its economy, raise an army, and hold{' '}
          {Math.round(VICTORY.CONTROL_FRACTION * 100)}% of the world before any rival does.
        </p>
      </div>

      {hasSavedGame && (
        <button
          type="button"
          onClick={onResume}
          className="rounded bg-amber-500 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-amber-400"
        >
          Resume saved game
        </button>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <label htmlFor="country-search" className="text-xs uppercase tracking-wider text-slate-400">
            Choose your nation
          </label>
          <button
            type="button"
            onClick={() => {
              const pick = seeds[Math.floor(Math.random() * seeds.length)];
              if (pick) {
                setCountryId(pick.id);
                setQuery(pick.name);
              }
            }}
            className="text-xs text-sky-300 hover:text-sky-200"
          >
            Surprise me
          </button>
        </div>
        <input
          id="country-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search all 175 countries…"
          className="rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
        />
        <div className="grid max-h-56 grid-cols-2 gap-1 overflow-y-auto sm:grid-cols-3">
          {matches.map((seed) => (
            <button
              key={seed.id}
              type="button"
              onClick={() => setCountryId(seed.id)}
              className={`rounded border px-2 py-1.5 text-left text-xs transition ${
                seed.id === countryId
                  ? 'border-amber-500 bg-amber-500/10 text-amber-200'
                  : 'border-slate-800 text-slate-300 hover:border-slate-600'
              }`}
            >
              <span className="block truncate font-medium">{seed.name}</span>
              <span className="text-[10px] text-slate-500">
                economy {'★'.repeat(seed.economyTier)}{'☆'.repeat(5 - seed.economyTier)} ·{' '}
                {(seed.population / 1_000_000).toFixed(1)}M
              </span>
            </button>
          ))}
          {matches.length === 0 && (
            <p className="col-span-full text-xs text-slate-500">No country matches that.</p>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <span className="text-xs uppercase tracking-wider text-slate-400">Difficulty</span>
        <div className="grid gap-1 sm:grid-cols-3">
          {DIFFICULTIES.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setDifficulty(option.id)}
              className={`rounded border px-2 py-2 text-left transition ${
                option.id === difficulty
                  ? 'border-amber-500 bg-amber-500/10'
                  : 'border-slate-800 hover:border-slate-600'
              }`}
            >
              <span className="block text-sm font-medium text-slate-100">{option.label}</span>
              <span className="text-[10px] text-slate-500">{option.blurb}</span>
            </button>
          ))}
        </div>
      </section>

      <button
        type="button"
        onClick={() => onStart(countryId, difficulty)}
        className="rounded bg-slate-100 px-4 py-3 text-sm font-bold text-slate-950 hover:bg-white"
      >
        Begin as {chosen?.name ?? '—'}
      </button>
    </main>
  );
}
