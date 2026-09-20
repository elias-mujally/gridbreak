import { Action, GameState, Player, Point, RushState, Wall, activePlayerStates, inBounds, otherPlayer, samePoint } from './state';
import { MAP_CONFIGS, RULE_SETS, pointInGoal } from './modes';
import { legalAssistPaths, legalMoves } from './movement';
import { routeLength } from './pathfinding';
import { blocksEdge, canStep, isLegalPhantomWall, isLegalWall, wallKey } from './walls';

const sameWall = (a: Wall, b: Wall) => wallKey(a) === wallKey(b);
const adjacent = (a: Point, b: Point) => Math.abs(a.row - b.row) + Math.abs(a.col - b.col) === 1;

export function grantAssist(rush: RushState, player: Player, amount = 1): number {
  const before = rush.assists[player];
  rush.assists[player] = Math.min(RULE_SETS.rush.assistMax, before + Math.max(0, amount));
  return rush.assists[player] - before;
}

function crossedEdges(start: Point, end: Point, opponent: Point, walls: Wall[], dimensions: { width: number; height: number }): [Point, Point][] {
  if (adjacent(start, end)) return [[start, end]];
  if (adjacent(start, opponent) && canStep(walls, start, opponent, dimensions) && canStep(walls, opponent, end, dimensions)) return [[start, opponent], [opponent, end]];
  return [];
}

function finishTurn(state: GameState, rush: RushState, pawns: GameState['pawns'], walls: Wall[], remaining: GameState['remaining'], winner: GameState['winner']): GameState {
  const map = MAP_CONFIGS[state.mapId];
  const dimensions = { width: state.width, height: state.height };
  const ply = state.ply + 1;
  if (!winner && ply >= map.suddenDeathPly) {
    rush.suddenDeath = true;
    const stage = Math.floor((ply - map.suddenDeathPly) / map.wallDrainEvery);
    if (stage > rush.pressureStage) {
      remaining.blue = Math.max(0, remaining.blue - 1); remaining.red = Math.max(0, remaining.red - 1);
      rush.pressureStage = stage;
      rush.event = { kind: 'pressure', text: 'Sudden Death: both wall reserves lose one.' };
    }
  }
  if (!winner && ply >= map.deadlinePly) {
    const blue = routeLength(pawns.blue, state.goals.blue, walls, dimensions);
    const red = routeLength(pawns.red, state.goals.red, walls, dimensions);
    winner = blue < red ? 'blue' : red < blue ? 'red' : rush.energy.blue > rush.energy.red ? 'blue' : rush.energy.red > rush.energy.blue ? 'red' : 'draw';
    rush.winnerReason = 'deadline';
    rush.event = { kind: 'pressure', text: 'Time. Closest route wins; Energy breaks a tie.' };
  }
  const next = { ...state, pawns, walls, remaining, rush, winner, turn: winner ? state.turn : otherPlayer(state.turn as Player), currentTurnIndex: winner ? state.currentTurnIndex ?? 0 : state.turn === 'blue' ? 1 : 0, ply };
  return { ...next, players: activePlayerStates(next) };
}

export function applyRushAction(state: GameState, action: Action): GameState | null {
  if (state.mode !== 'rush' || !state.rush || state.winner) return null;
  const dimensions = { width: state.width, height: state.height };
  const player = state.turn as Player;
  const enemy = otherPlayer(player);
  const start = state.pawns[player];
  const rush: RushState = {
    ...state.rush, energy: { ...state.rush.energy }, assists: { ...state.rush.assists }, momentum: { ...state.rush.momentum },
    phantomAvailable: { ...state.rush.phantomAvailable }, phantoms: state.rush.phantoms.map(wall => ({ ...wall })),
    tiles: state.rush.tiles.map(tile => ({ ...tile, point: { ...tile.point } })), event: null,
  };
  const pawns = { blue: { ...state.pawns.blue }, red: { ...state.pawns.red } };
  let walls = state.walls.map(wall => ({ ...wall }));
  const remaining = { ...state.remaining };
  let winner: GameState['winner'] = null;
  let progressed = false;
  let entered: Point[] = [];
  let crossed: [Point, Point][] = [];

  if (action.type === 'move') {
    if (!legalMoves(state).some(point => samePoint(point, action.to))) return null;
    pawns[player] = { ...action.to }; entered = [action.to];
    crossed = crossedEdges(start, action.to, state.pawns[enemy], state.walls, dimensions);
    progressed = routeLength(action.to, state.goals[player], walls, dimensions) < routeLength(start, state.goals[player], walls, dimensions);
    rush.event = { kind: 'move', text: `${player === 'blue' ? 'Blue' : 'Rival'} advanced.` };
  } else if (action.type === 'assist') {
    if (rush.assists[player] <= 0 || !legalAssistPaths(state).some(path => samePoint(path.via, action.via) && samePoint(path.to, action.to))) return null;
    rush.assists[player]--;
    pawns[player] = { ...action.to }; entered = [action.via, action.to]; crossed = [[start, action.via], [action.via, action.to]];
    progressed = routeLength(action.to, state.goals[player], walls, dimensions) < routeLength(start, state.goals[player], walls, dimensions);
    rush.event = { kind: 'assist', text: `${player === 'blue' ? 'Blue' : 'Rival'} used an Assist.` };
  } else if (action.type === 'wall') {
    if (!isLegalWall(state, action.wall)) return null;
    const before = routeLength(state.pawns[enemy], state.goals[enemy], walls, dimensions);
    walls = [...walls, { ...action.wall, owner: player }]; remaining[player]--;
    progressed = routeLength(state.pawns[enemy], state.goals[enemy], walls, dimensions) > before;
    rush.event = { kind: 'wall', text: progressed ? 'A tactical barrier earned +1 Energy.' : 'A barrier was placed.', wall: action.wall };
  } else if (action.type === 'phantom') {
    if (!isLegalPhantomWall(state, action.wall)) return null;
    rush.phantoms.push({ ...action.wall, owner: player }); rush.phantomAvailable[player] = false; remaining[player]--;
    rush.event = { kind: 'phantom', text: 'Your Phantom Wall is armed.', wall: action.wall, privateTo: player };
  } else if (action.type === 'break') {
    if (rush.energy[player] < RULE_SETS.rush.breakCost) return null;
    const real = walls.find(wall => sameWall(wall, action.wall) && wall.owner === enemy);
    const phantom = rush.phantoms.find(wall => sameWall(wall, action.wall) && wall.owner === enemy);
    if (!real && !phantom) return null;
    rush.energy[player] -= RULE_SETS.rush.breakCost;
    if (real) walls = walls.filter(wall => !sameWall(wall, action.wall));
    if (phantom) rush.phantoms = rush.phantoms.filter(wall => !sameWall(wall, action.wall));
    rush.event = { kind: 'break', text: phantom ? 'Decoy shattered.' : 'Enemy barrier shattered.', wall: action.wall };
  } else if (action.type === 'probe') {
    const target = action.to;
    if (!inBounds(target, state.width, state.height) || !adjacent(start, target) || samePoint(target, state.pawns[enemy])) return null;
    const real = blocksEdge(walls, start, target);
    const phantom = rush.phantoms.some(wall => wall.owner === enemy && blocksEdge([wall], start, target));
    if (!real && !phantom) return null;
    if (real) rush.event = { kind: 'probe', text: 'Solid wall. The probe used this turn.' };
    else {
      pawns[player] = { ...target }; entered = [target]; crossed = [[start, target]];
      progressed = routeLength(target, state.goals[player], walls, dimensions) < routeLength(start, state.goals[player], walls, dimensions);
      rush.event = { kind: 'reveal', text: 'Phantom exposed. You pass through!', wall: rush.phantoms.find(wall => wall.owner === enemy && blocksEdge([wall], start, target)) };
    }
  } else return null;

  if (crossed.length) {
    const revealed = rush.phantoms.filter(wall => wall.owner === enemy && crossed.some(([from, to]) => blocksEdge([wall], from, to)));
    if (revealed.length) {
      rush.phantoms = rush.phantoms.filter(wall => !revealed.some(found => sameWall(found, wall)));
      rush.event = { kind: 'reveal', text: 'Phantom exposed. The route opens!', wall: revealed[0] };
    }
  }
  for (const point of entered) {
    const tile = rush.tiles.find(item => !item.consumed && samePoint(item.point, point));
    if (!tile) continue;
    tile.consumed = true;
    if (tile.kind === 'energy') {
      rush.energy[player] = Math.min(RULE_SETS.rush.energyMax, rush.energy[player] + 1);
      rush.event = { kind: 'tile', text: '⚡ +1 ENERGY' };
    } else {
      grantAssist(rush, player);
      rush.event = { kind: 'tile', text: '🚀 +1 ASSIST' };
    }
  }
  if (progressed) {
    rush.energy[player] = Math.min(RULE_SETS.rush.energyMax, rush.energy[player] + 1); rush.momentum[player]++;
    if (rush.momentum[player] >= RULE_SETS.rush.momentumTarget) {
      rush.energy[player] = Math.min(RULE_SETS.rush.energyMax, rush.energy[player] + 1); rush.momentum[player] = 0;
      if (rush.event?.kind !== 'tile' && rush.event?.kind !== 'reveal') rush.event = { kind: rush.event?.kind ?? 'move', text: 'Momentum chain! +1 bonus Energy.', wall: rush.event?.wall };
    }
  } else rush.momentum[player] = 0;
  if (entered.length && pointInGoal(pawns[player], state.goals[player], dimensions)) { winner = player; rush.winnerReason = 'goal'; }
  return finishTurn(state, rush, pawns, walls, remaining, winner);
}
