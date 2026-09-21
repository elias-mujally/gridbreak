import { applyAction } from '../game/engine';
import { newGame, PLAYER_IDS, activePlayerStates, currentPlayerId, type Action, type GameState, type PlayerId } from '../game/state';
import type { MatchConfiguration } from '../game/modes';
import { viewForPlayer } from '../game/view';
import { GAME_BUILD_VERSION, PROTOCOL_VERSION, type ClientCommand, type ConnectionStatus, type OnlineErrorCode, type PublicRoomState, type RoomPhase, type RoomVisibility, type ValidationResult } from './protocol';

export const RECONNECT_GRACE_MS = 5 * 60_000;
export const ABANDON_AFTER_MS = 30 * 60_000;
export const ROOM_EXPIRY_MS = 24 * 60 * 60_000;
const ACTION_HISTORY_LIMIT = 100;

export type StoredRoomMember = { sessionId: string; tokenHash: string; playerId: PlayerId; displayName: string; ready: boolean; connected: boolean; disconnectedAt: number | null; rematchVote: boolean; recentActionIds: string[] };
export type StoredRoom = { code: string; visibility: RoomVisibility; phase: RoomPhase; configuration: MatchConfiguration; hostSessionId: string; members: StoredRoomMember[]; game: GameState | null; sequence: number; createdAt: number; lastActivityAt: number; allDisconnectedAt: number | null };
export type RoomMutation = { accepted: true; snapshot: PublicRoomState } | { accepted: false; code: OnlineErrorCode; message: string; sequence: number };
const reject = (state: StoredRoom, code: OnlineErrorCode, message: string): RoomMutation => ({ accepted: false, code, message, sequence: state.sequence });

function connectionStatus(member: StoredRoomMember, now: number): ConnectionStatus {
  if (member.connected) return 'connected';
  return member.disconnectedAt !== null && now - member.disconnectedAt < RECONNECT_GRACE_MS ? 'reconnecting' : 'disconnected';
}

function createAuthoritativeGame(state: StoredRoom): GameState {
  const { mode, mapId, layout, playerCount } = state.configuration;
  const game = newGame({ mode, mapId, layout, playerCount, online: true, controllers: state.configuration.controllers.map(type => ({ type })) });
  const names = new Map(state.members.map(member => [member.playerId, member.displayName]));
  return { ...game, players: activePlayerStates(game).map(player => ({ ...player, label: names.get(player.id) ?? player.label, controller: 'HUMAN_REMOTE' })) };
}

function actionAllowed(mode: MatchConfiguration['mode'], action: Action): boolean {
  if (mode === 'rush') return ['move', 'wall', 'assist', 'break', 'phantom', 'probe'].includes(action.type);
  return action.type === 'move' || action.type === 'wall';
}

export class OnlineRoom {
  constructor(private state: StoredRoom) {}

  static create(input: { code: string; configuration: MatchConfiguration; sessionId: string; tokenHash: string; displayName: string; now: number }): OnlineRoom {
    const host: StoredRoomMember = { sessionId: input.sessionId, tokenHash: input.tokenHash, playerId: 'blue', displayName: input.displayName, ready: false, connected: false, disconnectedAt: input.now, rematchVote: false, recentActionIds: [] };
    return new OnlineRoom({ code: input.code, visibility: 'UNLISTED', phase: 'waiting', configuration: structuredClone(input.configuration), hostSessionId: input.sessionId, members: [host], game: null, sequence: 0, createdAt: input.now, lastActivityAt: input.now, allDisconnectedAt: input.now });
  }

  static restore(state: StoredRoom): OnlineRoom { return new OnlineRoom(structuredClone(state)); }
  persisted(): StoredRoom { return structuredClone(this.state); }
  isExpired(): boolean { return this.state.phase === 'expired'; }
  code(): string { return this.state.code; }
  sequence(): number { return this.state.sequence; }
  authenticate(sessionId: string, tokenHash: string): boolean { return this.state.members.some(member => member.sessionId === sessionId && member.tokenHash === tokenHash); }

  snapshot(sessionId: string, now: number): PublicRoomState {
    const viewer = this.member(sessionId);
    if (!viewer) throw new Error('Cannot project a room for a non-member session.');
    return {
      code: this.state.code, visibility: this.state.visibility, phase: this.state.phase,
      configuration: structuredClone(this.state.configuration), selfPlayerId: viewer.playerId,
      members: this.state.members.map(member => ({ playerId: member.playerId, displayName: member.displayName, ready: member.ready, connection: connectionStatus(member, now), rematchVote: member.rematchVote, isHost: member.sessionId === this.state.hostSessionId, isSelf: member.sessionId === sessionId })),
      game: this.state.game ? viewForPlayer(this.state.game, viewer.playerId) : null,
      sequence: this.state.sequence, createdAt: this.state.createdAt, lastActivityAt: this.state.lastActivityAt,
    };
  }

  join(input: { sessionId: string; tokenHash: string; displayName: string; now: number }): ValidationResult<PublicRoomState> {
    if (this.state.phase === 'expired') return { ok: false, code: 'ROOM_NOT_FOUND', message: 'Room not found.' };
    if (['playing', 'finished', 'abandoned'].includes(this.state.phase)) return { ok: false, code: 'MATCH_ALREADY_STARTED', message: 'This match has already started.' };
    if (this.state.members.length >= this.state.configuration.playerCount) return { ok: false, code: 'ROOM_FULL', message: 'This room is full.' };
    const playerId = PLAYER_IDS[this.state.members.length];
    this.state.members.push({ sessionId: input.sessionId, tokenHash: input.tokenHash, playerId, displayName: input.displayName, ready: false, connected: false, disconnectedAt: input.now, rematchVote: false, recentActionIds: [] });
    this.touch(input.now);
    return { ok: true, value: this.snapshot(input.sessionId, input.now) };
  }

  connect(sessionId: string, now: number): RoomMutation {
    const member = this.member(sessionId); if (!member) return reject(this.state, 'UNAUTHENTICATED', 'Session is not a member of this room.');
    member.connected = true; member.disconnectedAt = null; this.state.allDisconnectedAt = null; this.touch(now);
    return { accepted: true, snapshot: this.snapshot(sessionId, now) };
  }
  disconnect(sessionId: string, now: number): RoomMutation {
    const member = this.member(sessionId); if (!member) return reject(this.state, 'UNAUTHENTICATED', 'Unknown room session.');
    member.connected = false; member.disconnectedAt = now;
    if (this.state.members.every(item => !item.connected)) this.state.allDisconnectedAt = now;
    this.touch(now); return { accepted: true, snapshot: this.snapshot(sessionId, now) };
  }

  command(sessionId: string, command: ClientCommand, now: number): RoomMutation {
    const member = this.member(sessionId);
    if (!member || command.sessionId !== sessionId || command.roomCode.toUpperCase() !== this.state.code) return reject(this.state, 'UNAUTHENTICATED', 'Action identity does not match the authenticated connection.');
    if (command.protocolVersion !== PROTOCOL_VERSION || command.buildVersion !== GAME_BUILD_VERSION) return reject(this.state, 'VERSION_MISMATCH', 'Refresh GridBreak to join this room version.');
    if (member.recentActionIds.includes(command.actionId)) return reject(this.state, 'DUPLICATE_ACTION', 'This action was already processed.');
    if (command.expectedSequence !== this.state.sequence) return reject(this.state, 'STALE_SEQUENCE', 'Room state changed. Use the latest snapshot.');
    member.recentActionIds.push(command.actionId);
    if (member.recentActionIds.length > ACTION_HISTORY_LIMIT) member.recentActionIds.splice(0, member.recentActionIds.length - ACTION_HISTORY_LIMIT);
    let error: { code: OnlineErrorCode; message: string } | null = null;
    if (command.type === 'READY') error = this.setReady(member, command.ready);
    else if (command.type === 'START') error = this.start(member);
    else if (command.type === 'GAME_ACTION') error = this.gameAction(member, command.action);
    else if (command.type === 'REMATCH_VOTE') error = this.rematch(member, command.accept);
    if (error) return reject(this.state, error.code, error.message);
    this.touch(now); return { accepted: true, snapshot: this.snapshot(sessionId, now) };
  }

  sweep(now: number): boolean {
    if (this.state.phase === 'expired') return false;
    if (now - this.state.lastActivityAt >= ROOM_EXPIRY_MS) { this.state.phase = 'expired'; this.state.sequence++; return true; }
    if (this.state.phase === 'playing' && this.state.allDisconnectedAt !== null && now - this.state.allDisconnectedAt >= ABANDON_AFTER_MS) { this.state.phase = 'abandoned'; this.state.sequence++; return true; }
    return false;
  }

  private member(sessionId: string) { return this.state.members.find(member => member.sessionId === sessionId); }
  private touch(now: number) { this.state.lastActivityAt = now; this.state.sequence++; }
  private refreshLobbyPhase() { this.state.phase = this.state.members.length === this.state.configuration.playerCount && this.state.members.every(member => member.ready) ? 'ready' : 'waiting'; }
  private setReady(member: StoredRoomMember, ready: boolean) {
    if (!['waiting', 'ready'].includes(this.state.phase)) return { code: 'MATCH_ALREADY_STARTED' as const, message: 'Ready state is locked after the match starts.' };
    member.ready = ready; this.refreshLobbyPhase(); return null;
  }
  private start(member: StoredRoomMember) {
    if (member.sessionId !== this.state.hostSessionId) return { code: 'NOT_HOST' as const, message: 'Only the host can start the lobby.' };
    if (this.state.phase !== 'ready' || this.state.members.length !== this.state.configuration.playerCount || this.state.members.some(item => !item.ready || !item.connected)) return { code: 'INVALID_START' as const, message: 'All required players must be connected and Ready.' };
    this.state.game = createAuthoritativeGame(this.state); this.state.phase = 'playing'; return null;
  }
  private gameAction(member: StoredRoomMember, action: Action) {
    if (this.state.phase !== 'playing' || !this.state.game) return { code: 'ILLEGAL_ACTION' as const, message: 'The match is not accepting actions.' };
    if (currentPlayerId(this.state.game) !== member.playerId) return { code: 'NOT_YOUR_TURN' as const, message: 'Wait for your turn.' };
    if (!actionAllowed(this.state.configuration.mode, action)) return { code: 'ILLEGAL_ACTION' as const, message: `${action.type.toUpperCase()} is unavailable in ${this.state.configuration.mode}.` };
    const next = applyAction(this.state.game, action);
    if (!next) return { code: 'ILLEGAL_ACTION' as const, message: 'The authoritative rules rejected that action.' };
    this.state.game = next; if (next.winner) this.state.phase = 'finished'; return null;
  }
  private rematch(member: StoredRoomMember, accept: boolean) {
    if (this.state.phase !== 'finished') return { code: 'ILLEGAL_ACTION' as const, message: 'Rematch voting opens after the match.' };
    member.rematchVote = accept;
    if (this.state.members.every(item => item.connected && item.rematchVote)) {
      for (const item of this.state.members) item.rematchVote = false;
      this.state.game = createAuthoritativeGame(this.state); this.state.phase = 'playing';
    }
    return null;
  }
}
