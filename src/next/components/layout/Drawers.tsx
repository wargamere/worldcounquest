'use client';

import { useGameStore, type PanelId } from '@/next/store/gameStore';
import { FeedPanel } from '../feed/FeedPanel';
import { EconomyPanel } from '../panels/EconomyPanel';
import { ExchangePanel } from '../panels/ExchangePanel';
import { GreatPowers } from '../panels/GreatPowers';
import { ProductionPanel } from '../panels/ProductionPanel';
import { HelpOverlay } from '../screens/HelpOverlay';
import { SettingsDialog } from '../screens/SettingsDialog';
import { act } from '../ui/act';
import { Drawer } from './Drawer';

const TITLE: Readonly<Record<PanelId, string>> = {
  economy: 'Economy',
  exchange: 'The Exchange',
  production: 'Production',
  powers: 'Great Powers',
  feed: 'Feed',
  help: 'Help',
  settings: 'Settings',
  attackWith: 'Attack with…',
};

/**
 * The modal drawers (§8.1): Economy, Exchange, Production, Help and Settings.
 * On phones Great Powers and Feed open as full sheets too (§8.6); on desktop
 * they are tabs of the right column, and Attack with… lives in the context panel.
 */
export function Drawers({ phone }: { phone: boolean }) {
  const panel = useGameStore((s) => s.panel);
  if (panel === null || panel === 'attackWith') return null;
  if (!phone && (panel === 'powers' || panel === 'feed')) return null;
  const close = (): void => act().openPanel(null);
  return (
    <Drawer title={TITLE[panel]} onClose={close} wide={panel === 'help' || panel === 'exchange' || panel === 'powers'} full={phone}>
      {panel === 'economy' && <EconomyPanel />}
      {panel === 'exchange' && <ExchangePanel />}
      {panel === 'production' && <ProductionPanel />}
      {panel === 'powers' && <GreatPowers />}
      {panel === 'feed' && (
        <div className="-m-4 flex h-[calc(100%+2rem)] flex-col">
          <FeedPanel />
        </div>
      )}
      {panel === 'help' && <HelpOverlay />}
      {panel === 'settings' && <SettingsDialog />}
    </Drawer>
  );
}
