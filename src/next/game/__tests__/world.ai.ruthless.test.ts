import { describe, it } from 'vitest';
import { checkWorldGame, FROZEN_WINDOW, playWorld, WORLD_AI_DAYS } from './ai/worldGame';

describe(`the real world on Ruthless, ${WORLD_AI_DAYS} days with a passive player`, () => {
  it('frozen-map, no-rejected-ai-commands, market-no-dump, no-oscillation and budgets', () => {
    checkWorldGame(playWorld('ruthless', 'ai-ruthless', WORLD_AI_DAYS, [20]), FROZEN_WINDOW);
  }, 240_000);
});
