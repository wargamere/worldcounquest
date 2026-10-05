'use client';

import { useCallback } from 'react';
import { DIFFICULTY, UNITS } from '@/next/game/balance';
import { UNIT_TYPES } from '@/next/game/types';
import type { Sim } from '@/next/game/types';
import { endDetails, endView } from '@/next/game/views';
import { playedMs, useSimView } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { compact, formatPlayed, pct, whole } from '../ui/format';
import { HistoryChart } from '../panels/HistoryChart';

/** The end screen (§7): headline, time, share, nations, battles, units, biggest battle, economy, revolts, fog, history and the buttons. */
export function EndScreen() {
  const data = useSimView(useCallback((sim: Sim) => ({ end: endView(sim, playedMs()), details: endDetails(sim), status: sim.state.status }), []));
  if (data === null || data.status === 'playing') return null;
  const { end, details, status } = data;
  const s = end.stats;
  const won = status === 'won';
  return (
    <div className="absolute inset-0 z-50 overflow-y-auto bg-slate-950/90 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={end.headline}>
      <div className="mx-auto max-w-2xl space-y-4 rounded-xl border border-slate-700 bg-slate-950 p-5 text-xs text-slate-300 shadow-2xl">
        <header>
          <h1 className={`text-2xl font-bold ${won ? 'text-amber-300' : 'text-rose-300'}`}>{end.headline}</h1>
          <p className="mt-1 text-slate-400">
            {details.clock} · {formatPlayed(end.playedMs)} played · {DIFFICULTY[details.difficulty].label} · seed {details.seed}
          </p>
        </header>
        <div className="grid gap-3 sm:grid-cols-2">
          <Block title="Share of the world">
            <Line label="Final VP share" value={pct(details.finalShare)} />
            <Line label="Peak VP share" value={pct(details.peakShare)} />
            <Line label="Provinces (peak)" value={`${details.provinces} (${s.peakProvinces})`} />
          </Block>
          <Block title="Nations">
            <Line label="Capitulated to you" value={String(end.surrenders.length)} />
            {details.surrendered.map((n) => (
              <Line key={`${n.name}-${n.day}`} label={`· ${n.name}`} value={`day ${n.day}, ${n.vp} VP`} />
            ))}
            <Line label="Capital relocations" value={String(s.capitalMoves)} />
          </Block>
          <Block title="Battles">
            <Line label="Attacks won / lost" value={`${s.attacksWon} / ${s.attacksLost}`} />
            <Line label="Defences held" value={String(s.defencesHeld)} />
            <Line label="Provinces captured / lost" value={`${s.provincesCaptured} / ${s.provincesLost}`} />
            {details.largestBattle !== null && <Line label="Biggest battle" value={`${details.largestBattle.name}, day ${details.largestBattle.day}, ${whole(details.largestBattle.hp)} HP`} />}
          </Block>
          <Block title="Units">
            {UNIT_TYPES.filter((u) => s.unitsTrained[u] + s.unitsLost[u] > 0).map((u) => (
              <Line key={u} label={UNITS[u].name} value={`${s.unitsTrained[u]} trained · ${s.unitsLost[u]} lost`} />
            ))}
            <Line label="Enemy units destroyed" value={whole(s.enemyUnitsDestroyed)} />
          </Block>
          <Block title="Economy">
            <Line label="Peak Funds per day" value={compact(s.peakFundsPerDay)} />
            <Line label="Funds earned" value={compact(s.fundsEarned)} />
            <Line label="Traded on the Exchange" value={compact(s.tradeVolume)} />
            <Line label="Revolts suffered" value={String(s.revoltsSuffered)} />
          </Block>
          {s.fogOff && (
            <Block title="Fog">
              <p>&ldquo;Show all armies&rdquo; was used.</p>
            </Block>
          )}
        </div>
        <HistoryChart chart={details.chart} height={170} />
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => act().playAgain()} className="rounded bg-amber-500 px-3 py-2 font-semibold text-slate-950 hover:bg-amber-400">
            Play again (same nation)
          </button>
          <button type="button" onClick={() => act().newGame()} className="rounded border border-slate-600 px-3 py-2 text-slate-100 hover:border-slate-400">
            New game
          </button>
          {won && (
            <button type="button" onClick={() => act().keepPlaying()} className="rounded border border-slate-600 px-3 py-2 text-slate-100 hover:border-slate-400">
              Keep playing
            </button>
          )}
          <button type="button" onClick={() => act().viewMap()} className="rounded px-3 py-2 text-slate-300 hover:text-white">
            View map
          </button>
        </div>
      </div>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded border border-slate-800 bg-slate-900/60 p-2">
      <h2 className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{title}</h2>
      {children}
    </section>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-slate-400">{label}</span>
      <span className="text-right tabular-nums text-slate-100">{value}</span>
    </div>
  );
}
