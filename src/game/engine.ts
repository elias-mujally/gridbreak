import { Action, GameState, Player, PlayerId, activePlayerStates, currentPlayerId, nextTurn, samePoint } from './state';
import { pointInGoal } from './modes';
import { legalMoves } from './movement';
import { isLegalWall } from './walls';
import { applyRushAction } from './rush';

function movePlayer(state: GameState, player: PlayerId, to: { row: number; col: number }) {
  const players = activePlayerStates(state).map(item => item.id === player ? { ...item, position: { ...to } } : item);
  const pawns = player === 'blue' || player === 'red' ? { ...state.pawns, [player]: { ...to } } : state.pawns;
  return { players, pawns };
}

function spendWall(state: GameState, player: PlayerId) {
  const players = activePlayerStates(state).map(item => item.id === player ? { ...item, wallsRemaining: item.wallsRemaining - 1 } : item);
  const remaining = player === 'blue' || player === 'red' ? { ...state.remaining, [player]: state.remaining[player as Player] - 1 } : state.remaining;
  return { players, remaining };
}

export function applyAction(state: GameState, action: Action): GameState | null {
  if (state.winner) return null;
  if (state.mode === 'rush') return applyRushAction(state, action);
  const player = currentPlayerId(state);
  const actor = activePlayerStates(state).find(item => item.id === player)!;
  if (action.type === 'move') {
    if (!legalMoves(state, player).some(point => samePoint(point, action.to))) return null;
    const winner = pointInGoal(action.to, actor.goal, state) ? player : null;
    const moved = movePlayer(state, player, action.to);
    const turn = winner ? { turn: player, currentTurnIndex: state.currentTurnIndex } : nextTurn(state);
    return { ...state, ...moved, ...turn, winner, ply: state.ply + 1 };
  }
  if (action.type === 'wall' && isLegalWall(state, action.wall, player)) {
    const spent = spendWall(state, player);
    return {
      ...state, ...spent, ...nextTurn(state),
      walls: [...state.walls, { ...action.wall, owner: player }],
      ply: state.ply + 1,
    };
  }
  return null;
}

