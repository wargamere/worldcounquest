'use client';

import { useEffect, useState } from 'react';
import { measureSaveBytes } from '@/next/store/gameStore';
import { registerRenderer } from '@/next/store/loop';
import { mapTimings } from '../map/controller';

const WINDOW_MS = 1000;
const SAVE_EVERY_MS = 5000;

interface Stats {
  fps: number;
  simP99: number;
  simMean: number;
  ticksPerFrame: number;
  saveKb: number;
  baseMs: number;
  overlayMs: number;
  markers: number;
}

/** `?debug=perf` (§9.7): frames per second, sim ms per frame (mean and p99), ticks per frame, the last base and overlay draws, and the save size. */
export function PerfOverlay() {
  const [stats, setStats] = useState<Stats>({ fps: 0, simP99: 0, simMean: 0, ticksPerFrame: 0, saveKb: 0, baseMs: 0, overlayMs: 0, markers: 0 });
  useEffect(() => {
    let start = performance.now();
    let lastSave = 0;
    let saveKb = 0;
    const sims: number[] = [];
    let ticks = 0;
    return registerRenderer((info) => {
      sims.push(info.simMs);
      ticks += info.ticksRun;
      const now = performance.now();
      if (now - start < WINDOW_MS) return;
      if (now - lastSave >= SAVE_EVERY_MS) {
        lastSave = now;
        saveKb = measureSaveBytes() / 1000;
      }
      const sorted = [...sims].sort((a, b) => a - b);
      const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] ?? 0;
      const mean = sims.reduce((a, b) => a + b, 0) / Math.max(1, sims.length);
      setStats({ fps: (sims.length * 1000) / (now - start), simP99: p99, simMean: mean, ticksPerFrame: ticks / Math.max(1, sims.length), saveKb, baseMs: mapTimings.baseMs, overlayMs: mapTimings.overlayMs, markers: mapTimings.markers });
      sims.length = 0;
      ticks = 0;
      start = now;
    });
  }, []);
  return (
    <div className="pointer-events-none absolute bottom-2 left-2 z-50 rounded bg-black/80 px-2 py-1 font-mono text-[10px] leading-tight text-lime-300">
      <div>{stats.fps.toFixed(0)} fps (while frames run)</div>
      <div>
        sim {stats.simMean.toFixed(2)} ms · p99 {stats.simP99.toFixed(2)} ms
      </div>
      <div>{stats.ticksPerFrame.toFixed(2)} ticks/frame</div>
      <div>
        base {stats.baseMs.toFixed(1)} ms · overlay {stats.overlayMs.toFixed(1)} ms · {stats.markers} markers
      </div>
      <div>save {stats.saveKb.toFixed(0)} KB</div>
    </div>
  );
}
