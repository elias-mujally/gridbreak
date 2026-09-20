import { describe, expect, it } from 'vitest';
import { chooseAIAction } from './ai';
import { applyAction } from './engine';
import { legalMoves } from './movement';
import { hasRoute, routeLength, shortestPath } from './pathfinding';
import { GameState, Point, Wall, newGame } from './state';
import { blocksEdge, collidesWithWall, isLegalWall, legalWalls } from './walls';

const point = (row: number, col: number): Point => ({ row, col });
const horizontal = (row: number, col: number): Wall => ({ row, col, orientation: 'horizontal' });
const vertical = (row: number, col: number): Wall => ({ row, col, orientation: 'vertical' });
const setup = (changes: Partial<GameState>): GameState => ({ ...newGame(), ...changes });
const top = { kind: 'edge' as const, edge: 'top' as const };
const bottom = { kind: 'edge' as const, edge: 'bottom' as const };

describe('movement', () => {
  it('allows only neighboring orthogonal cells at the opening', () => {
    expect(legalMoves(newGame())).toEqual([point(5, 3), point(6, 2), point(6, 4)]);
  });
  it('rejects diagonal, distant, and out-of-board moves through the engine', () => {
    const state = newGame();
    expect(applyAction(state, { type: 'move', to: point(5, 4) })).toBeNull();
    expect(applyAction(state, { type: 'move', to: point(4, 3) })).toBeNull();
    expect(applyAction(state, { type: 'move', to: point(7, 3) })).toBeNull();
    expect(state).toEqual(newGame());
  });
  it('blocks movement across horizontal and vertical walls', () => {
    const h = setup({ walls: [horizontal(5, 3)] });
    expect(legalMoves(h)).not.toContainEqual(point(5, 3));
    const v = setup({ walls: [vertical(5, 3)] });
    expect(legalMoves(v)).not.toContainEqual(point(6, 4));
    expect(blocksEdge([vertical(5, 3)], point(6, 3), point(6, 4))).toBe(true);
  });
  it('jumps an adjacent player when the cell behind is open', () => {
    const state = setup({ pawns: { blue: point(3, 3), red: point(2, 3) } });
    expect(legalMoves(state)).toContainEqual(point(1, 3));
    expect(legalMoves(state)).not.toContainEqual(point(2, 3));
    expect(legalMoves(state)).not.toContainEqual(point(2, 2));
  });
  it('offers side steps when a wall blocks the jump', () => {
    const state = setup({ pawns: { blue: point(3, 3), red: point(2, 3) }, walls: [horizontal(1, 3)] });
    expect(legalMoves(state)).toContainEqual(point(2, 2));
    expect(legalMoves(state)).toContainEqual(point(2, 4));
    expect(legalMoves(state)).not.toContainEqual(point(1, 3));
  });
  it('offers side steps when the opponent is at the board edge', () => {
    const state = setup({ pawns: { blue: point(1, 3), red: point(0, 3) } });
    expect(legalMoves(state)).toContainEqual(point(0, 2));
    expect(legalMoves(state)).toContainEqual(point(0, 4));
  });
  it('does not offer a side step through a wall beside the opponent', () => {
    const state = setup({ pawns: { blue: point(3, 3), red: point(2, 3) }, walls: [horizontal(1, 3), vertical(1, 2)] });
    expect(legalMoves(state)).not.toContainEqual(point(2, 2));
    expect(legalMoves(state)).toContainEqual(point(2, 4));
  });
});

describe('walls and routes', () => {
  it('blocks both edges covered by a horizontal or vertical wall', () => {
    expect(blocksEdge([horizontal(2, 2)], point(2, 2), point(3, 2))).toBe(true);
    expect(blocksEdge([horizontal(2, 2)], point(2, 3), point(3, 3))).toBe(true);
    expect(blocksEdge([vertical(2, 2)], point(2, 2), point(2, 3))).toBe(true);
    expect(blocksEdge([vertical(2, 2)], point(3, 2), point(3, 3))).toBe(true);
  });
  it('rejects overlap, partial overlap, crossing, and invalid anchors', () => {
    const state = setup({ walls: [horizontal(2, 2)] });
    expect(collidesWithWall(state.walls, horizontal(2, 2))).toBe(true);
    expect(collidesWithWall(state.walls, horizontal(2, 3))).toBe(true);
    expect(collidesWithWall(state.walls, vertical(2, 2))).toBe(true);
    expect(isLegalWall(state, horizontal(2, 2))).toBe(false);
    expect(isLegalWall(state, horizontal(2, 3))).toBe(false);
    expect(isLegalWall(state, vertical(2, 2))).toBe(false);
    expect(isLegalWall(state, horizontal(6, 0))).toBe(false);
    expect(isLegalWall(state, vertical(0, -1))).toBe(false);
  });
  it('spends exactly one wall and alternates turns; refuses a wall at zero inventory', () => {
    const start = newGame();
    const next = applyAction(start, { type: 'wall', wall: horizontal(2, 2) });
    expect(next?.remaining.blue).toBe(6);
    expect(next?.turn).toBe('red');
    expect(start.remaining.blue).toBe(7);
    expect(applyAction(setup({ remaining: { blue: 0, red: 7 } }), { type: 'wall', wall: horizontal(2, 2) })).toBeNull();
  });
  it('never allows a placement that cuts off either player', () => {
    // Find a reachable partial wall pattern on the small board whose next legal-shape wall seals a route.
    const base: GameState = {
      mode: 'classic', mapId: 'sprint', layout: 'opposite',
      width: 4, height: 4, pawns: { blue: point(3, 0), red: point(0, 3) },
      goals: { blue: top, red: bottom },
      walls: [], remaining: { blue: 12, red: 12 }, turn: 'blue', winner: null, ply: 0,
    };
    let trap: { state: GameState; wall: Wall } | null = null;
    const visit = (state: GameState, depth: number) => {
      if (trap || depth === 0) return;
      for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
        for (const orientation of ['horizontal', 'vertical'] as const) {
          const wall = { row, col, orientation };
          if (collidesWithWall(state.walls, wall)) continue;
          const nextWalls = [...state.walls, wall];
          if (!hasRoute(state.pawns.blue, state.goals.blue, nextWalls, { width: 4, height: 4 }) || !hasRoute(state.pawns.red, state.goals.red, nextWalls, { width: 4, height: 4 })) {
            trap = { state, wall }; return;
          }
          if (isLegalWall(state, wall)) visit({ ...state, walls: nextWalls }, depth - 1);
          if (trap) return;
        }
      }
    };
    visit(base, 5);
    expect(trap).not.toBeNull();
    if (!trap) return;
    const found: { state: GameState; wall: Wall } = trap;
    expect(isLegalWall(found.state, found.wall)).toBe(false);
    expect(applyAction(found.state, { type: 'wall', wall: found.wall })).toBeNull();
  });
  it('returns only valid wall candidates', () => {
    const state = newGame();
    expect(legalWalls(state)).toHaveLength(72);
    expect(legalWalls(setup({ remaining: { blue: 0, red: 7 } }))).toHaveLength(0);
  });
});

describe('pathfinding, victory, and AI', () => {
  it('finds shortest paths and detours, or null when fully cut off', () => {
    const dimensions = { width: 3, height: 3 };
    expect(shortestPath(point(2, 0), top, [], dimensions)).toEqual([point(2, 0), point(1, 0), point(0, 0)]);
    expect(routeLength(point(2, 0), top, [horizontal(1, 0)], dimensions)).toBe(4);
    expect(shortestPath(point(2, 0), top, [horizontal(1, 0), horizontal(1, 1)], dimensions)).toBeNull();
  });
  it('detects blue and red victories and ends the game', () => {
    const blue = setup({ pawns: { blue: point(1, 3), red: point(4, 3) } });
    const blueWin = applyAction(blue, { type: 'move', to: point(0, 3) });
    expect(blueWin?.winner).toBe('blue');
    expect(blueWin && applyAction(blueWin, { type: 'move', to: point(0, 2) })).toBeNull();
    const red = setup({ pawns: { blue: point(1, 3), red: point(5, 3) }, turn: 'red' });
    expect(applyAction(red, { type: 'move', to: point(6, 3) })?.winner).toBe('red');
  });
  it('makes valid, repeatable local AI choices at every level', () => {
    const state = setup({ turn: 'red', pawns: { blue: point(4, 3), red: point(2, 3) } });
    for (const level of ['easy', 'normal', 'hard'] as const) {
      const action = chooseAIAction(state, level);
      expect(action).toEqual(chooseAIAction(state, level));
      expect(action && applyAction(state, action)).not.toBeNull();
    }
  });
  it('finishes representative complete matches without invalid actions or deadlock', () => {
    for (const level of ['easy', 'normal', 'hard'] as const) {
      let state = newGame();
      for (let turn = 0; turn < 100 && !state.winner; turn++) {
        const action = state.turn === 'red'
          ? chooseAIAction(state, level)
          : { type: 'move' as const, to: legalMoves(state).sort((a, b) =>
              routeLength(a, state.goals.blue, state.walls, state) - routeLength(b, state.goals.blue, state.walls, state))[0] };
        expect(action).not.toBeNull();
        const next = action && applyAction(state, action);
        expect(next).not.toBeNull();
        if (!next) break;
        state = next;
      }
      expect(state.winner).not.toBeNull();
    }
  });
});
