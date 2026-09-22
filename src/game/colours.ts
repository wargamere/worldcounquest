import type { NationId } from './types';

/**
 * Owner colours. Nations are keyed by a stable id, so the palette is picked by
 * hashing that id — the same nation is the same colour across sessions without
 * storing anything.
 */
const PALETTE = [
  '#e4572e', '#4c9f70', '#3a7ca5', '#c94277', '#d9a404',
  '#7d5ba6', '#2a9d8f', '#bc4b51', '#5b8c5a', '#8e6c88',
  '#d97706', '#0e7490', '#9d174d', '#4d7c0f', '#6d28d9',
  '#b45309', '#155e75', '#a21caf', '#3f6212', '#1d4ed8',
] as const;

export const PLAYER_COLOUR = '#f5f3ef';
export const UNCLAIMED_COLOUR = '#1e293b';

export function nationColour(nationId: NationId, playerId: NationId): string {
  if (nationId === playerId) return PLAYER_COLOUR;
  let hash = 0;
  for (let i = 0; i < nationId.length; i += 1) hash = (hash * 31 + nationId.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length] ?? UNCLAIMED_COLOUR;
}
