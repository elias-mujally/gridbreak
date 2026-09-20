# GridBreak

GridBreak is an original local path-racing strategy game prototype built with Vite, React, and TypeScript. It supports Classic and Rush against local AI plus the experimental Convergence mode for two to four people sharing one device.

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

Convergence QA links use `mode=convergence` and `players=2`, `3`, or `4`, for example:

```text
?map=grand&mode=convergence&players=4
```

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

**Mode → Map → Layout or player count → Difficulty when applicable → Start**

Game mode and map are independent.

- **Classic** uses movement, collision jumps, side-steps, and route-safe walls only.
- **Rush** adds Energy, Assist, rewards, Break, Phantom Walls, Momentum, and Sudden Death.
- **Convergence** is a local shared-device center race for two to four human players. Its V1 rules use movement and walls without Rush resources.
- Classic and Rush use the same map dimensions, wall inventory, spawn zones, and goal zones.

## Shared maps

| Map | Size | Classic/Rush walls | Compatible layouts | Convergence players | Convergence walls each |
|---|---:|---:|---|---|---|
| Sprint | 7×7 | 7 | Opposite | — | — |
| Arena | 10×10 | 10 | Opposite | 2 | 5 |
| Wide | 12×7 | 9 | Opposite, horizontal Parallel | — | — |
| Gauntlet | 10×18 | 14 | Opposite, vertical Parallel | — | — |
| Grand | 15×15 | 16 | Opposite | 2–4 | 10 / 7 / 5 |
| Titan | 20×20 | 20 | Opposite | 2–4 | 14 / 9 / 7 |

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

### Convergence

Convergence uses configuration-owned player counts, spawn points, a central GoalZone, and wall inventories.

- Two players start North and South.
- Three players start North, East, and South. Their open-board route lengths are equal; leaving West unused creates an acknowledged tactical asymmetry for playtesting.
- Four players start North, East, South, and West.
- Odd boards use one center cell. Even boards use a symmetric 2×2 center region.
- Every player is a `HUMAN_LOCAL` controller in V1.
- A wall is accepted only when BFS still finds a route from every active pawn to the center.

The first collision pawn may be jumped when the cell behind it is open. When that cell is blocked by a wall, board edge, or another pawn, the mover receives open side-step destinations around the first pawn. Chained jumps over multiple pawns are intentionally excluded because they become ambiguous in clusters.

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
- `src/game/state.ts` — serializable player/controller model, turn order, match state, seeds, and rematches
- `src/game/movement.ts` — orthogonal N-player collision rules and two-player Rush Assist paths
- `src/game/pathfinding.ts` — BFS to configured goal zones and points
- `src/game/walls.ts` — geometry and all-player route preservation
- `src/game/tiles.ts` — layout-aware deterministic reward generation
- `src/game/rush.ts` — authoritative Rush transitions
- `src/game/view.ts` — player-specific hidden-information projection
- `src/game/ai.ts` — Classic policy and AI dispatch
- `src/game/aiRush.ts` — tactical Rush candidate generation, scoring, and explanation
- `src/ui/ModePicker.tsx` — mode, map, layout, difficulty, and seed setup
- `src/ui/App.tsx` — responsive rendering and validated input dispatch
- `src/ui/ConvergenceMatch.tsx` — local shared-device N-player board and turn presentation

## N-player foundation

`GameState` now includes serializable `PlayerState[]`, `turnOrder`, and `currentTurnIndex`. Each player owns an id, number, non-color token, visual color, controller type, spawn, goal, position, wall inventory, and optional Rush resources. Supported controller values are:

- `HUMAN_LOCAL`
- `AI`
- `HUMAN_REMOTE` as a future architecture value only

Classic and Rush retain two-player compatibility projections while their proven AI and resource rules remain specialized. Shared movement, victory, turn advancement, wall validation, goals, and rendering read the active player model.

## Work required before Online Multiplayer

Networking is intentionally absent. A future authoritative implementation still needs:

1. room and membership state with private room codes;
2. authenticated or guest remote identities mapped to `HUMAN_REMOTE` controllers;
3. a server-owned canonical `GameState` and action sequence number;
4. validation of serialized `move` and `wall` actions on the server using this pure engine;
5. action acknowledgement, ordering, duplicate rejection, and client reconciliation;
6. reconnect snapshots plus resumable turn timers;
7. room lifecycle, disconnect, surrender, and abandoned-match policies;
8. versioned replay/event storage and compatibility migrations.

The current action and state shapes are JSON serializable, but no transport, persistence, authentication, or server authority is included.

## Current scope

The project has no accounts, backend, online multiplayer, ads, purchases, rankings, cosmetics, sound, Phaser dependency, or Phase 3 features.
