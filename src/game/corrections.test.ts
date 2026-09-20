import { describe, expect, it } from 'vitest';
import { chooseAIAction } from './ai';
import { applyAction } from './engine';
import { legalMoves } from './movement';
import { MAP_CONFIGS, RUSH_MAP_IDS, RushMapId } from './modes';
import { hasRoute, routeLength, shortestPath } from './pathfinding';
import { GameState, Point, Wall, newGame, rematchGame } from './state';
import { isLegalWall, isWallAnchorInBounds } from './walls';
import { viewForPlayer } from './view';

const p = (row: number, col: number): Point => ({ row, col });
const h = (row: number, col: number): Wall => ({ row, col, orientation: 'horizontal' });

function advanceBlue(state: GameState) {
  const view = viewForPlayer(state, 'blue');
  const dimensions = { width: state.width, height: state.height };
  const moves = legalMoves({ ...view, walls: view.pathWalls }, 'blue').sort((a, b) =>
    routeLength(a, view.goals.blue, view.pathWalls, dimensions) - routeLength(b, view.goals.blue, view.pathWalls, dimensions));
  return moves[0] ? { type: 'move' as const, to: moves[0] } : null;
}

function simulate(mapId: RushMapId, difficulty: 'easy' | 'normal' | 'hard' = 'easy') {
  const config = MAP_CONFIGS[mapId];
  let state = newGame({ mode: 'rush', mapId, seed: 481, seedLocked: true });
  while (!state.winner && state.ply < config.deadlinePly) {
    const action = state.turn === 'red' ? chooseAIAction(state, difficulty) : advanceBlue(state);
    expect(action).not.toBeNull();
    const next = action ? applyAction(state, action) : null;
    expect(next).not.toBeNull();
    if (!next) break;
    state = next;
  }
  return state;
}

describe('MapConfig dimensions and starts', () => {
  it('creates every configured Rush map with its own walls, clocks, and dimensions', () => {
    for (const id of RUSH_MAP_IDS) {
      const config = MAP_CONFIGS[id];
      const state = newGame({ mode: 'rush', mapId: id, seed: 1 });
      expect([state.width, state.height]).toEqual([config.width, config.height]);
      expect(state.remaining).toEqual({ blue: config.startingWalls, red: config.startingWalls });
      expect(state.pawns.blue.row).toBe(config.height - 1);
      expect(state.pawns.red.row).toBe(0);
      expect(state.pawns.blue.col).toBe(Math.floor(config.width / 2));
    }
  });

  it('keeps the 12×7 landscape goals on top and bottom', () => {
    const state = newGame({ mode: 'rush', mapId: 'wide', seed: 2 });
    expect(state.width).toBe(12); expect(state.height).toBe(7);
    expect(shortestPath(state.pawns.blue, state.goals.blue, [], { width: 12, height: 7 })?.length).toBe(7);
  });

  it('keeps the 10×18 portrait goals on top and bottom', () => {
    const state = newGame({ mode: 'rush', mapId: 'gauntlet', seed: 2 });
    expect(state.width).toBe(10); expect(state.height).toBe(18);
    expect(shortestPath(state.pawns.red, state.goals.red, [], { width: 10, height: 18 })?.length).toBe(18);
  });
});

describe('rectangular pathfinding, walls, and victory', () => {
  it('BFS detours correctly on 12×7', () => {
    const dimensions = { width: 12, height: 7 };
    const start = p(6, 6);
    expect(routeLength(start, { kind: 'edge', edge: 'top' }, [], dimensions)).toBe(6);
    expect(routeLength(start, { kind: 'edge', edge: 'top' }, [h(5, 5)], dimensions)).toBe(7);
    expect(hasRoute(start, { kind: 'edge', edge: 'top' }, [h(5, 5)], dimensions)).toBe(true);
  });

  it('BFS detours correctly on 10×18', () => {
    const dimensions = { width: 10, height: 18 };
    const start = p(17, 5);
    expect(routeLength(start, { kind: 'edge', edge: 'top' }, [], dimensions)).toBe(17);
    expect(routeLength(start, { kind: 'edge', edge: 'top' }, [h(16, 4)], dimensions)).toBe(18);
  });

  it('validates rectangular wall anchors against width and height independently', () => {
    const dimensions = { width: 10, height: 18 };
    expect(isWallAnchorInBounds(h(16, 8), dimensions)).toBe(true);
    expect(isWallAnchorInBounds(h(17, 8), dimensions)).toBe(false);
    expect(isWallAnchorInBounds(h(16, 9), dimensions)).toBe(false);
    const state = newGame({ mode: 'rush', mapId: 'gauntlet', seed: 3 });
    expect(isLegalWall(state, h(16, 8))).toBe(true);
  });

  it('detects both goal edges on landscape and portrait boards', () => {
    for (const mapId of ['wide', 'gauntlet'] as const) {
      const base = newGame({ mode: 'rush', mapId, seed: 4 });
      const blue = { ...base, pawns: { blue: p(1, 1), red: p(base.height - 2, base.width - 2) }, rush: { ...base.rush!, tiles: [] } };
      expect(applyAction(blue, { type: 'move', to: p(0, 1) })?.winner).toBe('blue');
      const red = { ...base, turn: 'red' as const, pawns: { blue: p(1, 1), red: p(base.height - 2, base.width - 2) }, rush: { ...base.rush!, tiles: [] } };
      expect(applyAction(red, { type: 'move', to: p(base.height - 1, base.width - 2) })?.winner).toBe('red');
    }
  });
});

describe('fresh seeds and rematches', () => {
  it('automatically generates a fresh seed for normal new games', () => {
    const seeds = Array.from({ length: 5 }, () => newGame({ mode: 'rush' }).rush!.seed);
    expect(new Set(seeds).size).toBe(5);
  });

  it('gives unlocked rematches a new seed while preserving map', () => {
    const state = newGame({ mode: 'rush', mapId: 'wide', seed: 88 });
    const rematch = rematchGame(state);
    expect(rematch.mapId).toBe('wide');
    expect(rematch.rush?.seed).not.toBe(88);
  });

  it('preserves a deliberately locked seed during rematch', () => {
    const state = newGame({ mode: 'rush', mapId: 'arena', seed: 88, seedLocked: true });
    const rematch = rematchGame(state);
    expect(rematch.rush?.seed).toBe(88);
    expect(rematch.rush?.tiles).toEqual(state.rush?.tiles);
  });
});

describe('AI simulations across map sizes', () => {
  it.each(['sprint', 'arena', 'wide', 'gauntlet', 'grand'] as RushMapId[])('completes a valid %s match', mapId => {
    const final = simulate(mapId);
    expect(final.winner).not.toBeNull();
    expect(final.ply).toBeLessThanOrEqual(MAP_CONFIGS[mapId].deadlinePly);
  });

  it('keeps a complete 20×20 Titan simulation playable', () => {
    const final = simulate('titan');
    expect(final.winner).not.toBeNull();
    expect(final.width * final.height).toBe(400);
    expect(final.ply).toBeLessThanOrEqual(MAP_CONFIGS.titan.deadlinePly);
  });

  it('Normal and Hard choose valid actions on rectangular maps', () => {
    for (const mapId of ['wide', 'gauntlet'] as const) for (const difficulty of ['normal', 'hard'] as const) {
      const state = { ...newGame({ mode: 'rush', mapId, seed: 12 }), turn: 'red' as const };
      const action = chooseAIAction(state, difficulty);
      expect(action).not.toBeNull();
      expect(action && applyAction(state, action)).not.toBeNull();
    }
  });
});
