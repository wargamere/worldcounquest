import { describe, expect, it } from 'vitest';
import { AI_TIERS, COMBAT, DEVELOPMENT, MANPOWER, VICTORY } from '@/game/balance';

describe('balance constants', () => {
  it('gives the defender an edge and keeps the combat roll centred on 1', () => {
    expect(COMBAT.DEFENDER_ADVANTAGE).toBeGreaterThan(1);
    expect(COMBAT.ROLL_MIN).toBeLessThan(COMBAT.ROLL_MAX);
    expect((COMBAT.ROLL_MIN + COMBAT.ROLL_MAX) / 2).toBeCloseTo(1);
  });

  it('keeps casualty factors as fractions of the committed force', () => {
    expect(COMBAT.ATTACKER_SURVIVAL).toBeGreaterThan(0);
    expect(COMBAT.ATTACKER_SURVIVAL).toBeLessThan(1);
    expect(COMBAT.DEFENDER_LOSS_ON_HOLD).toBeGreaterThan(0);
    expect(COMBAT.DEFENDER_LOSS_ON_HOLD).toBeLessThan(1);
  });

  it('caps the manpower pool at a year of regen', () => {
    expect(MANPOWER.CAP_MONTHS).toBe(12);
    expect(MANPOWER.REGEN_RATE).toBeGreaterThan(0);
    expect(MANPOWER.REGEN_RATE).toBeLessThan(1);
  });

  it('keeps development levels a non-empty ascending range', () => {
    expect(DEVELOPMENT.MIN_LEVEL).toBeLessThan(DEVELOPMENT.MAX_LEVEL);
  });

  it('requires a majority of countries to win', () => {
    expect(VICTORY.CONTROL_FRACTION).toBeGreaterThan(0.5);
    expect(VICTORY.CONTROL_FRACTION).toBeLessThanOrEqual(1);
  });

  it('makes Tier B strictly more cautious than an even fight', () => {
    expect(AI_TIERS.TIER_B_ATTACK_RATIO).toBeGreaterThan(1);
    expect(AI_TIERS.TIER_A_SIZE).toBeGreaterThan(0);
  });
});
