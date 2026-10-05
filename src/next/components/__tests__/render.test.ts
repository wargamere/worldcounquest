import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ComponentType } from 'react';
import { renderToString } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { armiesOf, ownedProvinces } from '@/next/game/cache';
import { stepTick } from '@/next/game/sim';
import { TIME } from '@/next/game/balance';
import type { Sim } from '@/next/game/types';
import { useGameStore } from '@/next/store/gameStore';
import { getSession } from '@/next/store/session';
import { FeedPanel } from '../feed/FeedPanel';
import { DesktopLayout } from '../layout/DesktopLayout';
import { PhoneLayout } from '../layout/PhoneLayout';
import { CompactBar } from '../hud/CompactBar';
import { TopBar } from '../hud/TopBar';
import { ArmyPanel } from '../panels/ArmyPanel';
import { BattlePanel } from '../panels/BattlePanel';
import { EconomyPanel } from '../panels/EconomyPanel';
import { ExchangePanel } from '../panels/ExchangePanel';
import { GreatPowers } from '../panels/GreatPowers';
import { MultiArmyPanel } from '../panels/MultiArmyPanel';
import { ProductionPanel } from '../panels/ProductionPanel';
import { ProvincePanel } from '../panels/ProvincePanel';
import { HelpOverlay } from '../screens/HelpOverlay';
import { SettingsDialog } from '../screens/SettingsDialog';
import { StartScreen } from '../screens/StartScreen';

/**
 * Renders every panel to a string over a real running game (Node, no DOM):
 * a render that throws, or reads a view wrongly, fails here. Effects do not run.
 */
const PUBLIC = join(process.cwd(), 'public');

function render<P extends object>(component: ComponentType<P>, props: P): string {
  return renderToString(createElement(component, props));
}

function sim(): Sim {
  const s = getSession()?.sim;
  if (s === undefined) throw new Error('no game');
  return s;
}

beforeAll(async () => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.stubGlobal('fetch', (url: string) => {
    const text = readFileSync(join(PUBLIC, url.split('/').pop() ?? ''), 'utf8');
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(text) as unknown) });
  });
  await useGameStore.getState().init('');
}, 60_000);

afterAll(() => {
  useGameStore.getState().abandonGame();
  vi.unstubAllGlobals();
});

describe('components render over a live game', () => {
  it('renders the Start screen with the recommended starts', () => {
    const html = render(StartScreen, {});
    expect(html).toContain('Recommended starts');
    expect(html).toContain('France');
  });

  it('renders the HUD, the context panels and the drawers at day 1 and after six days of war', () => {
    useGameStore.getState().startGame('276', 'ruthless', 'render');
    for (const day of [0, 6]) {
      const s = sim();
      for (let i = 0; i < day * TIME.TICKS_PER_DAY; i += 1) stepTick(s);
      expect(render(TopBar, {})).toContain(s.map.nations[s.state.player]!.name);
      expect(render(CompactBar, {})).toContain('Day');
      const own = ownedProvinces(s, s.state.player);
      for (const p of own.slice(0, 8)) expect(render(ProvincePanel, { province: p })).toContain('Buildings');
      const foreign = s.map.edges[own[0]!]!.find((e) => s.state.provinces[e.to]!.owner !== s.state.player);
      if (foreign !== undefined) expect(render(ProvincePanel, { province: foreign.to })).toContain('Attack with');
      const armies = armiesOf(s, s.state.player).map((a) => a.id);
      for (const id of armies.slice(0, 5)) expect(render(ArmyPanel, { army: id })).toContain('Composition');
      expect(render(MultiArmyPanel, { armies })).toContain('armies');
      for (const p of s.cache.battles.slice(0, 5)) expect(render(BattlePanel, { province: p })).toContain('Battle');
      expect(render(EconomyPanel, {})).toContain('Produced');
      expect(render(ExchangePanel, {})).toContain('Keep stocked');
      expect(render(ProductionPanel, {})).toContain('Training Grounds');
      expect(render(GreatPowers, {})).toContain('(you)');
      expect(render(FeedPanel, {})).toContain('Mine');
    }
    expect(render(DesktopLayout, {})).toContain('World map');
    expect(render(PhoneLayout, { landscape: false })).toContain('World map');
    expect(render(HelpOverlay, {})).toContain('Controls');
    expect(render(SettingsDialog, {})).toContain('Pause automatically');
  }, 120_000);
});
