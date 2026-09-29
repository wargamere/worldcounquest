import { describe, expect, it } from 'vitest';
import { COMBAT } from '@/game/balance';
import { captureProbability, describeCombat, expectedSurvivors, resolveCombat, troopsForChance } from '@/game/combat';

const roll = (attackerTroops: number, defenderTroops: number, seed = 1) =>
  resolveCombat(
    { attackerTroops, attackerDev: 5, defenderTroops, defenderDev: 5 },
    seed,
  );

describe('resolveCombat', () => {
  it('is deterministic for a given seed', () => {
    const a = roll(100, 50, 42);
    const b = roll(100, 50, 42);
    expect(a.result).toEqual(b.result);
    expect(a.rngState).toBe(b.rngState);
  });

  it('advances the rng state so consecutive battles differ', () => {
    const first = roll(100, 50, 7);
    const second = roll(100, 50, first.rngState);
    expect(second.rngState).not.toBe(first.rngState);
    expect(first.result.attackPower).not.toBe(second.result.attackPower);
  });

  it('captures when the attacker overwhelms the defender', () => {
    const { result } = roll(500, 10);
    expect(result.captured).toBe(true);
    expect(result.defenderSurvivors).toBe(0);
    expect(result.attackerSurvivors).toBeGreaterThan(0);
  });

  it('fails when the attacker is badly outnumbered', () => {
    const { result } = roll(10, 500);
    expect(result.captured).toBe(false);
    expect(result.attackerSurvivors).toBe(0);
    expect(result.defenderSurvivors).toBeGreaterThan(0);
  });

  it('never lets survivors exceed the committed force', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const { result } = roll(120, 40, seed);
      expect(result.attackerSurvivors).toBeLessThanOrEqual(120);
    }
  });

  it('applies the defender advantage: an even fight overwhelmingly favours the defender', () => {
    // The attacker can still win by rolling 1.15 against 0.85 — a ratio of 1.35,
    // which clears the 1.25 defender advantage — so this is rare, not impossible.
    let captures = 0;
    for (let seed = 0; seed < 500; seed += 1) {
      if (roll(100, 100, seed).result.captured) captures += 1;
    }
    expect(captures).toBeGreaterThan(0);
    expect(captures / 500).toBeLessThan(0.1);
  });

  it('needs roughly the defender advantage in numbers to be an even fight', () => {
    let captures = 0;
    const attackers = Math.ceil(100 * COMBAT.DEFENDER_ADVANTAGE);
    for (let seed = 0; seed < 500; seed += 1) {
      if (roll(attackers, 100, seed).result.captured) captures += 1;
    }
    expect(captures).toBeGreaterThan(100);
    expect(captures).toBeLessThan(400);
  });

  it('gives the higher-developed side an edge at equal numbers', () => {
    let devWins = 0;
    for (let seed = 0; seed < 300; seed += 1) {
      const { result } = resolveCombat(
        { attackerTroops: 100, attackerDev: 10, defenderTroops: 100, defenderDev: 1 },
        seed,
      );
      if (result.captured) devWins += 1;
    }
    expect(devWins).toBeGreaterThan(0);
  });

  it('defender losses on a successful hold stay within the defending force', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const { result } = roll(60, 400, seed);
      expect(result.defenderSurvivors).toBeGreaterThanOrEqual(0);
      expect(result.defenderSurvivors).toBeLessThanOrEqual(400);
    }
  });

  it('writes the numbers into the log line so balance can be debugged', () => {
    const input = { attackerTroops: 500, attackerDev: 5, defenderTroops: 10, defenderDev: 5 };
    const { result } = resolveCombat(input, 1);
    const line = describeCombat('France', 'Belgium', input, result);
    expect(line).toContain('France');
    expect(line).toContain('Belgium');
    expect(line).toContain('500');
    expect(line).toMatch(/A \d+\.\d/);
    expect(line).toMatch(/D \d+\.\d/);
  });
});

describe('captureProbability', () => {
  const base = { attackerDev: 5, defenderDev: 5 };

  it('agrees with a brute-force simulation of the real combat function', () => {
    for (const [attackerTroops, defenderTroops] of [[100, 100], [125, 100], [140, 100], [110, 100], [60, 40]] as const) {
      const input = { ...base, attackerTroops, defenderTroops };
      let wins = 0;
      const trials = 20000;
      let state = 12345;
      for (let i = 0; i < trials; i += 1) {
        const out = resolveCombat(input, state);
        state = out.rngState;
        if (out.result.captured) wins += 1;
      }
      expect(captureProbability(input)).toBeCloseTo(wins / trials, 1);
    }
  });

  it('is 50% when expected strengths are exactly equal', () => {
    const p = captureProbability({ ...base, attackerTroops: 125, defenderTroops: 100 });
    expect(p).toBeCloseTo(0.5, 5);
  });

  it('is 0 when the defender cannot lose and 1 when the attacker cannot', () => {
    expect(captureProbability({ ...base, attackerTroops: 10, defenderTroops: 100 })).toBe(0);
    expect(captureProbability({ ...base, attackerTroops: 1000, defenderTroops: 10 })).toBe(1);
  });

  it('handles empty sides', () => {
    expect(captureProbability({ ...base, attackerTroops: 0, defenderTroops: 10 })).toBe(0);
    expect(captureProbability({ ...base, attackerTroops: 5, defenderTroops: 0 })).toBe(1);
  });

  it('rises monotonically with committed troops', () => {
    let last = 0;
    for (let n = 1; n <= 300; n += 1) {
      const p = captureProbability({ ...base, attackerTroops: n, defenderTroops: 100 });
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
  });
});

describe('troopsForChance', () => {
  const base = { attackerDev: 5, defenderDev: 5, defenderTroops: 100 };

  it('finds the smallest force that reaches the target', () => {
    const n = troopsForChance(base, 1000, 0.9);
    expect(n).not.toBeNull();
    expect(captureProbability({ ...base, attackerTroops: n! })).toBeGreaterThanOrEqual(0.9);
    expect(captureProbability({ ...base, attackerTroops: n! - 1 })).toBeLessThan(0.9);
  });

  it('returns null when even the whole stack falls short', () => {
    expect(troopsForChance(base, 50, 0.9)).toBeNull();
  });
});

describe('expectedSurvivors', () => {
  it('is zero for an attack expected to fail and positive for one expected to win', () => {
    expect(expectedSurvivors({ attackerTroops: 50, attackerDev: 5, defenderTroops: 100, defenderDev: 5 })).toBe(0);
    expect(expectedSurvivors({ attackerTroops: 300, attackerDev: 5, defenderTroops: 100, defenderDev: 5 })).toBeGreaterThan(0);
  });
});
