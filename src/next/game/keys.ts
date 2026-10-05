/**
 * Fresh, fully populated records for every keyed shape in the contract. Each
 * call returns a new object, so callers may mutate what they get.
 */
import { MARKET } from './balance';
import type {
  BuildingLevels,
  GoodAmounts,
  PlayerStats,
  ShortageFlags,
  Stocks,
  TradePolicy,
  UnitHp,
  Units,
  UnitType,
} from './types';

export function zeroUnits(): Units {
  return {
    rifles: { count: 0, hp: 0 },
    hunters: { count: 0, hp: 0 },
    motor: { count: 0, hp: 0 },
    guns: { count: 0, hp: 0 },
    tanks: { count: 0, hp: 0 },
  };
}

export function zeroUnitHp(): UnitHp {
  return { rifles: 0, hunters: 0, motor: 0, guns: 0, tanks: 0 };
}

export function zeroStocks(): Stocks {
  return { funds: 0, recruits: 0, food: 0, steel: 0, oil: 0 };
}

export function zeroGoods(): GoodAmounts {
  return { food: 0, steel: 0, oil: 0 };
}

export function noBuildings(): BuildingLevels {
  return { works: 0, training: 0, ramparts: 0, roads: 0, draft: 0 };
}

export function noShortage(): ShortageFlags {
  return { funds: false, food: false, steel: false, oil: false };
}

function zeroPerUnit(): Record<UnitType, number> {
  return { rifles: 0, hunters: 0, motor: 0, guns: 0, tanks: 0 };
}

export function emptyStats(): PlayerStats {
  return {
    attacksWon: 0,
    attacksLost: 0,
    defencesHeld: 0,
    provincesCaptured: 0,
    provincesLost: 0,
    unitsTrained: zeroPerUnit(),
    unitsLost: zeroPerUnit(),
    enemyUnitsDestroyed: 0,
    peakVp: 0,
    peakProvinces: 0,
    capitalMoves: 0,
    revoltsSuffered: 0,
    largestBattle: null,
    fundsEarned: 0,
    peakFundsPerDay: 0,
    tradeVolume: 0,
    fogOff: false,
  };
}

/** The player starts with the MARKET defaults; AI nations trade through planMarket instead. */
export function defaultTradePolicy(isPlayer: boolean): TradePolicy {
  if (!isPlayer) return { keepDays: zeroGoods(), sellAboveDays: zeroGoods() };
  return { keepDays: { ...MARKET.DEFAULT_KEEP_DAYS }, sellAboveDays: { ...MARKET.DEFAULT_SELL_ABOVE_DAYS } };
}
