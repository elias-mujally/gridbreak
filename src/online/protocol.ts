import type { GameState, PlayerId } from '../game/state';
import type { Action } from '../game/state';
import { MAP_CONFIGS, matchCapability, type ConvergencePlayerCount, type MapId } from '../game/modes';

export const PROTOCOL_VERSION = 1 as const;
export const GAME_BUILD_VERSION = 'convergence-online-v1' as const;
export const MAX_MESSAGE_BYTES = 8_192;
export const ROOM_CODE_PREFIX = 'GB-';
export const ROOM_CODE_PATTERN = /^GB-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/;

export type RoomVisibility = 'UNLISTED' | 'PUBLIC' | 'PASSWORD_PROTECTED';
export type RoomPhase = 'waiting' | 'ready' | 'playing' | 'finished' | 'abandoned' | 'expired';
export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';
export type OnlineErrorCode =
  | 'ROOM_NOT_FOUND' | 'ROOM_FULL' | 'MATCH_ALREADY_STARTED' | 'INVALID_NAME'
  | 'VERSION_MISMATCH' | 'INVALID_REQUEST' | 'NOT_HOST' | 'INVALID_START'
  | 'NOT_YOUR_TURN' | 'ILLEGAL_ACTION' | 'DUPLICATE_ACTION' | 'STALE_SEQUENCE'
  | 'UNAUTHENTICATED' | 'ROOM_EXPIRED' | 'PAYLOAD_TOO_LARGE' | 'INTERNAL_ERROR';

export type PublicRoomMember = {
  sessionId: string;
  playerId: PlayerId;
  displayName: string;
  ready: boolean;
  connection: ConnectionStatus;
  rematchVote: boolean;
};

export type PublicRoomState = {
  code: string;
  visibility: RoomVisibility;
  phase: RoomPhase;
  mapId: MapId;
  requiredPlayers: ConvergencePlayerCount;
  hostSessionId: string;
  members: PublicRoomMember[];
  game: GameState | null;
  sequence: number;
  createdAt: number;
  lastActivityAt: number;
};

export type SessionCredentials = { sessionId: string; sessionToken: string };
export type RoomAdmission = { credentials: SessionCredentials; room: PublicRoomState };

export type CreateRoomRequest = {
  protocolVersion: number;
  buildVersion: string;
  displayName: string;
  mapId: MapId;
  playerCount: ConvergencePlayerCount;
};

export type JoinRoomRequest = {
  protocolVersion: number;
  buildVersion: string;
  displayName: string;
  roomCode: string;
};

type CommandBase = {
  protocolVersion: number;
  buildVersion: string;
  roomCode: string;
  sessionId: string;
  actionId: string;
  expectedSequence: number;
};

export type AuthMessage = {
  type: 'AUTH';
  protocolVersion: number;
  buildVersion: string;
  roomCode: string;
  sessionId: string;
  sessionToken: string;
};
export type PingMessage = { type: 'PING'; protocolVersion: number; buildVersion: string; roomCode: string; sessionId: string };
export type ReadyCommand = CommandBase & { type: 'READY'; ready: boolean };
export type StartCommand = CommandBase & { type: 'START' };
export type GameActionCommand = CommandBase & { type: 'GAME_ACTION'; action: Extract<Action, { type: 'move' | 'wall' }> };
export type RematchCommand = CommandBase & { type: 'REMATCH_VOTE'; accept: boolean };
export type ClientCommand = ReadyCommand | StartCommand | GameActionCommand | RematchCommand;
export type ClientMessage = AuthMessage | PingMessage | ClientCommand;

export type SnapshotEvent = {
  type: 'SNAPSHOT'; protocolVersion: typeof PROTOCOL_VERSION; buildVersion: typeof GAME_BUILD_VERSION;
  sequence: number; room: PublicRoomState;
};
export type RejectionEvent = {
  type: 'ACTION_REJECTED'; protocolVersion: typeof PROTOCOL_VERSION; buildVersion: typeof GAME_BUILD_VERSION;
  sequence: number; actionId?: string; code: OnlineErrorCode; message: string;
};
export type AuthenticatedEvent = {
  type: 'AUTHENTICATED'; protocolVersion: typeof PROTOCOL_VERSION; buildVersion: typeof GAME_BUILD_VERSION;
  sequence: number; sessionId: string;
};
export type PongEvent = { type: 'PONG'; protocolVersion: typeof PROTOCOL_VERSION; buildVersion: typeof GAME_BUILD_VERSION; sequence: number };
export type ServerEvent = SnapshotEvent | RejectionEvent | AuthenticatedEvent | PongEvent;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; code: OnlineErrorCode; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const isInteger = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const isPoint = (value: unknown): value is { row: number; col: number } => isRecord(value) && hasOnly(value, ['row', 'col']) && Number.isInteger(value.row) && Number.isInteger(value.col);

export function normalizeRoomCode(value: string): string {
  const compact = value.trim().toUpperCase().replace(/\s+/g, '').replace(/^GB?/, '').replace(/^-/, '');
  return `${ROOM_CODE_PREFIX}${compact}`;
}

export function validateDisplayName(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string') return { ok: false, code: 'INVALID_NAME', message: 'Enter a display name.' };
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 20 || !/^[\p{L}\p{N} ._-]+$/u.test(name)) {
    return { ok: false, code: 'INVALID_NAME', message: 'Use 2–20 letters, numbers, spaces, dots, underscores, or hyphens.' };
  }
  return { ok: true, value: name };
}

export function validateCompatibility(protocolVersion: unknown, buildVersion: unknown): ValidationResult<true> {
  if (protocolVersion !== PROTOCOL_VERSION || buildVersion !== GAME_BUILD_VERSION) {
    return { ok: false, code: 'VERSION_MISMATCH', message: 'This game version is out of date. Refresh GridBreak and try again.' };
  }
  return { ok: true, value: true };
}

export function validateCreateRoomRequest(value: unknown): ValidationResult<CreateRoomRequest> {
  if (!isRecord(value) || !hasOnly(value, ['protocolVersion', 'buildVersion', 'displayName', 'mapId', 'playerCount'])) return { ok: false, code: 'INVALID_REQUEST', message: 'Invalid create-room request.' };
  const version = validateCompatibility(value.protocolVersion, value.buildVersion);
  if (!version.ok) return version;
  const displayName = validateDisplayName(value.displayName);
  if (!displayName.ok) return displayName;
  if (!(String(value.mapId) in MAP_CONFIGS) || ![2, 3, 4].includes(Number(value.playerCount))) return { ok: false, code: 'INVALID_REQUEST', message: 'Unsupported Convergence setup.' };
  const capability = matchCapability(value.mapId as MapId, 'convergence', 'convergence', value.playerCount as ConvergencePlayerCount);
  if (!capability?.online) return { ok: false, code: 'INVALID_REQUEST', message: 'This map and player count is unavailable in Online V1.' };
  return { ok: true, value: { protocolVersion: PROTOCOL_VERSION, buildVersion: GAME_BUILD_VERSION, displayName: displayName.value, mapId: value.mapId as MapId, playerCount: value.playerCount as ConvergencePlayerCount } };
}

export function validateJoinRoomRequest(value: unknown): ValidationResult<JoinRoomRequest> {
  if (!isRecord(value) || !hasOnly(value, ['protocolVersion', 'buildVersion', 'displayName', 'roomCode'])) return { ok: false, code: 'INVALID_REQUEST', message: 'Invalid join-room request.' };
  const version = validateCompatibility(value.protocolVersion, value.buildVersion);
  if (!version.ok) return version;
  const displayName = validateDisplayName(value.displayName);
  if (!displayName.ok) return displayName;
  const roomCode = typeof value.roomCode === 'string' ? normalizeRoomCode(value.roomCode) : '';
  if (!ROOM_CODE_PATTERN.test(roomCode)) return { ok: false, code: 'ROOM_NOT_FOUND', message: 'Room not found.' };
  return { ok: true, value: { protocolVersion: PROTOCOL_VERSION, buildVersion: GAME_BUILD_VERSION, displayName: displayName.value, roomCode } };
}

function validateGameAction(value: unknown): ValidationResult<GameActionCommand['action']> {
  if (!isRecord(value) || typeof value.type !== 'string') return { ok: false, code: 'INVALID_REQUEST', message: 'Malformed game action.' };
  if (value.type === 'move' && hasOnly(value, ['type', 'to']) && isPoint(value.to)) return { ok: true, value: { type: 'move', to: value.to } };
  if (value.type === 'wall' && hasOnly(value, ['type', 'wall']) && isRecord(value.wall) && hasOnly(value.wall, ['row', 'col', 'orientation']) && Number.isInteger(value.wall.row) && Number.isInteger(value.wall.col) && (value.wall.orientation === 'horizontal' || value.wall.orientation === 'vertical')) {
    return { ok: true, value: { type: 'wall', wall: { row: Number(value.wall.row), col: Number(value.wall.col), orientation: value.wall.orientation } } };
  }
  return { ok: false, code: 'INVALID_REQUEST', message: 'Online Convergence accepts only valid MOVE and PLACE_WALL intents.' };
}

export function parseClientMessage(raw: unknown): ValidationResult<ClientMessage> {
  if (typeof raw !== 'string') return { ok: false, code: 'INVALID_REQUEST', message: 'Messages must be UTF-8 JSON text.' };
  if (new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) return { ok: false, code: 'PAYLOAD_TOO_LARGE', message: 'Message exceeds the 8 KB limit.' };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { ok: false, code: 'INVALID_REQUEST', message: 'Malformed JSON.' }; }
  if (!isRecord(value) || typeof value.type !== 'string') return { ok: false, code: 'INVALID_REQUEST', message: 'Malformed protocol message.' };
  const version = validateCompatibility(value.protocolVersion, value.buildVersion);
  if (!version.ok) return version;
  if (value.type === 'AUTH') {
    if (!hasOnly(value, ['type', 'protocolVersion', 'buildVersion', 'roomCode', 'sessionId', 'sessionToken']) || typeof value.roomCode !== 'string' || typeof value.sessionId !== 'string' || typeof value.sessionToken !== 'string') return { ok: false, code: 'INVALID_REQUEST', message: 'Malformed authentication message.' };
    return { ok: true, value: value as AuthMessage };
  }
  if (value.type === 'PING') {
    if (!hasOnly(value, ['type', 'protocolVersion', 'buildVersion', 'roomCode', 'sessionId']) || typeof value.roomCode !== 'string' || typeof value.sessionId !== 'string') return { ok: false, code: 'INVALID_REQUEST', message: 'Malformed heartbeat.' };
    return { ok: true, value: value as PingMessage };
  }
  const baseKeys = ['type', 'protocolVersion', 'buildVersion', 'roomCode', 'sessionId', 'actionId', 'expectedSequence'];
  if (typeof value.roomCode !== 'string' || typeof value.sessionId !== 'string' || typeof value.actionId !== 'string' || value.actionId.length < 8 || value.actionId.length > 80 || !isInteger(value.expectedSequence)) return { ok: false, code: 'INVALID_REQUEST', message: 'Malformed action envelope.' };
  if (value.type === 'READY' && hasOnly(value, [...baseKeys, 'ready']) && typeof value.ready === 'boolean') return { ok: true, value: value as ReadyCommand };
  if (value.type === 'START' && hasOnly(value, baseKeys)) return { ok: true, value: value as StartCommand };
  if (value.type === 'REMATCH_VOTE' && hasOnly(value, [...baseKeys, 'accept']) && typeof value.accept === 'boolean') return { ok: true, value: value as RematchCommand };
  if (value.type === 'GAME_ACTION' && hasOnly(value, [...baseKeys, 'action'])) {
    const action = validateGameAction(value.action);
    if (!action.ok) return action;
    return { ok: true, value: { ...(value as unknown as CommandBase), type: 'GAME_ACTION', action: action.value } };
  }
  return { ok: false, code: 'INVALID_REQUEST', message: 'Unknown or malformed action.' };
}

export function rejection(code: OnlineErrorCode, message: string, sequence: number, actionId?: string): RejectionEvent {
  return { type: 'ACTION_REJECTED', protocolVersion: PROTOCOL_VERSION, buildVersion: GAME_BUILD_VERSION, sequence, actionId, code, message };
}
