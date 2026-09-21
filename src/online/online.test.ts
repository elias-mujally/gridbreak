import { describe, expect, it } from 'vitest';
import { generateRoomCode } from './identity';
import { GAME_BUILD_VERSION, MAX_MESSAGE_BYTES, PROTOCOL_VERSION, normalizeRoomCode, parseClientMessage, validateCreateRoomRequest, validateJoinRoomRequest, validateOnlineConfiguration, type ClientCommand } from './protocol';
import { ABANDON_AFTER_MS, OnlineRoom, RECONNECT_GRACE_MS, ROOM_EXPIRY_MS } from './room';
import { compatibleLayouts, MAP_CONFIGS, MAP_IDS, onlineMatchConfiguration, type ConvergencePlayerCount, type MapId, type MatchConfiguration, type RaceLayout } from '../game/modes';
import { activePlayerStates, type Action, type GameState, type Point, type Wall } from '../game/state';
import { legalMoves } from '../game/movement';
import { legalWalls } from '../game/walls';

let actionCounter = 0;
const now = 10_000;
const p = (row: number, col: number): Point => ({ row, col });
const h = (row: number, col: number): Wall => ({ row, col, orientation: 'horizontal' });
const v = (row: number, col: number): Wall => ({ row, col, orientation: 'vertical' });
const configuration = (mode: MatchConfiguration['mode'] = 'convergence', mapId: MapId = mode === 'convergence' ? 'arena' : 'sprint', layout: RaceLayout = mode === 'convergence' ? 'convergence' : 'opposite', playerCount: ConvergencePlayerCount = 2) => onlineMatchConfiguration(mode, mapId, layout, playerCount);

function createRoom(config = configuration()) {
  const room = OnlineRoom.create({ code: 'GB-X7K9', configuration: config, sessionId: 'session-1', tokenHash: 'hash-1', displayName: 'Player One', now });
  const sessions = ['session-1'];
  for (let index = 2; index <= config.playerCount; index++) {
    const sessionId = `session-${index}`;
    expect(room.join({ sessionId, tokenHash: `hash-${index}`, displayName: `Player ${index}`, now: now + index }).ok).toBe(true);
    sessions.push(sessionId);
  }
  return { room, sessions };
}
function command(room: OnlineRoom, sessionId: string, type: ClientCommand['type'], extra: Record<string, unknown> = {}, expectedSequence = room.sequence()): ClientCommand {
  return { type, protocolVersion: PROTOCOL_VERSION, buildVersion: GAME_BUILD_VERSION, roomCode: 'GB-X7K9', sessionId, actionId: `action-${(++actionCounter).toString().padStart(8, '0')}`, expectedSequence, ...extra } as ClientCommand;
}
function startRoom(config = configuration()) {
  const setup = createRoom(config);
  for (const session of setup.sessions) expect(setup.room.connect(session, now + 20).accepted).toBe(true);
  for (const session of setup.sessions) expect(setup.room.command(session, command(setup.room, session, 'READY', { ready: true }), now + 30).accepted).toBe(true);
  expect(setup.room.command(setup.sessions[0], command(setup.room, setup.sessions[0], 'START'), now + 40).accepted).toBe(true);
  return setup;
}
function authoritative(room: OnlineRoom): GameState { return room.persisted().game!; }
function send(room: OnlineRoom, sessionId: string, action: Action) { return room.command(sessionId, command(room, sessionId, 'GAME_ACTION', { action }), now); }

describe('online V2 protocol and capability validation', () => {
  it('increments compatibility metadata and rejects V1 clients', () => {
    expect(PROTOCOL_VERSION).toBe(2); expect(GAME_BUILD_VERSION).toBe('online-modes-v2');
    expect(validateCreateRoomRequest({ protocolVersion: 1, buildVersion: 'convergence-online-v1', displayName: 'Valid Name', configuration: configuration() })).toMatchObject({ ok: false, code: 'VERSION_MISMATCH' });
  });
  it('generates readable room-code shapes without ambiguous characters', () => {
    const codes = new Set(Array.from({ length: 2_000 }, () => generateRoomCode()));
    expect(codes.size).toBeGreaterThan(1_990); expect([...codes].every(code => /^GB-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/.test(code))).toBe(true);
  });
  it('normalizes room codes and validates joining', () => {
    expect(normalizeRoomCode(' gb-x7k9 ')).toBe('GB-X7K9');
    expect(validateJoinRoomRequest({ protocolVersion: PROTOCOL_VERSION, buildVersion: GAME_BUILD_VERSION, displayName: 'Guest Two', roomCode: 'bad' })).toMatchObject({ ok: false, code: 'ROOM_NOT_FOUND' });
  });
  it('accepts every compatible Classic map and layout from the shared catalog', () => {
    for (const mapId of MAP_IDS) for (const layout of compatibleLayouts(MAP_CONFIGS[mapId])) expect(validateOnlineConfiguration(configuration('classic', mapId, layout))).toMatchObject({ ok: true });
  });
  it('accepts every compatible Rush map and layout from the shared catalog', () => {
    for (const mapId of MAP_IDS) for (const layout of compatibleLayouts(MAP_CONFIGS[mapId])) expect(validateOnlineConfiguration(configuration('rush', mapId, layout))).toMatchObject({ ok: true });
  });
  it('accepts 2–4 player Convergence only where configured', () => {
    expect(validateOnlineConfiguration(configuration('convergence', 'arena', 'convergence', 2))).toMatchObject({ ok: true });
    for (const count of [2, 3, 4] as const) expect(validateOnlineConfiguration(configuration('convergence', 'grand', 'convergence', count))).toMatchObject({ ok: true });
    expect(validateOnlineConfiguration(configuration('convergence', 'arena', 'convergence', 4))).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  });
  it('rejects unsupported layouts, player counts, controllers, and unknown maps', () => {
    expect(validateOnlineConfiguration(configuration('classic', 'sprint', 'parallel'))).toMatchObject({ ok: false });
    expect(validateOnlineConfiguration({ ...configuration('rush'), controllers: ['HUMAN_LOCAL', 'HUMAN_REMOTE'] })).toMatchObject({ ok: false });
    expect(validateOnlineConfiguration({ ...configuration('classic'), playerCount: 3, controllers: ['HUMAN_REMOTE', 'HUMAN_REMOTE', 'HUMAN_REMOTE'] })).toMatchObject({ ok: false });
  });
  it('rejects invalid names, malformed JSON, oversized payloads, and state-forging fields', () => {
    expect(validateCreateRoomRequest({ protocolVersion: PROTOCOL_VERSION, buildVersion: GAME_BUILD_VERSION, displayName: '<x>', configuration: configuration() })).toMatchObject({ ok: false, code: 'INVALID_NAME' });
    expect(parseClientMessage('{')).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    expect(parseClientMessage('x'.repeat(MAX_MESSAGE_BYTES + 1))).toMatchObject({ ok: false, code: 'PAYLOAD_TOO_LARGE' });
    expect(parseClientMessage(JSON.stringify({ type: 'GAME_ACTION', protocolVersion: PROTOCOL_VERSION, buildVersion: GAME_BUILD_VERSION, roomCode: 'GB-X7K9', sessionId: 'session-1', actionId: 'action-123456', expectedSequence: 0, action: { type: 'move', to: p(1, 1), winner: 'blue' } }))).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  });
  it('parses every Rush intent without accepting authoritative fields', () => {
    const actions: Action[] = [{ type: 'move', to: p(1, 1) }, { type: 'wall', wall: h(1, 1) }, { type: 'assist', via: p(1, 1), to: p(2, 1) }, { type: 'break', wall: h(1, 1) }, { type: 'phantom', wall: h(1, 1) }, { type: 'probe', to: p(1, 1) }];
    for (const action of actions) expect(parseClientMessage(JSON.stringify({ type: 'GAME_ACTION', protocolVersion: PROTOCOL_VERSION, buildVersion: GAME_BUILD_VERSION, roomCode: 'GB-X7K9', sessionId: 'session-1', actionId: `rush-${action.type}-1234`, expectedSequence: 0, action }))).toMatchObject({ ok: true });
  });
});

describe('general authoritative room lifecycle', () => {
  it('projects an UNLISTED room without exposing session IDs or tokens', () => {
    const { room } = createRoom(configuration('classic'));
    const snapshot = room.snapshot('session-1', now); const json = JSON.stringify(snapshot);
    expect(snapshot).toMatchObject({ code: 'GB-X7K9', visibility: 'UNLISTED', phase: 'waiting', selfPlayerId: 'blue', configuration: { mode: 'classic' } });
    expect(snapshot.members[0]).toMatchObject({ playerId: 'blue', isHost: true, isSelf: true });
    expect(json).not.toContain('session-1'); expect(json).not.toContain('hash-1'); expect(json).not.toContain('tokenHash');
  });
  it('authenticates tokens, assigns deterministic seats, and rejects full rooms', () => {
    const { room } = createRoom();
    expect(room.authenticate('session-1', 'hash-1')).toBe(true); expect(room.authenticate('session-1', 'forged')).toBe(false);
    expect(room.snapshot('session-2', now).members.map(member => member.playerId)).toEqual(['blue', 'red']);
    expect(room.join({ sessionId: 'session-3', tokenHash: 'hash-3', displayName: 'Third', now })).toMatchObject({ ok: false, code: 'ROOM_FULL' });
  });
  it('requires a complete connected Ready lobby and host start', () => {
    const { room, sessions } = createRoom(configuration('classic'));
    for (const session of sessions) room.connect(session, now);
    expect(room.command(sessions[0], command(room, sessions[0], 'START'), now)).toMatchObject({ accepted: false, code: 'INVALID_START' });
    for (const session of sessions) room.command(session, command(room, session, 'READY', { ready: true }), now);
    expect(room.snapshot(sessions[0], now).phase).toBe('ready');
    expect(room.command(sessions[1], command(room, sessions[1], 'START'), now)).toMatchObject({ accepted: false, code: 'NOT_HOST' });
  });
  it.each([2, 3, 4] as const)('starts %i-player Convergence with remote controllers', count => {
    const { room } = startRoom(configuration('convergence', count === 2 ? 'arena' : 'grand', 'convergence', count));
    const game = authoritative(room); expect(activePlayerStates(game)).toHaveLength(count); expect(activePlayerStates(game).every(player => player.controller === 'HUMAN_REMOTE')).toBe(true);
  });
  it('preserves sequencing, rejects replay IDs, stale state, wrong turns, and spoofed sessions', () => {
    const { room, sessions } = startRoom(configuration('classic'));
    const move = legalMoves(authoritative(room), 'blue')[0]; const envelope = command(room, sessions[0], 'GAME_ACTION', { action: { type: 'move', to: move } });
    expect(room.command(sessions[0], envelope, now).accepted).toBe(true);
    expect(room.command(sessions[0], envelope, now)).toMatchObject({ accepted: false, code: 'DUPLICATE_ACTION' });
    expect(room.command(sessions[1], command(room, sessions[1], 'GAME_ACTION', { action: { type: 'move', to: p(1, 1) } }, 0), now)).toMatchObject({ accepted: false, code: 'STALE_SEQUENCE' });
    const spoof = command(room, sessions[1], 'GAME_ACTION', { action: { type: 'move', to: p(1, 1) } }) as ClientCommand & { sessionId: string }; spoof.sessionId = sessions[0];
    expect(room.command(sessions[1], spoof, now)).toMatchObject({ accepted: false, code: 'UNAUTHENTICATED' });
  });
  it('reconnects the same seat without advancing, duplicating, or revealing other credentials', () => {
    const { room, sessions } = startRoom(configuration('convergence', 'grand', 'convergence', 3)); const before = authoritative(room);
    room.disconnect(sessions[0], now + 1); expect(room.snapshot(sessions[0], now + RECONNECT_GRACE_MS - 1).members[0].connection).toBe('reconnecting');
    const restored = OnlineRoom.restore(room.persisted()); expect(restored.connect(sessions[0], now + 2).accepted).toBe(true);
    expect(restored.snapshot(sessions[0], now).members).toHaveLength(3); expect(authoritative(restored).turn).toBe(before.turn); expect(activePlayerStates(authoritative(restored)).map(player => player.position)).toEqual(activePlayerStates(before).map(player => player.position));
  });
  it('moves all-disconnected games through abandoned and expired lifecycle states', () => {
    const { room, sessions } = startRoom(); for (const session of sessions) room.disconnect(session, now);
    expect(room.sweep(now + ABANDON_AFTER_MS)).toBe(true); expect(room.persisted().phase).toBe('abandoned');
    expect(room.sweep(room.persisted().lastActivityAt + ROOM_EXPIRY_MS)).toBe(true); expect(room.persisted().phase).toBe('expired');
  });
});

describe('Classic Online', () => {
  it.each(MAP_IDS)('starts Classic on %s', mapId => {
    const { room } = startRoom(configuration('classic', mapId, MAP_CONFIGS[mapId].defaultLayout));
    expect(authoritative(room)).toMatchObject({ mode: 'classic', mapId, winner: null });
  });
  it.each([['wide', 'parallel'], ['gauntlet', 'parallel']] as const)('starts %s %s', (mapId, layout) => {
    expect(authoritative(startRoom(configuration('classic', mapId, layout)).room)).toMatchObject({ mapId, layout });
  });
  it('accepts movement and walls, rejects teleports and route sealing', () => {
    const { room, sessions } = startRoom(configuration('classic', 'sprint'));
    expect(send(room, sessions[0], { type: 'move', to: p(3, 3) })).toMatchObject({ accepted: false, code: 'ILLEGAL_ACTION' });
    expect(send(room, sessions[0], { type: 'move', to: legalMoves(authoritative(room), 'blue')[0] }).accepted).toBe(true);
    expect(send(room, sessions[1], { type: 'wall', wall: h(1, 1) }).accepted).toBe(true);
    const stored = room.persisted(); stored.game!.turn = 'blue'; stored.game!.currentTurnIndex = 0; stored.game!.walls = [h(0, 0), h(0, 2), v(0, 4)];
    const trapped = OnlineRoom.restore(stored); expect(send(trapped, sessions[0], { type: 'wall', wall: h(0, 4) })).toMatchObject({ accepted: false, code: 'ILLEGAL_ACTION' });
  });
  it('declares edge victory server-side and rematches only after both votes', () => {
    const { room, sessions } = startRoom(configuration('classic', 'sprint')); const stored = room.persisted(); stored.game!.pawns.blue = p(1, 2); stored.game!.players = activePlayerStates(stored.game!).map(player => player.id === 'blue' ? { ...player, position: p(1, 2) } : player);
    const decisive = OnlineRoom.restore(stored); expect(send(decisive, sessions[0], { type: 'move', to: p(0, 2) }).accepted).toBe(true); expect(decisive.persisted()).toMatchObject({ phase: 'finished', game: { winner: 'blue' } });
    decisive.command(sessions[0], command(decisive, sessions[0], 'REMATCH_VOTE', { accept: true }), now); expect(decisive.persisted().phase).toBe('finished');
    decisive.command(sessions[1], command(decisive, sessions[1], 'REMATCH_VOTE', { accept: true }), now); expect(decisive.persisted()).toMatchObject({ phase: 'playing', game: { winner: null, ply: 0, walls: [] } });
  });
  it('rejects Rush abilities in Classic without mutating state', () => {
    const { room, sessions } = startRoom(configuration('classic')); const before = room.persisted().game;
    expect(send(room, sessions[0], { type: 'phantom', wall: h(1, 1) })).toMatchObject({ accepted: false, code: 'ILLEGAL_ACTION' });
    expect(room.persisted().game).toEqual(before);
  });
});

describe('Rush Online authority and Phantom privacy', () => {
  it('starts Rush with server-generated deterministic rewards and full mechanics', () => {
    const { room } = startRoom(configuration('rush', 'wide', 'parallel')); const game = authoritative(room);
    expect(game.mode).toBe('rush'); expect(game.rush?.tiles.length).toBeGreaterThan(0); expect(game.rush).toMatchObject({ energy: { blue: 1, red: 1 }, assists: { blue: 1, red: 1 }, momentum: { blue: 0, red: 0 }, suddenDeath: false });
    expect(OnlineRoom.restore(room.persisted()).persisted().game).toEqual(game);
  });
  it('keeps Phantom identity out of the opponent snapshot and private event', () => {
    const { room, sessions } = startRoom(configuration('rush')); const wall = legalWalls(authoritative(room), 'blue')[0];
    expect(send(room, sessions[0], { type: 'phantom', wall }).accepted).toBe(true);
    const owner = room.snapshot(sessions[0], now); const opponent = room.snapshot(sessions[1], now); const opponentJson = JSON.stringify(opponent);
    expect(owner.game!.walls.find(item => item.row === wall.row && item.col === wall.col)?.knownPhantom).toBe(true);
    expect(owner.game!.rush?.ownPhantomAvailable).toBe(false);
    expect(opponent.game!.walls.find(item => item.row === wall.row && item.col === wall.col)?.knownPhantom).toBe(false);
    expect(opponent.game!.rush?.event).toEqual({ kind: 'wall', text: 'A barrier appeared.' });
    expect(opponentJson).not.toContain('"phantoms"'); expect(opponentJson).not.toContain('Your Phantom Wall is armed'); expect(opponentJson).not.toContain('"knownPhantom":true');
  });
  it('preserves each Phantom projection through reconnect and match finish', () => {
    const { room, sessions } = startRoom(configuration('rush')); const wall = legalWalls(authoritative(room), 'blue')[0]; send(room, sessions[0], { type: 'phantom', wall });
    room.disconnect(sessions[1], now + 1); const restored = OnlineRoom.restore(room.persisted()); restored.connect(sessions[1], now + 2);
    expect(JSON.stringify(restored.snapshot(sessions[1], now))).not.toContain('"knownPhantom":true');
    expect(restored.snapshot(sessions[0], now).game!.walls.some(item => item.knownPhantom)).toBe(true);
    const stored = restored.persisted(); stored.phase = 'finished'; stored.game!.winner = 'blue'; const finished = OnlineRoom.restore(stored);
    expect(JSON.stringify(finished.snapshot(sessions[1], now))).not.toContain('"knownPhantom":true');
  });
  it('rejects a second Phantom, Assist without charges, Break without Energy, and nonexistent Break targets', () => {
    const { room, sessions } = startRoom(configuration('rush')); const wall = legalWalls(authoritative(room), 'blue')[0]; send(room, sessions[0], { type: 'phantom', wall });
    const stored = room.persisted(); stored.game!.turn = 'blue'; stored.game!.currentTurnIndex = 0; stored.game!.rush!.assists.blue = 0; stored.game!.rush!.energy.blue = 0; const constrained = OnlineRoom.restore(stored);
    expect(send(constrained, sessions[0], { type: 'phantom', wall: legalWalls(authoritative(constrained), 'blue')[0] })).toMatchObject({ accepted: false, code: 'ILLEGAL_ACTION' });
    expect(send(constrained, sessions[0], { type: 'assist', via: p(5, 3), to: p(4, 3) })).toMatchObject({ accepted: false, code: 'ILLEGAL_ACTION' });
    expect(send(constrained, sessions[0], { type: 'break', wall: h(2, 2) })).toMatchObject({ accepted: false, code: 'ILLEGAL_ACTION' });
    const enough = constrained.persisted(); enough.game!.rush!.energy.blue = 5; const noTarget = OnlineRoom.restore(enough); expect(send(noTarget, sessions[0], { type: 'break', wall: h(2, 2) })).toMatchObject({ accepted: false, code: 'ILLEGAL_ACTION' });
  });
  it('applies legal Assist, Break, Momentum, and Sudden Death through the shared Rush engine', () => {
    const { room, sessions } = startRoom(configuration('rush', 'sprint')); const stored = room.persisted();
    stored.game!.pawns.blue = p(5, 3); stored.game!.players = activePlayerStates(stored.game!).map(player => player.id === 'blue' ? { ...player, position: p(5, 3) } : player); stored.game!.rush!.tiles = []; stored.game!.rush!.assists.blue = 1;
    let rushRoom = OnlineRoom.restore(stored); const path = legalMoves(authoritative(rushRoom), 'blue')[0]; const assistTo = legalMoves({ ...authoritative(rushRoom), pawns: { ...authoritative(rushRoom).pawns, blue: path }, players: activePlayerStates(authoritative(rushRoom)).map(player => player.id === 'blue' ? { ...player, position: path } : player) }, 'blue').find(point => !same(point, p(5, 3)))!;
    expect(send(rushRoom, sessions[0], { type: 'assist', via: path, to: assistTo }).accepted).toBe(true);
    let next = rushRoom.persisted(); next.game!.turn = 'blue'; next.game!.currentTurnIndex = 0; next.game!.rush!.energy.blue = 5; next.game!.walls = [{ ...h(2, 2), owner: 'red' }]; rushRoom = OnlineRoom.restore(next);
    expect(send(rushRoom, sessions[0], { type: 'break', wall: h(2, 2) }).accepted).toBe(true); expect(authoritative(rushRoom).rush!.energy.blue).toBe(1);
    next = rushRoom.persisted(); next.game!.rush!.suddenDeath = true; next.game!.rush!.momentum.blue = 2; expect(OnlineRoom.restore(next).snapshot(sessions[0], now).game!.rush).toMatchObject({ suddenDeath: true, momentum: { blue: 2 } });
  });
  it('awards server-owned rewards, advances Momentum, and activates Sudden Death', () => {
    const { room, sessions } = startRoom(configuration('rush', 'sprint')); const stored = room.persisted();
    stored.game!.pawns.blue = p(5, 2); stored.game!.players = activePlayerStates(stored.game!).map(player => player.id === 'blue' ? { ...player, position: p(5, 2) } : player);
    stored.game!.rush!.tiles = [{ kind: 'energy', point: p(4, 2), consumed: false }]; stored.game!.ply = MAP_CONFIGS.sprint.suddenDeathPly - 1;
    const target = OnlineRoom.restore(stored); expect(send(target, sessions[0], { type: 'move', to: p(4, 2) }).accepted).toBe(true);
    expect(authoritative(target).rush).toMatchObject({ energy: { blue: 3 }, momentum: { blue: 1 }, suddenDeath: true });
    expect(authoritative(target).rush!.tiles[0].consumed).toBe(true);
  });
  it('declares Rush victory only after the authoritative goal move', () => {
    const { room, sessions } = startRoom(configuration('rush', 'sprint')); const stored = room.persisted();
    stored.game!.pawns.blue = p(1, 2); stored.game!.players = activePlayerStates(stored.game!).map(player => player.id === 'blue' ? { ...player, position: p(1, 2) } : player); stored.game!.rush!.tiles = [];
    const decisive = OnlineRoom.restore(stored); expect(send(decisive, sessions[0], { type: 'move', to: p(0, 2) }).accepted).toBe(true);
    expect(decisive.persisted()).toMatchObject({ phase: 'finished', game: { winner: 'blue', rush: { winnerReason: 'goal' } } });
  });
  it('does not consume a Rush ability twice on a replayed action ID', () => {
    const { room, sessions } = startRoom(configuration('rush')); const stored = room.persisted(); stored.game!.rush!.energy.blue = 5; stored.game!.walls = [{ ...h(2, 2), owner: 'red' }]; const target = OnlineRoom.restore(stored);
    const envelope = command(target, sessions[0], 'GAME_ACTION', { action: { type: 'break', wall: h(2, 2) } }); expect(target.command(sessions[0], envelope, now).accepted).toBe(true); expect(target.command(sessions[0], envelope, now)).toMatchObject({ accepted: false, code: 'DUPLICATE_ACTION' }); expect(authoritative(target).rush!.energy.blue).toBe(1);
  });
  it('creates a fresh authoritative Rush seed on unanimous rematch', () => {
    const { room, sessions } = startRoom(configuration('rush')); const oldSeed = authoritative(room).rush!.seed; const stored = room.persisted(); stored.phase = 'finished'; stored.game!.winner = 'blue'; const finished = OnlineRoom.restore(stored);
    for (const session of sessions) finished.command(session, command(finished, session, 'REMATCH_VOTE', { accept: true }), now);
    expect(authoritative(finished).rush!.seed).not.toBe(oldSeed); expect(authoritative(finished).rush!.tiles.length).toBeGreaterThan(0);
  });
});

describe('Convergence Online regression', () => {
  it('validates movement, walls, center victory, reconnect, and rematch', () => {
    const { room, sessions } = startRoom(configuration('convergence', 'arena', 'convergence', 2));
    expect(send(room, sessions[0], { type: 'move', to: legalMoves(authoritative(room), 'blue')[0] }).accepted).toBe(true); expect(send(room, sessions[1], { type: 'wall', wall: h(1, 1) }).accepted).toBe(true);
    const stored = room.persisted(); stored.game!.turn = 'blue'; stored.game!.currentTurnIndex = 0; stored.game!.players = activePlayerStates(stored.game!).map(player => player.id === 'blue' ? { ...player, position: p(4, 5) } : player); stored.game!.pawns.blue = p(4, 5); const decisive = OnlineRoom.restore(stored);
    expect(send(decisive, sessions[0], { type: 'move', to: p(5, 5) }).accepted).toBe(true); expect(decisive.persisted()).toMatchObject({ phase: 'finished', game: { winner: 'blue' } });
    decisive.disconnect(sessions[1], now + 1); decisive.connect(sessions[1], now + 2); expect(decisive.snapshot(sessions[1], now).game?.winner).toBe('blue');
    for (const session of sessions) decisive.command(session, command(decisive, session, 'REMATCH_VOTE', { accept: true }), now); expect(decisive.persisted()).toMatchObject({ phase: 'playing', game: { winner: null, ply: 0 } });
  });
});

function same(a: Point, b: Point) { return a.row === b.row && a.col === b.col; }
