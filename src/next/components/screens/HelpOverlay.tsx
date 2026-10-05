import { CAPITAL, COMBAT, MOVEMENT, PROVINCE, TIME, VICTORY } from '@/next/game/balance';
import { pct } from '../ui/format';

const CARDS: readonly { title: string; lines: readonly string[] }[] = [
  {
    title: 'Time',
    lines: [
      `The world runs in real time: at 1× one game hour passes each second, ${(TIME.TICKS_PER_DAY * TIME.REAL_MS_PER_TICK_AT_1X) / 1000} s a day.`,
      'Pause at any time with Space — every order works while paused.',
      'Battles fight one round every hour; armies march leg by leg.',
    ],
  },
  {
    title: 'Provinces',
    lines: [
      'Home provinces pay in full. Captured land is Occupied: half the output and no Recruits.',
      `Occupied land integrates after ${PROVINCE.INTEGRATION_DAYS} days once its original nation is gone.`,
      'Stability drifts toward a target; battles and hunger lower it, and unstable Occupied land can revolt.',
    ],
  },
  {
    title: 'Economy',
    lines: [
      'Funds and Recruits come from people; Food, Steel and Oil from the land. Each province yields one good.',
      'Armies cost upkeep in Funds, Food and Oil. Running out hurts: check the chips.',
      'Buy and sell goods on the Exchange (X). Works raise a province’s good; the card shows when it pays back.',
    ],
  },
  {
    title: 'Armies',
    lines: [
      'Select an army, then click a province: the sheet shows routes, ETA and odds. Right-click orders at once.',
      'Order several armies at one target and they arrive together, from several directions for a flank bonus.',
      `Leaving a battle costs ${pct(MOVEMENT.DISENGAGE_HP_LOSS)} of HP. Delegate (F) hands an army to the Staff.`,
    ],
  },
  {
    title: 'Battles',
    lines: [
      'Defenders fight with the province garrison, terrain and Ramparts. Field Guns crack garrisons; Tank Hunters stop Tanks.',
      `The verdict (Decisive, Likely, Close, Unlikely, Hopeless) comes from ${COMBAT.WIN_CHANCE_SAMPLES} simulated battles.`,
      'Armies withdraw on their own below their retreat threshold.',
    ],
  },
  {
    title: 'Winning',
    lines: [
      `Hold ${pct(VICTORY.VP_SHARE)} of the world’s victory points. Cities and capitals are worth more.`,
      `Take a rival’s capital and the whole nation capitulates to you. Empires of ${CAPITAL.EMPIRE_PROVINCES}+ provinces make world news.`,
      'You lose when your last province falls, or when a rival gets there first.',
    ],
  },
];

const KEYS: readonly [string, string][] = [
  ['Space', 'Pause / resume'],
  ['1 2 3 4', '1×, 2×, 4×, 8×'],
  ['[ ]', 'Slower / faster'],
  ['Esc', 'Clear the draft, the selection, then the panel'],
  ['H / C', 'Frame your nation / capital'],
  ['N / Shift+N', 'Next / previous idle army'],
  ['B', 'Next battle'],
  ['.', 'Latest alert'],
  ['A', 'Suggest (again for the next card)'],
  ['Enter', 'Confirm the order or accept the suggestion'],
  ['F / Shift+F', 'Delegate / Defend'],
  ['M / S', 'Merge / split in half'],
  ['R', 'Retreat (−10%)'],
  ['Delete / Shift+Delete', 'Stop / disband'],
  ['T', 'Training for the selected province'],
  ['E X P G L', 'Economy, Exchange, Production, Great Powers, Feed'],
  ['V', 'Cycle the map mode'],
  ['Ctrl+S', 'Save now'],
  ['Right-click', 'Order at once (Shift: waypoint)'],
  ['Shift+drag', 'Box-select armies'],
];

/** Help (?, §8.3): six cards and the controls table. */
export function HelpOverlay() {
  return (
    <div className="space-y-4 text-xs text-slate-300">
      <div className="grid gap-2 sm:grid-cols-2">
        {CARDS.map((card) => (
          <section key={card.title} className="rounded border border-slate-800 bg-slate-900/60 p-3">
            <h3 className="mb-1 text-sm font-semibold text-slate-100">{card.title}</h3>
            <ul className="list-disc space-y-1 pl-4">
              {card.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <table className="w-full">
        <caption className="mb-1 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500">Controls</caption>
        <tbody>
          {KEYS.map(([key, what]) => (
            <tr key={key} className="border-t border-slate-800">
              <td className="py-1 pr-3">
                <kbd className="rounded border border-slate-700 px-1 font-mono text-[11px] text-slate-200">{key}</kbd>
              </td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-slate-500">On touch: tap to select, long-press a marker to multi-select, long-press a province for its details, drag a marker onto a province to order.</p>
    </div>
  );
}
