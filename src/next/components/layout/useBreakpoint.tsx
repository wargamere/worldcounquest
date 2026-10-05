'use client';

import { useSyncExternalStore } from 'react';

export interface Breakpoint {
  /** Below 768 px wide, or a short touch screen (a phone held sideways). */
  phone: boolean;
  /** A phone held sideways (height under 500 px): the sheet becomes a side drawer (§8.6). */
  landscape: boolean;
}

const PHONE_QUERY = '(max-width: 767px), (max-height: 499px) and (pointer: coarse)';
const LANDSCAPE_QUERY = '(max-height: 499px)';
const SERVER: Breakpoint = { phone: false, landscape: false };
let cached: Breakpoint = SERVER;

function read(): Breakpoint {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return SERVER;
  const phone = window.matchMedia(PHONE_QUERY).matches;
  const landscape = phone && window.matchMedia(LANDSCAPE_QUERY).matches;
  if (phone !== cached.phone || landscape !== cached.landscape) cached = { phone, landscape };
  return cached;
}

function subscribe(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  window.addEventListener('resize', fn);
  window.addEventListener('orientationchange', fn);
  return () => {
    window.removeEventListener('resize', fn);
    window.removeEventListener('orientationchange', fn);
  };
}

/** Desktop or phone layout (§8.1, §8.6), re-read on resize. */
export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribe, read, () => SERVER);
}
