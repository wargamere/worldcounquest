import { describe, expect, it } from 'vitest';
import { ECONOMY, UNITS } from '../balance';
import { zeroUnitHp } from '../keys';
import {
  addUnits,
  applyHpLoss,
  copyUnits,
  hardShare,
  heal,
  isEmpty,
  maxHp,
  pacedBy,
  scaleUnits,
  slowestSpeed,
  speedAtOilFactor,
  takeUnits,
  totalCount,
  totalHp,
  unitEquivalents,
  unitsFromCounts,
  upkeepOf,
  usesOil,
} from '../units';

describe('units', () => {
  it('builds full-strength stacks and sums them', () => {
    const units = unitsFromCounts({ rifles: 3, tanks: 2 });
    expect(units.rifles).toEqual({ count: 3, hp: 60 });
    expect(units.tanks).toEqual({ count: 2, hp: 72 });
    expect(units.guns).toEqual({ count: 0, hp: 0 });
    expect(totalCount(units)).toBe(5);
    expect(totalHp(units)).toBe(132);
    expect(maxHp(units)).toBe(132);
    expect(unitEquivalents(units)).toBe(5);
    units.rifles.hp = 30;
    expect(unitEquivalents(units)).toBe(3.5);
  });

  it('moves at the pace of the slowest type; Oil users halve in a shortage', () => {
    expect(slowestSpeed(unitsFromCounts({ rifles: 1, guns: 1, tanks: 1 }), false)).toBe(UNITS.guns.speedKmh);
    expect(slowestSpeed(unitsFromCounts({ rifles: 1, tanks: 1 }), false)).toBe(UNITS.rifles.speedKmh);
    expect(slowestSpeed(unitsFromCounts({ rifles: 1, tanks: 1 }), true)).toBe(UNITS.tanks.speedKmh * ECONOMY.OIL_SHORT_SPEED);
    expect(speedAtOilFactor(unitsFromCounts({ motor: 1 }), 0.5)).toBe(UNITS.motor.speedKmh / 2);
    expect(slowestSpeed(unitsFromCounts({}), false)).toBe(0);
    expect(pacedBy(unitsFromCounts({ rifles: 1, guns: 1 }), false)).toBe('guns');
    expect(pacedBy(unitsFromCounts({ rifles: 1, tanks: 1 }), true)).toBe('tanks');
    expect(pacedBy(unitsFromCounts({}), false)).toBeNull();
  });

  it('knows Oil users and the hard share', () => {
    expect(usesOil(unitsFromCounts({ rifles: 4 }))).toBe(false);
    expect(usesOil(unitsFromCounts({ rifles: 4, motor: 1 }))).toBe(true);
    expect(hardShare(unitsFromCounts({ rifles: 9, tanks: 5 }))).toBeCloseTo(180 / 360, 12);
    expect(hardShare(unitsFromCounts({}))).toBe(0);
  });

  it('merging and splitting conserve HP exactly, and a split keeps health proportional', () => {
    const a = unitsFromCounts({ rifles: 5, guns: 2 });
    a.rifles.hp = 70;
    const b = unitsFromCounts({ rifles: 1, tanks: 3 });
    const before = totalHp(a) + totalHp(b);
    addUnits(a, b);
    expect(totalHp(a)).toBe(before);
    expect(a.rifles).toEqual({ count: 6, hp: 90 });
    const taken = takeUnits(a, { rifles: 3, tanks: 1, guns: 5 });
    expect(taken.rifles).toEqual({ count: 3, hp: 45 });
    expect(taken.guns).toEqual({ count: 2, hp: 28 });
    expect(taken.tanks.count).toBe(1);
    expect(a.rifles).toEqual({ count: 3, hp: 45 });
    expect(a.guns).toEqual({ count: 0, hp: 0 });
    expect(totalHp(a) + totalHp(taken)).toBe(before);
    expect(taken.rifles.hp / (taken.rifles.count * 20)).toBe(a.rifles.hp / (a.rifles.count * 20));
  });

  it('counts drop only with damage, to the whole units the HP still supports', () => {
    const units = unitsFromCounts({ rifles: 5 });
    const loss = zeroUnitHp();
    loss.rifles = 25;
    applyHpLoss(units, loss);
    expect(units.rifles).toEqual({ count: 4, hp: 75 });
    loss.rifles = 0.2;
    applyHpLoss(units, loss);
    expect(units.rifles.count).toBe(4);
    loss.rifles = 74.6;
    applyHpLoss(units, loss);
    // 0.2 HP left is below COMBAT.DEAD_HP: the pool is gone.
    expect(units.rifles).toEqual({ count: 0, hp: 0 });
    expect(isEmpty(units)).toBe(true);
  });

  it('float noise above a whole number of units does not keep an extra unit', () => {
    const noisy = unitsFromCounts({ rifles: 3 });
    const loss = zeroUnitHp();
    loss.rifles = 20 - 1e-11;
    applyHpLoss(noisy, loss);
    expect(noisy.rifles.count).toBe(2);
    const real = unitsFromCounts({ rifles: 3 });
    loss.rifles = 19.9;
    applyHpLoss(real, loss);
    expect(real.rifles.count).toBe(3);
  });

  it('healing is capped at count × unit HP and never returns a lost unit', () => {
    const units = unitsFromCounts({ rifles: 3 });
    const loss = zeroUnitHp();
    loss.rifles = 25;
    applyHpLoss(units, loss);
    expect(units.rifles.count).toBe(2);
    heal(units, 0.1);
    expect(units.rifles.hp).toBeCloseTo(39, 12);
    heal(units, 1);
    expect(units.rifles).toEqual({ count: 2, hp: 40 });
  });

  it('scales every pool and recomputes counts', () => {
    const units = unitsFromCounts({ rifles: 5, tanks: 1, hunters: 1 });
    units.hunters.hp = 0.8;
    const half = scaleUnits(units, 0.5);
    expect(half.rifles).toEqual({ count: 3, hp: 50 });
    expect(half.tanks).toEqual({ count: 1, hp: 18 });
    expect(half.hunters).toEqual({ count: 0, hp: 0 });
    expect(units.rifles.hp).toBe(100);
  });

  it('upkeep is charged by whole units', () => {
    const units = unitsFromCounts({ rifles: 2, tanks: 1 });
    expect(upkeepOf(units)).toEqual({ funds: 18, food: 6, oil: 4 });
    units.rifles.hp = 21;
    expect(upkeepOf(units)).toEqual({ funds: 18, food: 6, oil: 4 });
  });

  it('copies are independent', () => {
    const units = unitsFromCounts({ rifles: 2 });
    const copy = copyUnits(units);
    copy.rifles.hp = 1;
    expect(units.rifles.hp).toBe(40);
  });
});
