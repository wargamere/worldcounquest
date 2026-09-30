'use client';

import { VICTORY } from '@/game/balance';

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  const share = Math.round(VICTORY.CONTROL_FRACTION * 100);
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-slate-950/80 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label="How to play"
        className="max-h-full w-full max-w-lg overflow-y-auto rounded-xl border border-slate-700 bg-slate-950 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold text-slate-50">How to play</h2>
        <p className="mt-1 text-sm text-slate-400">
          Hold {share}% of the world&apos;s countries to win. You lose if your last country falls — or if a
          rival reaches {share}% first.
        </p>

        <ol className="mt-4 flex flex-col gap-3 text-sm text-slate-300">
          <li>
            <strong className="text-slate-100">Start by recruiting.</strong> You begin with a war chest and a small
            garrison. Spend it before your neighbours notice.
          </li>
          <li>
            <strong className="text-slate-100">Each turn is a month.</strong> Your income arrives, you act as much as
            you can afford, then every other nation moves at once.
          </li>
          <li>
            <strong className="text-slate-100">Select one of your countries</strong> (gold). Neighbours you can attack
            are outlined <span className="text-rose-300">red</span>, your own you can move into{' '}
            <span className="text-sky-300">blue</span>. Click one to set up the order.
          </li>
          <li>
            <strong className="text-slate-100">Read the odds before you attack.</strong> The order panel shows your
            exact chance to capture, how many troops would hold the prize, and the risk you leave behind. Every
            troop you commit either takes the country or dies trying.
          </li>
          <li>
            <strong className="text-slate-100">Guard what you hold.</strong> Countries outlined solid red are likely to
            fall next turn. Recruit there, or move troops in. Each garrison moves or attacks once per turn.
          </li>
          <li>
            <strong className="text-slate-100">Grow the economy.</strong> Investing raises development: more income and
            10% more combat strength per level. Troops cost upkeep every month; if the treasury runs dry, they desert.
          </li>
          <li>
            <strong className="text-slate-100">Gang up.</strong> A country pinned by a big neighbour can rarely spare
            much alone. Several of your countries bordering the same enemy can attack it together — tick them under{' '}
            <em>Join the assault</em>. Each one uses its action for the turn.
          </li>
          <li>
            <strong className="text-slate-100">Stuck?</strong> <em>Advise</em> finds the best attack that is both likely
            to win and safe to launch.
          </li>
        </ol>

        <div className="mt-4 rounded-lg border border-slate-800 p-3 text-xs text-slate-400">
          <div className="mb-1 font-semibold text-slate-300">Controls</div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <span><kbd className="rounded border border-slate-700 px-1">Enter</kbd> end turn</span>
            <span><kbd className="rounded border border-slate-700 px-1">Esc</kbd> cancel / deselect</span>
            <span><kbd className="rounded border border-slate-700 px-1">A</kbd> advise</span>
            <span><kbd className="rounded border border-slate-700 px-1">H</kbd> zoom to your nation</span>
            <span><kbd className="rounded border border-slate-700 px-1">N</kbd> next country that can act</span>
            <span><kbd className="rounded border border-slate-700 px-1">Z</kbd> undo (not attacks)</span>
            <span>Drag to pan</span>
            <span>Scroll or pinch to zoom</span>
          </div>
        </div>

        <button type="button" onClick={onClose} className="mt-4 w-full rounded bg-amber-500 py-2 text-sm font-bold text-slate-950 hover:bg-amber-400">
          To war
        </button>
      </div>
    </div>
  );
}
