import { MAP_CONFIGS, RULE_SETS, layoutConfig, type GoalZone, type MapId, type RaceLayout } from './modes';
import { generateTiles } from './tiles';

export type Player = 'blue' | 'red';
export const PLAYERS: readonly Player[] = ['blue', 'red'];
export type GameMode = 'classic' | 'rush';
export type Difficulty = 'easy' | 'normal' | 'hard';
export type Point = { row: number; col: number };
export type Wall = { row: number; col: number; orientation: 'horizontal' | 'vertical'; owner?: Player };
export type PhantomWall = Wall & { owner: Player };
export type PowerTile = { kind: 'energy' | 'boost'; point: Point; consumed: boolean };
export type RushEvent = { kind: 'move' | 'assist' | 'wall' | 'phantom' | 'reveal' | 'break' | 'probe' | 'tile' | 'pressure'; text: string; wall?: Wall; privateTo?: Player };
export type RushState = {
  seed: number; seedLocked: boolean;
  energy: Record<Player, number>; assists: Record<Player, number>; momentum: Record<Player, number>;
  phantomAvailable: Record<Player, boolean>; phantoms: PhantomWall[]; tiles: PowerTile[];
  suddenDeath: boolean; pressureStage: number; event: RushEvent | null; winnerReason: 'goal' | 'deadline' | null;
};
export type Action =
  | { type: 'move'; to: Point } | { type: 'wall'; wall: Wall }
  | { type: 'assist'; via: Point; to: Point } | { type: 'break'; wall: Wall }
  | { type: 'phantom'; wall: Wall } | { type: 'probe'; to: Point };
export type GameState = {
  mode: GameMode; mapId: MapId; layout: RaceLayout; width: number; height: number;
  goals: Record<Player, GoalZone>; pawns: Record<Player, Point>; walls: Wall[];
  remaining: Record<Player, number>; turn: Player; winner: Player | 'draw' | null; ply: number; rush?: RushState;
};

let seedCounter = 0;
export function freshSeed(): number {
  seedCounter = (seedCounter + 1) >>> 0;
  const cryptoSeed = typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function' ? crypto.getRandomValues(new Uint32Array(1))[0] : 0;
  return (cryptoSeed ^ Date.now() ^ Math.imul(seedCounter, 0x9e3779b1)) >>> 0;
}

export type NewGameOptions = { mode?: GameMode; mapId?: MapId; layout?: RaceLayout; seed?: number; seedLocked?: boolean };
export function newGame(options: NewGameOptions = {}): GameState {
  const mode = options.mode ?? 'classic';
  const map = MAP_CONFIGS[options.mapId ?? 'sprint'];
  const chosenLayout = map.layouts[options.layout ?? map.defaultLayout] ? (options.layout ?? map.defaultLayout) : map.defaultLayout;
  const race = layoutConfig(map, chosenLayout);
  const seedLocked = mode === 'rush' && options.seedLocked === true;
  const seed = mode === 'rush' ? ((options.seed ?? freshSeed()) >>> 0) : 0;
  return {
    mode, mapId: map.id, layout: chosenLayout, width: map.width, height: map.height,
    goals: { blue: { ...race.goals.blue }, red: { ...race.goals.red } },
    pawns: { blue: { ...race.spawns.blue.point }, red: { ...race.spawns.red.point } },
    walls: [], remaining: { blue: map.startingWalls, red: map.startingWalls }, turn: 'blue', winner: null, ply: 0,
    ...(mode === 'rush' ? { rush: {
      seed, seedLocked,
      energy: { blue: RULE_SETS.rush.energyStart, red: RULE_SETS.rush.energyStart },
      assists: { blue: RULE_SETS.rush.assistStart, red: RULE_SETS.rush.assistStart },
      momentum: { blue: 0, red: 0 }, phantomAvailable: { blue: true, red: true }, phantoms: [],
      tiles: generateTiles(seed, map, chosenLayout), suddenDeath: false, pressureStage: 0, event: null, winnerReason: null,
    } satisfies RushState } : {}),
  };
}

export function rematchGame(state: GameState): GameState {
  return newGame({
    mode: state.mode, mapId: state.mapId, layout: state.layout,
    ...(state.mode === 'rush' && state.rush?.seedLocked ? { seed: state.rush.seed, seedLocked: true } : {}),
  });
}

export const otherPlayer = (player: Player): Player => player === 'blue' ? 'red' : 'blue';
export const samePoint = (a: Point, b: Point): boolean => a.row === b.row && a.col === b.col;
export const inBounds = (point: Point, width: number, height: number): boolean => point.row >= 0 && point.row < height && point.col >= 0 && point.col < width;
