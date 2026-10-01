import { describe, expect, it } from 'vitest';
import { ADVISOR } from '../balance';
import { validateCommand } from '../commands';
import { advise } from '../ai/advisor';
import { checkWorldGame, FROZEN_WINDOW, playWorld, WORLD_AI_DAYS } from './ai/worldGame';

/** §12.4's AI world game on Standard; Relaxed and Ruthless have their own files so they run in parallel. */
describe(`the real world on Standard, ${WORLD_AI_DAYS} days with a passive player`, () => {
  it('frozen-map, no-rejected-ai-commands, market-no-dump, no-oscillation, budgets and advisor-safe', () => {
    const game = playWorld('standard', 'ai-standard', WORLD_AI_DAYS, [10, 30]);
    checkWorldGame(game, FROZEN_WINDOW);
    // advisor-safe on the real map: every card the passive player is offered validates.
    const cards = advise(game.sim, ADVISOR.SUGGESTIONS * 3);
    for (const card of cards) for (const command of card.commands) expect(validateCommand(game.sim, command, 'player').ok).toBe(true);
  }, 240_000);
});
