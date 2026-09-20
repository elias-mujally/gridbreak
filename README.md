# GridBreak

GridBreak is an original local path-racing strategy game prototype built with Vite, React, and TypeScript. It currently supports Classic and Rush rules, six shared maps, two race layouts, local AI, deterministic Rush seeds, and responsive SVG/CSS rendering.

## Run locally

```bash
npm install
npm run dev
```

Validation:

```bash
npm test
npm run build
```

Production preview:

```bash
npm run build
npm run preview
```

The preview server prints its local URL. Query parameters such as
`?map=wide&mode=rush&layout=parallel&difficulty=hard&seed=33&aiDebug=1`
remain available for reproducible QA.

## Deploy to Vercel

The repository is configured as a Vite project:

- Install command: `npm install`
- Build command: `npm run build`
- Output directory: `dist`

Import the GitHub repository into Vercel and deploy with the Vite framework preset. Vercel automatically deploys the production branch and creates preview deployments for pull requests.

CLI deployment is also supported:

```bash
vercel link
vercel --prod
```

No environment variables, backend services, or runtime secrets are required.

## Setup model

The setup flow is:

**Mode → Map → Layout → Difficulty → Start**

Game mode and map are independent.

- **Classic** uses movement, collision jumps, side-steps, and route-safe walls only.
- **Rush** adds Energy, Assist, rewards, Break, Phantom Walls, Momentum, and Sudden Death.
- Both modes use the same map dimensions, wall inventory, spawn zones, and goal zones.

## Shared maps

| Map | Size | Walls | Compatible layouts | Rush rewards | Sudden Death | Deadline | AI wall limit |
|---|---:|---:|---|---:|---:|---:|---:|
| Sprint | 7×7 | 7 | Opposite | 2–4 | 32 | 64 | 72 |
| Arena | 10×10 | 10 | Opposite | 4–6 | 50 | 96 | 96 |
| Wide | 12×7 | 9 | Opposite, horizontal Parallel | 4–6 | 40 | 80 | 96 |
| Gauntlet | 10×18 | 14 | Opposite, vertical Parallel | 6–8 | 72 | 140 | 120 |
| Grand | 15×15 | 16 | Opposite | 8–10 | 84 | 160 | 140 |
| Titan | 20×20 | 20 | Opposite | 10–14 | 120 | 220 | 160 |

These are playtest defaults rather than final balance values.

## SpawnZone, GoalZone, and layouts

`MapConfig` owns serializable `LayoutConfig` values.

Each layout explicitly defines:

- one `SpawnZone` per current player;
- one `GoalZone` per current player;
- the goal edge and orientation;
- symmetric starting points.

Victory, BFS, wall validation, AI scoring, rewards, and rendering read those definitions. Player color no longer determines destination.

### Opposite

Blue and Red begin on opposing edges and race through each other toward opposite goal edges.

### Parallel

Both players begin on the same edge with mirrored, separated positions and race toward the same destination edge.

- Wide Parallel: right edge → left edge.
- Gauntlet Parallel: bottom edge → top edge.

Open-board starting routes are equal in both Parallel layouts.

## Rush movement correction

Human playtesting showed that the old reusable Energy-powered Dash weakened wall strategy. It chained two normal steps whenever Energy was available, making wall ends too easy to escape.

Dash was replaced by **Assist**:

- one starting charge;
- maximum inventory of two;
- exactly two engine-validated orthogonal edges;
- normal turn consumption;
- walls still block each traversed edge.

Collision jumping and its blocked-jump side-step remain normal movement because they only resolve direct pawn encounters.

Boost rewards grant **+1 Assist**. Energy rewards grant **+1 Energy**.

## Seeds and rewards

Unlocked Rush matches and rematches generate fresh unsigned 32-bit seeds. Locked debug seeds reproduce the same reward count, type distribution, and placement.

Rewards:

- vary within each map range;
- avoid starts, goal edges, and dominant opening positions;
- mirror across the appropriate fairness axis;
- use 180-degree symmetry for Opposite;
- use cross-axis symmetry for Parallel;
- remain visible to both players once the match begins.

## Rush AI Batch #2

The passive AI came from several interacting causes:

1. Normal movement earned a reliable score while wall value was reduced by fixed placement and self-route penalties.
2. Defensive urgency was weak when the human approached victory.
3. Wall generation ranked a broad list but did not derive candidates directly from route edges and chokepoints.
4. Reward scoring only noticed tiles already entered; it did not compare detour cost with capped resource value.
5. Break and Phantom had consistently lower scores than moving.
6. Assist scarcity was modeled as a flat penalty rather than a decisive-position tradeoff.

The revised evaluator generates and scores:

- normal moves;
- route-edge and corridor walls;
- Assist paths;
- Break targets;
- tactical Phantom placements;
- probes;
- visible reward detours.

Scoring includes own and opponent route changes, defensive urgency, reward value, Energy and Assist caps, wall reserves, ability costs, decisive range, and future route damage.

Difficulty remains behavioral:

- **Easy:** route-oriented, imperfect, and only occasionally tactical.
- **Normal:** balances progress, clear defense, rewards, and obviously useful abilities.
- **Hard:** evaluates offense, defense, resources, tactical walls, and deliberate sacrifices.

AI receives only `viewForPlayer(state, 'red')`. An enemy Phantom has the same visible representation as a real wall. Its hidden identity is unavailable to every AI difficulty.

### AI explanation mode

Development builds can show the last decision with:

```text
?map=wide&mode=rush&layout=parallel&difficulty=hard&seed=33&aiDebug=1
```

The panel reports the selected action, score, own-route effect, opponent-route effect, reason, and runner-up. Development-only `scenario=ai-defense`, `scenario=ai-reward`, and `scenario=ai-break` states support repeatable tuning.

## Architecture

- `src/game/modes.ts` — shared `MapConfig`, `SpawnZone`, `GoalZone`, and layout configuration
- `src/game/state.ts` — serializable match state, mode/map/layout selection, seeds, and rematches
- `src/game/movement.ts` — orthogonal movement, collision rules, and Assist paths
- `src/game/pathfinding.ts` — BFS to configured goal zones and points
- `src/game/walls.ts` — geometry and all-player route preservation
- `src/game/tiles.ts` — layout-aware deterministic reward generation
- `src/game/rush.ts` — authoritative Rush transitions
- `src/game/view.ts` — player-specific hidden-information projection
- `src/game/ai.ts` — Classic policy and AI dispatch
- `src/game/aiRush.ts` — tactical Rush candidate generation, scoring, and explanation
- `src/ui/ModePicker.tsx` — mode, map, layout, difficulty, and seed setup
- `src/ui/App.tsx` — responsive rendering and validated input dispatch

## Remaining two-player assumptions

The spawn and goal refactor is compatible with future center-goal layouts, but Convergence still requires deliberate engine work:

- `Player` is currently the union `blue | red`.
- State resources use two-entry `Record<Player, ...>` objects.
- `otherPlayer` alternates between exactly two turns.
- Collision movement checks one opponent pawn.
- Deadline tie-breaking compares Blue and Red directly.
- Local UI and AI assume Blue is human and Red is the rival.
- Win presentation and labels are two-player specific.

Convergence, three-player, and four-player gameplay are not implemented.

## Current scope

The project has no accounts, backend, online multiplayer, ads, purchases, rankings, cosmetics, sound, Phaser dependency, Convergence, or Phase 3 features.
