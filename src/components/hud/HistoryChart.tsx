'use client';

import { useEffect, useRef, useState } from 'react';
import { TURN, VICTORY } from '@/game/balance';
import { formatTurn } from '@/game/log';
import type { GameState, NationId } from '@/game/types';

const MARGIN = { top: 10, right: 34, bottom: 18, left: 26 };
/** You plus this many rivals; past four converging lines a chart stops being readable. */
const RIVALS_SHOWN = 3;

interface Series {
  id: NationId;
  name: string;
  colour: string;
  points: { turn: number; value: number }[];
}

/**
 * Countries held over time — you and the current leading rivals — against the
 * number that wins. Colours are each nation's map colour, so a line always
 * matches its territory; identity is carried by the legend, the end labels and
 * the tooltip, never by colour alone. The standings table below is the table view.
 */
export function HistoryChart({ game, height = 150 }: { game: GameState; height?: number }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const history = game.history;
  if (history.length < 2) {
    return <p className="text-[11px] text-slate-500">The chart fills in as the months pass.</p>;
  }

  const latest = history[history.length - 1]!;
  const rivals = Object.entries(latest.counts)
    .filter(([id]) => id !== game.playerId)
    .sort((a, b) => b[1] - a[1])
    .slice(0, RIVALS_SHOWN)
    .map(([id]) => id);
  const series: Series[] = [game.playerId, ...rivals].map((id) => ({
    id,
    name: id === game.playerId ? 'You' : (game.nations[id]?.name ?? id),
    colour: game.nations[id]?.colour ?? '#94a3b8',
    points: history.flatMap((p) => (p.counts[id] === undefined ? [] : [{ turn: p.turn, value: p.counts[id] }])),
  }));

  const total = Object.keys(game.countries).length;
  const goal = Math.ceil(total * VICTORY.CONTROL_FRACTION);
  const maxValue = Math.max(goal, ...series.flatMap((s) => s.points.map((p) => p.value)));
  const firstTurn = history[0]!.turn;
  const lastTurn = latest.turn;

  const plotW = Math.max(40, width - MARGIN.left - MARGIN.right);
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const x = (turn: number) => MARGIN.left + ((turn - firstTurn) / Math.max(1, lastTurn - firstTurn)) * plotW;
  const y = (value: number) => MARGIN.top + plotH - (value / maxValue) * plotH;

  const step = maxValue > 100 ? 50 : maxValue > 40 ? 20 : 10;
  const ticks: number[] = [];
  for (let v = 0; v <= maxValue; v += step) ticks.push(v);

  const path = (points: Series['points']) => {
    let d = '';
    let previous: number | null = null;
    for (const p of points) {
      // Break the line where a nation dropped out of the tracked set.
      const gap = previous !== null && p.turn - previous > 1;
      d += `${d === '' || gap ? 'M' : 'L'}${x(p.turn).toFixed(1)},${y(p.value).toFixed(1)}`;
      previous = p.turn;
    }
    return d;
  };

  const onMove = (event: React.PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    setHoverIndex(Math.round(fraction * (history.length - 1)));
  };

  const hovered = hoverIndex === null ? null : history[hoverIndex];
  const hoverRows = hovered
    ? series
        .map((s) => ({ s, value: hovered.counts[s.id] }))
        .filter((r): r is { s: Series; value: number } => r.value !== undefined)
        .sort((a, b) => b.value - a.value)
    : [];

  return (
    <figure className="flex flex-col gap-1.5">
      <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
        <span className="font-semibold uppercase tracking-wider text-slate-500">Countries held</span>
        {series.map((s) => (
          <span key={s.id} className="flex items-center gap-1">
            <span aria-hidden className="inline-block h-0.5 w-3 rounded-full" style={{ background: s.colour }} />
            {s.name}
          </span>
        ))}
      </figcaption>
      <div ref={boxRef} className="relative">
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`Countries held over time. ${series.map((s) => `${s.name}: ${s.points[s.points.length - 1]?.value ?? 0}`).join(', ')}. ${goal} wins.`}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={y(t)} y2={y(t)} stroke="#1e293b" strokeWidth={1} />
              <text x={MARGIN.left - 4} y={y(t)} textAnchor="end" dominantBaseline="central" className="fill-slate-500 text-[9px] tabular-nums">
                {t}
              </text>
            </g>
          ))}
          <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={y(goal)} y2={y(goal)} stroke="#64748b" strokeWidth={1} />
          <text x={MARGIN.left + 2} y={y(goal) - 3} className="fill-slate-400 text-[9px]">
            {goal} wins
          </text>
          <text x={MARGIN.left} y={height - 4} className="fill-slate-500 text-[9px]">
            {formatTurn(firstTurn, TURN.START_YEAR, TURN.START_MONTH)}
          </text>
          <text x={MARGIN.left + plotW} y={height - 4} textAnchor="end" className="fill-slate-500 text-[9px]">
            {formatTurn(lastTurn, TURN.START_YEAR, TURN.START_MONTH)}
          </text>

          {series.map((s) => (
            <path key={s.id} d={path(s.points)} fill="none" stroke={s.colour} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {series.map((s) => {
            const end = s.points[s.points.length - 1];
            if (!end || end.turn !== lastTurn) return null;
            return (
              <text key={`end-${s.id}`} x={x(end.turn) + 4} y={y(end.value)} dominantBaseline="central" className="fill-slate-300 text-[9px] font-semibold tabular-nums">
                {end.value}
              </text>
            );
          })}

          {hovered && (
            <line x1={x(hovered.turn)} x2={x(hovered.turn)} y1={MARGIN.top} y2={MARGIN.top + plotH} stroke="#94a3b8" strokeWidth={1} pointerEvents="none" />
          )}
          <rect
            x={MARGIN.left}
            y={0}
            width={plotW}
            height={height}
            fill="transparent"
            onPointerMove={onMove}
            onPointerLeave={() => setHoverIndex(null)}
          />
        </svg>

        {hovered && (
          <div
            className="pointer-events-none absolute top-1 z-10 rounded border border-slate-700 bg-slate-950/95 px-2 py-1 text-[11px] shadow-lg"
            style={
              x(hovered.turn) > width / 2
                ? { right: width - x(hovered.turn) + 8 }
                : { left: x(hovered.turn) + 8 }
            }
          >
            <div className="mb-0.5 text-slate-400">{formatTurn(hovered.turn, TURN.START_YEAR, TURN.START_MONTH)}</div>
            {hoverRows.map(({ s, value }) => (
              <div key={s.id} className="flex items-center gap-1.5 whitespace-nowrap">
                <span aria-hidden className="inline-block h-0.5 w-3 rounded-full" style={{ background: s.colour }} />
                <strong className="tabular-nums text-slate-100">{value}</strong>
                <span className="text-slate-400">{s.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}
