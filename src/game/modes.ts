import type { GameMode, Player, PlayerId, Point } from './state';

export type MapId = 'sprint' | 'arena' | 'wide' | 'gauntlet' | 'grand' | 'titan';
/** Compatibility name retained for saved Phase 2 fixtures. Maps are now mode-independent. */
export type RushMapId = MapId;
export type RaceLayout = 'opposite' | 'parallel' | 'convergence';
export type LegacyRaceLayout = Exclude<RaceLayout, 'convergence'>;
export type GoalEdge = 'top' | 'bottom' | 'left' | 'right';
export type BoardDimensions = { width: number; height: number };
export type GoalZone = { kind: 'edge'; edge: GoalEdge; cells?: never } | { kind: 'cells'; cells: Point[]; edge?: never };
export type SpawnZone = { kind: 'point'; point: Point; edge: GoalEdge };
export type LayoutConfig = {
  id: LegacyRaceLayout;
  name: string;
  spawns: Record<Player, SpawnZone>;
  goals: Record<Player, GoalZone>;
};
export type ConvergencePlayerCount = 2 | 3 | 4;
export type ConvergenceSetup = {
  playerCount: ConvergencePlayerCount;
  turnOrder: PlayerId[];
  spawns: Partial<Record<PlayerId, SpawnZone>>;
  goal: GoalZone;
  wallsPerPlayer: number;
};
export type ConvergenceConfig = {
  supportedPlayerCounts: ConvergencePlayerCount[];
  setups: Partial<Record<ConvergencePlayerCount, ConvergenceSetup>>;
};
export type MapConfig = BoardDimensions & {
  id: MapId;
  name: string;
  startingWalls: number;
  layouts: Partial<Record<RaceLayout, LayoutConfig>>;
  defaultLayout: LegacyRaceLayout;
  convergence?: ConvergenceConfig;
  rewardRange: readonly [number, number];
  rewardWeights: { energy: number; boost: number };
  suddenDeathPly: number;
  deadlinePly: number;
  wallDrainEvery: number;
  aiWallLimit: number;
};

const CONVERGENCE_IDS: PlayerId[] = ['blue', 'red', 'amber', 'violet'];
const pointSpawn = (row: number, col: number, edge: GoalEdge): SpawnZone => ({ kind: 'point', point: { row, col }, edge });
const edgeGoal = (edge: GoalEdge): GoalZone => ({ kind: 'edge', edge });

export function centerGoalZone(width: number, height: number): GoalZone {
  const rows = height % 2 ? [Math.floor(height / 2)] : [height / 2 - 1, height / 2];
  const cols = width % 2 ? [Math.floor(width / 2)] : [width / 2 - 1, width / 2];
  return { kind: 'cells', cells: rows.flatMap(row => cols.map(col => ({ row, col }))) };
}

function convergenceSpawns(width: number, height: number, count: ConvergencePlayerCount): Partial<Record<PlayerId, SpawnZone>> {
  const leftCenter = Math.floor((width - 1) / 2);
  const rightCenter = Math.ceil((width - 1) / 2);
  const topCenter = Math.floor((height - 1) / 2);
  const bottomCenter = Math.ceil((height - 1) / 2);
  const cardinal: SpawnZone[] = [
    pointSpawn(0, leftCenter, 'top'),
    pointSpawn(topCenter, width - 1, 'right'),
    pointSpawn(height - 1, rightCenter, 'bottom'),
    pointSpawn(bottomCenter, 0, 'left'),
  ];
  const indices = count === 2 ? [0, 2] : count === 3 ? [0, 1, 2] : [0, 1, 2, 3];
  return Object.fromEntries(indices.map((cardinalIndex, playerIndex) => [CONVERGENCE_IDS[playerIndex], cardinal[cardinalIndex]]));
}

function convergence(width: number, height: number, walls: Partial<Record<ConvergencePlayerCount, number>>): ConvergenceConfig {
  const supportedPlayerCounts = (Object.keys(walls).map(Number) as ConvergencePlayerCount[]).sort();
  return {
    supportedPlayerCounts,
    setups: Object.fromEntries(supportedPlayerCounts.map(playerCount => [playerCount, {
      playerCount,
      turnOrder: CONVERGENCE_IDS.slice(0, playerCount),
      spawns: convergenceSpawns(width, height, playerCount),
      goal: centerGoalZone(width, height),
      wallsPerPlayer: walls[playerCount]!,
    }])) as ConvergenceConfig['setups'],
  };
}

function opposite(width: number, height: number): LayoutConfig {
  const middle = Math.floor(width / 2);
  return {
    id: 'opposite', name: 'Opposite',
    spawns: { blue: pointSpawn(height - 1, middle, 'bottom'), red: pointSpawn(0, middle, 'top') },
    goals: { blue: edgeGoal('top'), red: edgeGoal('bottom') },
  };
}

function horizontalParallel(width: number, height: number): LayoutConfig {
  const upper = Math.max(1, Math.floor((height - 1) / 3));
  const lower = height - 1 - upper;
  return {
    id: 'parallel', name: 'Parallel',
    spawns: { blue: pointSpawn(lower, width - 1, 'right'), red: pointSpawn(upper, width - 1, 'right') },
    goals: { blue: edgeGoal('left'), red: edgeGoal('left') },
  };
}

function verticalParallel(width: number, height: number): LayoutConfig {
  const left = Math.max(1, Math.floor((width - 1) / 3));
  const right = width - 1 - left;
  return {
    id: 'parallel', name: 'Parallel',
    spawns: { blue: pointSpawn(height - 1, left, 'bottom'), red: pointSpawn(height - 1, right, 'bottom') },
    goals: { blue: edgeGoal('top'), red: edgeGoal('top') },
  };
}

function layouts(width: number, height: number, parallel?: 'horizontal' | 'vertical'): MapConfig['layouts'] {
  return {
    opposite: opposite(width, height),
    ...(parallel === 'horizontal' ? { parallel: horizontalParallel(width, height) } : {}),
    ...(parallel === 'vertical' ? { parallel: verticalParallel(width, height) } : {}),
  };
}

export const MAP_CONFIGS: Record<MapId, MapConfig> = {
  sprint: { id: 'sprint', name: 'Sprint', width: 7, height: 7, startingWalls: 7, layouts: layouts(7, 7), defaultLayout: 'opposite', rewardRange: [2, 4], rewardWeights: { energy: 55, boost: 45 }, suddenDeathPly: 32, deadlinePly: 64, wallDrainEvery: 4, aiWallLimit: 72 },
  arena: { id: 'arena', name: 'Arena', width: 10, height: 10, startingWalls: 10, layouts: layouts(10, 10), defaultLayout: 'opposite', convergence: convergence(10, 10, { 2: 5 }), rewardRange: [4, 6], rewardWeights: { energy: 55, boost: 45 }, suddenDeathPly: 50, deadlinePly: 96, wallDrainEvery: 5, aiWallLimit: 96 },
  wide: { id: 'wide', name: 'Wide', width: 12, height: 7, startingWalls: 9, layouts: layouts(12, 7, 'horizontal'), defaultLayout: 'opposite', rewardRange: [4, 6], rewardWeights: { energy: 60, boost: 40 }, suddenDeathPly: 40, deadlinePly: 80, wallDrainEvery: 4, aiWallLimit: 96 },
  gauntlet: { id: 'gauntlet', name: 'Gauntlet', width: 10, height: 18, startingWalls: 14, layouts: layouts(10, 18, 'vertical'), defaultLayout: 'opposite', rewardRange: [6, 8], rewardWeights: { energy: 60, boost: 40 }, suddenDeathPly: 72, deadlinePly: 140, wallDrainEvery: 6, aiWallLimit: 120 },
  grand: { id: 'grand', name: 'Grand', width: 15, height: 15, startingWalls: 16, layouts: layouts(15, 15), defaultLayout: 'opposite', convergence: convergence(15, 15, { 2: 10, 3: 7, 4: 5 }), rewardRange: [8, 10], rewardWeights: { energy: 60, boost: 40 }, suddenDeathPly: 84, deadlinePly: 160, wallDrainEvery: 7, aiWallLimit: 140 },
  titan: { id: 'titan', name: 'Titan', width: 20, height: 20, startingWalls: 20, layouts: layouts(20, 20), defaultLayout: 'opposite', convergence: convergence(20, 20, { 2: 14, 3: 9, 4: 7 }), rewardRange: [10, 14], rewardWeights: { energy: 65, boost: 35 }, suddenDeathPly: 120, deadlinePly: 220, wallDrainEvery: 8, aiWallLimit: 160 },
};

export const MAP_IDS = Object.keys(MAP_CONFIGS) as MapId[];
export const RUSH_MAP_IDS = MAP_IDS;
export const CONVERGENCE_MAP_IDS = MAP_IDS.filter(id => !!MAP_CONFIGS[id].convergence);

export type RuleSet = { energyMax: number; energyStart: number; assistStart: number; assistMax: number; breakCost: number; momentumTarget: number };
export const RULE_SETS: Record<Exclude<GameMode, 'convergence'>, RuleSet> = {
  classic: { energyMax: 0, energyStart: 0, assistStart: 0, assistMax: 0, breakCost: 0, momentumTarget: 0 },
  rush: { energyMax: 5, energyStart: 1, assistStart: 1, assistMax: 2, breakCost: 4, momentumTarget: 3 },
};

export function mapConfig(id: MapId = 'sprint'): MapConfig { return MAP_CONFIGS[id]; }
export function layoutConfig(map: MapConfig, id: LegacyRaceLayout = map.defaultLayout): LayoutConfig {
  return map.layouts[id] ?? map.layouts[map.defaultLayout]!;
}
export function convergenceSetup(map: MapConfig, playerCount: ConvergencePlayerCount): ConvergenceSetup | null {
  return map.convergence?.setups[playerCount] ?? null;
}
export function compatibleLayouts(map: MapConfig): LegacyRaceLayout[] {
  return (Object.keys(map.layouts) as LegacyRaceLayout[]).filter(id => !!map.layouts[id]);
}
export function pointInGoal(point: Point, goal: GoalZone, dimensions: BoardDimensions): boolean {
  if (goal.kind === 'cells') return goal.cells.some(cell => cell.row === point.row && cell.col === point.col);
  if (goal.edge === 'top') return point.row === 0;
  if (goal.edge === 'bottom') return point.row === dimensions.height - 1;
  if (goal.edge === 'left') return point.col === 0;
  return point.col === dimensions.width - 1;
}
export function goalLabel(goal: GoalZone): string {
  return goal.kind === 'cells' ? 'CENTER ZONE' : `${goal.edge.toUpperCase()} EDGE`;
}
