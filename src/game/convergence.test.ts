import { describe, expect, it } from 'vitest';
import { applyAction } from './engine';
import { centerGoalZone, CONVERGENCE_MAP_IDS, MAP_CONFIGS, pointInGoal } from './modes';
import { legalMoves } from './movement';
import { hasRoute, routeLength, shortestPath } from './pathfinding';
import { activePlayerStates, GameState, PlayerId, Point, Wall, newGame, rematchGame, samePoint } from './state';
import { isLegalWall } from './walls';

const p = (row: number, col: number): Point => ({ row, col });
const h = (row: number, col: number): Wall => ({ row, col, orientation: 'horizontal' });
const v = (row: number, col: number): Wall => ({ row, col, orientation: 'vertical' });

function placePlayers(state: GameState, positions: Partial<Record<PlayerId, Point>>, turn: PlayerId): GameState {
  const players = activePlayerStates(state).map(player => ({ ...player, position: { ...(positions[player.id] ?? player.position) } }));
  const currentTurnIndex = state.turnOrder!.indexOf(turn);
  return { ...state, players, turn, currentTurnIndex };
}

describe('N-player foundation', () => {
  it('keeps the legacy two-player controllers and turn order intact', () => {
    const state = newGame({ mode: 'rush', mapId: 'wide', layout: 'parallel', seed: 11 });
    expect(activePlayerStates(state).map(player => [player.id, player.controller])).toEqual([
      ['blue', 'HUMAN_LOCAL'], ['red', 'AI'],
    ]);
    expect(state.turnOrder).toEqual(['blue', 'red']);
    expect(state.currentTurnIndex).toBe(0);
  });

  it.each([2, 3, 4] as const)('rotates a %i-player turn order centrally', playerCount => {
    let state = newGame({ mode: 'convergence', mapId: 'grand', playerCount });
    const expected = state.turnOrder!;
    for (let index = 1; index <= playerCount * 2; index++) {
      const move = legalMoves(state)[0];
      state = applyAction(state, { type: 'move', to: move })!;
      expect(state.turn).toBe(expected[index % playerCount]);
      expect(state.currentTurnIndex).toBe(index % playerCount);
    }
  });

  it('keeps deterministic actions and state JSON serializable', () => {
    const state = newGame({ mode: 'convergence', mapId: 'grand', playerCount: 4 });
    const action = { type: 'move' as const, to: legalMoves(state)[0] };
    expect(JSON.parse(JSON.stringify(action))).toEqual(action);
    expect(JSON.parse(JSON.stringify(applyAction(state, action))).players).toHaveLength(4);
  });
});
describe('Convergence configuration', () => {
  it('generates exactly one mathematical center GoalCell', () => {
    expect(centerGoalZone(15, 15)).toEqual({ kind: 'cell', cell: p(7, 7) });
  });

  it.each([[10, 11], [11, 10], [20, 20]] as const)('rejects incompatible %i×%i Convergence geometry', (width, height) => {
    expect(() => centerGoalZone(width, height)).toThrow(/require odd dimensions/);
  });

  it('exposes only explicitly configured Convergence maps and counts', () => {
    expect(CONVERGENCE_MAP_IDS).toEqual(['arena', 'grand', 'titan']);
    expect(MAP_CONFIGS.arena.convergence?.supportedPlayerCounts).toEqual([2]);
    expect(MAP_CONFIGS.grand.convergence?.supportedPlayerCounts).toEqual([2, 3, 4]);
    expect(MAP_CONFIGS.titan.convergence?.supportedPlayerCounts).toEqual([2, 3, 4]);
  });

  it('keeps every configured Convergence board odd with one GoalCell', () => {
    for (const mapId of CONVERGENCE_MAP_IDS) {
      const config = MAP_CONFIGS[mapId].convergence!;
      expect(config.width % 2).toBe(1);
      expect(config.height % 2).toBe(1);
      for (const setup of Object.values(config.setups)) {
        expect(setup?.goal).toEqual({ kind: 'cell', cell: p(Math.floor(config.height / 2), Math.floor(config.width / 2)) });
      }
    }
  });

  it.each([
    ['arena', 11, 11, p(5, 5)],
    ['grand', 15, 15, p(7, 7)],
    ['titan', 21, 21, p(10, 10)],
  ] as const)('configures %s as %i×%i with the correct center', (mapId, width, height, center) => {
    const state = newGame({ mode: 'convergence', mapId, playerCount: 2 });
    expect([state.width, state.height]).toEqual([width, height]);
    expect(activePlayerStates(state)[0].goal).toEqual({ kind: 'cell', cell: center });
  });

  it('preserves the established Classic and Rush Arena/Titan dimensions', () => {
    const classicArena = newGame({ mode: 'classic', mapId: 'arena' });
    const rushArena = newGame({ mode: 'rush', mapId: 'arena' });
    const classicTitan = newGame({ mode: 'classic', mapId: 'titan' });
    const rushTitan = newGame({ mode: 'rush', mapId: 'titan' });
    expect([classicArena.width, classicArena.height, rushArena.width, rushArena.height]).toEqual([10, 10, 10, 10]);
    expect([classicTitan.width, classicTitan.height, rushTitan.width, rushTitan.height]).toEqual([20, 20, 20, 20]);
  });

  it.each([
    ['arena', 2], ['grand', 2], ['grand', 3], ['grand', 4], ['titan', 2], ['titan', 3], ['titan', 4],
  ] as const)('creates valid non-overlapping %s spawns for %i players', (mapId, playerCount) => {
    const state = newGame({ mode: 'convergence', mapId, playerCount });
    const players = activePlayerStates(state);
    expect(players).toHaveLength(playerCount);
    expect(new Set(players.map(player => `${player.position.row},${player.position.col}`)).size).toBe(playerCount);
    for (const player of players) {
      expect(player.position.row).toBeGreaterThanOrEqual(0);
      expect(player.position.row).toBeLessThan(state.height);
      expect(player.position.col).toBeGreaterThanOrEqual(0);
      expect(player.position.col).toBeLessThan(state.width);
      expect(hasRoute(player.position, player.goal, [], state)).toBe(true);
    }
  });

  it.each(CONVERGENCE_MAP_IDS)('gives %s two-player spawns exact north/south symmetry', mapId => {
    const state = newGame({ mode: 'convergence', mapId, playerCount: 2 });
    const [north, south] = activePlayerStates(state);
    expect(north.spawn.col).toBe(Math.floor(state.width / 2));
    expect(south.spawn.col).toBe(north.spawn.col);
    expect(north.spawn.row + south.spawn.row).toBe(state.height - 1);
  });

  it.each(['grand', 'titan'] as const)('gives %s four-player spawns exact cardinal symmetry', mapId => {
    const state = newGame({ mode: 'convergence', mapId, playerCount: 4 });
    const center = p(Math.floor(state.height / 2), Math.floor(state.width / 2));
    expect(activePlayerStates(state).map(player => player.spawn)).toEqual([
      p(0, center.col), p(center.row, state.width - 1), p(state.height - 1, center.col), p(center.row, 0),
    ]);
  });

  it.each(['grand', 'titan'] as const)('gives all three %s players equal open-board routes while leaving west unused', mapId => {
    const state = newGame({ mode: 'convergence', mapId, playerCount: 3 });
    const players = activePlayerStates(state);
    const lengths = players.map(player => routeLength(player.position, player.goal, [], state));
    expect(new Set(lengths).size).toBe(1);
    expect(lengths[0]).toBe(Math.floor(state.width / 2));
  });

  it('finds a BFS route from every supported spawn to the single center', () => {
    for (const mapId of CONVERGENCE_MAP_IDS) {
      for (const playerCount of MAP_CONFIGS[mapId].convergence!.supportedPlayerCounts) {
        const state = newGame({ mode: 'convergence', mapId, playerCount });
        for (const player of activePlayerStates(state)) {
          const path = shortestPath(player.spawn, player.goal, [], state);
          expect(path).not.toBeNull();
          expect(path?.at(-1)).toEqual(player.goal.kind === 'cell' ? player.goal.cell : null);
        }
      }
    }
  });

  it('uses provisional per-map wall inventories that decrease as player count grows', () => {
    expect(activePlayerStates(newGame({ mode: 'convergence', mapId: 'arena', playerCount: 2 }))[0].wallsRemaining).toBe(5);
    expect(activePlayerStates(newGame({ mode: 'convergence', mapId: 'grand', playerCount: 2 }))[0].wallsRemaining).toBe(10);
    expect(activePlayerStates(newGame({ mode: 'convergence', mapId: 'grand', playerCount: 3 }))[0].wallsRemaining).toBe(7);
    expect(activePlayerStates(newGame({ mode: 'convergence', mapId: 'grand', playerCount: 4 }))[0].wallsRemaining).toBe(5);
    expect(activePlayerStates(newGame({ mode: 'convergence', mapId: 'titan', playerCount: 4 }))[0].wallsRemaining).toBe(7);
  });
});

describe('Convergence movement and collision', () => {
  it('never permits a move onto another pawn', () => {
    const state = placePlayers(newGame({ mode: 'convergence', mapId: 'grand', playerCount: 4 }), {
      blue: p(5, 7), red: p(4, 7), amber: p(10, 10), violet: p(10, 4),
    }, 'blue');
    expect(legalMoves(state, 'blue')).not.toContainEqual(p(4, 7));
    expect(legalMoves(state, 'blue')).toContainEqual(p(3, 7));
  });

  it('does not chain-jump a three-pawn cluster and offers deterministic side-steps', () => {
    const state = placePlayers(newGame({ mode: 'convergence', mapId: 'grand', playerCount: 4 }), {
      blue: p(5, 7), red: p(4, 7), amber: p(3, 7), violet: p(10, 4),
    }, 'blue');
    const moves = legalMoves(state, 'blue');
    expect(moves).not.toContainEqual(p(3, 7));
    expect(moves).not.toContainEqual(p(2, 7));
    expect(moves).toContainEqual(p(4, 6));
    expect(moves).toContainEqual(p(4, 8));
  });

  it('side-steps around an adjacent pawn when a wall blocks the jump', () => {
    const state = { ...placePlayers(newGame({ mode: 'convergence', mapId: 'grand', playerCount: 3 }), {
      blue: p(5, 7), red: p(4, 7), amber: p(10, 7),
    }, 'blue'), walls: [h(3, 6)] };
    expect(legalMoves(state, 'blue')).toEqual(expect.arrayContaining([p(4, 6), p(4, 8)]));
  });

  it('supports BFS directly to a central GoalZone', () => {
    const state = newGame({ mode: 'convergence', mapId: 'titan', playerCount: 4 });
    const player = activePlayerStates(state)[0];
    const path = shortestPath(player.position, player.goal, [], state)!;
    expect(path.length - 1).toBe(10);
    expect(pointInGoal(path.at(-1)!, player.goal, state)).toBe(true);
  });

  it.each([2, 3, 4] as const)('lets each of %i players adjacent to an unoccupied center enter it', playerCount => {
    const positions = { blue: p(6, 7), red: p(7, 8), amber: p(8, 7), violet: p(7, 6) };
    const state = placePlayers(newGame({ mode: 'convergence', mapId: 'grand', playerCount }), positions, 'blue');
    for (const player of activePlayerStates(state)) expect(legalMoves(state, player.id)).toContainEqual(p(7, 7));
  });

  it('allows a pawn to jump one blocker directly into the center', () => {
    const state = placePlayers(newGame({ mode: 'convergence', mapId: 'grand', playerCount: 4 }), {
      blue: p(5, 7), red: p(6, 7), amber: p(10, 10), violet: p(10, 4),
    }, 'blue');
    expect(legalMoves(state, 'blue')).toContainEqual(p(7, 7));
    expect(applyAction(state, { type: 'move', to: p(7, 7) })?.winner).toBe('blue');
  });

  it('blocks a direct center entry when a wall covers that edge', () => {
    const state = { ...placePlayers(newGame({ mode: 'convergence', mapId: 'grand', playerCount: 4 }), {
      blue: p(6, 7), red: p(7, 8), amber: p(8, 7), violet: p(7, 6),
    }, 'blue'), walls: [h(6, 6)] };
    expect(legalMoves(state, 'blue')).not.toContainEqual(p(7, 7));
    expect(legalMoves(state, 'blue')).toEqual(expect.arrayContaining([p(6, 6), p(6, 8)]));
  });

  it('uses deterministic side-steps when a pawn and wall block the center approach', () => {
    const state = { ...placePlayers(newGame({ mode: 'convergence', mapId: 'grand', playerCount: 4 }), {
      blue: p(5, 7), red: p(6, 7), amber: p(10, 10), violet: p(10, 4),
    }, 'blue'), walls: [h(6, 6)] };
    const moves = legalMoves(state, 'blue');
    expect(moves).not.toContainEqual(p(7, 7));
    expect(moves).toEqual(expect.arrayContaining([p(6, 6), p(6, 8)]));
  });
});

describe('Convergence walls and victory', () => {
  it.each([2, 3, 4] as const)('preserves every route for a legal wall with %i players', playerCount => {
    const state = newGame({ mode: 'convergence', mapId: 'grand', playerCount });
    const wall = h(1, 1);
    expect(isLegalWall(state, wall)).toBe(true);
    const next = applyAction(state, { type: 'wall', wall })!;
    for (const player of activePlayerStates(next)) expect(hasRoute(player.position, player.goal, next.walls, next)).toBe(true);
  });

  it('revalidates legal all-player wall routes on Arena, Grand, and Titan', () => {
    for (const mapId of CONVERGENCE_MAP_IDS) {
      for (const playerCount of MAP_CONFIGS[mapId].convergence!.supportedPlayerCounts) {
        const state = newGame({ mode: 'convergence', mapId, playerCount });
        const next = applyAction(state, { type: 'wall', wall: h(1, 1) })!;
        expect(activePlayerStates(next).every(player => hasRoute(player.position, player.goal, next.walls, next))).toBe(true);
      }
    }
  });

  it.each(CONVERGENCE_MAP_IDS)('rejects a final %s barrier that traps any active player', mapId => {
    const supported = MAP_CONFIGS[mapId].convergence!.supportedPlayerCounts;
    const state = newGame({ mode: 'convergence', mapId, playerCount: supported.at(-1)! });
    const finalCol = state.width - 3;
    const nearlyClosed = Array.from({ length: finalCol / 2 }, (_, index) => h(1, index * 2));
    const candidate = h(1, finalCol);
    const prepared = { ...state, walls: [...nearlyClosed, v(0, state.width - 2)] };
    expect(hasRoute(activePlayerStates(prepared)[0].position, activePlayerStates(prepared)[0].goal, [...prepared.walls, candidate], prepared)).toBe(false);
    expect(isLegalWall(prepared, candidate)).toBe(false);
    expect(applyAction(prepared, { type: 'wall', wall: candidate })).toBeNull();
  });

  it('awards victory to an entrant from every cardinal starting edge and freezes play', () => {
    const approaches: Record<PlayerId, Point> = { blue: p(6, 7), red: p(7, 8), amber: p(8, 7), violet: p(7, 6) };
    for (const id of Object.keys(approaches) as PlayerId[]) {
      const state = placePlayers(newGame({ mode: 'convergence', mapId: 'grand', playerCount: 4 }), approaches, id);
      const won = applyAction(state, { type: 'move', to: p(7, 7) })!;
      expect(won.winner).toBe(id);
      expect(activePlayerStates(won).find(player => player.id === id)?.position).toEqual(p(7, 7));
      expect(applyAction(won, { type: 'move', to: p(7, 8) })).toBeNull();
    }
  });

  it('does not award victory on any cell neighboring the exact center', () => {
    const state = placePlayers(newGame({ mode: 'convergence', mapId: 'grand', playerCount: 2 }), { blue: p(5, 7), red: p(14, 7) }, 'blue');
    const next = applyAction(state, { type: 'move', to: p(6, 7) })!;
    expect(next.winner).toBeNull();
    expect(pointInGoal(p(6, 7), activePlayerStates(next)[0].goal, next)).toBe(false);
  });

  it('rematches with the same Convergence map and player count but a clean state', () => {
    const state = applyAction(newGame({ mode: 'convergence', mapId: 'titan', playerCount: 3 }), { type: 'wall', wall: h(1, 1) })!;
    const rematch = rematchGame(state);
    expect(rematch.mode).toBe('convergence');
    expect(rematch.mapId).toBe('titan');
    expect(activePlayerStates(rematch)).toHaveLength(3);
    expect(rematch.walls).toEqual([]);
    expect(rematch.ply).toBe(0);
    expect(rematch.winner).toBeNull();
  });

  it('keeps every configured goal cell and final position inside the board for mobile-safe rendering', () => {
    for (const mapId of CONVERGENCE_MAP_IDS) {
      const config = MAP_CONFIGS[mapId];
      for (const playerCount of config.convergence!.supportedPlayerCounts) {
        const state = newGame({ mode: 'convergence', mapId, playerCount });
        for (const player of activePlayerStates(state)) {
          expect(player.goal.kind).toBe('cell');
          expect(player.goal.kind === 'cell' && player.goal.cell.row >= 0 && player.goal.cell.row < state.height && player.goal.cell.col >= 0 && player.goal.cell.col < state.width).toBe(true);
          expect(activePlayerStates(state).filter(other => samePoint(other.position, player.position))).toHaveLength(1);
        }
      }
    }
  });
});
