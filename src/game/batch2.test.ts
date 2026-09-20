import { describe, expect, it } from 'vitest';
import { chooseAIAction, chooseAIActionWithDebug } from './ai';
import { chooseRushAIDecision } from './aiRush';
import { applyAction } from './engine';
import { legalAssistPaths, legalMoves } from './movement';
import { MAP_CONFIGS, MAP_IDS, MapId, compatibleLayouts, pointInGoal } from './modes';
import { hasRoute, routeLength, shortestPath } from './pathfinding';
import { GameState, Point, Wall, newGame } from './state';
import { isLegalWall } from './walls';
import { viewForPlayer } from './view';
import { generateTiles } from './tiles';

const p = (row: number, col: number): Point => ({ row, col });
const h = (row: number, col: number, owner?: 'blue' | 'red'): Wall => ({ row, col, orientation: 'horizontal', ...(owner ? { owner } : {}) });

function advanceBlue(state: GameState) {
  const view = viewForPlayer(state, 'blue');
  const move = legalMoves({ ...view, walls: view.pathWalls }, 'blue')
    .sort((a, b) => routeLength(a, view.goals.blue, view.pathWalls, view) - routeLength(b, view.goals.blue, view.pathWalls, view))[0];
  return move ? { type: 'move' as const, to: move } : null;
}

function simulateParallel(mapId: 'wide' | 'gauntlet', difficulty: 'easy' | 'normal' | 'hard') {
  const map = MAP_CONFIGS[mapId];
  let state = newGame({ mode: 'rush', mapId, layout: 'parallel', seed: 924, seedLocked: true });
  while (!state.winner && state.ply < map.deadlinePly) {
    const action = state.turn === 'red' ? chooseAIAction(state, difficulty) : advanceBlue(state);
    expect(action).not.toBeNull();
    const next = action ? applyAction(state, action) : null;
    expect(next).not.toBeNull();
    if (!next) break;
    state = next;
  }
  return state;
}

describe('mode and map independence', () => {
  it.each(MAP_IDS)('runs Classic on %s without Rush resources', mapId => {
    const state = newGame({ mode: 'classic', mapId });
    expect(state.mapId).toBe(mapId);
    expect([state.width, state.height]).toEqual([MAP_CONFIGS[mapId].width, MAP_CONFIGS[mapId].height]);
    expect(state.rush).toBeUndefined();
    expect(state.remaining.blue).toBe(MAP_CONFIGS[mapId].startingWalls);
  });

  it.each(MAP_IDS)('runs Rush on %s from the same geometry', mapId => {
    const classic = newGame({ mode: 'classic', mapId });
    const rush = newGame({ mode: 'rush', mapId, seed: 11 });
    expect(rush.pawns).toEqual(classic.pawns);
    expect(rush.goals).toEqual(classic.goals);
    expect([rush.width, rush.height]).toEqual([classic.width, classic.height]);
    expect(rush.rush).toBeDefined();
  });

  it('exposes Parallel only on compatible rectangular maps', () => {
    expect(compatibleLayouts(MAP_CONFIGS.wide)).toEqual(['opposite', 'parallel']);
    expect(compatibleLayouts(MAP_CONFIGS.gauntlet)).toEqual(['opposite', 'parallel']);
    for (const id of ['sprint', 'arena', 'grand', 'titan'] as MapId[]) expect(compatibleLayouts(MAP_CONFIGS[id])).toEqual(['opposite']);
  });
});

describe('explicit spawn and goal zones', () => {
  it('retains Opposite as the default layout', () => {
    const state = newGame({ mode: 'classic', mapId: 'arena' });
    expect(state.layout).toBe('opposite');
    expect(state.goals.blue.edge).toBe('top');
    expect(state.goals.red.edge).toBe('bottom');
  });

  it('creates a fair horizontal Parallel race on Wide', () => {
    const state = newGame({ mode: 'classic', mapId: 'wide', layout: 'parallel' });
    expect(state.goals.blue.edge).toBe('left');
    expect(state.goals.red.edge).toBe('left');
    expect(state.pawns.blue.col).toBe(11);
    expect(state.pawns.red.col).toBe(11);
    expect(state.pawns.blue.row + state.pawns.red.row).toBe(6);
    expect(routeLength(state.pawns.blue, state.goals.blue, [], state)).toBe(routeLength(state.pawns.red, state.goals.red, [], state));
  });

  it('creates a fair vertical Parallel race on Gauntlet', () => {
    const state = newGame({ mode: 'classic', mapId: 'gauntlet', layout: 'parallel' });
    expect(state.goals.blue.edge).toBe('top');
    expect(state.goals.red.edge).toBe('top');
    expect(state.pawns.blue.row).toBe(17);
    expect(state.pawns.red.row).toBe(17);
    expect(state.pawns.blue.col + state.pawns.red.col).toBe(9);
    expect(Math.abs(state.pawns.blue.col - state.pawns.red.col)).toBeGreaterThan(1);
    expect(routeLength(state.pawns.blue, state.goals.blue, [], state)).toBe(routeLength(state.pawns.red, state.goals.red, [], state));
  });

  it('mirrors Parallel rewards across the fair cross-axis', () => {
    const wide = generateTiles(51, MAP_CONFIGS.wide, 'parallel');
    for (const tile of wide) expect(wide.some(other => other.kind === tile.kind && other.point.row === 6 - tile.point.row && other.point.col === tile.point.col)).toBe(true);
    const gauntlet = generateTiles(51, MAP_CONFIGS.gauntlet, 'parallel');
    for (const tile of gauntlet) expect(gauntlet.some(other => other.kind === tile.kind && other.point.row === tile.point.row && other.point.col === 9 - tile.point.col)).toBe(true);
  });

  it('BFS follows each configured goal instead of player color', () => {
    const wide = newGame({ mode: 'classic', mapId: 'wide', layout: 'parallel' });
    const path = shortestPath(wide.pawns.red, wide.goals.red, [], wide)!;
    expect(path).toHaveLength(12);
    expect(path.at(-1)?.col).toBe(0);
    expect(path.at(-1)?.row).toBe(wide.pawns.red.row);
  });

  it('detects victories for two players sharing the same destination edge', () => {
    const base = newGame({ mode: 'classic', mapId: 'wide', layout: 'parallel' });
    const blue = { ...base, pawns: { blue: p(4, 1), red: p(2, 8) } };
    expect(applyAction(blue, { type: 'move', to: p(4, 0) })?.winner).toBe('blue');
    const red = { ...base, turn: 'red' as const, pawns: { blue: p(4, 8), red: p(2, 1) } };
    expect(applyAction(red, { type: 'move', to: p(2, 0) })?.winner).toBe('red');
  });
});

describe('Parallel rules', () => {
  it('preserves both configured routes after legal walls', () => {
    for (const mapId of ['wide', 'gauntlet'] as const) {
      const state = newGame({ mode: 'classic', mapId, layout: 'parallel' });
      const wall = mapId === 'wide' ? h(1, 8) : h(15, 2);
      expect(isLegalWall(state, wall)).toBe(true);
      const next = applyAction(state, { type: 'wall', wall })!;
      expect(hasRoute(next.pawns.blue, next.goals.blue, next.walls, next)).toBe(true);
      expect(hasRoute(next.pawns.red, next.goals.red, next.walls, next)).toBe(true);
    }
  });

  it('keeps collision jumps goal-agnostic in Parallel', () => {
    const base = newGame({ mode: 'classic', mapId: 'wide', layout: 'parallel' });
    const state = { ...base, pawns: { blue: p(3, 6), red: p(3, 5) } };
    expect(legalMoves(state, 'blue')).toContainEqual(p(3, 4));
  });

  it('allows validated Assist paths in Parallel', () => {
    const state = newGame({ mode: 'rush', mapId: 'wide', layout: 'parallel', seed: 12 });
    const paths = legalAssistPaths(state, 'blue');
    expect(paths.length).toBeGreaterThan(0);
    const towardGoal = paths.find(path => path.to.col === state.pawns.blue.col - 2)!;
    const next = applyAction(state, { type: 'assist', ...towardGoal })!;
    expect(next.rush?.assists.blue).toBe(0);
    expect(next.pawns.blue.col).toBe(state.pawns.blue.col - 2);
  });

  it('completes horizontal and vertical Parallel Rush matches', () => {
    expect(simulateParallel('wide', 'normal').winner).not.toBeNull();
    expect(simulateParallel('gauntlet', 'normal').winner).not.toBeNull();
  });
});

describe('Rush tactical AI', () => {
  it('chooses a disruptive wall when the human is one move from victory', () => {
    const base = newGame({ mode: 'rush', mapId: 'sprint', seed: 3 });
    const state = { ...base, turn: 'red' as const, pawns: { blue: p(1, 3), red: p(1, 5) }, rush: { ...base.rush!, tiles: [] } };
    const decision = chooseRushAIDecision(viewForPlayer(state, 'red'), 'hard');
    expect(decision.action?.type).toBe('wall');
    expect(decision.ranked[0].opponentDelta).toBeGreaterThan(0);
    expect(applyAction(state, decision.action!)).not.toBeNull();
  });

  it('pursues a nearby visible Assist reward when the detour is worthwhile', () => {
    const base = newGame({ mode: 'rush', mapId: 'sprint', seed: 3 });
    const state = { ...base, turn: 'red' as const, pawns: { blue: p(5, 0), red: p(2, 3) }, remaining: { blue: 0, red: 0 }, rush: { ...base.rush!, assists: { blue: 1, red: 0 }, tiles: [{ kind: 'boost' as const, point: p(2, 4), consumed: false }] } };
    expect(chooseAIAction(state, 'hard')).toEqual({ type: 'move', to: p(2, 4) });
  });

  it('ignores an Energy detour when already at the cap', () => {
    const base = newGame({ mode: 'rush', mapId: 'sprint', seed: 3 });
    const state = { ...base, turn: 'red' as const, pawns: { blue: p(5, 0), red: p(2, 3) }, remaining: { blue: 0, red: 0 }, rush: { ...base.rush!, energy: { blue: 1, red: 5 }, tiles: [{ kind: 'energy' as const, point: p(2, 4), consumed: false }] } };
    expect(chooseAIAction(state, 'hard')).not.toEqual({ type: 'move', to: p(2, 4) });
  });

  it('uses Assist to secure a decisive finish', () => {
    const base = newGame({ mode: 'rush', mapId: 'sprint', seed: 3 });
    const state = { ...base, turn: 'red' as const, pawns: { blue: p(4, 0), red: p(4, 3) }, remaining: { blue: 0, red: 0 }, rush: { ...base.rush!, tiles: [] } };
    expect(chooseAIAction(state, 'hard')?.type).toBe('assist');
  });

  it('uses Break when an enemy wall causes material route damage', () => {
    const base = newGame({ mode: 'rush', mapId: 'sprint', seed: 3 });
    const wall = h(2, 2, 'blue');
    const state = { ...base, turn: 'red' as const, pawns: { blue: p(5, 0), red: p(2, 3) }, walls: [wall], remaining: { blue: 0, red: 0 }, rush: { ...base.rush!, energy: { blue: 1, red: 5 }, tiles: [] } };
    expect(chooseAIAction(state, 'hard')).toEqual({ type: 'break', wall });
  });

  it('generates tactical Phantom candidates without exposing their identity', () => {
    const base = newGame({ mode: 'rush', mapId: 'sprint', seed: 3 });
    const state = { ...base, turn: 'red' as const, pawns: { blue: p(2, 3), red: p(1, 3) }, rush: { ...base.rush!, tiles: [] } };
    const decision = chooseRushAIDecision(viewForPlayer(state, 'red'), 'hard');
    expect(decision.ranked.some(candidate => candidate.category === 'phantom' && candidate.opponentDelta > 0)).toBe(true);
  });

  it('selects Phantom when a real barrier would damage its own route', () => {
    const base = newGame({ mode: 'rush', mapId: 'sprint', seed: 3 });
    let found = false;
    for (let blueRow = 1; blueRow <= 5 && !found; blueRow++) for (let redRow = 1; redRow <= 5 && !found; redRow++) {
      if (blueRow === redRow) continue;
      for (const redCol of [2, 3, 4]) {
        if (blueRow === redRow && redCol === 3) continue;
        const state = { ...base, turn: 'red' as const, ply: 6, pawns: { blue: p(blueRow, 3), red: p(redRow, redCol) }, rush: { ...base.rush!, assists: { blue: 0, red: 0 }, tiles: [] } };
        const action = chooseAIAction(state, 'hard');
        if (action?.type === 'phantom') { found = true; expect(applyAction(state, action)).not.toBeNull(); break; }
      }
    }
    expect(found).toBe(true);
  });

  it('produces a debug explanation with route effects', () => {
    const state = { ...newGame({ mode: 'rush', mapId: 'sprint', seed: 9 }), turn: 'red' as const };
    const decision = chooseAIActionWithDebug(state, 'hard');
    expect(decision.explanation).toMatch(/Selected:/);
    expect(decision.explanation).toMatch(/Own route:/);
    expect(decision.explanation).toMatch(/Opponent route:/);
  });

  it('never distinguishes an enemy real wall from the same visible Phantom', () => {
    const base = newGame({ mode: 'rush', mapId: 'wide', layout: 'parallel', seed: 7 });
    const wall = { ...h(3, 8), owner: 'blue' as const };
    const real = { ...base, turn: 'red' as const, walls: [wall] };
    const phantom = { ...base, turn: 'red' as const, rush: { ...base.rush!, phantoms: [wall], phantomAvailable: { blue: false, red: true } } };
    expect(viewForPlayer(real, 'red').walls).toEqual(viewForPlayer(phantom, 'red').walls);
    expect(chooseRushAIDecision(viewForPlayer(real, 'red'), 'hard').action)
      .toEqual(chooseRushAIDecision(viewForPlayer(phantom, 'red'), 'hard').action);
  });

  it('returns a legal Hard action on Titan within the local performance budget', () => {
    const state = { ...newGame({ mode: 'rush', mapId: 'titan', seed: 31 }), turn: 'red' as const };
    const started = performance.now();
    const action = chooseAIAction(state, 'hard');
    const elapsed = performance.now() - started;
    expect(action).not.toBeNull();
    expect(action && applyAction(state, action)).not.toBeNull();
    expect(elapsed).toBeLessThan(1500);
  });
});

describe('configuration serialization', () => {
  it('serializes map, layout, spawns, and goals without functions', () => {
    const state = newGame({ mode: 'rush', mapId: 'gauntlet', layout: 'parallel', seed: 41, seedLocked: true });
    const copy = JSON.parse(JSON.stringify(state)) as GameState;
    expect(copy.mapId).toBe('gauntlet');
    expect(copy.layout).toBe('parallel');
    expect(copy.goals).toEqual(state.goals);
    expect(pointInGoal(p(0, 2), copy.goals.blue, copy)).toBe(true);
  });
});
