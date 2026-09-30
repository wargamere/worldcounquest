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

- **Invest** — raise a country's development by one level: more income, and 10%
  more combat strength there. Cost scales with the current level; the panel shows
  the payback time.
- **Recruit** — troops cost money *and* draw on a national manpower pool that
  regenerates at 0.2% of your population per month and banks up to a year.
- **Move** — free between adjacent countries you own. Each garrison moves or
  attacks once per turn.
- **Attack** — an adjacent enemy. Committed troops either take the territory or
  die there.
- **Combined assault** — attack one enemy from several of your bordering
  countries at once, as a single battle. Each contributor uses its action; the
  attacking development is the troop-weighted average. This is how armed borders
  break: a country pinned by a big neighbour can spare little alone, but three
  together often can. In one stalled game only 4 of 24 border targets were
  winnable from any single country — and 12 once neighbours could combine.

You win at 60% of the world. You lose if your last country falls, **or if a rival
reaches 60% first**.

### Playing it

Select one of your countries (gold). Neighbours you can attack are outlined red,
your own you can move into blue; click one to set up the order. Before you commit,
the order panel shows:

- your **exact chance to capture** — computed in closed form from the combat
  formula, not estimated;
- how many troops would **hold** it if you win;
- the chance your **source falls** next turn with what you leave behind;
- the chance the prize is **retaken** straight away.

The default force is the one a careful commander would send: it wins, keeps home
safe, and leaves enough behind to hold what it takes. Presets jump to a near-sure
win, a likely win, everything home can spare, or everything. Under *Join the
assault*, tick your other countries that border the target to add their spare
troops; the odds update as you do, and joiners are outlined on the map. Clicking
an enemy country offers a one-click *Combined assault* from every bordering
country that can spare troops.

**Advise** (`A`) suggests the best attack that is both likely to win and safe to
launch — from one country, or combined from several; when there is none, it
suggests the most useful troop movement. It uses
the AI's own planner, so it never walks you into a trap — and it will not win the
game for you: breaking an armed border takes your own judgement.

Countries likely to fall next turn are outlined solid red. A turn report tells you
what you lost while the world moved. `Enter` ends the turn, `Esc` cancels, `H`
frames your nation, `N` selects the next country that can still act (most
endangered first), `Z` undoes a recruit, investment or move, `?` opens the rules.
Attacks cannot be undone — rewinding a lost battle and retrying would reroll the
dice. Hovering an enemy while one of your countries is selected shows the odds
from it; the recruit button shows your net income after the purchase.

*Great powers* charts countries held over time for you and the three leading
rivals against the number that wins, above the standings table.

Combat writes its numbers into the event log (`A 69.3` against `D 14.8`, and the
survivors) so the balance can be debugged from a real game rather than guessed at.

## Architecture

- `src/game/` — all game rules, as **pure functions**. No React, no Next, no
  store imports. ESLint enforces this with a `no-restricted-imports` zone on the
  directory, so the rules stay testable in plain Node. Includes the odds and
  threat maths (`combat.ts`, `threat.ts`), the order previews the panel shows
  (`orders.ts`), and the advisor, which is the AI planner run for the player.
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
flooding the log, the AI runs in two tiers: **majors** (the strongest ~20, plus
anyone who grows past a country-count or income threshold) and **minors**, which
hold a size-proportionate garrison and only take near-certain wins.

A major power, each turn: invests, recruits where the threat or the opportunity
is, attacks — alone or in a combined assault — then moves spare troops toward
threatened or active borders. An
attack is only made if the force it needs leaves the source safe, and is sized so
the survivors can hold what they take.

Those rules exist because each one fixed a failure found by simulating whole games
(each has a regression test):

| Symptom | Cause |
| --- | --- |
| Belgium owned the UK in month two | Attacks committed most of a stack without checking what was left at home |
| The map froze solid by year five | The AI compared raw troop counts, so every border settled at parity |
| No nation ever attacked from its homeland | It reinforced before attacking, and moving out uses up a country's action |
| The US sat 1,637 troops next to Panama for years | Attacks were capped at a size too small to hold the prize, so were never made |
| China fell to Vietnam in year one | Threat counted only the strongest neighbour; China has fourteen |
| France's homeland fell in month one | Threat ignored that enemies recruit before they attack |

Threat is **combined** across every enemy neighbour (1 − Π(1 − pᵢ)) and assumes
each enemy commits part of its standing troops plus part of what it can afford to
recruit first. How paranoid that estimate is (`THREAT_COMMIT_SHARE`,
`THREAT_RESERVE_SHARE`) is the single biggest lever on the pace of the world:
too high and every border is an armed standoff, too low and one empire eats the
planet in five years.

### Balance

Tuned by simulating full games with a scripted player that does exactly what the
advisor suggests every turn — a competent, careful player — across eight starting
nations:

| Difficulty | That player wins | Median winning turn |
| --- | --- | --- |
| Relaxed | 6 of 8 | 35 |
| Standard | 4 of 8 | 39 |
| Ruthless | 2 of 8 | 97 |

The rules give the player no action counter: they can act from every
country every turn, while AI great powers are capped per turn. So difficulty comes
from the AI: its income, its caution, its attacks per turn, and the player's
opening war chest. On Standard, playing as well as the advisor wins about half the
time; beating it reliably means taking the risks the advisor will not.

The event log is filtered to events involving you, your neighbours, or a major
power, with the full log behind a toggle. Only the player's purchases are logged,
so battles are never crowded out.

### Map colours

AI nations use the validated dark-mode steps of the reference data-viz palette,
minus yellow, which is reserved so the player's gold is unique. Gold separates
from every AI colour (worst colour-blind ΔE 17.5 on the ocean surface).

Seven hues cannot all be told apart pairwise, and on this map no colouring can
keep every failing pair apart; an exhaustive search proves it. So colours are
assigned by constrained graph colouring: **no two neighbours ever share a
colour**, and pairs the validator flags are kept apart where possible, normal-vision
failures first. About 5% of borders still carry a weak pair (e.g. blue beside
violet). Every border between two nations is drawn as a line, which is the
secondary encoding there, and the tooltip names the owner.

Labels and camera framing use each country's largest polygon rather than the
whole feature: France's full centroid is pulled out to sea by French Guiana, and
the United States' toward Alaska.

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
