'use client';

import { useEffect, useMemo, useState } from 'react';
import { DIFFICULTY, VICTORY } from '@/next/game/balance';
import type { Difficulty } from '@/next/game/types';
import { getMapStatic, randomSeed, startCard, useGameStore, type StartCard } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { compact, pct } from '../ui/format';
import { Icon } from '../ui/Icon';

/** The ten recommended starts (§8.7). */
const RECOMMENDED = ['250', '276', '826', '392', '840', '643', '356', '076', '792', '036'] as const;
const DIFFICULTIES: readonly Difficulty[] = ['relaxed', 'standard', 'ruthless'];

/** The Start screen (§8.7): Continue, the recommended starts with their cards, a search over every nation, difficulty and an advanced seed. */
export function StartScreen() {
  const hasSave = useGameStore((s) => s.hasSavedGame);
  const loadError = useGameStore((s) => s.loadError);
  const [query, setQuery] = useState('');
  const [countryId, setCountryId] = useState<string>('250');
  const [difficulty, setDifficulty] = useState<Difficulty>('standard');
  const [seed, setSeed] = useState(() => randomSeed());
  const [advanced, setAdvanced] = useState(false);
  const [cards, setCards] = useState<Record<string, StartCard>>({});
  const map = getMapStatic();

  // Each card plays a throwaway opening; build them one per idle slot so the screen stays responsive.
  useEffect(() => {
    let cancelled = false;
    const queue = [countryId, ...RECOMMENDED.filter((id) => id !== countryId)];
    const next = (): void => {
      const id = queue.shift();
      if (cancelled || id === undefined) return;
      const card = startCard(id, difficulty);
      if (card !== null) setCards((c) => ({ ...c, [`${id}|${difficulty}`]: card }));
      setTimeout(next, 0);
    };
    const timer = setTimeout(next, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [difficulty, countryId]);

  const nations = useMemo(() => (map === null ? [] : [...map.nations].sort((a, b) => a.name.localeCompare(b.name))), [map]);
  const matches = useMemo(() => {
    const term = query.trim().toLowerCase();
    return term === '' ? [] : nations.filter((n) => n.name.toLowerCase().includes(term)).slice(0, 30);
  }, [query, nations]);
  const chosen = nations.find((n) => n.id === countryId);
  const chosenCard = cards[`${countryId}|${difficulty}`];

  return (
    <main className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-5 overflow-y-auto p-4 sm:p-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-slate-50">Hegemon</h1>
        <p className="mt-1 text-sm text-slate-400">
          A real-time war for the world&apos;s {map?.provinces.length.toLocaleString('en-US') ?? ''} provinces. Build an economy, march your armies and hold {pct(VICTORY.VP_SHARE)} of the world&apos;s victory points before any rival does.
        </p>
      </div>
      {loadError !== null && <p className="rounded border border-rose-700 bg-rose-950/40 p-2 text-xs text-rose-200">{loadError}</p>}
      {hasSave && (
        <button type="button" onClick={() => act().resumeGame()} className="flex items-center justify-center gap-2 rounded bg-amber-500 px-4 py-3 text-sm font-semibold text-slate-950 hover:bg-amber-400">
          <Icon name="play" size={16} /> Continue your game
        </button>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-xs uppercase tracking-wider text-slate-400">Recommended starts</h2>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
          {RECOMMENDED.map((id) => {
            const nation = map?.nations.find((n) => n.id === id);
            const card = cards[`${id}|${difficulty}`];
            return (
              <button
                key={id}
                type="button"
                onClick={() => setCountryId(id)}
                aria-pressed={countryId === id}
                className={`rounded border px-2 py-1.5 text-left text-xs ${countryId === id ? 'border-amber-500 bg-amber-500/10' : 'border-slate-800 hover:border-slate-600'}`}
              >
                <span className="block truncate font-medium text-slate-100">{nation?.name ?? id}</span>
                <span className="text-[10px] text-slate-500">{card === undefined ? '…' : `${card.provinces} provinces · ${card.units} units`}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <label htmlFor="nation-search" className="text-xs uppercase tracking-wider text-slate-400">
          Or search all {nations.length} nations
        </label>
        <input
          id="nation-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
          className="rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600"
        />
        {matches.length > 0 && (
          <div className="grid max-h-48 grid-cols-2 gap-1 overflow-y-auto sm:grid-cols-4">
            {matches.map((n) => (
              <button key={n.id} type="button" onClick={() => setCountryId(n.id)} className={`truncate rounded border px-2 py-1.5 text-left text-xs ${n.id === countryId ? 'border-amber-500 bg-amber-500/10 text-amber-100' : 'border-slate-800 text-slate-300 hover:border-slate-600'}`}>
                {n.name}
                <span className="block text-[10px] text-slate-500">
                  {n.home.length} provinces · {compact(n.population)} people
                </span>
              </button>
            ))}
          </div>
        )}
        {query.trim() !== '' && matches.length === 0 && <p className="text-xs text-slate-500">No nation matches that.</p>}
      </section>

      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-xs">
        <h2 className="text-base font-semibold text-slate-50">{chosen?.name ?? '—'}</h2>
        {chosenCard === undefined ? (
          <p className="text-slate-500">Surveying the opening…</p>
        ) : (
          <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-slate-300 sm:grid-cols-4">
            <Fact label="Provinces" value={String(chosenCard.provinces)} />
            <Fact label="VP" value={String(chosenCard.vp)} />
            <Fact label="Funds per day" value={compact(chosenCard.fundsPerDay)} />
            <Fact label="Army" value={`${chosenCard.units} units`} />
            <Fact label="Food / Steel / Oil per day" value={`${compact(chosenCard.goods.food)} / ${compact(chosenCard.goods.steel)} / ${compact(chosenCard.goods.oil)}`} />
            <Fact label="First target" value={chosenCard.firstTarget ?? 'none nearby'} />
          </dl>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-xs uppercase tracking-wider text-slate-400">Difficulty</h2>
        <div className="grid gap-1 sm:grid-cols-3">
          {DIFFICULTIES.map((d) => (
            <button key={d} type="button" onClick={() => setDifficulty(d)} aria-pressed={difficulty === d} className={`rounded border px-2 py-2 text-left ${difficulty === d ? 'border-amber-500 bg-amber-500/10' : 'border-slate-800 hover:border-slate-600'}`}>
              <span className="block text-sm font-medium text-slate-100">{DIFFICULTY[d].label}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">{DIFFICULTY[d].blurb}</span>
            </button>
          ))}
        </div>
      </section>

      <div>
        <button type="button" onClick={() => setAdvanced(!advanced)} className="text-xs text-sky-300 hover:text-sky-200" aria-expanded={advanced}>
          {advanced ? 'Hide advanced' : 'Advanced'}
        </button>
        {advanced && (
          <label className="mt-2 flex items-center gap-2 text-xs text-slate-400">
            Seed
            <input value={seed} onChange={(e) => setSeed(e.target.value)} className="w-40 rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-slate-100" />
          </label>
        )}
      </div>

      <button type="button" disabled={chosen === undefined} onClick={() => act().startGame(countryId, difficulty, seed.trim() === '' ? randomSeed() : seed.trim())} className="rounded bg-slate-100 px-4 py-3 text-sm font-bold text-slate-950 hover:bg-white disabled:opacity-40">
        Begin as {chosen?.name ?? '—'}
      </button>
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] text-slate-500">{label}</dt>
      <dd className="text-slate-100">{value}</dd>
    </div>
  );
}
