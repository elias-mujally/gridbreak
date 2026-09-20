import { GameState, PLAYERS, Point, Wall, inBounds } from './state';
import { hasRoute } from './pathfinding';
import type { BoardDimensions } from './modes';

export const wallKey = (wall: Wall): string => `${wall.orientation}:${wall.row}:${wall.col}`;
export function isWallAnchorInBounds(wall: Wall, dimensions: BoardDimensions): boolean {
  return Number.isInteger(wall.row) && Number.isInteger(wall.col) && wall.row >= 0 && wall.col >= 0 &&
    wall.row < dimensions.height - 1 && wall.col < dimensions.width - 1 && (wall.orientation === 'horizontal' || wall.orientation === 'vertical');
}
export function blocksEdge(walls: readonly Wall[], a: Point, b: Point): boolean {
  if (Math.abs(a.row - b.row) + Math.abs(a.col - b.col) !== 1) return true;
  if (a.row !== b.row) {
    const row = Math.min(a.row, b.row);
    return walls.some(w => w.orientation === 'horizontal' && w.row === row && (w.col === a.col || w.col + 1 === a.col));
  }
  const col = Math.min(a.col, b.col);
  return walls.some(w => w.orientation === 'vertical' && w.col === col && (w.row === a.row || w.row + 1 === a.row));
}
export function canStep(walls: readonly Wall[], from: Point, to: Point, dimensions: BoardDimensions): boolean {
  return inBounds(from, dimensions.width, dimensions.height) && inBounds(to, dimensions.width, dimensions.height) && !blocksEdge(walls, from, to);
}
export function collidesWithWall(walls: readonly Wall[], candidate: Wall): boolean {
  return walls.some(existing => {
    if (existing.orientation !== candidate.orientation) return existing.row === candidate.row && existing.col === candidate.col;
    if (existing.orientation === 'horizontal') return existing.row === candidate.row && Math.abs(existing.col - candidate.col) <= 1;
    return existing.col === candidate.col && Math.abs(existing.row - candidate.row) <= 1;
  });
}
export function placementGeometry(state: GameState): Wall[] { return state.mode === 'rush' && state.rush ? [...state.walls, ...state.rush.phantoms] : state.walls; }
export function isLegalWall(state: GameState, wall: Wall, player = state.turn): boolean {
  const dimensions = { width: state.width, height: state.height };
  if (state.winner || state.remaining[player] <= 0 || !isWallAnchorInBounds(wall, dimensions) || collidesWithWall(placementGeometry(state), wall)) return false;
  const nextWalls = [...placementGeometry(state), wall];
  return PLAYERS.every(id => hasRoute(state.pawns[id], state.goals[id], nextWalls, dimensions));
}
export function isLegalPhantomWall(state: GameState, wall: Wall, player = state.turn): boolean {
  return state.mode === 'rush' && !!state.rush?.phantomAvailable[player] && isLegalWall(state, wall, player);
}
export function legalWalls(state: GameState, player = state.turn): Wall[] {
  if (state.winner || state.remaining[player] <= 0) return [];
  const result: Wall[] = [];
  for (let row = 0; row < state.height - 1; row++) for (let col = 0; col < state.width - 1; col++) {
    for (const orientation of ['horizontal', 'vertical'] as const) {
      const wall = { row, col, orientation };
      if (isLegalWall(state, wall, player)) result.push(wall);
    }
  }
  return result;
}

