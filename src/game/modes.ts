import type { ControllerType, GameMode, Player, PlayerId, Point } from './state';

export type MapId = 'sprint' | 'arena' | 'wide' | 'gauntlet' | 'grand' | 'titan';
/** Compatibility name retained for saved Phase 2 fixtures. Maps are now mode-independent. */
export type RushMapId = MapId;
export type RaceLayout = 'opposite' | 'parallel' | 'convergence';
export type LegacyRaceLayout = Exclude<RaceLayout, 'convergence'>;
export type GoalEdge = 'top' | 'bottom' | 'left' | 'right';
export type BoardDimensions = { width: number; height: number };
export type GoalZone = { kind: 'edge'; edge: GoalEdge; cell?: never } | { kind: 'cell'; cell: Point; edge?: never };
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
export type ConvergenceConfig = BoardDimensions & {
  supportedPlayerCounts: ConvergencePlayerCount[];
  setups: Partial<Record<ConvergencePlayerCount, ConvergenceSetup>>;
};
export type ControllerPolicy = 'LOCAL_OPEN' | 'LOCAL_RUSH_PRIVATE' | 'REMOTE_ONLY';
export type MatchCapability = {
  mode: GameMode;
  layout: RaceLayout;
  playerCounts: ConvergencePlayerCount[];
  geometry: 'race' | 'center';
  controllerPolicy: ControllerPolicy;
  online: boolean;
};
export type MatchConfiguration = {
  mode: GameMode;
  mapId: MapId;
  layout: RaceLayout;
  playerCount: ConvergencePlayerCount;
  controllers: ControllerType[];
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
  capabilities: MatchCapability[];
};

const CONVERGENCE_IDS: PlayerId[] = ['blue', 'red', 'amber', 'violet'];
const pointSpawn = (row: number, col: number, edge: GoalEdge): SpawnZone => ({ kind: 'point', point: { row, col }, edge });
const edgeGoal = (edge: GoalEdge): GoalZone => ({ kind: 'edge', edge });

export function centerGoalZone(width: number, height: number): GoalZone {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3 || width % 2 === 0 || height % 2 === 0) {
    throw new Error(`Convergence boards require odd dimensions of at least 3×3; received ${width}×${height}.`);
  }
  return { kind: 'cell', cell: { row: Math.floor(height / 2), col: Math.floor(width / 2) } };
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
  const goal = centerGoalZone(width, height);
  const supportedPlayerCounts = (Object.keys(walls).map(Number) as ConvergencePlayerCount[]).sort();
  return {
    width, height,
    supportedPlayerCounts,
    setups: Object.fromEntries(supportedPlayerCounts.map(playerCount => [playerCount, {
      playerCount,
      turnOrder: CONVERGENCE_IDS.slice(0, playerCount),
      spawns: convergenceSpawns(width, height, playerCount),
      goal,
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

type MapDefinition = Omit<MapConfig, 'capabilities'> & { onlineConvergence?: boolean };
function defineMap(definition: MapDefinition): MapConfig {
  const { onlineConvergence = false, ...map } = definition;
  const raceLayouts = (Object.keys(map.layouts) as LegacyRaceLayout[]).filter(layout => !!map.layouts[layout]);
  const capabilities: MatchCapability[] = raceLayouts.flatMap(layout => [
    { mode: 'classic', layout, playerCounts: [2], geometry: 'race', controllerPolicy: 'LOCAL_OPEN', online: true },
    // A shared screen cannot keep Phantom Walls private, so Rush is intentionally Human vs AI only.
    { mode: 'rush', layout, playerCounts: [2], geometry: 'race', controllerPolicy: 'LOCAL_RUSH_PRIVATE', online: true },
  ]);
  if (map.convergence) capabilities.push({
    mode: 'convergence', layout: 'convergence', playerCounts: [...map.convergence.supportedPlayerCounts],
    geometry: 'center', controllerPolicy: 'LOCAL_OPEN', online: onlineConvergence,
  });
  return { ...map, capabilities };
}

export const MAP_CONFIGS: Record<MapId, MapConfig> = {
  sprint: defineMap({ id: 'sprint', name: 'Sprint', width: 7, height: 7, startingWalls: 7, layouts: layouts(7, 7), defaultLayout: 'opposite', rewardRange: [2, 4], rewardWeights: { energy: 55, boost: 45 }, suddenDeathPly: 32, deadlinePly: 64, wallDrainEvery: 4, aiWallLimit: 72 }),
  arena: defineMap({ id: 'arena', name: 'Arena', width: 10, height: 10, startingWalls: 10, layouts: layouts(10, 10), defaultLayout: 'opposite', convergence: convergence(11, 11, { 2: 5 }), onlineConvergence: true, rewardRange: [4, 6], rewardWeights: { energy: 55, boost: 45 }, suddenDeathPly: 50, deadlinePly: 96, wallDrainEvery: 5, aiWallLimit: 96 }),
  wide: defineMap({ id: 'wide', name: 'Wide', width: 12, height: 7, startingWalls: 9, layouts: layouts(12, 7, 'horizontal'), defaultLayout: 'opposite', rewardRange: [4, 6], rewardWeights: { energy: 60, boost: 40 }, suddenDeathPly: 40, deadlinePly: 80, wallDrainEvery: 4, aiWallLimit: 96 }),
  gauntlet: defineMap({ id: 'gauntlet', name: 'Gauntlet', width: 10, height: 18, startingWalls: 14, layouts: layouts(10, 18, 'vertical'), defaultLayout: 'opposite', rewardRange: [6, 8], rewardWeights: { energy: 60, boost: 40 }, suddenDeathPly: 72, deadlinePly: 140, wallDrainEvery: 6, aiWallLimit: 120 }),
  grand: defineMap({ id: 'grand', name: 'Grand', width: 15, height: 15, startingWalls: 16, layouts: layouts(15, 15), defaultLayout: 'opposite', convergence: convergence(15, 15, { 2: 10, 3: 7, 4: 5 }), onlineConvergence: true, rewardRange: [8, 10], rewardWeights: { energy: 60, boost: 40 }, suddenDeathPly: 84, deadlinePly: 160, wallDrainEvery: 7, aiWallLimit: 140 }),
  titan: defineMap({ id: 'titan', name: 'Titan', width: 20, height: 20, startingWalls: 20, layouts: layouts(20, 20), defaultLayout: 'opposite', convergence: convergence(21, 21, { 2: 14, 3: 9, 4: 7 }), onlineConvergence: true, rewardRange: [10, 14], rewardWeights: { energy: 65, boost: 35 }, suddenDeathPly: 120, deadlinePly: 220, wallDrainEvery: 8, aiWallLimit: 160 }),
};

export const MAP_IDS = Object.keys(MAP_CONFIGS) as MapId[];
export const RUSH_MAP_IDS = MAP_IDS;
export const CONVERGENCE_MAP_IDS = MAP_IDS.filter(id => !!MAP_CONFIGS[id].convergence);

export function matchCapability(mapId: MapId, mode: GameMode, layout: RaceLayout, playerCount: number): MatchCapability | null {
  return MAP_CONFIGS[mapId].capabilities.find(capability => capability.mode === mode && capability.layout === layout && capability.playerCounts.includes(playerCount as ConvergencePlayerCount)) ?? null;
}
export function mapSupportsMode(mapId: MapId, mode: GameMode): boolean {
  return MAP_CONFIGS[mapId].capabilities.some(capability => capability.mode === mode);
}
export function mapDimensions(mapId: MapId, mode: GameMode): BoardDimensions {
  const map = MAP_CONFIGS[mapId];
  return mode === 'convergence' && map.convergence ? { width: map.convergence.width, height: map.convergence.height } : { width: map.width, height: map.height };
}
export function isControllerCombinationSupported(capability: MatchCapability, controllers: readonly ControllerType[], online = false): boolean {
  if (!capability.playerCounts.includes(controllers.length as ConvergencePlayerCount)) return false;
  if (online) return capability.online && controllers.every(controller => controller === 'HUMAN_REMOTE');
  if (controllers.some(controller => controller === 'HUMAN_REMOTE')) return false;
  if (capability.controllerPolicy === 'LOCAL_RUSH_PRIVATE') return controllers.length === 2 && controllers[0] === 'HUMAN_LOCAL' && controllers[1] === 'AI';
  return controllers.every(controller => controller === 'HUMAN_LOCAL' || controller === 'AI');
}
export function resolveMatchCapability(configuration: MatchConfiguration, online = false): MatchCapability | null {
  const capability = matchCapability(configuration.mapId, configuration.mode, configuration.layout, configuration.playerCount);
  if (!capability || !isControllerCombinationSupported(capability, configuration.controllers, online)) return null;
  return capability;
}
export function onlineMatchConfiguration(mode: GameMode, mapId: MapId, layout: RaceLayout, playerCount: ConvergencePlayerCount): MatchConfiguration {
  return { mode, mapId, layout, playerCount, controllers: Array.from({ length: playerCount }, () => 'HUMAN_REMOTE') };
}
export function unsupportedMapReason(mapId: MapId, mode: GameMode): string | null {
  if (mapSupportsMode(mapId, mode)) return null;
  if (mode === 'convergence') return 'No balanced true-center layout';
  return 'Unsupported by this ruleset';
}

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
  if (goal.kind === 'cell') return goal.cell.row === point.row && goal.cell.col === point.col;
  if (goal.edge === 'top') return point.row === 0;
  if (goal.edge === 'bottom') return point.row === dimensions.height - 1;
  if (goal.edge === 'left') return point.col === 0;
  return point.col === dimensions.width - 1;
}
export function goalLabel(goal: GoalZone): string {
  return goal.kind === 'cell' ? 'CENTER CELL' : `${goal.edge.toUpperCase()} EDGE`;
}
