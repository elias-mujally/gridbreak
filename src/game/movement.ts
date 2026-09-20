import { GameState, PlayerId, Point, activePlayerStates, currentPlayerId, inBounds, samePoint } from './state';
import { pointInGoal } from './modes';
import { canStep } from './walls';

export type MovementBoard = Pick<GameState, 'mode' | 'width' | 'height' | 'goals' | 'pawns' | 'players' | 'turnOrder' | 'currentTurnIndex' | 'walls' | 'winner' | 'turn'>;
export type AssistPath = { via: Point; to: Point };
const directions = [{ row: -1, col: 0 }, { row: 0, col: -1 }, { row: 0, col: 1 }, { row: 1, col: 0 }];
const pointKey = (point: Point) => `${point.row},${point.col}`;

function movementPlayers(state: MovementBoard) {
  return activePlayerStates(state as GameState);
}

/**
 * Multi-pawn collision rule: jump one adjacent pawn when the cell directly behind it is open.
 * If that landing is blocked by a wall, board edge, or another pawn, use either open side-step
 * around the first pawn. Chained jumps across two pawns are deliberately not allowed.
 */
export function legalMoves(state: MovementBoard, player: PlayerId = currentPlayerId(state as GameState)): Point[] {
  if (state.winner) return [];
  const dimensions = { width: state.width, height: state.height };
  const players = movementPlayers(state);
  const own = players.find(item => item.id === player)?.position;
  if (!own) return [];
  const occupied = new Map(players.filter(item => item.id !== player).map(item => [pointKey(item.position), item.position]));
  const moves = new Map<string, Point>();
  for (const direction of directions) {
    const neighbor = { row: own.row + direction.row, col: own.col + direction.col };
    if (!canStep(state.walls, own, neighbor, dimensions)) continue;
    const blockingPawn = occupied.get(pointKey(neighbor));
    if (!blockingPawn) { moves.set(pointKey(neighbor), neighbor); continue; }
    const behind = { row: blockingPawn.row + direction.row, col: blockingPawn.col + direction.col };
    if (canStep(state.walls, blockingPawn, behind, dimensions) && !occupied.has(pointKey(behind)) && !samePoint(behind, own)) {
      moves.set(pointKey(behind), behind);
      continue;
    }
    const sides = direction.row !== 0 ? [{ row: 0, col: -1 }, { row: 0, col: 1 }] : [{ row: -1, col: 0 }, { row: 1, col: 0 }];
    for (const side of sides) {
      const diagonal = { row: blockingPawn.row + side.row, col: blockingPawn.col + side.col };
      if (inBounds(diagonal, state.width, state.height) && !occupied.has(pointKey(diagonal)) &&
          !samePoint(diagonal, own) && canStep(state.walls, blockingPawn, diagonal, dimensions)) moves.set(pointKey(diagonal), diagonal);
    }
  }
  return [...moves.values()];
}

/** Assist spends one scarce inventory charge to traverse exactly two legal orthogonal edges. */
export function legalAssistPaths(state: MovementBoard, player: PlayerId = currentPlayerId(state as GameState)): AssistPath[] {
  if (state.winner || state.mode !== 'rush' || (player !== 'blue' && player !== 'red')) return [];
  const players = movementPlayers(state);
  const start = players.find(item => item.id === player)?.position;
  const goal = players.find(item => item.id === player)?.goal;
  if (!start || !goal) return [];
  const paths: AssistPath[] = [];
  for (const via of legalMoves(state, player)) {
    if (Math.abs(via.row - start.row) + Math.abs(via.col - start.col) !== 1 || pointInGoal(via, goal, state)) continue;
    const advancedPlayers = players.map(item => item.id === player ? { ...item, position: via } : item);
    const advanced: MovementBoard = { ...state, players: advancedPlayers, pawns: { ...state.pawns, [player]: via } };
    for (const to of legalMoves(advanced, player)) {
      if (Math.abs(to.row - via.row) + Math.abs(to.col - via.col) !== 1 || samePoint(to, start)) continue;
      paths.push({ via, to });
    }
  }
  return paths;
}

