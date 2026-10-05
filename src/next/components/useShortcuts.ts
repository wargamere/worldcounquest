'use client';

import { useEffect } from 'react';
import type { RunSpeed } from '@/next/game/types';
import { useGameStore } from '@/next/store/gameStore';
import { nextMapMode } from './layout/MapControls';
import { confirmDisband } from './panels/ArmyPanel';

const SPEED_KEYS: Readonly<Record<string, RunSpeed>> = { '1': 1, '2': 2, '3': 4, '4': 8 };

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * The keyboard (§8.5). Keys are ignored while an input has focus, Tab keeps its
 * browser behaviour, and a pointer click gives focus back from buttons (the
 * turn-based game's fix: a focused button would otherwise swallow Space and Enter).
 */
export function useShortcuts(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent): void => {
      if (isTyping(event.target)) return;
      const store = useGameStore.getState();
      const key = event.key;
      if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 's') {
        event.preventDefault();
        store.saveNow();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const onButton = event.target instanceof HTMLButtonElement;
      const speed = SPEED_KEYS[key];
      if (speed !== undefined) {
        store.setSpeed(speed);
        return;
      }
      switch (key) {
        case ' ':
          event.preventDefault();
          store.togglePause();
          return;
        case '[':
          store.stepSpeed(-1);
          return;
        case ']':
          store.stepSpeed(1);
          return;
        case 'Escape':
          store.cancel();
          return;
        case 'Enter':
          if (onButton) return;
          event.preventDefault();
          if (store.draft !== null) store.confirmDraft();
          else if (store.attackWith !== null) store.confirmAttackWith();
          else if (store.suggestions.length > 0) store.acceptSuggestion();
          return;
        case 'Delete':
        case 'Backspace':
          if (event.shiftKey) store.disbandSelected(confirmDisband);
          else store.stopSelected();
          return;
        case '.':
          store.latestAlert();
          return;
        case '?':
          store.openPanel('help');
          return;
      }
      switch (key.toLowerCase()) {
        case 'h':
          store.focusHome();
          return;
        case 'c':
          store.focusCapital();
          return;
        case 'n':
          store.nextIdleArmy(event.shiftKey ? -1 : 1);
          return;
        case 'b':
          store.nextBattle();
          return;
        case 'a':
          store.advise();
          return;
        case 'f':
          store.delegate(event.shiftKey ? 'defend' : 'delegate', 'selected');
          return;
        case 'm':
          store.mergeSelected();
          return;
        case 's':
          store.splitSelected();
          return;
        case 'r':
          store.retreatSelected();
          return;
        case 't':
          store.trainingForSelection();
          return;
        case 'e':
          store.openPanel('economy');
          return;
        case 'x':
          store.openPanel('exchange');
          return;
        case 'p':
          store.openPanel('production');
          return;
        case 'g':
          store.openPanel('powers');
          return;
        case 'l':
          store.openPanel('feed');
          return;
        case 'v':
          store.setMapMode(nextMapMode(store.mapMode));
          return;
      }
    };
    const release = (): void => {
      const focused = document.activeElement;
      if (focused instanceof HTMLButtonElement) focused.blur();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerup', release);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerup', release);
    };
  }, [active]);
}
