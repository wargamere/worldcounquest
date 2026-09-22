# Hegemon

A browser nation-conquest strategy game: pick a country on the world map, run its
economy, raise an army, take your neighbours. Single-player, no backend — saves
go to `localStorage`.

Original work. Not affiliated with, and sharing no code or assets with, any
existing game.

## Running it

```bash
npm install
npm run dev      # http://localhost:3000
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Next dev server |
| `npm run build` | Production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest, one pass |
| `npm run test:watch` | Vitest, watch mode |

## Architecture

- `src/game/` — all game rules, as **pure functions**. No React, no Next, no
  store imports. ESLint enforces this (`no-restricted-imports` on the directory),
  so the rules stay testable in plain Node.
- `src/game/balance.ts` — every tunable number, in one file. Rebalance here.
- `src/data/` — hand-editable game data (country seed values, sea links). This is
  authored content, not derived output; regenerating it is a manual decision.
- `src/store/` — Zustand. A thin shell that calls into `src/game`.
- `src/components/` — rendering only.

## Pinned toolchain

Dependencies are pinned to exact versions, not carets. Two of them are
deliberately not the newest published release:

- **TypeScript 5.9.3**, not 7.x. TypeScript 7 is the native-port compiler and
  does not yet have a stable type-aware ESLint story. Do not "upgrade" it
  without re-verifying the whole lint pipeline first.
- **ESLint 9.39.5**, not 10.x. This matches the peer range `eslint-config-next@16`
  actually declares. Being on 10 is worth less than the config working.

## Status

Alpha, built in milestones. M0 — scaffold.
