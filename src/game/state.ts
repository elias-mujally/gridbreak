import { MAP_CONFIGS, RULE_SETS, convergenceSetup, isControllerCombinationSupported, layoutConfig, matchCapability, type ConvergencePlayerCount, type GoalZone, type MapId, type RaceLayout } from './modes';
import { generateTiles } from './tiles';

export type Player = 'blue' | 'red';
export type PlayerId = Player | 'amber' | 'violet';
export const PLAYERS: readonly Player[] = ['blue', 'red'];
export const PLAYER_IDS: readonly PlayerId[] = ['blue', 'red', 'amber', 'violet'];
export type ControllerType = 'HUMAN_LOCAL' | 'AI' | 'HUMAN_REMOTE';
export type GameMode = 'classic' | 'rush' | 'convergence';
export type Difficulty = 'easy' | 'normal' | 'hard';
export type ControllerSelection = { type: ControllerType; difficulty?: Difficulty };
export type Point = { row: number; col: number };
export type Wall = { row: number; col: number; orientation: 'horizontal' | 'vertical'; owner?: PlayerId };
export type PhantomWall = Wall & { owner: Player };
export type PowerTile = { kind: 'energy' | 'boost'; point: Point; consumed: boolean };
export type RushEvent = { kind: 'move' | 'assist' | 'wall' | 'phantom' | 'reveal' | 'break' | 'probe' | 'tile' | 'pressure'; text: string; wall?: Wall; privateTo?: Player };
export type RushState = {
  seed: number; seedLocked: boolean;
  energy: Record<Player, number>; assists: Record<Player, number>; momentum: Record<Player, number>;
  phantomAvailable: Record<Player, boolean>; phantoms: PhantomWall[]; tiles: PowerTile[];
  suddenDeath: boolean; pressureStage: number; event: RushEvent | null; winnerReason: 'goal' | 'deadline' | null;
};
export type PlayerState = {
  id: PlayerId;
  number: number;
  label: string;
  token: string;
  color: string;
  controller: ControllerType;
  difficulty: Difficulty;
  spawn: Point;
  goal: GoalZone;
  position: Point;
  wallsRemaining: number;
  energy: number;
  assists: number;
  phantomAvailable: boolean;
};
export type Action =
  | { type: 'move'; to: Point } | { type: 'wall'; wall: Wall }
  | { type: 'assist'; via: Point; to: Point } | { type: 'break'; wall: Wall }
  | { type: 'phantom'; wall: Wall } | { type: 'probe'; to: Point };
export type GameState = {
  mode: GameMode; mapId: MapId; layout: RaceLayout; width: number; height: number;
  players?: PlayerState[]; turnOrder?: PlayerId[]; currentTurnIndex?: number;
  /** Two-player compatibility projections retained while Classic/Rush migrate incrementally. */
  goals: Record<Player, GoalZone>; pawns: Record<Player, Point>; remaining: Record<Player, number>;
  walls: Wall[]; turn: PlayerId; winner: PlayerId | 'draw' | null; ply: number; rush?: RushState;
};

export const PLAYER_PRESENTATION: Record<PlayerId, Pick<PlayerState, 'label' | 'token' | 'color'>> = {
  blue: { label: 'Player 1', token: '1', color: '#27c5ff' },
  red: { label: 'Player 2', token: '2', color: '#ff5d73' },
  amber: { label: 'Player 3', token: '3', color: '#ffc857' },
  violet: { label: 'Player 4', token: '4', color: '#a98bff' },
};

let seedCounter = 0;
export function freshSeed(): number {
  seedCounter = (seedCounter + 1) >>> 0;
  const cryptoSeed = typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function' ? crypto.getRandomValues(new Uint32Array(1))[0] : 0;
  return (cryptoSeed ^ Date.now() ^ Math.imul(seedCounter, 0x9e3779b1)) >>> 0;
}

export function cloneGoal(goal: GoalZone): GoalZone {
  return goal.kind === 'cell' ? { kind: 'cell', cell: { ...goal.cell } } : { ...goal };
}

function playerState(id: PlayerId, number: number, spawn: Point, goal: GoalZone, wallsRemaining: number, controller: ControllerType, rush?: RushState, difficulty: Difficulty = 'normal'): PlayerState {
  const legacy = id === 'blue' || id === 'red' ? id : null;
  return {
    id, number, ...PLAYER_PRESENTATION[id], controller, difficulty,
    spawn: { ...spawn }, goal: cloneGoal(goal), position: { ...spawn }, wallsRemaining,
    energy: legacy && rush ? rush.energy[legacy] : 0,
    assists: legacy && rush ? rush.assists[legacy] : 0,
    phantomAvailable: legacy && rush ? rush.phantomAvailable[legacy] : false,
  };
}

export type NewGameOptions = { mode?: GameMode; mapId?: MapId; layout?: RaceLayout; seed?: number; seedLocked?: boolean; playerCount?: ConvergencePlayerCount; controllers?: ControllerSelection[] };
export function newGame(options: NewGameOptions = {}): GameState {
  const mode = options.mode ?? 'classic';
  if (mode === 'convergence') {
    const requestedMap = MAP_CONFIGS[options.mapId ?? 'grand'];
    const requestedCount = options.playerCount ?? 4;
    if (!requestedMap.convergence) throw new Error(`${requestedMap.name} does not support Convergence.`);
    const capability = matchCapability(requestedMap.id, mode, 'convergence', requestedCount);
    if (!capability) throw new Error(`${requestedMap.name} does not support ${requestedCount}-player Convergence.`);
    const selections: ControllerSelection[] = options.controllers ?? Array.from({ length: requestedCount }, () => ({ type: 'HUMAN_LOCAL' as const }));
    if (!isControllerCombinationSupported(capability, selections.map(selection => selection.type))) throw new Error('Unsupported controller combination for this match.');
    const map = requestedMap;
    const setup = convergenceSetup(map, requestedCount)!;
    const players = setup.turnOrder.map((id, index) => {
      const spawn = setup.spawns[id]!;
      const selection = selections[index];
      return playerState(id, index + 1, spawn.point, setup.goal, setup.wallsPerPlayer, selection.type, undefined, selection.difficulty ?? 'normal');
    });
    return {
      mode, mapId: map.id, layout: 'convergence', width: map.convergence!.width, height: map.convergence!.height,
      players, turnOrder: [...setup.turnOrder], currentTurnIndex: 0,
      goals: { blue: cloneGoal(setup.goal), red: cloneGoal(setup.goal) },
      pawns: { blue: { ...players[0].position }, red: { ...players[1].position } },
      remaining: { blue: players[0].wallsRemaining, red: players[1].wallsRemaining },
      walls: [], turn: setup.turnOrder[0], winner: null, ply: 0,
    };
  }

  const map = MAP_CONFIGS[options.mapId ?? 'sprint'];
  const requestedLayout = options.layout === 'convergence' ? map.defaultLayout : options.layout ?? map.defaultLayout;
  if (!map.layouts[requestedLayout]) throw new Error(`${map.name} does not support the ${requestedLayout} layout.`);
  const chosenLayout = requestedLayout;
  const capability = matchCapability(map.id, mode, chosenLayout, 2);
  if (!capability) throw new Error(`${map.name} does not support ${mode} with ${chosenLayout}.`);
  const selections: ControllerSelection[] = options.controllers ?? [{ type: 'HUMAN_LOCAL' as const }, { type: 'AI' as const }];
  if (!isControllerCombinationSupported(capability, selections.map(selection => selection.type))) throw new Error('Unsupported controller combination for this match.');
  const race = layoutConfig(map, chosenLayout);
  const seedLocked = mode === 'rush' && options.seedLocked === true;
  const seed = mode === 'rush' ? ((options.seed ?? freshSeed()) >>> 0) : 0;
  const rush = mode === 'rush' ? {
    seed, seedLocked,
    energy: { blue: RULE_SETS.rush.energyStart, red: RULE_SETS.rush.energyStart },
    assists: { blue: RULE_SETS.rush.assistStart, red: RULE_SETS.rush.assistStart },
    momentum: { blue: 0, red: 0 }, phantomAvailable: { blue: true, red: true }, phantoms: [],
    tiles: generateTiles(seed, map, chosenLayout), suddenDeath: false, pressureStage: 0, event: null, winnerReason: null,
  } satisfies RushState : undefined;
  const pawns = { blue: { ...race.spawns.blue.point }, red: { ...race.spawns.red.point } };
  const goals = { blue: cloneGoal(race.goals.blue), red: cloneGoal(race.goals.red) };
  const remaining = { blue: map.startingWalls, red: map.startingWalls };
  return {
    mode, mapId: map.id, layout: chosenLayout, width: map.width, height: map.height,
    players: [
      playerState('blue', 1, pawns.blue, goals.blue, remaining.blue, selections[0].type, rush, selections[0].difficulty ?? 'normal'),
      playerState('red', 2, pawns.red, goals.red, remaining.red, selections[1].type, rush, selections[1].difficulty ?? 'normal'),
    ],
    turnOrder: ['blue', 'red'], currentTurnIndex: 0,
    goals, pawns, walls: [], remaining, turn: 'blue', winner: null, ply: 0,
    ...(rush ? { rush } : {}),
  };
}

export function activePlayerStates(state: GameState): PlayerState[] {
  const stored = state.players ?? PLAYERS.map((id, index) => playerState(id, index + 1, state.pawns[id], state.goals[id], state.remaining[id], id === 'blue' ? 'HUMAN_LOCAL' : 'AI', state.rush));
  if (state.mode === 'convergence') return stored;
  return stored.map(player => {
    if (player.id !== 'blue' && player.id !== 'red') return player;
    const id = player.id;
    return {
      ...player,
      position: { ...state.pawns[id] }, goal: cloneGoal(state.goals[id]), wallsRemaining: state.remaining[id],
      energy: state.rush?.energy[id] ?? 0, assists: state.rush?.assists[id] ?? 0,
      phantomAvailable: state.rush?.phantomAvailable?.[id] ?? false,
    };
  });
}

export function currentPlayerId(state: Pick<GameState, 'mode' | 'turn' | 'turnOrder' | 'currentTurnIndex'>): PlayerId {
  return state.mode === 'convergence' ? state.turnOrder?.[state.currentTurnIndex ?? 0] ?? state.turn : state.turn;
}
export function playerStateById(state: GameState, id: PlayerId): PlayerState {
  const player = activePlayerStates(state).find(item => item.id === id);
  if (!player) throw new Error(`Unknown active player: ${id}`);
  return player;
}
export function nextTurn(state: GameState): { turn: PlayerId; currentTurnIndex: number } {
  const current = currentPlayerId(state);
  const turnOrder = state.turnOrder ?? ['blue', 'red'];
  const index = Math.max(0, turnOrder.indexOf(current));
  const currentTurnIndex = (index + 1) % turnOrder.length;
  return { currentTurnIndex, turn: turnOrder[currentTurnIndex] };
}

export function rematchGame(state: GameState): GameState {
  const controllers = activePlayerStates(state).map(player => ({ type: player.controller, difficulty: player.difficulty }));
  return newGame({
    mode: state.mode, mapId: state.mapId, layout: state.layout,
    controllers,
    ...(state.mode === 'convergence' ? { playerCount: activePlayerStates(state).length as ConvergencePlayerCount } : {}),
    ...(state.mode === 'rush' && state.rush?.seedLocked ? { seed: state.rush.seed, seedLocked: true } : {}),
  });
}

export const otherPlayer = (player: Player): Player => player === 'blue' ? 'red' : 'blue';
export const samePoint = (a: Point, b: Point): boolean => a.row === b.row && a.col === b.col;
export const inBounds = (point: Point, width: number, height: number): boolean => point.row >= 0 && point.row < height && point.col >= 0 && point.col < width;
