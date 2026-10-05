/**
 * The cost bench (spec §9.7, §12.5): real-map games with a passive player,
 * timed per tick phase through SimHooks, per AI think, and per save.
 *
 *   npx tsx scripts/bench.mts --seeds a,b,c --days 60 [--difficulty standard] [--nation 250] [--json out.json]
 *
 * Prints p50 / p95 per measure against the §9.7 Node targets. Timings come
 * from performance.now() and vary by machine; the games themselves do not.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { TIME } from '../src/next/game/balance';
import { dueNations } from '../src/next/game/ai/scheduler';
import { runStaff } from '../src/next/game/ai/staff';
import { runNation } from '../src/next/game/ai/think';
import { isHourStart } from '../src/next/game/clock';
import { createGame } from '../src/next/game/init';
import { serialize } from '../src/next/game/save';
import { createSim, stepTick } from '../src/next/game/sim';
import type { CountrySeed, Difficulty, MapStatic, SimHooks, SimPhase } from '../src/next/game/types';
import { buildMap, parseFacts } from '../src/next/game/world';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** §9.7 Node targets, in milliseconds (seconds for the whole game). */
const TARGETS = {
  nonHourlyTickP95: 0.3,
  hourlyTickNoAiP95: 1.5,
  majorThinkP95: 1.5,
  minorThinkMax: 0.2,
  wholeTickP95: 1.5,
  gameSeconds150Days: 25,
} as const;

interface Options {
  seeds: string[];
  days: number;
  difficulty: Difficulty;
  nation: string;
  json: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]!;
    const value = argv[i + 1];
    if (!key.startsWith('--') || value === undefined) throw new Error(`Expected --name value pairs, got ${key}`);
    args.set(key.slice(2), value);
  }
  const difficulty = args.get('difficulty') ?? 'standard';
  if (difficulty !== 'relaxed' && difficulty !== 'standard' && difficulty !== 'ruthless') throw new Error(`Unknown difficulty ${difficulty}`);
  const days = Number(args.get('days') ?? '60');
  if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a whole number of days');
  return {
    seeds: (args.get('seeds') ?? 'a,b,c').split(',').filter((s) => s.length > 0),
    days,
    difficulty,
    nation: args.get('nation') ?? '250',
    json: args.get('json') ?? null,
  };
}

function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

interface SeedResult {
  seed: string;
  phases: Partial<Record<SimPhase, { p50: number; p95: number }>>;
  nonHourlyTick: { p50: number; p95: number };
  hourlyTickNoAi: { p50: number; p95: number };
  wholeTick: { p50: number; p95: number };
  majorThink: { p50: number; p95: number; count: number };
  minorThink: { p50: number; p95: number; max: number; count: number };
  saveBytes: number;
  saveMs: number;
  gameSeconds: number;
}

function bench(map: MapStatic, options: Options, seed: string): SeedResult {
  const started = performance.now();
  const sim = createSim(map, createGame(map, { playerCountryId: options.nation, difficulty: options.difficulty, seed }), { recordCommands: false });
  const phaseMs = new Map<SimPhase, number[]>();
  const open = new Map<SimPhase, number>();
  const major: number[] = [];
  const minor: number[] = [];
  let aiMs = 0;
  const hooks: SimHooks = {
    phase(name, edge) {
      if (edge === 'start') {
        open.set(name, performance.now());
        if (name !== 'ai' || (sim.state.status !== 'playing' && !sim.state.sandbox)) return;
        // Time every due think on its own; the sim's own AI phase then finds nothing due.
        const { regular, alerts } = dueNations(sim);
        for (const [list, alert] of [[regular, false], [alerts, true]] as const) {
          for (const n of list) {
            const t0 = performance.now();
            const isMajor = sim.state.nations[n]!.tier === 'major';
            runNation(sim, n, alert);
            (isMajor ? major : minor).push(performance.now() - t0);
          }
        }
        runStaff(sim);
        return;
      }
      const ms = performance.now() - open.get(name)!;
      if (name === 'ai') aiMs += ms;
      const list = phaseMs.get(name);
      if (list === undefined) phaseMs.set(name, [ms]);
      else list.push(ms);
    },
  };
  const nonHourly: number[] = [];
  const hourlyNoAi: number[] = [];
  const whole: number[] = [];
  for (let i = 0; i < options.days * TIME.TICKS_PER_DAY; i += 1) {
    const hourly = isHourStart(sim.state.tick);
    const ai = aiMs;
    const t0 = performance.now();
    stepTick(sim, hooks);
    const ms = performance.now() - t0;
    whole.push(ms);
    // The AI phase runs on any tick (thinks are staggered), so both tick kinds are also timed without it.
    if (hourly) hourlyNoAi.push(ms - (aiMs - ai));
    else nonHourly.push(ms - (aiMs - ai));
    if (sim.state.status !== 'playing') break;
  }
  const s0 = performance.now();
  const save = serialize(sim.state, map, { savedAt: 0, playedMs: 0 });
  const saveMs = performance.now() - s0;
  const span = (list: readonly number[]) => ({ p50: quantile(list, 0.5), p95: quantile(list, 0.95) });
  const phases: SeedResult['phases'] = {};
  for (const [name, list] of phaseMs) phases[name] = span(list);
  return {
    seed,
    phases,
    nonHourlyTick: span(nonHourly),
    hourlyTickNoAi: span(hourlyNoAi),
    wholeTick: span(whole),
    majorThink: { ...span(major), count: major.length },
    minorThink: { ...span(minor), max: minor.length > 0 ? Math.max(...minor) : 0, count: minor.length },
    saveBytes: save.length,
    saveMs,
    gameSeconds: (performance.now() - started) / 1000,
  };
}

const ms = (x: number): string => x.toFixed(3);
const mark = (value: number, target: number): string => (value <= target ? 'ok' : 'over');

function table(results: readonly SeedResult[], days: number): string {
  const rows = [
    '| Seed | Non-hourly tick (no AI) p95 | Hourly tick (no AI) p95 | Whole tick p95 | Major think p50 / p95 (n) | Minor think p95 / max (n) | Save KB (ms) | Game s |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    rows.push(
      `| ${r.seed} | ${ms(r.nonHourlyTick.p95)} (${mark(r.nonHourlyTick.p95, TARGETS.nonHourlyTickP95)}) | ${ms(r.hourlyTickNoAi.p95)} (${mark(r.hourlyTickNoAi.p95, TARGETS.hourlyTickNoAiP95)}) | ${ms(r.wholeTick.p95)} (${mark(r.wholeTick.p95, TARGETS.wholeTickP95)}) | ${ms(r.majorThink.p50)} / ${ms(r.majorThink.p95)} (${r.majorThink.count}) (${mark(r.majorThink.p95, TARGETS.majorThinkP95)}) | ${ms(r.minorThink.p95)} / ${ms(r.minorThink.max)} (${r.minorThink.count}) (${mark(r.minorThink.max, TARGETS.minorThinkMax)}) | ${(r.saveBytes / 1000).toFixed(0)} (${ms(r.saveMs)}) | ${r.gameSeconds.toFixed(1)} |`,
    );
  }
  const phaseNames: SimPhase[] = ['movement', 'combat', 'economy', 'provinces', 'daily', 'ai', 'sweep'];
  rows.push('', '| Seed | ' + phaseNames.map((p) => `${p} p50 / p95`).join(' | ') + ' |', `|---|${phaseNames.map(() => '---').join('|')}|`);
  for (const r of results) rows.push(`| ${r.seed} | ${phaseNames.map((p) => (r.phases[p] === undefined ? '–' : `${ms(r.phases[p].p50)} / ${ms(r.phases[p].p95)}`)).join(' | ')} |`);
  const per150 = results.map((r) => (r.gameSeconds * 150) / days);
  rows.push('', `150-day game, scaled from ${days} days: ${per150.map((s) => s.toFixed(1)).join(', ')} s (target ≤ ${TARGETS.gameSeconds150Days} s)`);
  return rows.join('\n');
}

const options = parseArgs(process.argv.slice(2));
const read = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const map = buildMap(parseFacts(read('public/province-facts.json')), read('src/data/countries.seed.json') as CountrySeed[]);
const results = options.seeds.map((seed) => {
  const result = bench(map, options, seed);
  process.stderr.write(`${seed}: ${result.gameSeconds.toFixed(1)} s\n`);
  return result;
});
process.stdout.write(`${table(results, options.days)}\n`);
if (options.json !== null) {
  mkdirSync(dirname(options.json), { recursive: true });
  writeFileSync(options.json, `${JSON.stringify({ options, targets: TARGETS, results }, null, 2)}\n`);
}
