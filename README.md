# GridBreak

GridBreak is an original path-racing strategy game built with Vite, React, and TypeScript. It supports Classic and Rush against local AI, local Convergence for two to four people sharing one device, and private authoritative online Convergence rooms.

## Run locally

```bash
npm install
npm run worker:dev
npm run dev
```

The Worker listens on `http://127.0.0.1:8787`, which is also the frontend's development fallback. Copy `.env.example` to `.env.local` only when a different Worker endpoint is needed.

Validation:

```bash
npm test
npm run worker:typecheck
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

Set the Vercel production environment variable `VITE_ONLINE_SERVER_URL` to the deployed Worker's public HTTPS origin. This is a public endpoint, not a secret. No Cloudflare credentials or session secrets belong in the Vite environment or client bundle.

## Online server

Online V1 uses one Cloudflare Durable Object per private room. The Worker owns room admission and WebSocket transport; the Durable Object owns the lobby, authoritative game state, sequence, reconnect metadata, action history, and expiry alarm. Rendering and browser APIs remain outside the shared deterministic engine.

```bash
npm run worker:typecheck
npm run worker:dev
npm run worker:deploy
```

`wrangler.jsonc` declares the `ROOMS` Durable Object binding and its SQLite-backed migration. The production allowlist is configured through `ALLOWED_ORIGINS`; update it before deploying a frontend on a new origin.

### Room and session lifecycle

- Rooms are unlisted and use a case-insensitive `GB-XXXX` code that excludes ambiguous characters.
- A guest receives a random session ID and 256-bit session token. The browser stores that temporary reconnect credential locally; Durable Object storage keeps only its SHA-256 hash.
- Lobby actions and game intents use protocol version 1, a build compatibility value, unique action IDs, and the expected authoritative sequence.
- The server accepts only `MOVE` and `PLACE_WALL` game intents and validates identity, turn ownership, collision, walls, route preservation, and victory with the shared engine.
- A disconnected seat is retained for five minutes and turns are never skipped. A playing room with no connected players becomes abandoned after 30 minutes. Any room expires after 24 hours without activity.
- Rematches require every connected room member to vote. Membership, map, and player count are retained while a clean authoritative game is created.

Room metadata reserves `PUBLIC` and `PASSWORD_PROTECTED` visibility values, while Online V1 creates only `UNLISTED` rooms. Future accounts can replace the guest identity provider without changing `PlayerState` or the game rules.

## Setup model

The setup flow is:

**Mode → Map → Layout or player count → Difficulty when applicable → Start**

Game mode and map are independent.

- **Classic** uses movement, collision jumps, side-steps, and route-safe walls only.
- **Rush** adds Energy, Assist, rewards, Break, Phantom Walls, Momentum, and Sudden Death.
- **Convergence** is a local shared-device center race for two to four human players. Its V1 rules use movement and walls without Rush resources.
- Classic and Rush use the same map dimensions, wall inventory, spawn zones, and goal zones.

## Shared maps

| Map | Classic/Rush size | Classic/Rush walls | Compatible layouts | Convergence size | Convergence players | Convergence walls each |
|---|---:|---:|---|---:|---|---|
| Sprint | 7×7 | 7 | Opposite | — | — | — |
| Arena | 10×10 | 10 | Opposite | 11×11 | 2 | 5 |
| Wide | 12×7 | 9 | Opposite, horizontal Parallel | — | — | — |
| Gauntlet | 10×18 | 14 | Opposite, vertical Parallel | — | — | — |
| Grand | 15×15 | 16 | Opposite | 15×15 | 2–4 | 10 / 7 / 5 |
| Titan | 20×20 | 20 | Opposite | 21×21 | 2–4 | 14 / 9 / 7 |

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

Convergence uses configuration-owned dimensions, player counts, spawn points, one central GoalCell, and wall inventories. Its mode-specific boards are Arena 11×11, Grand 15×15, and Titan 21×21; Classic and Rush retain their established map dimensions.

- Two players start North and South.
- Three players start North, East, and South. Their open-board route lengths are equal; leaving West unused creates an acknowledged tactical asymmetry for playtesting.
- Four players start North, East, South, and West.
- Every Convergence board must have odd width and height. Configuration construction rejects even dimensions.
- The only winning destination is the cell at `floor(width / 2), floor(height / 2)`.
- Every player is a `HUMAN_LOCAL` controller in V1.
- A wall is accepted only when BFS still finds a route from every active pawn to that single center cell.

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
