import { GameState, Player, Point, inBounds, otherPlayer, samePoint } from './state';
import { pointInGoal } from './modes';
import { canStep } from './walls';

export type MovementBoard = Pick<GameState, 'width' | 'height' | 'goals' | 'pawns' | 'walls' | 'winner' | 'turn'>;
export type AssistPath = { via: Point; to: Point };
const directions = [{ row: -1, col: 0 }, { row: 0, col: -1 }, { row: 0, col: 1 }, { row: 1, col: 0 }];

export function legalMoves(state: MovementBoard, player: Player = state.turn): Point[] {
  if (state.winner) return [];
  const dimensions = { width: state.width, height: state.height };
  const own = state.pawns[player];
  const opponent = state.pawns[otherPlayer(player)];
  const moves: Point[] = [];
  for (const direction of directions) {
    const neighbor = { row: own.row + direction.row, col: own.col + direction.col };
    if (!canStep(state.walls, own, neighbor, dimensions)) continue;
    if (!samePoint(neighbor, opponent)) { moves.push(neighbor); continue; }
    const behind = { row: opponent.row + direction.row, col: opponent.col + direction.col };
    if (canStep(state.walls, opponent, behind, dimensions)) { moves.push(behind); continue; }
    const sides = direction.row !== 0 ? [{ row: 0, col: -1 }, { row: 0, col: 1 }] : [{ row: -1, col: 0 }, { row: 1, col: 0 }];
    for (const side of sides) {
      const diagonal = { row: opponent.row + side.row, col: opponent.col + side.col };
      if (inBounds(diagonal, state.width, state.height) && canStep(state.walls, opponent, diagonal, dimensions)) moves.push(diagonal);
    }
  }
  return moves;
}

/** Assist spends one scarce inventory charge to traverse exactly two legal orthogonal edges. */
export function legalAssistPaths(state: MovementBoard, player: Player = state.turn): AssistPath[] {
  if (state.winner) return [];
  const start = state.pawns[player];
  const paths: AssistPath[] = [];
  for (const via of legalMoves(state, player)) {
    if (Math.abs(via.row - start.row) + Math.abs(via.col - start.col) !== 1 || pointInGoal(via, state.goals[player], state)) continue;
    const advanced: MovementBoard = { ...state, pawns: { ...state.pawns, [player]: via } };
    for (const to of legalMoves(advanced, player)) {
      if (Math.abs(to.row - via.row) + Math.abs(to.col - via.col) !== 1 || samePoint(to, start)) continue;
      paths.push({ via, to });
    }
  }
  return paths;
}

