import { GameMode, GameState, PLAYERS, Player, Point, PowerTile, RushEvent, Wall, inBounds, otherPlayer, samePoint } from './state';
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
  viewer: Player; mode: GameMode; mapId: MapId; layout: RaceLayout; width: number; height: number;
  goals: Record<Player, GoalZone>; pawns: Record<Player, Point>;
  walls: VisibleWall[]; pathWalls: Wall[]; remaining: Record<Player, number>; turn: Player;
  winner: GameState['winner']; ply: number; rush?: RushView;
};

/** The sole player/AI projection. Enemy decoys are indistinguishable from ordinary walls. */
export function viewForPlayer(state: GameState, viewer: Player): GameView {
  const real = state.walls.map(wall => ({ ...wall, knownPhantom: false }));
  const phantom = state.mode === 'rush' && state.rush ? state.rush.phantoms.map(wall => ({ ...wall, knownPhantom: wall.owner === viewer })) : [];
  const walls = [...real, ...phantom];
  const pathWalls = walls.filter(wall => !wall.knownPhantom).map(({ knownPhantom: _unused, ...wall }) => wall);
  const result: GameView = {
    viewer, mode: state.mode, mapId: state.mapId, layout: state.layout, width: state.width, height: state.height,
    goals: { blue: { ...state.goals.blue }, red: { ...state.goals.red } },
    pawns: { blue: { ...state.pawns.blue }, red: { ...state.pawns.red } }, walls, pathWalls,
    remaining: { ...state.remaining }, turn: state.turn, winner: state.winner, ply: state.ply,
  };
  if (state.mode === 'rush' && state.rush) {
    const rush = state.rush;
    const event = rush.event?.privateTo && rush.event.privateTo !== viewer ? { kind: 'wall' as const, text: 'A barrier appeared.' }
      : rush.event ? { ...rush.event, wall: rush.event.wall && { ...rush.event.wall } } : null;
    result.rush = {
      seed: rush.seed, seedLocked: rush.seedLocked, energy: { ...rush.energy }, assists: { ...rush.assists },
      momentum: { ...rush.momentum }, ownPhantomAvailable: rush.phantomAvailable[viewer],
      tiles: rush.tiles.map(tile => ({ ...tile, point: { ...tile.point } })), suddenDeath: rush.suddenDeath,
      pressureStage: rush.pressureStage, event, winnerReason: rush.winnerReason,
    };
  }
  return result;
}
export function perceivedMovementBoard(view: GameView) { return { ...view, walls: view.pathWalls }; }
export function probeTargets(view: GameView, player: Player = view.turn): Point[] {
  if (view.mode !== 'rush' || view.winner) return [];
  const from = view.pawns[player]; const opponent = view.pawns[otherPlayer(player)];
  return [{ row: from.row - 1, col: from.col }, { row: from.row + 1, col: from.col }, { row: from.row, col: from.col - 1 }, { row: from.row, col: from.col + 1 }]
    .filter(to => inBounds(to, view.width, view.height) && !samePoint(to, opponent) && blocksEdge(view.pathWalls, from, to));
}
export function canPlaceViewedWall(view: GameView, wall: Wall, phantom = false): boolean {
  const dimensions = { width: view.width, height: view.height };
  if (view.winner || view.remaining[view.viewer] <= 0 || (phantom && (view.mode !== 'rush' || !view.rush?.ownPhantomAvailable)) ||
      !isWallAnchorInBounds(wall, dimensions) || collidesWithWall(view.walls, wall)) return false;
  const geometry = [...view.walls, wall];
  return PLAYERS.every(player => hasRoute(view.pawns[player], view.goals[player], geometry, dimensions));
}

