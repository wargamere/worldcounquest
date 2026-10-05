'use client';

import { useEffect, useRef, useState } from 'react';
import type { HistorySeries } from '@/next/game/views';
import { pct } from '../ui/format';

const MARGIN = { top: 10, right: 34, bottom: 18, left: 30 };

/**
 * VP share per day for you and the three leading rivals, against the goal line
 * (§7, §8.9). Colours are each nation's map colour, so a line matches its land;
 * identity is carried by the legend, the end labels and the tooltip, never by
 * colour alone. The standings table beside it is the table view.
 */
export function HistoryChart({ chart, height = 150 }: { chart: { goalShare: number; series: readonly HistorySeries[] }; height?: number }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [hoverDay, setHoverDay] = useState<number | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (el === null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined && entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const days = [...new Set(chart.series.flatMap((s) => s.points.map((p) => p.day)))].sort((a, b) => a - b);
  if (days.length < 2) return <p className="text-[11px] text-slate-500">The chart fills in at each midnight.</p>;
  const firstDay = days[0]!;
  const lastDay = days[days.length - 1]!;
  const maxShare = Math.max(chart.goalShare, ...chart.series.flatMap((s) => s.points.map((p) => p.share)));
  const plotW = Math.max(40, width - MARGIN.left - MARGIN.right);
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const x = (day: number): number => MARGIN.left + ((day - firstDay) / Math.max(1, lastDay - firstDay)) * plotW;
  const y = (share: number): number => MARGIN.top + plotH - (share / maxShare) * plotH;
  const ticks: number[] = [];
  for (let v = 0; v <= maxShare + 1e-9; v += 0.1) ticks.push(v);

  const path = (points: HistorySeries['points']): string => {
    let d = '';
    let previous: number | null = null;
    for (const p of points) {
      // Break the line where a nation dropped out of the tracked set (history is downsampled to every 2nd day at most).
      const gap = previous !== null && p.day - previous > 2;
      d += `${d === '' || gap ? 'M' : 'L'}${x(p.day).toFixed(1)},${y(p.share).toFixed(1)}`;
      previous = p.day;
    }
    return d;
  };

  const onMove = (event: React.PointerEvent<SVGRectElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const target = firstDay + fraction * (lastDay - firstDay);
    let best = days[0]!;
    for (const d of days) if (Math.abs(d - target) < Math.abs(best - target)) best = d;
    setHoverDay(best);
  };
  const hoverRows =
    hoverDay === null
      ? []
      : chart.series
          .map((s) => ({ s, share: s.points.find((p) => p.day === hoverDay)?.share }))
          .filter((r): r is { s: HistorySeries; share: number } => r.share !== undefined)
          .sort((a, b) => b.share - a.share);

  return (
    <figure className="flex flex-col gap-1.5">
      <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400">
        <span className="font-semibold uppercase tracking-wider text-slate-500">Share of world VP</span>
        {chart.series.map((s) => (
          <span key={s.nation} className="flex items-center gap-1">
            <span aria-hidden className="inline-block h-0.5 w-3 rounded-full" style={{ background: s.colour }} />
            {s.name}
          </span>
        ))}
      </figcaption>
      <div ref={boxRef} className="relative">
        <svg width={width} height={height} role="img" aria-label={`VP share per day. ${chart.series.map((s) => `${s.name}: ${pct(s.points[s.points.length - 1]?.share ?? 0)}`).join(', ')}. ${pct(chart.goalShare)} wins.`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={y(t)} y2={y(t)} stroke="#1e293b" strokeWidth={1} />
              <text x={MARGIN.left - 4} y={y(t)} textAnchor="end" dominantBaseline="central" className="fill-slate-500 text-[9px] tabular-nums">
                {Math.round(t * 100)}%
              </text>
            </g>
          ))}
          <line x1={MARGIN.left} x2={MARGIN.left + plotW} y1={y(chart.goalShare)} y2={y(chart.goalShare)} stroke="#64748b" strokeDasharray="4 3" strokeWidth={1} />
          <text x={MARGIN.left + 2} y={y(chart.goalShare) - 3} className="fill-slate-400 text-[9px]">
            {pct(chart.goalShare)} wins
          </text>
          <text x={MARGIN.left} y={height - 4} className="fill-slate-500 text-[9px]">
            Day {firstDay + 1}
          </text>
          <text x={MARGIN.left + plotW} y={height - 4} textAnchor="end" className="fill-slate-500 text-[9px]">
            Day {lastDay + 1}
          </text>
          {chart.series.map((s) => (
            <path key={s.nation} d={path(s.points)} fill="none" stroke={s.colour} strokeWidth={s.you ? 2.5 : 1.75} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {chart.series.map((s) => {
            const end = s.points[s.points.length - 1];
            if (end === undefined || end.day !== lastDay) return null;
            return (
              <text key={`end-${s.nation}`} x={x(end.day) + 4} y={y(end.share)} dominantBaseline="central" className="fill-slate-300 text-[9px] font-semibold tabular-nums">
                {pct(end.share)}
              </text>
            );
          })}
          {hoverDay !== null && <line x1={x(hoverDay)} x2={x(hoverDay)} y1={MARGIN.top} y2={MARGIN.top + plotH} stroke="#94a3b8" strokeWidth={1} pointerEvents="none" />}
          <rect x={MARGIN.left} y={0} width={plotW} height={height} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHoverDay(null)} />
        </svg>
        {hoverDay !== null && (
          <div className="pointer-events-none absolute top-1 z-10 rounded border border-slate-700 bg-slate-950/95 px-2 py-1 text-[11px] shadow-lg" style={x(hoverDay) > width / 2 ? { right: width - x(hoverDay) + 8 } : { left: x(hoverDay) + 8 }}>
            <div className="mb-0.5 text-slate-400">Day {hoverDay + 1}</div>
            {hoverRows.map(({ s, share }) => (
              <div key={s.nation} className="flex items-center gap-1.5 whitespace-nowrap">
                <span aria-hidden className="inline-block h-0.5 w-3 rounded-full" style={{ background: s.colour }} />
                <strong className="tabular-nums text-slate-100">{pct(share)}</strong>
                <span className="text-slate-400">{s.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}
