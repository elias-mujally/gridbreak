import { Action, GameState, otherPlayer, samePoint } from './state';
import { pointInGoal } from './modes';
import { legalMoves } from './movement';
import { isLegalWall } from './walls';
import { applyRushAction } from './rush';

export function applyAction(state: GameState, action: Action): GameState | null {
  if (state.winner) return null;
  if (state.mode === 'rush') return applyRushAction(state, action);
  const player = state.turn;
  if (action.type === 'move') {
    if (!legalMoves(state).some(point => samePoint(point, action.to))) return null;
    const winner = pointInGoal(action.to, state.goals[player], state) ? player : null;
    return {
      ...state,
      pawns: { ...state.pawns, [player]: { ...action.to } },
      turn: winner ? player : otherPlayer(player),
      winner,
      ply: state.ply + 1,
    };
  }
  if (action.type === 'wall' && isLegalWall(state, action.wall)) {
    return {
      ...state,
      walls: [...state.walls, { ...action.wall, owner: player }],
      remaining: { ...state.remaining, [player]: state.remaining[player] - 1 },
      turn: otherPlayer(player),
      ply: state.ply + 1,
    };
  }
  return null;
}

