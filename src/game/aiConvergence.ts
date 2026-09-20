import { legalMoves } from './movement';
import { routeLength, shortestPath } from './pathfinding';
import { activePlayerStates, currentPlayerId, type Action, type Difficulty, type GameState, type PlayerId, type Point, type Wall } from './state';
import { isLegalWall, wallKey } from './walls';

export type ConvergenceAIDecision = { action: Action | null; explanation: string };
type Candidate = { wall: Wall; score: number; threatGain: number; selfCost: number };

function wallsBlockingEdge(a: Point, b: Point): Wall[] {
  if (a.row !== b.row) {
    const row = Math.min(a.row, b.row);
    return [{ row, col: a.col - 1, orientation: 'horizontal' }, { row, col: a.col, orientation: 'horizontal' }];
  }
  const col = Math.min(a.col, b.col);
  return [{ row: a.row - 1, col, orientation: 'vertical' }, { row: a.row, col, orientation: 'vertical' }];
}

function candidateWalls(state: GameState, actorId: PlayerId): Wall[] {
  const candidates = new Map<string, Wall>();
  const players = activePlayerStates(state);
  for (const player of players) {
    const path = shortestPath(player.position, player.goal, state.walls, state);
    if (!path) continue;
    // The first three route edges cover immediate defense and nearby tactical pressure
    // without scanning every anchor on Titan each turn.
    for (let index = 0; index < Math.min(path.length - 1, 3); index++) {
      for (const wall of wallsBlockingEdge(path[index], path[index + 1])) {
        if (isLegalWall(state, wall, actorId)) candidates.set(wallKey(wall), wall);
      }
    }
  }
  return [...candidates.values()];
}

function turnsUntil(state: GameState, id: PlayerId): number {
  const order = state.turnOrder ?? [];
  const current = Math.max(0, order.indexOf(currentPlayerId(state)));
  const target = Math.max(0, order.indexOf(id));
  return (target - current + order.length) % order.length || order.length;
}

function rankedWalls(state: GameState, actorId: PlayerId, difficulty: Difficulty): Candidate[] {
  const players = activePlayerStates(state);
  const actor = players.find(player => player.id === actorId)!;
  const before = new Map(players.map(player => [player.id, routeLength(player.position, player.goal, state.walls, state)]));
  const selfBefore = before.get(actorId)!;
  return candidateWalls(state, actorId).map(wall => {
    const walls = [...state.walls, wall];
    const selfAfter = routeLength(actor.position, actor.goal, walls, state);
    const selfCost = selfAfter - selfBefore;
    let threatGain = 0;
    let accidentalBenefit = 0;
    for (const opponent of players.filter(player => player.id !== actorId)) {
      const prior = before.get(opponent.id)!;
      const after = routeLength(opponent.position, opponent.goal, walls, state);
      const delta = after - prior;
      const danger = Math.max(1, selfBefore - prior + 2) + (prior <= 2 ? 5 : 0);
      const urgency = 1 + 1 / turnsUntil(state, opponent.id);
      if (delta > 0) threatGain += delta * danger * urgency;
      if (delta < 0) accidentalBenefit += -delta * (difficulty === 'hard' ? 2.4 : 1.5);
    }
    const reservePenalty = actor.wallsRemaining <= 2 ? (difficulty === 'hard' ? 1.6 : 2.1) : .25;
    const score = threatGain * (difficulty === 'hard' ? 1.35 : 1.05) - selfCost * (difficulty === 'hard' ? 2.1 : 2.6) - accidentalBenefit - reservePenalty;
    return { wall, score, threatGain, selfCost };
  }).sort((a, b) => b.score - a.score || a.wall.row - b.wall.row || a.wall.col - b.wall.col || a.wall.orientation.localeCompare(b.wall.orientation));
}

export function chooseConvergenceAIDecision(state: GameState, difficulty: Difficulty, actorId: PlayerId = currentPlayerId(state)): ConvergenceAIDecision {
  if (state.mode !== 'convergence' || state.winner || currentPlayerId(state) !== actorId) return { action: null, explanation: 'Convergence AI cannot act.' };
  const actor = activePlayerStates(state).find(player => player.id === actorId);
  if (!actor || actor.controller !== 'AI') return { action: null, explanation: 'Current slot is not AI controlled.' };
  const moves = legalMoves(state, actorId).map(to => ({
    to,
    distance: routeLength(to, actor.goal, state.walls, state),
  })).sort((a, b) => a.distance - b.distance || a.to.row - b.to.row || a.to.col - b.to.col);
  const winningMove = moves.find(move => move.distance === 0);
  if (winningMove) return { action: { type: 'move', to: winningMove.to }, explanation: `Selected: MOVE\nImmediate center victory\nActor: ${actorId}` };
  if (!moves.length) return { action: null, explanation: 'No legal move.' };

  const players = activePlayerStates(state);
  const selfDistance = routeLength(actor.position, actor.goal, state.walls, state);
  const nearestThreat = Math.min(...players.filter(player => player.id !== actorId).map(player => routeLength(player.position, player.goal, state.walls, state)));
  const bestWall = actor.wallsRemaining > 0 ? rankedWalls(state, actorId, difficulty)[0] : undefined;
  const emergency = nearestThreat <= 1;
  const wallThreshold = difficulty === 'hard' ? (emergency ? .1 : 2.4) : difficulty === 'normal' ? (emergency ? 1 : 4.2) : 7;
  const easyWallTurn = (state.ply + actor.number) % 7 === 0;
  const useWall = !!bestWall && bestWall.threatGain > 0 && bestWall.score > wallThreshold &&
    (difficulty === 'hard' || difficulty === 'normal' || easyWallTurn) &&
    (emergency || bestWall.selfCost <= (difficulty === 'hard' ? 2 : 1) || nearestThreat < selfDistance);
  if (useWall) return {
    action: { type: 'wall', wall: bestWall.wall },
    explanation: `Selected: PLACE_WALL\nScore: ${bestWall.score.toFixed(2)}\nThreat gain: ${bestWall.threatGain.toFixed(2)}\nSelf cost: ${bestWall.selfCost}`,
  };

  const moveIndex = difficulty === 'easy' && (state.ply + actor.number) % 6 === 0 && moves.length > 1 ? 1 : 0;
  const move = moves[moveIndex];
  return { action: { type: 'move', to: move.to }, explanation: `Selected: MOVE\nCenter route: ${move.distance}\nNearest opponent: ${nearestThreat}` };
}

