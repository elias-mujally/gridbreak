import { describe, expect, it } from 'vitest';
import { chooseAIAction } from './ai';
import { applyAction } from './engine';
import { legalAssistPaths } from './movement';
import { hasRoute } from './pathfinding';
import { MAP_CONFIGS, RULE_SETS } from './modes';
import { GameState, Point, Wall, newGame } from './state';
import { generateTiles } from './tiles';
import { isLegalWall } from './walls';
import { probeTargets, viewForPlayer } from './view';

const p = (row: number, col: number): Point => ({ row, col });
const h = (row: number, col: number): Wall => ({ row, col, orientation: 'horizontal' });
const v = (row: number, col: number): Wall => ({ row, col, orientation: 'vertical' });
const rush = (): GameState => newGame({ mode: 'rush', mapId: 'sprint', seed: 19, seedLocked: true });

describe('Rush Assist, rewards, and resources', () => {
  it('starts with one serializable Assist and caps inventory at two', () => {
    const state = rush();
    expect(state.rush?.assists).toEqual({ blue: 1, red: 1 });
    expect(RULE_SETS.rush.assistMax).toBe(2);
    expect(JSON.parse(JSON.stringify(state)).rush.assists.blue).toBe(1);
  });

  it('consumes one Assist and does not spend Energy', () => {
    const state = rush();
    const next = applyAction(state, { type: 'assist', via: p(5, 3), to: p(4, 3) })!;
    expect(next.pawns.blue).toEqual(p(4, 3));
    expect(next.rush?.assists.blue).toBe(0);
    expect(next.rush?.energy.blue).toBe(2); // one Energy for forward progress
    expect(applyAction({ ...next, turn: 'blue' }, { type: 'assist', via: p(3, 3), to: p(2, 3) })).toBeNull();
  });

  it('requires both Assist legs to obey real walls', () => {
    const action = { type: 'assist' as const, via: p(5, 3), to: p(4, 3) };
    expect(applyAction({ ...rush(), walls: [h(5, 3)] }, action)).toBeNull();
    expect(applyAction({ ...rush(), walls: [h(4, 3)] }, action)).toBeNull();
    expect(legalAssistPaths(rush()).some(path => path.via.row === 5 && path.to.row === 4)).toBe(true);
  });

  it('keeps collision jump and side-step behavior separate from Assist inventory', () => {
    const state = { ...rush(), pawns: { blue: p(3, 3), red: p(2, 3) }, rush: { ...rush().rush!, assists: { blue: 0, red: 0 } } };
    expect(applyAction(state, { type: 'move', to: p(1, 3) })?.pawns.blue).toEqual(p(1, 3));
  });

  it('makes Boost grant +1 Assist and respects the maximum', () => {
    const base = rush();
    const tile = { kind: 'boost' as const, point: p(5, 3), consumed: false };
    const collected = applyAction({ ...base, rush: { ...base.rush!, tiles: [tile] } }, { type: 'move', to: p(5, 3) })!;
    expect(collected.rush?.assists.blue).toBe(2);
    expect(collected.rush?.event?.text).toBe('🚀 +1 ASSIST');
    const capped = applyAction({ ...base, rush: { ...base.rush!, assists: { blue: 2, red: 1 }, tiles: [tile] } }, { type: 'move', to: p(5, 3) })!;
    expect(capped.rush?.assists.blue).toBe(2);
  });

  it('makes Energy pickup feedback immediate and keeps Energy capped', () => {
    const base = rush();
    const state = { ...base, rush: { ...base.rush!, energy: { blue: 5, red: 1 }, tiles: [{ kind: 'energy' as const, point: p(5, 3), consumed: false }] } };
    const next = applyAction(state, { type: 'move', to: p(5, 3) })!;
    expect(next.rush?.energy.blue).toBe(5);
    expect(next.rush?.event?.text).toBe('⚡ +1 ENERGY');
  });

  it('breaks only an enemy wall and spends four Energy', () => {
    const base = rush(); const wall = { ...v(2, 2), owner: 'red' as const };
    const state = { ...base, walls: [wall], rush: { ...base.rush!, energy: { blue: 4, red: 1 } } };
    const next = applyAction(state, { type: 'break', wall })!;
    expect(next.walls).toHaveLength(0); expect(next.rush?.energy.blue).toBe(0);
    expect(applyAction({ ...state, rush: { ...state.rush!, energy: { blue: 3, red: 1 } } }, { type: 'break', wall })).toBeNull();
  });

  it('awards bounded Momentum after three progressive turns', () => {
    const base = rush();
    const next = applyAction({ ...base, rush: { ...base.rush!, momentum: { blue: 2, red: 0 }, tiles: [] } }, { type: 'move', to: p(5, 3) })!;
    expect(next.rush?.momentum.blue).toBe(0); expect(next.rush?.energy.blue).toBe(3);
  });

  it('allows a final-cell victory through Assist', () => {
    const base = rush();
    const state = { ...base, pawns: { blue: p(2, 3), red: p(5, 3) }, rush: { ...base.rush!, tiles: [] } };
    const next = applyAction(state, { type: 'assist', via: p(1, 3), to: p(0, 3) });
    expect(next?.winner).toBe('blue'); expect(next?.rush?.winnerReason).toBe('goal');
  });
});

describe('seeded reward generation', () => {
  it('reproduces identical layouts from identical seeds', () => {
    expect(generateTiles(12345, MAP_CONFIGS.arena)).toEqual(generateTiles(12345, MAP_CONFIGS.arena));
  });

  it('varies reward count, placement, and composition across seeds', () => {
    const samples = Array.from({ length: 24 }, (_, seed) => generateTiles(seed + 1, MAP_CONFIGS.arena));
    expect(new Set(samples.map(tiles => tiles.length)).size).toBeGreaterThan(1);
    expect(new Set(samples.map(tiles => tiles.map(tile => `${tile.point.row},${tile.point.col}`).join('|'))).size).toBeGreaterThan(8);
    expect(new Set(samples.map(tiles => tiles.map(tile => tile.kind).join('|'))).size).toBeGreaterThan(1);
  });

  it('keeps rewards valid, symmetric, and away from both starts on every map', () => {
    for (const config of Object.values(MAP_CONFIGS)) for (const seed of [1, 7, 99, 203]) {
      const tiles = generateTiles(seed, config);
      expect(tiles.length).toBeGreaterThanOrEqual(config.rewardRange[0]);
      expect(tiles.length).toBeLessThanOrEqual(config.rewardRange[1]);
      for (const tile of tiles) {
        expect(tile.point.row).toBeGreaterThan(0); expect(tile.point.row).toBeLessThan(config.height - 1);
        const mirror = { row: config.height - 1 - tile.point.row, col: config.width - 1 - tile.point.col };
        expect(tiles.some(other => other.kind === tile.kind && other.point.row === mirror.row && other.point.col === mirror.col)).toBe(true);
      }
    }
  });
});

describe('Phantom secrecy and route guarantees', () => {
  it('shows the Phantom identity only to its owner', () => {
    const next = applyAction(rush(), { type: 'phantom', wall: h(2, 2) })!;
    expect(viewForPlayer(next, 'blue').walls.find(w => w.row === 2 && w.col === 2)?.knownPhantom).toBe(true);
    expect(viewForPlayer(next, 'red').walls.find(w => w.row === 2 && w.col === 2)?.knownPhantom).toBe(false);
    expect(JSON.stringify(viewForPlayer(next, 'red'))).not.toContain('phantoms');
  });

  it('reveals and removes a Phantom when crossed', () => {
    const base = rush();
    const state = { ...base, turn: 'red' as const, rush: { ...base.rush!, phantoms: [{ ...h(0, 2), owner: 'blue' as const }], tiles: [] } };
    expect(probeTargets(viewForPlayer(state, 'red'), 'red')).toContainEqual(p(1, 3));
    const next = applyAction(state, { type: 'probe', to: p(1, 3) })!;
    expect(next.pawns.red).toEqual(p(1, 3)); expect(next.rush?.phantoms).toHaveLength(0);
  });

  it('gives AI identical actions for identical visible real and Phantom walls', () => {
    const base = rush(); const wall = { ...h(0, 2), owner: 'blue' as const };
    const real = { ...base, turn: 'red' as const, walls: [wall] };
    const phantom = { ...base, turn: 'red' as const, rush: { ...base.rush!, phantoms: [wall], phantomAvailable: { blue: false, red: true } } };
    expect(viewForPlayer(real, 'red').walls).toEqual(viewForPlayer(phantom, 'red').walls);
    for (const difficulty of ['easy', 'normal', 'hard'] as const) expect(chooseAIAction(real, difficulty)).toEqual(chooseAIAction(phantom, difficulty));
  });

  it('keeps a physical route after every accepted wall', () => {
    const state = rush(); const next = applyAction(state, { type: 'wall', wall: h(3, 2) })!;
    const dimensions = { width: next.width, height: next.height };
    expect(isLegalWall(state, h(3, 2))).toBe(true);
    expect(hasRoute(next.pawns.blue, next.goals.blue, next.walls, dimensions)).toBe(true);
    expect(hasRoute(next.pawns.red, next.goals.red, next.walls, dimensions)).toBe(true);
  });
});

describe('Sudden Death', () => {
  it('uses the selected map threshold and deadline', () => {
    const base = rush(); const map = MAP_CONFIGS.sprint;
    const threshold = applyAction({ ...base, ply: map.suddenDeathPly - 1 }, { type: 'move', to: p(5, 3) })!;
    expect(threshold.rush?.suddenDeath).toBe(true);
    const late = { ...base, ply: map.deadlinePly - 1, pawns: { blue: p(3, 3), red: p(1, 3) }, rush: { ...base.rush!, suddenDeath: true, pressureStage: 20 } };
    expect(applyAction(late, { type: 'move', to: p(2, 3) })?.rush?.winnerReason).toBe('deadline');
  });
});
