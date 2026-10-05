/**
 * The balance harness (spec §12.5): whole headless games on the committed map,
 * the player played by autoplay('advisor') (or nobody, with --player passive),
 * reported per game as a markdown table and JSON.
 *
 *   npx tsx scripts/simulate.mts --difficulty standard --nations 250,840,156,792,076,566,616,764 \
 *     --seeds a,b,c --days 240 --player advisor --jobs 4 --json .cache/balance/standard.json
 *
 * --difficulty takes one difficulty, a comma list or "all" (the default). Games
 * run on a pool of --jobs child processes (default: CPUs, at most 8); child
 * processes inherit the tsx loader, which worker threads do not reliably do.
 * The game is deterministic, so a report depends only on its arguments; only
 * the timing columns vary between machines.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { fork, type ChildProcess } from 'node:child_process';
import { MARKET, TIME } from '../src/next/game/balance';
import { autoplay, type AutoplayStyle } from '../src/next/game/ai/autoplay';
import { dueNations } from '../src/next/game/ai/scheduler';
import { runStaff } from '../src/next/game/ai/staff';
import { runNation } from '../src/next/game/ai/think';
import { isHourStart } from '../src/next/game/clock';
import { nationRates } from '../src/next/game/economy';
import { createGame } from '../src/next/game/init';
import { priceFactor } from '../src/next/game/market';
import { serialize } from '../src/next/game/save';
import { createSim, stepTick } from '../src/next/game/sim';
import { GOODS, STOCK_KEYS } from '../src/next/game/types';
import type { CountrySeed, Difficulty, Good, MapStatic, NationIx, ProvinceIx, Sim, SimHooks, StockKey } from '../src/next/game/types';
import { totalHp } from '../src/next/game/units';
import { vpShare } from '../src/next/game/victory';
import { buildMap, parseFacts } from '../src/next/game/world';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIFFICULTIES: readonly Difficulty[] = ['relaxed', 'standard', 'ruthless'];
const CHECKPOINTS = [30, 60, 90, 120] as const;

// ------------------------------------------------------------------ options

export interface Job {
  difficulty: Difficulty;
  nation: string;
  seed: string;
  days: number;
  player: AutoplayStyle;
}

interface Options {
  jobs: Job[];
  workers: number;
  json: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]!;
    if (!key.startsWith('--')) throw new Error(`Unexpected argument ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} needs a value`);
    args.set(key.slice(2), value);
    i += 1;
  }
  const list = (key: string, fallback: string): string[] => (args.get(key) ?? fallback).split(',').filter((s) => s.length > 0);
  const difficulty = args.get('difficulty') ?? 'all';
  const difficulties = difficulty === 'all' ? DIFFICULTIES : list('difficulty', '').map((d) => {
    if (!(DIFFICULTIES as readonly string[]).includes(d)) throw new Error(`Unknown difficulty ${d}`);
    return d as Difficulty;
  });
  const player = args.get('player') ?? 'advisor';
  if (player !== 'advisor' && player !== 'passive') throw new Error(`--player is advisor or passive, not ${player}`);
  const days = Number(args.get('days') ?? '240');
  if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a whole number of days');
  const jobs: Job[] = [];
  for (const d of difficulties) {
    for (const nation of list('nations', '250,840,156,792,076,566,616,764')) {
      for (const seed of list('seeds', 'a,b,c')) jobs.push({ difficulty: d, nation, seed, days, player });
    }
  }
  const workers = Number(args.get('jobs') ?? String(Math.min(8, cpus().length)));
  return { jobs, workers: Math.max(1, Math.floor(workers)), json: args.get('json') ?? null };
}

// ------------------------------------------------------------------ the game

export interface GameReport {
  difficulty: Difficulty;
  nation: string;
  name: string;
  seed: string;
  player: AutoplayStyle;
  result: 'won' | 'lost' | 'playing';
  day: number;
  lossReason: string | null;
  share: Partial<Record<(typeof CHECKPOINTS)[number], number>>;
  alive: Partial<Record<(typeof CHECKPOINTS)[number], number>>;
  largestAiShare: Partial<Record<(typeof CHECKPOINTS)[number], number>>;
  capitulations: number;
  capitulationsToPlayer: number;
  firstCaptureDay: number | null;
  firstCapitulationWonDay: number | null;
  battlesPerDay: number;
  medianBattleHours: number | null;
  attackerWinShare: number | null;
  medianKeptInWonAttacks: number | null;
  priceFactor: Record<Good, { p5: number; p95: number; floorShare: number }>;
  shortageDays: { player: Partial<Record<StockKey, number>>; majors: Partial<Record<StockKey, number>> };
  upkeepShare: { player: number | null; majors: number | null };
  tickMs: { p50: number; p95: number };
  thinkMs: { majorP95: number | null; minorP95: number | null };
  saveBytes: number;
  wallSeconds: number;
}

let cachedMap: MapStatic | null = null;

function loadMap(): MapStatic {
  if (cachedMap === null) {
    const read = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
    cachedMap = buildMap(parseFacts(read('public/province-facts.json')), read('src/data/countries.seed.json') as CountrySeed[]);
  }
  return cachedMap;
}

function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

const dayNow = (sim: Sim): number => Math.floor(sim.state.tick / TIME.TICKS_PER_DAY);

/** Battle bookkeeping from the index: starts, ends, durations, who won, what the captor kept. */
class BattleWatch {
  private open = new Map<ProvinceIx, { since: number; owner: NationIx }>();
  private startHp = new Map<ProvinceIx, Map<NationIx, number>>();
  starts = 0;
  hours: number[] = [];
  attackerWins = 0;
  ended = 0;
  kept: number[] = [];

  /** Before the hourly round: the HP each attacking nation brought into each battle. */
  beforeRound(sim: Sim): void {
    this.startHp.clear();
    for (const p of sim.cache.battles) {
      const owner = sim.state.provinces[p]!.owner;
      const byNation = new Map<NationIx, number>();
      for (const army of sim.cache.armiesAt[p]!) {
        if (army.owner === owner || army.battle === null) continue;
        byNation.set(army.owner, (byNation.get(army.owner) ?? 0) + army.battle.startHp);
      }
      this.startHp.set(p, byNation);
    }
  }

  /** After the round: a battle province that changed hands was won; the captor's armies there show what it kept. */
  afterRound(sim: Sim): void {
    for (const [p, byNation] of this.startHp) {
      const owner = sim.state.provinces[p]!.owner;
      const brought = byNation.get(owner);
      if (brought === undefined || brought <= 0) continue;
      let hp = 0;
      for (const army of sim.state.armies) if (army.alive && army.owner === owner && army.at === p && army.leg === null) hp += totalHp(army.units);
      this.kept.push(Math.min(1, hp / brought));
    }
  }

  /** After a tick: battles that began and ended. */
  afterTick(sim: Sim): void {
    const now = new Set(sim.cache.battles);
    for (const p of now) {
      if (this.open.has(p)) continue;
      this.open.set(p, { since: sim.state.tick, owner: sim.state.provinces[p]!.owner });
      this.starts += 1;
    }
    for (const [p, battle] of this.open) {
      if (now.has(p)) continue;
      this.open.delete(p);
      this.ended += 1;
      this.hours.push((sim.state.tick - battle.since) / TIME.TICKS_PER_HOUR);
      if (sim.state.provinces[p]!.owner !== battle.owner) this.attackerWins += 1;
    }
  }
}

export function runGame(job: Job): GameReport {
  const started = performance.now();
  const map = loadMap();
  const state = createGame(map, { playerCountryId: job.nation, difficulty: job.difficulty, seed: job.seed });
  const sim = createSim(map, state, { recordCommands: false });
  const player = state.player;
  const battles = new BattleWatch();
  const majorThinks: number[] = [];
  const minorThinks: number[] = [];
  const hooks: SimHooks = {
    phase(name, edge) {
      if (name === 'combat') {
        if (edge === 'start') battles.beforeRound(sim);
        else battles.afterRound(sim);
      }
      if (name !== 'ai' || edge !== 'start') return;
      // Each due think on its own, timed; the sim's AI phase then finds nothing due.
      if (sim.state.status !== 'playing' && !sim.state.sandbox) return;
      const { regular, alerts } = dueNations(sim);
      for (const [list, alert] of [[regular, false], [alerts, true]] as const) {
        for (const n of list) {
          const major = sim.state.nations[n]!.tier === 'major';
          const t0 = performance.now();
          runNation(sim, n, alert);
          (major ? majorThinks : minorThinks).push(performance.now() - t0);
        }
      }
      runStaff(sim);
    },
  };
  const tickMs: number[] = [];
  const factors: Record<Good, number[]> = { food: [], steel: [], oil: [] };
  const shortPlayer: Partial<Record<StockKey, number>> = {};
  const shortMajors: Partial<Record<StockKey, number>> = {};
  let majorDays = 0;
  const report: GameReport = {
    difficulty: job.difficulty,
    nation: job.nation,
    name: map.nations[player]!.name,
    seed: job.seed,
    player: job.player,
    result: 'playing',
    day: 0,
    lossReason: null,
    share: {},
    alive: {},
    largestAiShare: {},
    capitulations: 0,
    capitulationsToPlayer: 0,
    firstCaptureDay: null,
    firstCapitulationWonDay: null,
    battlesPerDay: 0,
    medianBattleHours: null,
    attackerWinShare: null,
    medianKeptInWonAttacks: null,
    priceFactor: { food: { p5: 0, p95: 0, floorShare: 0 }, steel: { p5: 0, p95: 0, floorShare: 0 }, oil: { p5: 0, p95: 0, floorShare: 0 } },
    shortageDays: { player: shortPlayer, majors: shortMajors },
    upkeepShare: { player: null, majors: null },
    tickMs: { p50: 0, p95: 0 },
    thinkMs: { majorP95: null, minorP95: null },
    saveBytes: 0,
    wallSeconds: 0,
  };
  const upkeepShare = (n: NationIx): number | null => {
    const rates = nationRates(sim, n);
    return rates.income.funds > 0 ? rates.upkeep.funds / rates.income.funds : null;
  };
  const sampleDay = (): void => {
    const day = dayNow(sim);
    for (const good of GOODS) factors[good].push(priceFactor(sim.state.market.pressure[good], good));
    for (const key of STOCK_KEYS) {
      if (key === 'recruits') continue;
      if (sim.state.nations[player]!.shortage[key]) shortPlayer[key] = (shortPlayer[key] ?? 0) + 1;
    }
    for (const nation of sim.state.nations) {
      if (!nation.alive || nation.isPlayer || nation.tier !== 'major') continue;
      majorDays += 1;
      for (const key of STOCK_KEYS) if (key !== 'recruits' && nation.shortage[key]) shortMajors[key] = (shortMajors[key] ?? 0) + 1;
    }
    if (report.firstCaptureDay === null && sim.state.stats.provincesCaptured > 0) report.firstCaptureDay = day;
    for (const checkpoint of CHECKPOINTS) {
      if (day !== checkpoint) continue;
      report.share[checkpoint] = vpShare(sim, player);
      report.alive[checkpoint] = sim.state.nations.filter((x) => x.alive).length;
      let largest = 0;
      for (const nation of sim.state.nations) if (nation.alive && !nation.isPlayer) largest = Math.max(largest, vpShare(sim, nation.ix));
      report.largestAiShare[checkpoint] = largest;
    }
    if (day === 60) {
      report.upkeepShare.player = upkeepShare(player);
      const shares = sim.state.nations.filter((x) => x.alive && !x.isPlayer && x.tier === 'major').map((x) => upkeepShare(x.ix)).filter((x): x is number => x !== null);
      report.upkeepShare.majors = shares.length > 0 ? shares.reduce((a, b) => a + b, 0) / shares.length : null;
    }
  };
  // state.surrenders records only the player's capitulations (the end screen's list),
  // so every capitulation is counted here: a nation seated in its original capital
  // before a tick and dead after it surrendered (an elimination needs a lost seat).
  let capitulations = 0;
  const seated = new Uint8Array(state.nations.length);
  for (let i = 0; i < job.days * TIME.TICKS_PER_DAY; i += 1) {
    if (job.player === 'advisor' && isHourStart(sim.state.tick)) autoplay(sim, 'advisor');
    for (const nation of sim.state.nations) seated[nation.ix] = nation.alive && nation.capital === map.nations[nation.ix]!.capital ? 1 : 0;
    const t0 = performance.now();
    stepTick(sim, hooks);
    tickMs.push(performance.now() - t0);
    for (const nation of sim.state.nations) if (seated[nation.ix] === 1 && !nation.alive) capitulations += 1;
    battles.afterTick(sim);
    if (sim.state.tick % TIME.TICKS_PER_DAY === 0) sampleDay();
    if (sim.state.status !== 'playing') break;
  }
  const { state: end } = sim;
  report.result = end.status;
  report.day = Math.floor(end.tick / TIME.TICKS_PER_DAY) + 1;
  if (end.status === 'lost') {
    const holds = sim.cache.nationProvinces[player]!.length;
    report.lossReason = holds === 0 ? 'last province fell' : 'a rival reached the goal';
  }
  report.capitulations = capitulations;
  report.capitulationsToPlayer = end.surrenders.filter((s) => s.winner === player).length;
  const firstWon = end.surrenders.find((s) => s.winner === player);
  report.firstCapitulationWonDay = firstWon === undefined ? null : Math.floor(firstWon.tick / TIME.TICKS_PER_DAY) + 1;
  const daysPlayed = Math.max(1, end.tick / TIME.TICKS_PER_DAY);
  report.battlesPerDay = battles.starts / daysPlayed;
  report.medianBattleHours = quantile(battles.hours, 0.5);
  report.attackerWinShare = battles.ended > 0 ? battles.attackerWins / battles.ended : null;
  report.medianKeptInWonAttacks = quantile(battles.kept, 0.5);
  for (const good of GOODS) {
    const list = factors[good];
    report.priceFactor[good] = {
      p5: quantile(list, 0.05) ?? 1,
      p95: quantile(list, 0.95) ?? 1,
      floorShare: list.length > 0 ? list.filter((f) => f <= MARKET.MIN_FACTOR + 1e-9).length / list.length : 0,
    };
  }
  const days = Math.max(1, factors.food.length);
  for (const key of Object.keys(shortPlayer) as StockKey[]) shortPlayer[key] = shortPlayer[key]! / days;
  for (const key of Object.keys(shortMajors) as StockKey[]) shortMajors[key] = shortMajors[key]! / Math.max(1, majorDays);
  report.tickMs = { p50: quantile(tickMs, 0.5) ?? 0, p95: quantile(tickMs, 0.95) ?? 0 };
  report.thinkMs = { majorP95: quantile(majorThinks, 0.95), minorP95: quantile(minorThinks, 0.95) };
  report.saveBytes = serialize(end, map, { savedAt: 0, playedMs: 0 }).length;
  report.wallSeconds = (performance.now() - started) / 1000;
  return report;
}

// ------------------------------------------------------------------ output

const pct = (x: number | null | undefined): string => (x === null || x === undefined ? '–' : `${(x * 100).toFixed(1)}%`);
const num = (x: number | null | undefined, digits = 1): string => (x === null || x === undefined ? '–' : x.toFixed(digits));

export function markdown(reports: readonly GameReport[]): string {
  const head =
    '| Difficulty | Nation | Seed | Result | Day | Share 30/60/90/120 | Alive 30/60/90 | Largest AI 90 | Capitulations (to you) | First capture / capitulation won | Battles/day | Median battle h | Attacker wins | Kept in won attacks | Upkeep/gross d60 (you / majors) | Tick ms p50/p95 | Think ms p95 major/minor | Save KB |';
  const rule = `|${head.split('|').slice(1, -1).map(() => '---').join('|')}|`;
  const rows = reports.map((r) =>
    [
      r.difficulty,
      r.name,
      r.seed,
      r.result + (r.lossReason === null ? '' : ` (${r.lossReason})`),
      String(r.day),
      CHECKPOINTS.map((c) => pct(r.share[c])).join(' / '),
      [30, 60, 90].map((c) => String(r.alive[c as 30] ?? '–')).join(' / '),
      pct(r.largestAiShare[90]),
      `${r.capitulations} (${r.capitulationsToPlayer})`,
      `${r.firstCaptureDay ?? '–'} / ${r.firstCapitulationWonDay ?? '–'}`,
      num(r.battlesPerDay),
      num(r.medianBattleHours),
      pct(r.attackerWinShare),
      pct(r.medianKeptInWonAttacks),
      `${pct(r.upkeepShare.player)} / ${pct(r.upkeepShare.majors)}`,
      `${num(r.tickMs.p50, 2)} / ${num(r.tickMs.p95, 2)}`,
      `${num(r.thinkMs.majorP95, 2)} / ${num(r.thinkMs.minorP95, 2)}`,
      num(r.saveBytes / 1000, 0),
    ].join(' | '),
  );
  const summary = DIFFICULTIES.map((d) => {
    const games = reports.filter((r) => r.difficulty === d);
    if (games.length === 0) return null;
    const wins = games.filter((r) => r.result === 'won');
    const winDay = quantile(
      wins.map((r) => r.day),
      0.5,
    );
    const alive90 = games.map((r) => r.alive[90]).filter((x): x is number => x !== undefined);
    return `- **${d}:** ${wins.length} of ${games.length} won${winDay === null ? '' : `, median winning day ${winDay}`}; median nations alive at day 90: ${quantile(alive90, 0.5) ?? '–'}`;
  }).filter((line): line is string => line !== null);
  return [head, rule, ...rows.map((row) => `| ${row} |`), '', ...summary].join('\n');
}

// ------------------------------------------------------------------ the pool

/** Marks a child process of the pool; it runs the jobs its parent sends. */
const CHILD_FLAG = '--pool-child';

async function runAll(options: Options): Promise<GameReport[]> {
  const reports: GameReport[] = new Array<GameReport>(options.jobs.length);
  const progress = (i: number, done: number): void => {
    const job = options.jobs[i]!;
    process.stderr.write(`${done}/${options.jobs.length} ${job.difficulty} ${job.nation} ${job.seed}: ${reports[i]!.result} day ${reports[i]!.day}\n`);
  };
  if (options.workers <= 1) {
    options.jobs.forEach((job, i) => {
      reports[i] = runGame(job);
      progress(i, i + 1);
    });
    return reports;
  }
  let next = 0;
  let done = 0;
  await new Promise<void>((resolve, reject) => {
    const feed = (child: ChildProcess): void => {
      if (next >= options.jobs.length) {
        child.disconnect();
        return;
      }
      const index = next;
      next += 1;
      child.send({ index, job: options.jobs[index] });
    };
    for (let w = 0; w < Math.min(options.workers, options.jobs.length); w += 1) {
      const child = fork(fileURLToPath(import.meta.url), [CHILD_FLAG], { execArgv: process.execArgv });
      child.on('message', (message: { index: number; report: GameReport }) => {
        reports[message.index] = message.report;
        done += 1;
        progress(message.index, done);
        if (done === options.jobs.length) resolve();
        feed(child);
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code !== 0 && done < options.jobs.length) reject(new Error(`A harness process exited with code ${code}`));
      });
      feed(child);
    }
  });
  return reports;
}

if (process.argv.includes(CHILD_FLAG)) {
  process.on('message', (message: { index: number; job: Job }) => {
    process.send!({ index: message.index, report: runGame(message.job) });
  });
} else {
  const options = parseArgs(process.argv.slice(2));
  const reports = await runAll(options);
  process.stdout.write(`${markdown(reports)}\n`);
  if (options.json !== null) {
    mkdirSync(dirname(options.json), { recursive: true });
    writeFileSync(options.json, `${JSON.stringify({ jobs: options.jobs, reports }, null, 2)}\n`);
  }
}
