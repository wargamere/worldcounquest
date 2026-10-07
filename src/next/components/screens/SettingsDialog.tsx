'use client';

import type { AlertKind } from '@/next/game/types';
import { exportCommandLog, useGameStore } from '@/next/store/gameStore';
import { act } from '../ui/act';

const ALERTS: readonly { kind: AlertKind; label: string }[] = [
  { kind: 'capitalAttacked', label: 'Your capital is attacked' },
  { kind: 'shortage', label: 'A stock runs out' },
  { kind: 'provinceAttacked', label: 'A province is attacked' },
  { kind: 'provinceLost', label: 'A province is lost' },
  { kind: 'armyDestroyed', label: 'An army is destroyed' },
  { kind: 'capitulation', label: 'A nation capitulates' },
];
const DEV = process.env.NODE_ENV !== 'production';

/** Settings (§8.3): auto-pause, Show all armies, instant right-click, reduce motion, the coach and the save. */
export function SettingsDialog() {
  const prefs = useGameStore((s) => s.prefs);
  const warning = useGameStore((s) => s.saveWarning);
  const exportLog = (): void => {
    const json = exportCommandLog();
    if (json === null) return;
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'hegemon-commands.json';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-5 text-xs text-slate-300">
      {warning !== null && warning !== 'notOwner' && <p className="rounded border border-rose-700 bg-rose-950/40 p-2 text-rose-200">Saving failed: {warning === 'quota' ? 'storage is full' : 'storage is blocked'}.</p>}
      <section className="space-y-1.5">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Pause automatically when</h3>
        {ALERTS.map((a) => (
          <Toggle key={a.kind} label={a.label} checked={prefs.autoPause[a.kind]} onChange={(on) => act().setPrefs({ autoPause: { ...prefs.autoPause, [a.kind]: on } })} />
        ))}
      </section>
      <section className="space-y-1.5">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Map and orders</h3>
        <Toggle label="Show all armies (lifts the fog; the end screen records it)" checked={prefs.showAllArmies} onChange={(on) => act().setPrefs({ showAllArmies: on })} />
        <Toggle label="Instant right-click orders" checked={prefs.instantRightClick} onChange={(on) => act().setPrefs({ instantRightClick: on })} />
        <Toggle label="Reduce motion" checked={prefs.reduceMotion} onChange={(on) => act().setPrefs({ reduceMotion: on })} />
      </section>
      <section className="flex flex-wrap gap-2">
        <button type="button" onClick={() => act().replayCoach()} className="rounded border border-slate-600 px-2 py-1 text-slate-100 hover:border-slate-400">
          Replay the coach
        </button>
        <button
          type="button"
          onClick={() => {
            if (window.confirm('Delete this game and its save, and go back to the start screen? This cannot be undone.')) act().deleteSave();
          }}
          className="rounded border border-rose-700 px-2 py-1 text-rose-200 hover:border-rose-500"
        >
          Delete the save
        </button>
        {DEV && (
          <button type="button" onClick={exportLog} className="rounded border border-slate-600 px-2 py-1 text-slate-100 hover:border-slate-400">
            Export the command log
          </button>
        )}
      </section>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-amber-500" />
      {label}
    </label>
  );
}
