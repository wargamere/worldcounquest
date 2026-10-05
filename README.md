# Hegemon

A real-time browser strategy game on a map of 1,487 provinces. Pick any of 175
nations, run its economy, raise armies and march them across the world until you
hold half of the world's victory points. Single-player, no backend: the game
autosaves to `localStorage`.

**Play it:** https://wargamere.github.io/worldcounquest/

Original work. The mechanics are inspired by the real-time grand-strategy genre,
but no name, unit, building, text or asset is copied from any existing game. The
only data source is Natural Earth, which is public domain.

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
| `npm run sim -- --difficulty standard --days 120` | Balance harness: whole headless games, reported as a table |
| `npm run bench` | Simulation cost per tick and per AI think |
| `npm run build:provinces` | Rebuild the province map from Natural Earth (about 3 minutes) |

## How it plays

**Time runs.** At 1× one game hour passes per real second, so a game day takes
24 s; 2×, 4× and 8× speed it up, and Space pauses. Every order works while the
game is paused. The game starts paused, and it also pauses when you switch tabs.

**Provinces.** Each of the 175 nations is split into provinces: Russia has 68,
the United States 51, China 51, France 13, Luxembourg 1. Each province has:
- a terrain type (plains, hills, mountains, desert, jungle, arctic, urban), which
  shapes movement and combat;
- one good it produces (Food, Steel or Oil);
- a militia garrison;
- a stability level;
- its own buildings.

Land you take stays *Occupied*, paying half until its original nation is gone and
it integrates. Take an AI nation's capital and the whole nation capitulates to
you.

**The economy.** People pay *Funds* and supply *Recruits*. Land yields *Food*,
*Steel* or *Oil*. Armies cost all of them and eat Food every day. When a stock
runs out, troops lose strength or slow down.

There are five buildings:
- **Works** (shown as Farms, Mines or Oil Wells, by the province's good)
- **Training Ground**
- **Ramparts**
- **Roads**
- **Draft Office**

**The Exchange** is a world market whose prices move with demand. It can keep a
stock topped up for you automatically.

**Armies.** There are five land units: Rifles, Tank Hunters, Motor Rifles, Field
Guns and Tanks. Armies march along province routes at the pace of their slowest
unit. They can be merged and split.

You can send any number of armies, from anywhere, at the same target:
- **Arrive together** times their departures so they all reach the target in the
  same hour.
- Attacking from more than one direction widens your frontage and adds damage.
- **Attack with…** picks the fewest armies that win.

Battles are fought in hourly rounds. The order sheet shows the odds before you
commit. They come from the same round function the game resolves battles with.

**The AI** is 175 nations thinking in real time on a staggered schedule. Each one
builds, trains, trades, defends its borders and runs multi-army operations.
**Suggest** (A) runs the same planner for you. Armies set to *Delegate* are run
by your Staff.

You win at 50% of world VP (1,534 of 3,068). You lose if an AI gets there first,
or when your last province falls.

## Architecture

The game lives in `src/next/`. It was built alongside the turn-based version,
which is still in `src/game`, `src/lib`, `src/store` and `src/components` but is
no longer mounted (see "Legacy code" below).

- `src/next/game/`: every rule, as plain deterministic TypeScript.
  - No React, DOM, timers, `Date` or `Math.random`.
  - Lint also bans the non-portable maths functions, so a seed plus a command log
    replays byte for byte on any JavaScript engine.
  - `types.ts` is the shared contract.
  - `balance.ts` holds every tunable number.
  - `ai/` holds the AI, the advisor and Staff.
- `src/next/store/`:
  - the `requestAnimationFrame` loop, with a fixed 15-minute game tick and a
    per-frame time budget;
  - the session;
  - persistence: rotating save slots, a guard against two open tabs, and a purge
    of saves from older versions;
  - the Zustand store.
- `src/next/lib/` and `src/next/components/map/`: the Canvas 2D map.
  - Province paths are projected once.
  - Fills are batched by colour at low zoom.
  - Nation borders are rebuilt from a precomputed table of which provinces lie on
    each side of every border.
  - Only changed areas are repainted, and army markers are drawn on an overlay
    layer.
- `src/next/components/`: the HUD, panels, feed, phone and desktop layouts,
  onboarding coach, start and end screens.

### The province map

`scripts/build-provinces.mts` turns Natural Earth's 10m admin-1 units and
populated places (at a pinned commit) into `public/provinces.json` (the TopoJSON
the map draws) and `public/province-facts.json` (what the game reads). The steps:

1. Each unit joins one of the 175 countries by majority vote of its centroids.
   Microstates within 200 km fold into their neighbour, and remote territories
   stay off the map.
2. Each country's units merge greedily, smallest into smallest neighbour, down to
   `round(√area / 60)` provinces, each at least 2,500 km².
3. Each province gets an anchor point, its largest city, a population share, a
   terrain class from Natural Earth geography regions, a good, and its
   neighbours, including 101 sea crossings.
4. The build is reproducible byte for byte.

### Balance

Tuned with `npm run sim` (whole headless games). The first pass froze the world:
province garrisons outweighed every army, and every border counted every
neighbour's whole army as a threat. The fixes were lighter garrisons, starting
armies twice as large, looser AI guards, and a relaxed guard for the player's
advisor.

Over 120 days, with the advisor playing 8 starting nations on each difficulty:
- 13–20 battles a day worldwide;
- 89–124 nations still alive at day 90;
- the largest AI nation at 5–20% of world VP.

**Not yet met:** the spec's targets for how often an advisor-driven player wins.
In those runs it captures early and wins capitulations, but overextends and loses
ground, and it had not won a game by day 120.

### Map colours

AI nations use the validated dark-mode steps of the reference data-viz palette,
minus yellow, which is reserved so the player's gold is unique. Colours are
assigned by constrained graph colouring on the country graph, so no two
neighbouring nations ever share a colour.

## Legacy code

The turn-based game (`src/game`, `src/lib`, `src/store`, `src/components`,
`public/countries-110m.json`) still compiles and its tests still pass, but the
page no longer mounts it. It is kept only until its removal is approved; the new
game imports nothing from it.

## Pinned toolchain

Dependencies are pinned to exact versions, not carets. Two are deliberately not
the newest published release:

- **TypeScript 5.9.3**, not 7.x. TypeScript 7 is the native-port compiler and
  does not yet have a stable type-aware ESLint story. Do not "upgrade" it without
  re-verifying the whole lint pipeline first.
- **ESLint 9.39.5**, not 10.x. This matches the peer range `eslint-config-next@16`
  actually declares. Being on 10 is worth less than the config working.

## Deployment

`.github/workflows/ci.yml` lints, typechecks, tests and builds every pull request.
`.github/workflows/deploy.yml` does the same and publishes the static export to
GitHub Pages on every push to `main`. A project site is served from `/<repo>`, so
the build takes its `basePath` from the Pages action rather than hard-coding it.

## Not in scope

Multiplayer, diplomacy, research and tech trees, naval or air units, historical
scenarios, sound, sprite animation, accounts, any database.
