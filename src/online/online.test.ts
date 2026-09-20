import { describe, expect, it } from 'vitest';
import { generateRoomCode } from './identity';
import {
  GAME_BUILD_VERSION, MAX_MESSAGE_BYTES, PROTOCOL_VERSION, normalizeRoomCode, parseClientMessage,
  validateCreateRoomRequest, validateJoinRoomRequest, type ClientCommand,
} from './protocol';
import { ABANDON_AFTER_MS, OnlineRoom, RECONNECT_GRACE_MS, ROOM_EXPIRY_MS } from './room';
import { activePlayerStates, type Point, type Wall } from '../game/state';
import { legalMoves } from '../game/movement';

let actionCounter = 0;
const now = 10_000;
const p = (row: number, col: number): Point => ({ row, col });
const h = (row: number, col: number): Wall => ({ row, col, orientation: 'horizontal' });
const v = (row: number, col: number): Wall => ({ row, col, orientation: 'vertical' });

function createRoom(playerCount: 2 | 3 | 4 = 2, mapId: 'arena' | 'grand' | 'titan' = playerCount === 2 ? 'arena' : 'grand') {
  const room = OnlineRoom.create({ code: 'GB-X7K9', mapId, playerCount, sessionId: 'session-1', tokenHash: 'hash-1', displayName: 'Player One', now });
  const sessions = ['session-1'];
  for (let index = 2; index <= playerCount; index++) {
    const sessionId = `session-${index}`;
    expect(room.join({ sessionId, tokenHash: `hash-${index}`, displayName: `Player ${index}`, now: now + index }).ok).toBe(true);
    sessions.push(sessionId);
  }
  return { room, sessions };
}

function command<T extends ClientCommand['type']>(room: OnlineRoom, sessionId: string, type: T, extra: Record<string, unknown> = {}, expectedSequence = room.snapshot(now).sequence): ClientCommand {
  return {
    type, protocolVersion: PROTOCOL_VERSION, buildVersion: GAME_BUILD_VERSION, roomCode: 'GB-X7K9', sessionId,
    actionId: `action-${(++actionCounter).toString().padStart(8, '0')}`, expectedSequence, ...extra,
  } as ClientCommand;
}

function startRoom(playerCount: 2 | 3 | 4 = 2, mapId: 'arena' | 'grand' | 'titan' = playerCount === 2 ? 'arena' : 'grand') {
  const setup = createRoom(playerCount, mapId);
  for (const session of setup.sessions) expect(setup.room.connect(session, now + 20).accepted).toBe(true);
  for (const session of setup.sessions) expect(setup.room.command(session, command(setup.room, session, 'READY', { ready: true }), now + 30).accepted).toBe(true);
  expect(setup.room.command(setup.sessions[0], command(setup.room, setup.sessions[0], 'START'), now + 40).accepted).toBe(true);
  return setup;
}

describe('online protocol and identity', () => {
  it('generates readable collision-resistant room-code shapes without ambiguous characters', () => {
    const codes = new Set(Array.from({ length: 2_000 }, () => generateRoomCode()));
    expect(codes.size).toBeGreaterThan(1_990);
    expect([...codes].every(code => /^GB-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/.test(code))).toBe(true);
  });

  it('normalizes case-insensitive room entry', () => expect(normalizeRoomCode(' gb-x7k9 ')).toBe('GB-X7K9'));

  it('rejects invalid room codes as ROOM_NOT_FOUND', () => {
    const result = validateJoinRoomRequest({ protocolVersion: PROTOCOL_VERSION, buildVersion: GAME_BUILD_VERSION, displayName: 'Guest Two', roomCode: 'bad' });
    expect(result).toMatchObject({ ok: false, code: 'ROOM_NOT_FOUND' });
  });

  it('rejects invalid names and version mismatches', () => {
    expect(validateCreateRoomRequest({ protocolVersion: PROTOCOL_VERSION, buildVersion: GAME_BUILD_VERSION, displayName: '<x>', mapId: 'grand', playerCount: 4 })).toMatchObject({ ok: false, code: 'INVALID_NAME' });
    expect(validateCreateRoomRequest({ protocolVersion: 999, buildVersion: 'old', displayName: 'Valid Name', mapId: 'grand', playerCount: 4 })).toMatchObject({ ok: false, code: 'VERSION_MISMATCH' });
  });

  it('rejects malformed, oversized, and client-forged action payloads', () => {
    expect(parseClientMessage('{')).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    expect(parseClientMessage('x'.repeat(MAX_MESSAGE_BYTES + 1))).toMatchObject({ ok: false, code: 'PAYLOAD_TOO_LARGE' });
    const forged = JSON.stringify({ type: 'GAME_ACTION', protocolVersion: PROTOCOL_VERSION, buildVersion: GAME_BUILD_VERSION, roomCode: 'GB-X7K9', sessionId: 'session-1', actionId: 'action-123456', expectedSequence: 0, action: { type: 'move', to: p(1, 1), winner: 'blue' } });
    expect(parseClientMessage(forged)).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  });
});

describe('authoritative online room', () => {
  it('creates an UNLISTED room with an authoritative host identity', () => {
    const { room } = createRoom();
    expect(room.snapshot(now)).toMatchObject({ code: 'GB-X7K9', visibility: 'UNLISTED', phase: 'waiting', requiredPlayers: 2, hostSessionId: 'session-1' });
    expect(room.authenticate('session-1', 'hash-1')).toBe(true);
    expect(room.authenticate('session-1', 'forged')).toBe(false);
  });

  it('joins players in deterministic identities and rejects a full room', () => {
    const { room } = createRoom(2);
    expect(room.snapshot(now).members.map(member => member.playerId)).toEqual(['blue', 'red']);
    expect(room.join({ sessionId: 'session-3', tokenHash: 'hash-3', displayName: 'Third', now })).toMatchObject({ ok: false, code: 'ROOM_FULL' });
  });

  it('synchronizes Ready state and rejects invalid starts', () => {
    const { room, sessions } = createRoom(2);
    for (const session of sessions) room.connect(session, now);
    expect(room.command(sessions[0], command(room, sessions[0], 'START'), now)).toMatchObject({ accepted: false, code: 'INVALID_START' });
    room.command(sessions[0], command(room, sessions[0], 'READY', { ready: true }), now);
    room.command(sessions[1], command(room, sessions[1], 'READY', { ready: true }), now);
    expect(room.snapshot(now).phase).toBe('ready');
    expect(room.command(sessions[1], command(room, sessions[1], 'START'), now)).toMatchObject({ accepted: false, code: 'NOT_HOST' });
  });

  it('starts only a complete, connected, Ready lobby', () => {
    const { room } = startRoom(2);
    expect(room.snapshot(now)).toMatchObject({ phase: 'playing' });
    expect(activePlayerStates(room.snapshot(now).game!).every(player => player.controller === 'HUMAN_REMOTE')).toBe(true);
  });

  it.each([2, 3, 4] as const)('starts a synchronized %i-player online match', playerCount => {
    const { room } = startRoom(playerCount);
    expect(activePlayerStates(room.snapshot(now).game!)).toHaveLength(playerCount);
    expect(room.snapshot(now).game?.turnOrder).toHaveLength(playerCount);
  });

  it('enforces turn ownership', () => {
    const { room, sessions } = startRoom(2);
    const move = legalMoves(room.snapshot(now).game!)[0];
    expect(room.command(sessions[1], command(room, sessions[1], 'GAME_ACTION', { action: { type: 'move', to: move } }), now)).toMatchObject({ accepted: false, code: 'NOT_YOUR_TURN' });
  });

  it('accepts legal MOVE and PLACE_WALL intents through the shared engine', () => {
    const { room, sessions } = startRoom(2);
    const move = legalMoves(room.snapshot(now).game!)[0];
    expect(room.command(sessions[0], command(room, sessions[0], 'GAME_ACTION', { action: { type: 'move', to: move } }), now).accepted).toBe(true);
    expect(room.command(sessions[1], command(room, sessions[1], 'GAME_ACTION', { action: { type: 'wall', wall: h(1, 1) } }), now).accepted).toBe(true);
    expect(room.snapshot(now).game?.walls).toHaveLength(1);
  });

  it('rejects illegal movement and walls that trap any active player', () => {
    const started = startRoom(4, 'titan');
    expect(started.room.command(started.sessions[0], command(started.room, started.sessions[0], 'GAME_ACTION', { action: { type: 'move', to: p(10, 10) } }), now)).toMatchObject({ accepted: false, code: 'ILLEGAL_ACTION' });
    const stored = started.room.persisted();
    const finalCol = stored.game!.width - 3;
    stored.game!.walls = [...Array.from({ length: finalCol / 2 }, (_, index) => h(1, index * 2)), v(0, stored.game!.width - 2)];
    const trapped = OnlineRoom.restore(stored);
    expect(trapped.command(started.sessions[0], command(trapped, started.sessions[0], 'GAME_ACTION', { action: { type: 'wall', wall: h(1, finalCol) } }), now)).toMatchObject({ accepted: false, code: 'ILLEGAL_ACTION' });
  });

  it('rejects duplicate and stale actions without merging state', () => {
    const { room, sessions } = startRoom(2);
    const envelope = command(room, sessions[0], 'GAME_ACTION', { action: { type: 'move', to: legalMoves(room.snapshot(now).game!)[0] } });
    expect(room.command(sessions[0], envelope, now).accepted).toBe(true);
    expect(room.command(sessions[0], envelope, now)).toMatchObject({ accepted: false, code: 'DUPLICATE_ACTION' });
    expect(room.command(sessions[1], command(room, sessions[1], 'GAME_ACTION', { action: { type: 'move', to: p(1, 1) } }, 0), now)).toMatchObject({ accepted: false, code: 'STALE_SEQUENCE' });
  });

  it('reconnects during play without adding a duplicate pawn or member', () => {
    const { room, sessions } = startRoom(3);
    room.disconnect(sessions[0], now + 1);
    expect(room.snapshot(now + RECONNECT_GRACE_MS - 1).members[0].connection).toBe('reconnecting');
    const restored = OnlineRoom.restore(room.persisted());
    expect(restored.connect(sessions[0], now + 2).accepted).toBe(true);
    expect(restored.snapshot(now).members).toHaveLength(3);
    expect(activePlayerStates(restored.snapshot(now).game!)).toHaveLength(3);
  });

  it('retains the same lobby seat and Ready state through reconnect', () => {
    const { room, sessions } = createRoom(2);
    for (const session of sessions) room.connect(session, now);
    room.command(sessions[1], command(room, sessions[1], 'READY', { ready: true }), now);
    room.disconnect(sessions[1], now + 1);
    expect(room.snapshot(now + 2).members[1]).toMatchObject({ ready: true, connection: 'reconnecting' });
    room.connect(sessions[1], now + 3);
    expect(room.snapshot(now + 3).members[1]).toMatchObject({ sessionId: sessions[1], playerId: 'red', ready: true, connection: 'connected' });
    expect(room.snapshot(now + 3).members).toHaveLength(2);
  });

  it('does not advance or skip turns when either the active or waiting player reconnects', () => {
    const { room, sessions } = startRoom(2);
    const before = room.snapshot(now).game!;
    for (const session of [sessions[0], sessions[1]]) {
      room.disconnect(session, now + 1);
      room.connect(session, now + 2);
      const after = room.snapshot(now + 2).game!;
      expect(after.currentTurnIndex).toBe(before.currentTurnIndex);
      expect(activePlayerStates(after).map(player => player.position)).toEqual(activePlayerStates(before).map(player => player.position));
    }
  });

  it('restores the authoritative winner and result phase after reconnect', () => {
    const { room, sessions } = startRoom(2, 'arena');
    const stored = room.persisted();
    stored.game!.players = activePlayerStates(stored.game!).map(player => player.id === 'blue' ? { ...player, position: p(4, 5) } : player);
    const finished = OnlineRoom.restore(stored);
    finished.command(sessions[0], command(finished, sessions[0], 'GAME_ACTION', { action: { type: 'move', to: p(5, 5) } }), now);
    finished.disconnect(sessions[1], now + 1);
    finished.connect(sessions[1], now + 2);
    expect(finished.snapshot(now + 2)).toMatchObject({ phase: 'finished', game: { winner: 'blue' } });
    expect(finished.snapshot(now + 2).members).toHaveLength(2);
  });

  it('recovers an identical authoritative snapshot from persisted storage', () => {
    const { room, sessions } = startRoom(4);
    const move = legalMoves(room.snapshot(now).game!)[0];
    room.command(sessions[0], command(room, sessions[0], 'GAME_ACTION', { action: { type: 'move', to: move } }), now);
    expect(OnlineRoom.restore(room.persisted()).snapshot(now)).toEqual(room.snapshot(now));
  });

  it('declares and synchronizes victory only after the server validates the center move', () => {
    const { room, sessions } = startRoom(2, 'arena');
    const stored = room.persisted();
    stored.game!.players = activePlayerStates(stored.game!).map(player => player.id === 'blue' ? { ...player, position: p(4, 5) } : player);
    const decisive = OnlineRoom.restore(stored);
    const result = decisive.command(sessions[0], command(decisive, sessions[0], 'GAME_ACTION', { action: { type: 'move', to: p(5, 5) } }), now);
    expect(result.accepted).toBe(true);
    expect(decisive.snapshot(now)).toMatchObject({ phase: 'finished', game: { winner: 'blue' } });
  });

  it('starts a clean online rematch only after every connected member votes', () => {
    const { room, sessions } = startRoom(2, 'arena');
    const stored = room.persisted();
    stored.game!.players = activePlayerStates(stored.game!).map(player => player.id === 'blue' ? { ...player, position: p(4, 5) } : player);
    const finished = OnlineRoom.restore(stored);
    finished.command(sessions[0], command(finished, sessions[0], 'GAME_ACTION', { action: { type: 'move', to: p(5, 5) } }), now);
    finished.command(sessions[0], command(finished, sessions[0], 'REMATCH_VOTE', { accept: true }), now);
    expect(finished.snapshot(now).phase).toBe('finished');
    finished.command(sessions[1], command(finished, sessions[1], 'REMATCH_VOTE', { accept: true }), now);
    expect(finished.snapshot(now)).toMatchObject({ phase: 'playing', game: { winner: null, ply: 0, walls: [] } });
    expect(finished.snapshot(now).members.every(member => !member.rematchVote)).toBe(true);
  });

  it('moves all-disconnected games through abandoned and expired lifecycle states', () => {
    const { room, sessions } = startRoom(2);
    for (const session of sessions) room.disconnect(session, now);
    expect(room.sweep(now + ABANDON_AFTER_MS)).toBe(true);
    expect(room.snapshot(now).phase).toBe('abandoned');
    expect(room.sweep(room.persisted().lastActivityAt + ROOM_EXPIRY_MS)).toBe(true);
    expect(room.snapshot(now).phase).toBe('expired');
  });
});
