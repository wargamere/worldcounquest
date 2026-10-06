'use client';

import { useCallback, useEffect } from 'react';
import type { ProvinceIx, Sim } from '@/next/game/types';
import { coachHints } from '@/next/game/views';
import { useGameStore, useSimView } from '@/next/store/gameStore';
import { act } from '../ui/act';

/** Which control each step points at (by `data-coach`). */
const ANCHOR: Readonly<Record<number, string>> = { 2: 'attack', 3: 'speed', 6: 'economy', 7: 'training', 8: 'suggest' };
const STEPS = 8;
/** The anchored element can appear later (a panel opening), so the ring is re-applied on this cadence. */
const ANCHOR_REFRESH_MS = 400;

/**
 * The onboarding coach (§8.7): non-modal cards, each completed by the player's
 * own action (the store advances them), with Skip always present.
 */
export function Coach({ phone = false }: { phone?: boolean }) {
  const step = useGameStore((s) => s.coachStep);
  const target = useGameStore((s) => s.coachTarget);
  const hints = useSimView(useCallback((sim: Sim) => ({ ...coachHints(sim), targetName: target === null ? null : (sim.map.provinces[target.target]?.name ?? null) }), [target]));

  useEffect(() => {
    if (step === null) return;
    const anchor = ANCHOR[step];
    if (anchor === undefined) return;
    const mark = (): void => {
      for (const el of document.querySelectorAll(`[data-coach="${anchor}"]`)) el.classList.add('coach-ring');
    };
    mark();
    const timer = setInterval(mark, ANCHOR_REFRESH_MS);
    return () => {
      clearInterval(timer);
      for (const el of document.querySelectorAll('.coach-ring')) el.classList.remove('coach-ring');
    };
  }, [step]);

  if (step === null || hints === null) return null;
  const show = (p: ProvinceIx): void => {
    act().clickProvince(p, false);
    act().focusProvinces([p]);
  };
  // The phone is tapped, the desktop clicked.
  const tap = phone ? 'tap' : 'click';
  const Tap = phone ? 'Tap' : 'Click';
  let title = '';
  let body = '';
  let action: { label: string; run: () => void } | null = null;
  switch (step) {
    case 1:
      title = `You are ${hints.nation}.`;
      body = `Your armies are the gold-outlined markers — ${tap} ${hints.firstArmy ?? 'one of them'}.`;
      break;
    case 2:
      title = 'Pick a target.';
      body =
        hints.targetName === null
          ? `${Tap} a neighbouring province, then Attack. The sheet shows the odds before you commit.`
          : `${hints.targetName} is weak and next to you. ${Tap} it with your army selected, then press Attack.${target !== null && target.armies.length >= 2 ? ' Both armies arrive together from two directions: +flank.' : ''}`;
      if (target !== null) action = { label: 'Show', run: () => act().focusProvinces([target.target]) };
      break;
    case 3:
      title = 'Start the clock: Space or ▶.';
      body = 'Orders work while paused, too. 1× is one game hour per second.';
      break;
    case 4:
      title = 'Armies march in real time; battles are fought every hour.';
      body = 'Watch your army move. The Battle panel opens when the fighting starts.';
      break;
    case 5:
      title = 'Capture.';
      body = 'Occupied land pays half until it integrates.';
      action = { label: 'Next', run: () => act().advanceCoach() };
      break;
    case 6: {
      title = 'Your economy.';
      const works = hints.works;
      body =
        works === null
          ? 'The chips show every stock and how long it lasts. Build Works in a province to raise its good.'
          : `The chips show every stock. Build ${works.label} in ${works.name}${works.paybackDays === null ? '' : ` — pays back in ${Math.ceil(works.paybackDays)} days`}.`;
      if (works !== null) action = { label: 'Show', run: () => show(works.province) };
      break;
    }
    case 7:
      title = `Train Rifles${hints.capital === null ? '' : ` in ${hints.capital}`} and turn on Keep training.`;
      body = 'New units join the idle army there, or march to a rally point.';
      break;
    default:
      title = 'Press A any time for the advisor’s best move.';
      body = 'Good luck. Help (?) has the rules and every shortcut.';
      action = { label: 'Done', run: () => act().advanceCoach() };
  }
  return (
    <aside className={`pointer-events-auto absolute z-30 rounded-lg ${phone ? 'left-2 top-2 w-[calc(100%-4.5rem)]' : 'bottom-4 left-4 w-[min(20rem,calc(100%-2rem))]'} border border-amber-500/70 bg-slate-950/95 p-3 text-xs shadow-xl`} aria-live="polite" aria-label="Coach">
      <p className="text-[10px] uppercase tracking-wider text-amber-300">
        Step {step} of {STEPS}
      </p>
      <h2 className="mt-0.5 text-sm font-semibold text-slate-50">{title}</h2>
      <p className="mt-1 text-slate-300">{body}</p>
      <div className="mt-2 flex gap-2">
        {action !== null && (
          <button type="button" onClick={action.run} className="rounded bg-amber-500 px-2.5 py-1 font-semibold text-slate-950 hover:bg-amber-400">
            {action.label}
          </button>
        )}
        <button type="button" onClick={() => act().skipCoach()} className="ml-auto text-slate-400 hover:text-slate-100">
          Skip
        </button>
      </div>
    </aside>
  );
}
