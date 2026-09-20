import { describe, expect, it } from 'vitest';
import { chooseAIAction } from './ai';
import { applyAction } from './engine';
import { legalMoves } from './movement';
import { hasRoute } from './pathfinding';
import { MAP_CONFIGS, MAP_IDS, isControllerCombinationSupported, mapDimensions, mapSupportsMode, matchCapability } from './modes';
import { activePlayerStates, currentPlayerId, newGame, rematchGame, type ControllerSelection, type GameState, type PlayerId, type Point } from './state';
import { viewForPlayer } from './view';

const human = (): ControllerSelection => ({ type: 'HUMAN_LOCAL' });
const ai = (difficulty: 'easy' | 'normal' | 'hard' = 'normal'): ControllerSelection => ({ type: 'AI', difficulty });
const p = (row: number, col: number): Point => ({ row, col });

function positionPlayers(state: GameState, positions: Partial<Record<PlayerId, Point>>): GameState {
  const players = activePlayerStates(state).map(player => positions[player.id] ? { ...player, position: positions[player.id]! } : player);
  return {
    ...state, players,
    pawns: {
      blue: positions.blue ?? state.pawns.blue,
      red: positions.red ?? state.pawns.red,
    },
  };
}

describe('unified map capability catalog', () => {
  it('keeps every public map in one catalog with explicit Classic and Rush capabilities', () => {
    expect(MAP_IDS).toEqual(['sprint', 'arena', 'wide', 'gauntlet', 'grand', 'titan']);
    for (const mapId of MAP_IDS) {
      expect(mapSupportsMode(mapId, 'classic')).toBe(true);
      expect(mapSupportsMode(mapId, 'rush')).toBe(true);
      expect(MAP_CONFIGS[mapId].capabilities.length).toBeGreaterThan(0);
    }
  });

  it('models race and true-center geometry variants under the same map identity', () => {
    expect(mapDimensions('arena', 'classic')).toEqual({ width: 10, height: 10 });
    expect(mapDimensions('arena', 'convergence')).toEqual({ width: 11, height: 11 });
    expect(mapDimensions('titan', 'rush')).toEqual({ width: 20, height: 20 });
    expect(mapDimensions('titan', 'convergence')).toEqual({ width: 21, height: 21 });
  });

  it('makes unsupported center geometries explicit', () => {
    expect(mapSupportsMode('sprint', 'convergence')).toBe(false);
    expect(mapSupportsMode('wide', 'convergence')).toBe(false);
    expect(mapSupportsMode('gauntlet', 'convergence')).toBe(false);
  });

  it('resolves controller policy independently from map selection', () => {
    const classic = matchCapability('wide', 'classic', 'parallel', 2)!;
    expect(isControllerCombinationSupported(classic, ['HUMAN_LOCAL', 'AI'])).toBe(true);
    expect(isControllerCombinationSupported(classic, ['HUMAN_LOCAL', 'HUMAN_LOCAL'])).toBe(true);
    const rush = matchCapability('wide', 'rush', 'parallel', 2)!;
    expect(isControllerCombinationSupported(rush, ['HUMAN_LOCAL', 'AI'])).toBe(true);
    expect(isControllerCombinationSupported(rush, ['HUMAN_LOCAL', 'HUMAN_LOCAL'])).toBe(false);
  });
});

describe('controller-independent local match construction', () => {
  it.each(MAP_IDS)('supports Classic human vs human on %s', mapId => {
    const state = newGame({ mode: 'classic', mapId, controllers: [human(), human()] });
    expect(activePlayerStates(state).map(player => player.controller)).toEqual(['HUMAN_LOCAL', 'HUMAN_LOCAL']);
    expect(applyAction(state, { type: 'move', to: legalMoves(state)[0] })).not.toBeNull();
  });

  it('supports non-default Parallel Classic with two local humans', () => {
    const state = newGame({ mode: 'classic', mapId: 'gauntlet', layout: 'parallel', controllers: [human(), human()] });
    const afterBlue = applyAction(state, { type: 'move', to: legalMoves(state)[0] })!;
    expect(currentPlayerId(afterBlue)).toBe('red');
    expect(activePlayerStates(afterBlue).find(player => player.id === 'red')?.controller).toBe('HUMAN_LOCAL');
  });

  it('preserves Rush human vs AI and rejects secrecy-breaking shared-screen Rush', () => {
    const state = newGame({ mode: 'rush', mapId: 'grand', seed: 41, controllers: [human(), ai('hard')] });
    expect(activePlayerStates(state).map(player => player.controller)).toEqual(['HUMAN_LOCAL', 'AI']);
    expect(() => newGame({ mode: 'rush', mapId: 'grand', controllers: [human(), human()] })).toThrow(/Unsupported controller combination/);
  });

  it('keeps enemy Phantom identity out of the opposing projection', () => {
    const state = newGame({ mode: 'rush', mapId: 'arena', seed: 7 });
    state.rush!.phantoms.push({ row: 1, col: 1, orientation: 'horizontal', owner: 'red' });
    const blue = viewForPlayer(state, 'blue');
    const red = viewForPlayer(state, 'red');
    expect(blue.walls.at(-1)?.knownPhantom).toBe(false);
    expect(red.walls.at(-1)?.knownPhantom).toBe(true);
  });

  it('preserves controller assignments and AI difficulty on rematch', () => {
    const state = newGame({ mode: 'convergence', mapId: 'grand', playerCount: 4, controllers: [human(), human(), ai('easy'), ai('hard')] });
    expect(activePlayerStates(rematchGame(state)).map(player => [player.controller, player.difficulty])).toEqual([
      ['HUMAN_LOCAL', 'normal'], ['HUMAN_LOCAL', 'normal'], ['AI', 'easy'], ['AI', 'hard'],
    ]);
  });
});

describe('Convergence AI through authoritative actions', () => {
  it.each([
    [2, [human(), ai('normal')]],
    [3, [human(), ai('easy'), ai('normal')]],
    [4, [human(), ai('easy'), ai('normal'), ai('hard')]],
  ] as const)('constructs %i-player mixed control matches', (playerCount, controllers) => {
    const mapId = playerCount === 2 ? 'arena' : 'grand';
    const state = newGame({ mode: 'convergence', mapId, playerCount, controllers: [...controllers] });
    expect(activePlayerStates(state).map(player => player.controller)).toEqual(controllers.map(controller => controller.type));
  });

  it('runs one human and three AI turns through the normal validator', () => {
    let state = newGame({ mode: 'convergence', mapId: 'grand', playerCount: 4, controllers: [human(), ai('easy'), ai('normal'), ai('hard')] });
    state = applyAction(state, { type: 'move', to: legalMoves(state)[0] })!;
    for (let index = 0; index < 3; index++) {
      const actor = activePlayerStates(state).find(player => player.id === currentPlayerId(state))!;
      const action = chooseAIAction(state, actor.difficulty, actor.id);
      expect(action).not.toBeNull();
      const accepted = applyAction(state, action!);
      expect(accepted).not.toBeNull();
      state = accepted!;
    }
    expect(currentPlayerId(state)).toBe('blue');
    expect(state.ply).toBe(4);
  });

  it('Hard AI sacrifices a move to stop an adjacent center threat', () => {
    let state = newGame({ mode: 'convergence', mapId: 'grand', playerCount: 4, controllers: [ai('hard'), human(), human(), human()] });
    state = positionPlayers(state, { blue: p(0, 7), red: p(7, 8), amber: p(14, 7), violet: p(7, 0) });
    const action = chooseAIAction(state, 'hard', 'blue');
    expect(action?.type).toBe('wall');
    const next = applyAction(state, action!)!;
    expect(next).not.toBeNull();
    expect(activePlayerStates(next).every(player => hasRoute(player.position, player.goal, next.walls, next))).toBe(true);
  });

  it('AI wall choices never bypass route preservation', () => {
    let state = newGame({ mode: 'convergence', mapId: 'titan', playerCount: 4, controllers: [ai('hard'), ai('hard'), ai('hard'), ai('hard')] });
    for (let turn = 0; turn < 20 && !state.winner; turn++) {
      const actor = activePlayerStates(state).find(player => player.id === currentPlayerId(state))!;
      const action = chooseAIAction(state, actor.difficulty, actor.id)!;
      const next = applyAction(state, action);
      expect(next).not.toBeNull();
      state = next!;
      expect(activePlayerStates(state).every(player => hasRoute(player.position, player.goal, state.walls, state))).toBe(true);
    }
  });
});

