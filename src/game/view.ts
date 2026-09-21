import { GameMode, GameState, Player, PlayerId, PlayerState, Point, PowerTile, RushEvent, Wall, activePlayerStates, inBounds, otherPlayer, samePoint } from './state';
import { blocksEdge, collidesWithWall, isWallAnchorInBounds } from './walls';
import { hasRoute } from './pathfinding';
import type { GoalZone, MapId, RaceLayout } from './modes';

export type VisibleWall = Wall & { knownPhantom: boolean };
export type RushView = {
  seed: number; seedLocked: boolean; energy: Record<Player, number>; assists: Record<Player, number>;
  momentum: Record<Player, number>; ownPhantomAvailable: boolean; tiles: PowerTile[]; suddenDeath: boolean;
  pressureStage: number; event: RushEvent | null; winnerReason: 'goal' | 'deadline' | null;
};
export type GameView = {
  viewer: PlayerId; mode: GameMode; mapId: MapId; layout: RaceLayout; width: number; height: number;
  players: PlayerState[]; turnOrder: PlayerId[]; currentTurnIndex: number;
  goals: Record<Player, GoalZone>; pawns: Record<Player, Point>;
  walls: VisibleWall[]; pathWalls: Wall[]; remaining: Record<Player, number>; turn: PlayerId;
  winner: GameState['winner']; ply: number; rush?: RushView;
};

/** The sole player/AI projection. Enemy decoys are indistinguishable from ordinary walls. */
export function viewForPlayer(state: GameState, viewer: PlayerId): GameView {
  if (state.mode === 'rush' && viewer !== 'blue' && viewer !== 'red') throw new Error('Rush views require a two-player viewer.');
  const rushViewer = viewer === 'red' ? 'red' : 'blue';
  const real = state.walls.map(wall => ({ ...wall, knownPhantom: false }));
  const phantom = state.mode === 'rush' && state.rush ? state.rush.phantoms.map(wall => ({ ...wall, knownPhantom: wall.owner === rushViewer })) : [];
  // Sorting removes the real-first/phantom-last ordering side channel from serialized views.
  const walls = [...real, ...phantom].sort((a, b) => `${a.orientation}:${a.row}:${a.col}`.localeCompare(`${b.orientation}:${b.row}:${b.col}`));
  const pathWalls = walls.filter(wall => !wall.knownPhantom).map(({ knownPhantom: _unused, ...wall }) => wall);
  const result: GameView = {
    viewer, mode: state.mode, mapId: state.mapId, layout: state.layout, width: state.width, height: state.height,
    players: activePlayerStates(state).map(player => ({ ...player, phantomAvailable: false, spawn: { ...player.spawn }, position: { ...player.position }, goal: player.goal.kind === 'cell' ? { kind: 'cell', cell: { ...player.goal.cell } } : { ...player.goal } })),
    turnOrder: [...(state.turnOrder ?? ['blue', 'red'])], currentTurnIndex: state.currentTurnIndex ?? (state.turn === 'red' ? 1 : 0),
    goals: { blue: state.goals.blue.kind === 'cell' ? { kind: 'cell', cell: { ...state.goals.blue.cell } } : { ...state.goals.blue }, red: state.goals.red.kind === 'cell' ? { kind: 'cell', cell: { ...state.goals.red.cell } } : { ...state.goals.red } },
    pawns: { blue: { ...state.pawns.blue }, red: { ...state.pawns.red } }, walls, pathWalls,
    remaining: { ...state.remaining }, turn: state.turn, winner: state.winner, ply: state.ply,
  };
  if (state.mode === 'rush' && state.rush) {
    const rush = state.rush;
    const event = rush.event?.privateTo && rush.event.privateTo !== rushViewer ? { kind: 'wall' as const, text: 'A barrier appeared.' }
      : rush.event ? { ...rush.event, wall: rush.event.wall && { ...rush.event.wall } } : null;
    result.rush = {
      seed: rush.seed, seedLocked: rush.seedLocked, energy: { ...rush.energy }, assists: { ...rush.assists },
      momentum: { ...rush.momentum }, ownPhantomAvailable: rush.phantomAvailable[rushViewer],
      tiles: rush.tiles.map(tile => ({ ...tile, point: { ...tile.point } })), suddenDeath: rush.suddenDeath,
      pressureStage: rush.pressureStage, event, winnerReason: rush.winnerReason,
    };
  }
  return result;
}
export function perceivedMovementBoard(view: GameView) { return { ...view, walls: view.pathWalls }; }
export function probeTargets(view: GameView, player: Player = view.turn as Player): Point[] {
  if (view.mode !== 'rush' || view.winner) return [];
  const from = view.pawns[player]; const opponent = view.pawns[otherPlayer(player)];
  return [{ row: from.row - 1, col: from.col }, { row: from.row + 1, col: from.col }, { row: from.row, col: from.col - 1 }, { row: from.row, col: from.col + 1 }]
    .filter(to => inBounds(to, view.width, view.height) && !samePoint(to, opponent) && blocksEdge(view.pathWalls, from, to));
}
export function canPlaceViewedWall(view: GameView, wall: Wall, phantom = false): boolean {
  const dimensions = { width: view.width, height: view.height };
  const viewer = view.viewer === 'red' ? 'red' : 'blue';
  if (view.winner || view.remaining[viewer] <= 0 || (phantom && (view.mode !== 'rush' || !view.rush?.ownPhantomAvailable)) ||
      !isWallAnchorInBounds(wall, dimensions) || collidesWithWall(view.walls, wall)) return false;
  const geometry = [...view.walls, wall];
  return view.players.every(player => hasRoute(player.position, player.goal, geometry, dimensions));
}
