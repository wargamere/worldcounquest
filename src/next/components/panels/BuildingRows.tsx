'use client';

import { BUILDINGS, EFFECTS, UNITS } from '@/next/game/balance';
import { STOCK_LABELS } from '@/next/game/economy';
import { STOCK_KEYS, UNIT_TYPES } from '@/next/game/types';
import type { BuildingType, Construction, ProvinceIx } from '@/next/game/types';
import type { BuildingRow } from '@/next/game/views';
import { playerNation } from '@/next/store/gameStore';
import { act } from '../ui/act';
import { CostChips } from '../ui/CostChips';
import { formatRate, pct } from '../ui/format';
import { Meter } from '../ui/Meter';

/** What the next level does, in numbers. */
function effectText(row: BuildingRow): string {
  const gains = STOCK_KEYS.filter((k) => Math.abs(row.preview.deltaPerDay[k]) > 0.05).map((k) => `${formatRate(row.preview.deltaPerDay[k])} ${STOCK_LABELS[k]}`);
  if (gains.length > 0) return gains.join(', ');
  const next = row.level + 1;
  switch (row.type) {
    case 'training': {
      const unlocked = UNIT_TYPES.filter((u) => UNITS[u].trainingLevel === next).map((u) => UNITS[u].name);
      const speed = EFFECTS.TRAINING_SPEED[next - 1] ?? 1;
      return `${unlocked.length > 0 ? `Unlocks ${unlocked.join(' and ')}; ` : ''}training ×${speed.toFixed(2)}`;
    }
    case 'ramparts':
      return `Defenders +${pct(EFFECTS.RAMPARTS_DAMAGE_PER_LEVEL)} damage, −${pct(EFFECTS.RAMPARTS_PROTECTION_PER_LEVEL)} taken, garrison +${pct(EFFECTS.RAMPARTS_GARRISON_PER_LEVEL)}`;
    case 'roads':
      return `Legs touching it +${pct(EFFECTS.ROADS_SPEED_PER_LEVEL / 2)} faster`;
    default:
      return '';
  }
}

/** The five building rows (§8.3): level pips, effect, cost chips, hours, payback (Works) and Build with its reason. */
export function BuildingRows({ province, rows, construction }: { province: ProvinceIx; rows: readonly BuildingRow[]; construction: Construction | null }) {
  const build = (b: BuildingType): void => {
    const nation = playerNation();
    if (nation !== null) act().command({ kind: 'build', nation, province, building: b });
  };
  return (
    <section aria-label="Buildings" className="space-y-1.5">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Buildings</h3>
      {construction !== null && (
        <div className="rounded border border-sky-700/60 bg-sky-950/30 p-2 text-xs">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sky-100">
              Building {rows.find((r) => r.type === construction.building)?.label ?? BUILDINGS[construction.building].name} {construction.level}
            </span>
            <span className="tabular-nums text-slate-400">{Math.ceil(construction.hoursLeft)} h left</span>
          </div>
          <Meter value={construction.hoursTotal - construction.hoursLeft} max={construction.hoursTotal} label="Construction progress" />
          <button
            type="button"
            onClick={() => {
              const nation = playerNation();
              if (nation !== null) act().command({ kind: 'cancelBuild', nation, province });
            }}
            className="mt-1.5 text-[11px] text-rose-300 hover:text-rose-200"
          >
            Cancel (refunds {pct(EFFECTS.CONSTRUCTION_CANCEL_REFUND)})
          </button>
        </div>
      )}
      {rows.map((row) => {
        const maxed = row.level >= row.maxLevel;
        return (
          <div key={row.type} className="rounded border border-slate-800 bg-slate-900/60 p-2 text-xs" data-coach={row.type === 'works' ? 'works' : undefined}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-slate-100">{row.label}</span>
              <span className="flex gap-0.5" aria-label={`Level ${row.level} of ${row.maxLevel}`}>
                {Array.from({ length: row.maxLevel }, (_, i) => (
                  <span key={i} className={`h-2 w-3 rounded-sm ${i < row.level ? 'bg-amber-400' : 'bg-slate-700'}`} />
                ))}
              </span>
            </div>
            {!maxed && (
              <>
                <p className="mt-0.5 text-slate-400">{effectText(row)}</p>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <CostChips cost={row.preview.cost} />
                  <span className="text-[11px] text-slate-500">{row.preview.hours} h</span>
                  {row.preview.paybackDays !== null && <span className="text-[11px] text-emerald-300">pays back in {Math.ceil(row.preview.paybackDays)} d</span>}
                  <button
                    type="button"
                    disabled={row.preview.reason !== null}
                    title={row.preview.reason ?? undefined}
                    onClick={() => build(row.type)}
                    className="ml-auto rounded bg-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-950 hover:bg-white disabled:bg-slate-800 disabled:text-slate-500"
                  >
                    Build {row.preview.level}
                  </button>
                </div>
                {row.preview.reason !== null && <p className="mt-0.5 text-[11px] text-slate-500">{row.preview.reason}</p>}
              </>
            )}
            {maxed && <p className="mt-0.5 text-[11px] text-slate-500">Fully built</p>}
          </div>
        );
      })}
    </section>
  );
}
