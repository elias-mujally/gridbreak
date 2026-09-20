import { Action, Difficulty, GameState, Player, PlayerId, Point, Wall, currentPlayerId } from './state';
import { legalMoves } from './movement';
import { legalWalls } from './walls';
import { routeLength } from './pathfinding';
import { viewForPlayer } from './view';
import { chooseRushAIDecision } from './aiRush';
import { chooseConvergenceAIDecision } from './aiConvergence';

type Scored<T> = { value: T; score: number };
export type AIDecision = { action: Action | null; explanation: string };
function rankedMoves(state: GameState, actor: Player): Scored<Point>[] {
  const center = (state.width - 1) / 2;
  return legalMoves(state, actor).map(value => ({ value, score: -routeLength(value, state.goals[actor], state.walls, state) - Math.abs(value.col - center) * .025 }))
    .sort((a, b) => b.score - a.score || a.value.col - b.value.col);
}
function rankedWalls(state: GameState, actor: Player): Scored<Wall>[] {
  const opponent: Player = actor === 'blue' ? 'red' : 'blue';
  const opponentBefore = routeLength(state.pawns[opponent], state.goals[opponent], state.walls, state);
  const actorBefore = routeLength(state.pawns[actor], state.goals[actor], state.walls, state);
  return legalWalls(state, actor).map(value => {
    const walls = [...state.walls, value];
    return { value, score: (routeLength(state.pawns[opponent], state.goals[opponent], walls, state) - opponentBefore) * 1.75 - (routeLength(state.pawns[actor], state.goals[actor], walls, state) - actorBefore) * 1.25 };
  }).sort((a, b) => b.score - a.score || a.value.row - b.value.row || a.value.col - b.value.col);
}
export function chooseAIActionWithDebug(state: GameState, difficulty: Difficulty, actorId: PlayerId = currentPlayerId(state)): AIDecision {
  if (state.winner || currentPlayerId(state) !== actorId) return { action: null, explanation: 'AI cannot act.' };
  if (state.mode === 'convergence') return chooseConvergenceAIDecision(state, difficulty, actorId);
  if (actorId !== 'blue' && actorId !== 'red') return { action: null, explanation: 'AI cannot act.' };
  if (state.mode === 'rush') {
    if (actorId !== 'red') return { action: null, explanation: 'Rush AI is configured for the private rival view.' };
    const decision = chooseRushAIDecision(viewForPlayer(state, actorId), difficulty);
    return { action: decision.action, explanation: decision.explanation };
  }
  const moves = rankedMoves(state, actorId); if (!moves.length) return { action: null, explanation: 'No legal move.' };
  if (difficulty === 'easy') {
    const chosen = moves[state.ply % 8 === 7 && moves.length > 1 ? 1 : 0];
    return { action: { type: 'move', to: chosen.value }, explanation: `Selected: MOVE\nScore: ${chosen.score.toFixed(2)}\nClassic route priority` };
  }
  const opponent: Player = actorId === 'blue' ? 'red' : 'blue';
  const bestMove = moves[0]; const walls = rankedWalls(state, actorId); const bestWall = walls[0];
  if (bestWall && state.remaining[actorId] > 0) {
    const opponentRoute = routeLength(state.pawns[opponent], state.goals[opponent], state.walls, state);
    const actorRoute = routeLength(state.pawns[actorId], state.goals[actorId], state.walls, state);
    const pressure = opponentRoute <= actorRoute ? .9 : 0;
    const conservation = difficulty === 'hard' ? Math.max(0, 2 - state.remaining[actorId]) * .7 : .25;
    if (bestWall.score + pressure - conservation > .7) return { action: { type: 'wall', wall: bestWall.value }, explanation: `Selected: PLACE_WALL\nScore: ${bestWall.score.toFixed(2)}\nClassic defensive route delta` };
  }
  return { action: { type: 'move', to: bestMove.value }, explanation: `Selected: MOVE\nScore: ${bestMove.score.toFixed(2)}\nClassic route priority` };
}
export function chooseAIAction(state: GameState, difficulty: Difficulty, actorId?: PlayerId): Action | null {
  return chooseAIActionWithDebug(state, difficulty, actorId).action;
}
