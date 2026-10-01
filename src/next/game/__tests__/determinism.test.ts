import { describe, expect, it } from 'vitest';
import { FEED, TIME } from '../balance';
import { armiesOf } from '../cache';
import { isIdle } from '../armies';
import { applyCommand } from '../commands';
import { deserialize, serialize } from '../save';
import { createSim, stepTick } from '../sim';
import type { Command, Sim } from '../types';
import { realSim, stateHash } from './helpers';

const META = { savedAt: 0, playedMs: 0 };
const SCRIPT_EVERY_TICKS = 12 * TIME.TICKS_PER_HOUR;

/**
 * A busy, scripted player: attacks a neighbour with one idle army, keeps the
 * capital training, builds, trades and merges. Every command is a function of
 * the state, so two runs in the same state issue the same commands.
 */
function playerCommands(sim: Sim): Command[] {
  const { map, state } = sim;
  const nation = state.player;
  const capital = state.nations[nation]!.capital;
  const out: Command[] = [];
  const idle = armiesOf(sim, nation).filter((army) => isIdle(sim, army));
  const attacker = idle[0];
  if (attacker !== undefined) {
    const target = map.edges[attacker.at]!.find((e) => state.provinces[e.to]!.owner !== nation);
    if (target !== undefined) out.push({ kind: 'move', nation, armies: [attacker.id], to: target.to, together: false, append: false });
  }
  const pair = idle.slice(1).filter((army) => army.at === idle[1]?.at);
  if (pair.length >= 2) out.push({ kind: 'merge', nation, armies: pair.map((army) => army.id) });
  if (capital !== null) {
    out.push({ kind: 'train', nation, province: capital, unit: 'rifles', count: 1 });
    out.push({ kind: 'keepTraining', nation, province: capital, on: true });
    out.push({ kind: 'build', nation, province: capital, building: 'ramparts' });
  }
  out.push({ kind: 'trade', nation, good: 'food', amount: 40 });
  return out;
}

function play(sim: Sim, ticks: number): void {
  for (let i = 0; i < ticks; i += 1) {
    if (sim.state.tick % SCRIPT_EVERY_TICKS === 0) for (const command of playerCommands(sim)) applyCommand(sim, command, 'player');
    stepTick(sim);
  }
}

describe('determinism', () => {
  it('the same seed and command log give the same state after 720 ticks', () => {
    const live = realSim({ seed: 'determinism' });
    play(live, 720);
    const log = live.cache.commandLog!;
    expect(log.filter((entry) => entry.source === 'player').length).toBeGreaterThan(20);

    // Only the player's entries are replayed: the AI and the Staff issue theirs again inside the tick.
    const byTick = new Map<number, Command[]>();
    for (const entry of log) if (entry.source === 'player') byTick.set(entry.tick, [...(byTick.get(entry.tick) ?? []), entry.command]);
    const replay = realSim({ seed: 'determinism' });
    for (let i = 0; i < 720; i += 1) {
      for (const command of byTick.get(replay.state.tick) ?? []) applyCommand(replay, command, 'player');
      stepTick(replay);
    }
    expect(stateHash(replay)).toBe(stateHash(live));
    expect(replay.cache.commandLog).toEqual(log);
  }, 60_000);

  it('a save at day 10, loaded and run 5 days, equals 15 days straight (byte-identical)', () => {
    const straight = realSim({ seed: 'continuation' });
    play(straight, 10 * TIME.TICKS_PER_DAY + 37);
    const text = serialize(straight.state, straight.map, META);
    const file = deserialize(text, straight.map);
    expect(file).not.toBeNull();
    const loadedState = file!.state;
    expect({ ...loadedState, feed: [] }).toEqual({ ...straight.state, feed: [] });
    expect(loadedState.feed).toEqual(straight.state.feed.slice(0, FEED.SAVED_ENTRIES));
    expect(serialize(loadedState, straight.map, META)).toBe(text);

    const loaded = createSim(straight.map, loadedState, { recordCommands: true });
    for (let day = 0; day < 5; day += 1) {
      const ticks = TIME.TICKS_PER_DAY - (straight.state.tick % TIME.TICKS_PER_DAY);
      play(straight, ticks);
      play(loaded, ticks);
      expect(serialize(loaded.state, loaded.map, META)).toBe(serialize(straight.state, straight.map, META));
    }
    expect(loaded.state.tick).toBe(15 * TIME.TICKS_PER_DAY);
  }, 120_000);
});
