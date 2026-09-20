import { Action, Difficulty, Point, Wall } from './state';
import { legalAssistPaths, legalMoves } from './movement';
import { pointDistance, routeLength, shortestPath } from './pathfinding';
import { blocksEdge, wallKey } from './walls';
import { GameView, canPlaceViewedWall, perceivedMovementBoard, probeTargets } from './view';
import { MAP_CONFIGS, RULE_SETS, pointInGoal } from './modes';

export type AICategory = 'move' | 'wall' | 'assist' | 'break' | 'phantom' | 'probe';
export type AICandidate = {
  action: Action;
  category: AICategory;
  score: number;
  ownDelta: number;
  opponentDelta: number;
  reason: string;
};
export type RushAIDecision = { action: Action | null; explanation: string; ranked: AICandidate[] };

function wallsBlockingEdge(a: Point, b: Point, width: number, height: number): Wall[] {
  const result: Wall[] = [];
  if (a.row !== b.row) {
    const row = Math.min(a.row, b.row);
    for (const col of [a.col - 1, a.col]) if (row >= 0 && row < height - 1 && col >= 0 && col < width - 1) result.push({ row, col, orientation: 'horizontal' });
  } else {
    const col = Math.min(a.col, b.col);
    for (const row of [a.row - 1, a.row]) if (row >= 0 && row < height - 1 && col >= 0 && col < width - 1) result.push({ row, col, orientation: 'vertical' });
  }
  return result;
}

function candidateWalls(view: GameView): Wall[] {
  const map = MAP_CONFIGS[view.mapId];
  const opponentPath = shortestPath(view.pawns.blue, view.goals.blue, view.pathWalls, view) ?? [];
  const ownPath = shortestPath(view.pawns.red, view.goals.red, view.pathWalls, view) ?? [];
  const ranked = new Map<string, { wall: Wall; priority: number }>();
  const add = (wall: Wall, priority: number) => {
    const key = wallKey(wall);
    if (!ranked.has(key) || ranked.get(key)!.priority < priority) ranked.set(key, { wall, priority });
  };
  for (let index = 0; index < opponentPath.length - 1; index++) {
    for (const wall of wallsBlockingEdge(opponentPath[index], opponentPath[index + 1], view.width, view.height)) add(wall, 100 - index);
    const point = opponentPath[index];
    for (let row = Math.max(0, point.row - 1); row <= Math.min(view.height - 2, point.row); row++) {
      for (let col = Math.max(0, point.col - 1); col <= Math.min(view.width - 2, point.col); col++) {
        add({ row, col, orientation: 'horizontal' }, 55 - index);
        add({ row, col, orientation: 'vertical' }, 54 - index);
      }
    }
  }
  for (let index = 0; index < Math.min(ownPath.length - 1, 5); index++) {
    const point = ownPath[index];
    for (let row = Math.max(0, point.row - 1); row <= Math.min(view.height - 2, point.row); row++) {
      for (let col = Math.max(0, point.col - 1); col <= Math.min(view.width - 2, point.col); col++) {
        add({ row, col, orientation: 'horizontal' }, 20 - index);
        add({ row, col, orientation: 'vertical' }, 19 - index);
      }
    }
  }
  const ordered = [...ranked.values()].sort((a, b) => b.priority - a.priority || a.wall.row - b.wall.row || a.wall.col - b.wall.col);
  const legal: Wall[] = [];
  for (const item of ordered) {
    if (canPlaceViewedWall(view, item.wall)) legal.push(item.wall);
    if (legal.length >= map.aiWallLimit) break;
  }
  return legal;
}

function rewardOpportunity(view: GameView, from: Point): { bonus: number; text: string } {
  const rush = view.rush!;
  const ownRoute = routeLength(from, view.goals.red, view.pathWalls, view);
  let best = { bonus: 0, text: 'no worthwhile visible reward' };
  for (const tile of rush.tiles.filter(item => !item.consumed)) {
    const capped = tile.kind === 'energy' ? rush.energy.red >= RULE_SETS.rush.energyMax : rush.assists.red >= RULE_SETS.rush.assistMax;
    if (capped) continue;
    const toTile = pointDistance(from, tile.point, view.pathWalls, view);
    const afterTile = routeLength(tile.point, view.goals.red, view.pathWalls, view);
    if (!Number.isFinite(toTile) || !Number.isFinite(afterTile)) continue;
    const detour = Math.max(0, toTile + afterTile - ownRoute);
    const value = tile.kind === 'boost' ? 3.3 : 1.8 + (RULE_SETS.rush.energyMax - rush.energy.red) * .12;
    const bonus = value - detour * .9 - Math.max(0, toTile - 3) * .18;
    if (bonus > best.bonus) best = { bonus, text: `${tile.kind === 'boost' ? 'Assist' : 'Energy'} reward worth ${bonus.toFixed(1)} after ${detour} detour` };
  }
  return best;
}

function explanation(selected: AICandidate | undefined, ranked: AICandidate[]): string {
  if (!selected) return 'No legal AI action.';
  const runner = ranked.find(item => item !== selected);
  return [
    `Selected: ${selected.action.type.toUpperCase()}`,
    `Score: ${selected.score.toFixed(2)}`,
    `Own route: ${selected.ownDelta >= 0 ? '+' : ''}${selected.ownDelta}`,
    `Opponent route: ${selected.opponentDelta >= 0 ? '+' : ''}${selected.opponentDelta}`,
    selected.reason,
    runner ? `Runner-up: ${runner.action.type.toUpperCase()} ${runner.score.toFixed(2)}` : '',
  ].filter(Boolean).join('\n');
}

export function chooseRushAIDecision(view: GameView, difficulty: Difficulty): RushAIDecision {
  if (view.mode !== 'rush' || !view.rush || view.viewer !== 'red' || view.turn !== 'red' || view.winner) return { action: null, explanation: 'AI cannot act.', ranked: [] };
  const board = perceivedMovementBoard(view); const rush = view.rush; const candidates: AICandidate[] = [];
  const ownBefore = routeLength(view.pawns.red, view.goals.red, view.pathWalls, view);
  const opponentBefore = routeLength(view.pawns.blue, view.goals.blue, view.pathWalls, view);
  const threat = opponentBefore <= 2 ? 3.5 : opponentBefore <= 4 ? 1.4 : 0;
  const push = (candidate: AICandidate) => candidates.push(candidate);

  for (const to of legalMoves(board, 'red')) {
    const ownAfter = routeLength(to, view.goals.red, view.pathWalls, view);
    const gain = ownBefore - ownAfter;
    const reward = rewardOpportunity(view, to);
    const landing = rush.tiles.find(tile => !tile.consumed && tile.point.row === to.row && tile.point.col === to.col);
    const landingValue = landing?.kind === 'boost' && rush.assists.red < RULE_SETS.rush.assistMax ? 3.5
      : landing?.kind === 'energy' && rush.energy.red < RULE_SETS.rush.energyMax ? 2.1 : 0;
    const winning = pointInGoal(to, view.goals.red, view) ? 100 : 0;
    push({ action: { type: 'move', to }, category: 'move', score: winning + gain * 2 + reward.bonus + landingValue - threat * .35, ownDelta: -gain, opponentDelta: 0, reason: landingValue ? 'collects a useful visible reward' : reward.text });
  }

  if (rush.assists.red > 0) for (const path of legalAssistPaths(board, 'red')) {
    const ownAfter = routeLength(path.to, view.goals.red, view.pathWalls, view);
    const gain = ownBefore - ownAfter;
    const decisive = pointInGoal(path.to, view.goals.red, view) ? 100 : ownBefore <= 4 ? 2.8 : 0;
    const reward = rewardOpportunity(view, path.to);
    const scarcity = rush.assists.red === 1 && ownBefore > 4 ? 2.4 : .8;
    push({ action: { type: 'assist', ...path }, category: 'assist', score: decisive + gain * 2.15 + reward.bonus - scarcity, ownDelta: -gain, opponentDelta: 0, reason: `saves ${gain} route steps; scarcity cost ${scarcity.toFixed(1)}` });
  }

  const allowTactics = difficulty !== 'easy' || view.ply % 6 === 5;
  if (allowTactics && rush.energy.red >= RULE_SETS.rush.breakCost) for (const wall of view.walls.filter(item => item.owner === 'blue')) {
    const without = view.pathWalls.filter(item => wallKey(item) !== wallKey(wall));
    const ownAfter = routeLength(view.pawns.red, view.goals.red, without, view);
    const recovery = ownBefore - ownAfter;
    if (recovery > 0) {
      const energyCost = rush.energy.red === RULE_SETS.rush.breakCost ? 2.3 : 1.4;
      const { knownPhantom: _hiddenIdentity, ...target } = wall;
      push({ action: { type: 'break', wall: target }, category: 'break', score: recovery * 4.2 - energyCost + (ownBefore <= 4 ? 1.4 : 0), ownDelta: -recovery, opponentDelta: 0, reason: `recovers ${recovery} route steps for 4 Energy` });
    }
  }

  if (allowTactics && view.remaining.red > 0) for (const wall of candidateWalls(view)) {
    const withWall = [...view.pathWalls, wall];
    const opponentAfter = routeLength(view.pawns.blue, view.goals.blue, withWall, view);
    const ownAfter = routeLength(view.pawns.red, view.goals.red, withWall, view);
    const opponentGain = opponentAfter - opponentBefore;
    const ownCost = ownAfter - ownBefore;
    if (opponentGain <= 0) continue;
    const reserveCost = view.remaining.red <= 2 ? 1.8 : view.remaining.red <= 5 ? .65 : .25;
    const wallScore = opponentGain * (difficulty === 'hard' ? 2.8 : 2.35) - ownCost * 2.2 + threat - reserveCost;
    push({ action: { type: 'wall', wall }, category: 'wall', score: wallScore, ownDelta: ownCost, opponentDelta: opponentGain, reason: `adds ${opponentGain} opponent steps; defensive urgency ${threat.toFixed(1)}` });
    if (rush.ownPhantomAvailable) {
      const sharedCorridorBonus = ownCost > 0 ? 1.5 + ownCost * .6 : 0;
      const phantomScore = opponentGain * (difficulty === 'hard' ? 2.35 : 1.85) + threat * .7 + sharedCorridorBonus - reserveCost - .35;
      push({ action: { type: 'phantom', wall }, category: 'phantom', score: phantomScore, ownDelta: 0, opponentDelta: opponentGain, reason: `credible decoy on the opponent corridor; avoids ${ownCost} own-route cost` });
    }
  }

  for (const to of probeTargets(view, 'red')) {
    const unblocked = view.pathWalls.filter(wall => !blocksEdge([wall], view.pawns.red, to));
    const ownAfter = 1 + routeLength(to, view.goals.red, unblocked, view);
    const recovery = ownBefore - ownAfter;
    push({ action: { type: 'probe', to }, category: 'probe', score: recovery * 1.8 - .35, ownDelta: -recovery, opponentDelta: 0, reason: `tests a blocking unknown barrier; projected recovery ${recovery}` });
  }

  candidates.sort((a, b) => b.score - a.score || JSON.stringify(a.action).localeCompare(JSON.stringify(b.action)));
  let eligible = candidates;
  if (difficulty === 'easy') {
    const simple = candidates.filter(item => item.category === 'move' || (view.ply % 12 === 9 && item.category === 'assist') || (view.ply % 6 === 5 && item.category === 'wall'));
    eligible = simple.length ? simple : candidates;
    if (view.ply % 8 === 7 && eligible.length > 1) {
      const selected = eligible[1];
      return { action: selected.action, explanation: explanation(selected, eligible), ranked: candidates };
    }
  }
  if (difficulty === 'normal') {
    eligible = candidates.filter(item => item.category !== 'phantom' || item.score >= 2.2);
    const bestAssist = eligible[0]?.category === 'assist' ? eligible[0] : undefined;
    const alternative = eligible.find(item => item.category !== 'assist');
    if (bestAssist && alternative && bestAssist.score < alternative.score + 1.1) eligible = [alternative, ...eligible.filter(item => item !== alternative)];
  }
  const selected = eligible[0];
  return { action: selected?.action ?? null, explanation: explanation(selected, eligible), ranked: candidates };
}

export function chooseRushAIAction(view: GameView, difficulty: Difficulty): Action | null {
  return chooseRushAIDecision(view, difficulty).action;
}
