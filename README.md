# Hegemon

A browser nation-conquest strategy game. Pick any of 175 countries on the world
map, run its economy, raise an army, and take your neighbours until you hold 60%
of the world. Single-player, no backend — the game autosaves to `localStorage`.

**Play it:** https://wargamere.github.io/worldcounquest/

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
| `npm run build` | Static export into `out/` |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest, one pass |
| `npm run test:watch` | Vitest, watch mode |

## How it plays

One turn is one month: your income lands, you act, then every AI nation acts in
one batch. Actions cost money and manpower, never an action counter.

- **Invest** — raise a country's development by one level. Cost scales with the
  current level.
- **Recruit** — troops cost money *and* draw on a national manpower pool that
  regenerates at 0.2% of your population per month and banks up to a year.
- **Move** — free between adjacent countries you own, once per garrison per turn.
- **Attack** — an adjacent enemy. Committed troops either take the territory or
  die there.

Combat writes its numbers into the event log (`A 69.3` against `D 14.8`, and the
survivors) so the balance can be debugged from a real game rather than guessed at.

## Architecture

- `src/game/` — all game rules, as **pure functions**. No React, no Next, no
  store imports. ESLint enforces this with a `no-restricted-imports` zone on the
  directory, so the rules stay testable in plain Node.
- `src/game/balance.ts` — every tunable number, in one file. Rebalance here.
- `src/data/` — hand-authored game data: `countries.seed.json` (population and
  economy tier per country) and `sea-links.json` (crossings the land-border graph
  cannot know about, like Dover and the Korea Strait). Authored content, not
  derived output.
- `src/lib/world.ts` — loads the TopoJSON and derives the adjacency graph.
- `src/store/` — Zustand. A thin shell that calls into `src/game`.
- `src/components/` — rendering only.

### The world

Territories come from world-atlas `countries-110m`, vendored into `public/` so
nothing is fetched from a CDN at runtime. The file's actual shape was inspected
rather than assumed, and it holds two surprises worth knowing:

- `id` is a **zero-padded string** (`"826"`), not a number.
- Three geometries — N. Cyprus, Somaliland and Kosovo — ship with **no `id` at
  all**. They are assigned ids in the `9xx` private-use range so every territory
  has a stable key.

Antarctica and the French Southern and Antarctic Lands are excluded, leaving 175
playable countries. Land borders come from `topojson.neighbors()`; sea links are
layered on top from `src/data/sea-links.json`.

### AI

Every country is its own nation, so conquest is continuous rather than gated
behind a handful of great powers. To keep 175 nations from scrambling the map and
flooding the log, the AI runs in two tiers:

- **Major** (the strongest ~20, plus anyone who grows past a country-count or
  income threshold) — invests, recruits, consolidates troops toward its most
  threatened border, and attacks.
- **Minor** — holds a garrison floor and only attacks a badly outmatched
  neighbour.

The AI compares *expected combat strength* — troops scaled by development, with
the defender bonus applied — not raw troop counts. This matters: comparing raw
counts deadlocks the world, because every border settles at parity, no stack ever
clears the aggression threshold, and ownership stops changing entirely. There is a
regression test for it.

The event log is filtered to events involving you, your neighbours, or a major
power, with the full log behind a toggle.

## Pinned toolchain

Dependencies are pinned to exact versions, not carets. Two are deliberately not
the newest published release:

- **TypeScript 5.9.3**, not 7.x. TypeScript 7 is the native-port compiler and
  does not yet have a stable type-aware ESLint story. Do not "upgrade" it without
  re-verifying the whole lint pipeline first.
- **ESLint 9.39.5**, not 10.x. This matches the peer range `eslint-config-next@16`
  actually declares. Being on 10 is worth less than the config working.

## Deployment

`.github/workflows/deploy.yml` lints, typechecks, tests, then builds a static
export and publishes it to GitHub Pages on every push to `main`. A project site is
served from `/<repo>`, so the build takes its `basePath` from the Pages action
rather than hard-coding it.

## Not in the alpha

Multiplayer, diplomacy, tech trees, naval or air unit types, historical scenarios,
sound, sprite animation, accounts, any database.
