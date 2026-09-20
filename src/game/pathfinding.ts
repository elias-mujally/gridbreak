import type { BoardDimensions, GoalZone } from './modes';
import { pointInGoal } from './modes';
import type { Point, Wall } from './state';
import { canStep } from './walls';

const directions = [{ row: -1, col: 0 }, { row: 0, col: -1 }, { row: 0, col: 1 }, { row: 1, col: 0 }];
const key = (point: Point) => `${point.row},${point.col}`;

function search(start: Point, isGoal: (point: Point) => boolean, walls: readonly Wall[], dimensions: BoardDimensions): Point[] | null {
  const queue: Point[] = [start];
  const parents = new Map<string, Point | null>([[key(start), null]]);
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (isGoal(current)) {
      const path: Point[] = [];
      let point: Point | null = current;
      while (point) { path.push(point); point = parents.get(key(point)) ?? null; }
      return path.reverse();
    }
    for (const direction of directions) {
      const next = { row: current.row + direction.row, col: current.col + direction.col };
      if (!parents.has(key(next)) && canStep(walls, current, next, dimensions)) {
        parents.set(key(next), current); queue.push(next);
      }
    }
  }
  return null;
}

export function shortestPath(start: Point, goal: GoalZone, walls: readonly Wall[], dimensions: BoardDimensions): Point[] | null {
  return search(start, point => pointInGoal(point, goal, dimensions), walls, dimensions);
}
export function shortestPathToPoint(start: Point, target: Point, walls: readonly Wall[], dimensions: BoardDimensions): Point[] | null {
  return search(start, point => point.row === target.row && point.col === target.col, walls, dimensions);
}
export const hasRoute = (start: Point, goal: GoalZone, walls: readonly Wall[], dimensions: BoardDimensions): boolean => shortestPath(start, goal, walls, dimensions) !== null;
export function routeLength(start: Point, goal: GoalZone, walls: readonly Wall[], dimensions: BoardDimensions): number {
  const path = shortestPath(start, goal, walls, dimensions);
  return path ? path.length - 1 : Infinity;
}
export function pointDistance(start: Point, target: Point, walls: readonly Wall[], dimensions: BoardDimensions): number {
  const path = shortestPathToPoint(start, target, walls, dimensions);
  return path ? path.length - 1 : Infinity;
}

