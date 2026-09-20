import { describe, expect, it } from 'vitest';
import { applyAction } from './engine';
import { centerGoalZone, CONVERGENCE_MAP_IDS, MAP_CONFIGS, pointInGoal } from './modes';
import { legalMoves } from './movement';
import { hasRoute, routeLength, shortestPath } from './pathfinding';
import { activePlayerStates, GameState, PlayerId, Point, Wall, newGame, rematchGame, samePoint } from './state';
import { isLegalWall } from './walls';

const p = (row: number, col: number): Point => ({ row, col });
const h = (row: number, col: number): Wall => ({ row, col, orientation: 'horizontal' });

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
  it('uses a single center cell on odd boards', () => {
    expect(centerGoalZone(15, 15)).toEqual({ kind: 'cells', cells: [p(7, 7)] });
  });

  it('uses a symmetric 2x2 center on even boards', () => {
    expect(centerGoalZone(20, 20)).toEqual({ kind: 'cells', cells: [p(9, 9), p(9, 10), p(10, 9), p(10, 10)] });
  });

  it('exposes only explicitly configured Convergence maps and counts', () => {
    expect(CONVERGENCE_MAP_IDS).toEqual(['arena', 'grand', 'titan']);
    expect(MAP_CONFIGS.arena.convergence?.supportedPlayerCounts).toEqual([2]);
    expect(MAP_CONFIGS.grand.convergence?.supportedPlayerCounts).toEqual([2, 3, 4]);
    expect(MAP_CONFIGS.titan.convergence?.supportedPlayerCounts).toEqual([2, 3, 4]);
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

  it('gives all three players equal open-board routes while documenting the unused west edge', () => {
    const state = newGame({ mode: 'convergence', mapId: 'grand', playerCount: 3 });
    const players = activePlayerStates(state);
    expect(players.map(player => routeLength(player.position, player.goal, [], state))).toEqual([7, 7, 7]);
    expect(players.map(player => player.spawn)).toEqual([p(0, 7), p(7, 14), p(14, 7)]);
  });

  it('uses provisional per-map wall inventories that decrease as player count grows', () => {
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
    expect(path.length - 1).toBe(9);
    expect(pointInGoal(path.at(-1)!, player.goal, state)).toBe(true);
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

  it('rejects a final barrier that traps any one of four players', () => {
    const state = newGame({ mode: 'convergence', mapId: 'titan', playerCount: 4 });
    const nearlyClosed = Array.from({ length: 9 }, (_, index) => h(1, index * 2));
    const candidate = h(1, 18);
    const prepared = { ...state, walls: nearlyClosed };
    expect(hasRoute(activePlayerStates(prepared)[0].position, activePlayerStates(prepared)[0].goal, [...nearlyClosed, candidate], prepared)).toBe(false);
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
          expect(player.goal.kind).toBe('cells');
          expect(player.goal.cells?.every(cell => cell.row >= 0 && cell.row < state.height && cell.col >= 0 && cell.col < state.width)).toBe(true);
          expect(activePlayerStates(state).filter(other => samePoint(other.position, player.position))).toHaveLength(1);
        }
      }
    }
  });
});
