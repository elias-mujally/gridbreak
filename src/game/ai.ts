import { Action, Difficulty, GameState, Point, Wall } from './state';
import { legalMoves } from './movement';
import { legalWalls } from './walls';
import { routeLength } from './pathfinding';
import { viewForPlayer } from './view';
import { chooseRushAIDecision } from './aiRush';

type Scored<T> = { value: T; score: number };
export type AIDecision = { action: Action | null; explanation: string };
function rankedMoves(state: GameState): Scored<Point>[] {
  const center = (state.width - 1) / 2;
  return legalMoves(state, 'red').map(value => ({ value, score: -routeLength(value, state.goals.red, state.walls, state) - Math.abs(value.col - center) * .025 }))
    .sort((a, b) => b.score - a.score || a.value.col - b.value.col);
}
function rankedWalls(state: GameState): Scored<Wall>[] {
  const blueBefore = routeLength(state.pawns.blue, state.goals.blue, state.walls, state);
  const redBefore = routeLength(state.pawns.red, state.goals.red, state.walls, state);
  return legalWalls(state, 'red').map(value => {
    const walls = [...state.walls, value];
    return { value, score: (routeLength(state.pawns.blue, state.goals.blue, walls, state) - blueBefore) * 1.75 - (routeLength(state.pawns.red, state.goals.red, walls, state) - redBefore) * 1.25 };
  }).sort((a, b) => b.score - a.score || a.value.row - b.value.row || a.value.col - b.value.col);
}
export function chooseAIActionWithDebug(state: GameState, difficulty: Difficulty): AIDecision {
  if (state.turn !== 'red' || state.winner) return { action: null, explanation: 'AI cannot act.' };
  if (state.mode === 'rush') {
    const decision = chooseRushAIDecision(viewForPlayer(state, 'red'), difficulty);
    return { action: decision.action, explanation: decision.explanation };
  }
  const moves = rankedMoves(state); if (!moves.length) return { action: null, explanation: 'No legal move.' };
  if (difficulty === 'easy') {
    const chosen = moves[state.ply % 8 === 7 && moves.length > 1 ? 1 : 0];
    return { action: { type: 'move', to: chosen.value }, explanation: `Selected: MOVE\nScore: ${chosen.score.toFixed(2)}\nClassic route priority` };
  }
  const bestMove = moves[0]; const walls = rankedWalls(state); const bestWall = walls[0];
  if (bestWall && state.remaining.red > 0) {
    const blueRoute = routeLength(state.pawns.blue, state.goals.blue, state.walls, state);
    const redRoute = routeLength(state.pawns.red, state.goals.red, state.walls, state);
    const pressure = blueRoute <= redRoute ? .9 : 0;
    const conservation = difficulty === 'hard' ? Math.max(0, 2 - state.remaining.red) * .7 : .25;
    if (bestWall.score + pressure - conservation > .7) return { action: { type: 'wall', wall: bestWall.value }, explanation: `Selected: PLACE_WALL\nScore: ${bestWall.score.toFixed(2)}\nClassic defensive route delta` };
  }
  return { action: { type: 'move', to: bestMove.value }, explanation: `Selected: MOVE\nScore: ${bestMove.score.toFixed(2)}\nClassic route priority` };
}
export function chooseAIAction(state: GameState, difficulty: Difficulty): Action | null {
  return chooseAIActionWithDebug(state, difficulty).action;
}

