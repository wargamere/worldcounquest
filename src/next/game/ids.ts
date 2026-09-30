/**
 * The only casts to the branded index types. Everything else receives indices
 * from these functions or from the map and state, so a province index can never
 * be passed where a nation index is expected.
 */
import type { ArmyId, NationIx, ProvinceIx } from './types';

export function asProvince(n: number): ProvinceIx {
  return n as ProvinceIx;
}

export function asNation(n: number): NationIx {
  return n as NationIx;
}

export function asArmy(n: number): ArmyId {
  return n as ArmyId;
}
