/**
 * Inline stroke icons (24 × 24), drawn in code so the game ships no icon font.
 * Every icon is decorative unless given a `label`; buttons carry their own
 * accessible name.
 */
import type { ReactElement } from 'react';

export type IconName =
  | 'funds'
  | 'recruits'
  | 'food'
  | 'steel'
  | 'oil'
  | 'play'
  | 'pause'
  | 'battle'
  | 'incoming'
  | 'suggest'
  | 'menu'
  | 'close'
  | 'home'
  | 'capital'
  | 'plus'
  | 'minus'
  | 'layers'
  | 'feed'
  | 'clock'
  | 'check'
  | 'warning'
  | 'go'
  | 'shield'
  | 'build'
  | 'train'
  | 'chart'
  | 'help'
  | 'settings'
  | 'flag';

const PATHS: Readonly<Record<IconName, ReactElement>> = {
  funds: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.5 0-2.5.8-2.5 2s1 1.6 2.5 2 2.5.8 2.5 2-1 2-2.5 2c-1 0-2-.5-2.5-1.5M12 6.5v1.5M12 16v1.5" />
    </>
  ),
  recruits: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19c.5-3 2.5-5 5.5-5s5 2 5.5 5" />
      <circle cx="17" cy="9" r="2.3" />
      <path d="M15.5 14.2c2.5-.4 4.5 1.3 5 4.8" />
    </>
  ),
  food: (
    <>
      <path d="M12 21V8" />
      <path d="M12 8c-3 0-4-2-4-4 2 0 4 1 4 4zM12 8c3 0 4-2 4-4-2 0-4 1-4 4zM12 13c-3 0-4-2-4-4 2 0 4 1 4 4zM12 13c3 0 4-2 4-4-2 0-4 1-4 4zM12 18c-3 0-4-2-4-4 2 0 4 1 4 4zM12 18c3 0 4-2 4-4-2 0-4 1-4 4z" />
    </>
  ),
  steel: (
    <>
      <path d="M4 15l3-6h10l3 6z" />
      <path d="M4 15h16v3H4z" />
    </>
  ),
  oil: <path d="M12 3c3.5 4.5 6 8 6 11a6 6 0 0 1-12 0c0-3 2.5-6.5 6-11z" />,
  play: <path d="M7 5l12 7-12 7z" />,
  pause: <path d="M8 5v14M16 5v14" />,
  battle: <path d="M5 5l14 14M19 5L5 19M5 5h3M5 5v3M19 5h-3M19 5v3" />,
  incoming: (
    <>
      <path d="M3 12h13M11 7l5 5-5 5" />
      <path d="M20 5v14" />
    </>
  ),
  suggest: (
    <>
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.3 1 2.1h5c0-.8.4-1.6 1-2.1A6 6 0 0 0 12 3z" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  home: (
    <>
      <path d="M4 11l8-7 8 7" />
      <path d="M6 10v10h12V10" />
    </>
  ),
  capital: <path d="M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  layers: (
    <>
      <path d="M12 4l9 5-9 5-9-5z" />
      <path d="M3 14l9 5 9-5" />
    </>
  ),
  feed: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  check: <path d="M5 12l5 5 9-10" />,
  warning: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17v.5" />
    </>
  ),
  go: <path d="M5 12h12M13 7l5 5-5 5" />,
  shield: <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />,
  build: (
    <>
      <path d="M3 21h18M5 21V11l7-5 7 5v10" />
      <path d="M10 21v-5h4v5" />
    </>
  ),
  train: (
    <>
      <rect x="4" y="7" width="16" height="10" rx="1" />
      <path d="M4 7l16 10M20 7L4 17" />
    </>
  ),
  chart: <path d="M4 19h16M6 16l4-5 3 3 5-7" />,
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17v.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
    </>
  ),
  flag: <path d="M5 21V4M5 4h11l-2 4 2 4H5" />,
};

export function Icon({ name, size = 16, className = '', label }: { name: IconName; size?: number; className?: string; label?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`inline-block shrink-0 ${className}`}
      role={label === undefined ? undefined : 'img'}
      aria-hidden={label === undefined ? true : undefined}
      aria-label={label}
    >
      {PATHS[name]}
    </svg>
  );
}

