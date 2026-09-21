import type { Action } from '../game/state';
import type { MatchConfiguration } from '../game/modes';
import {
  GAME_BUILD_VERSION, PROTOCOL_VERSION, type ClientCommand, type OnlineErrorCode,
  type PublicRoomState, type RoomAdmission, type ServerEvent, type SessionCredentials,
} from './protocol';

const STORAGE_KEY = 'gridbreak.online.session.v2';
const configuredEndpoint = import.meta.env.VITE_ONLINE_SERVER_URL?.replace(/\/$/, '');
export const ONLINE_SERVER_URL = configuredEndpoint || (import.meta.env.DEV ? 'http://127.0.0.1:8787' : '');

export type StoredOnlineSession = { roomCode: string; displayName: string; credentials: SessionCredentials };
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed';
export type OnlineCallbacks = {
  onSnapshot: (room: PublicRoomState) => void;
  onConnection: (state: ConnectionState) => void;
  onError: (code: OnlineErrorCode | 'NETWORK_ERROR', message: string) => void;
  onPending: (pending: boolean) => void;
};

async function request<T>(path: string, body: unknown): Promise<T> {
  if (!ONLINE_SERVER_URL) throw new Error('Online server is not configured for this build.');
  let response: Response;
  try {
    response = await fetch(`${ONLINE_SERVER_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (cause) {
    throw Object.assign(new Error('Unable to reach GridBreak Online. Check your connection and try again.'), { code: 'NETWORK_ERROR', cause });
  }
  let result: T & { error?: { code: OnlineErrorCode; message: string } };
  try { result = await response.json() as typeof result; }
  catch (cause) { throw Object.assign(new Error('The online server returned an unreadable response.'), { code: 'INTERNAL_ERROR', cause }); }
  if (!response.ok) {
    const code = result.error?.code ?? 'INTERNAL_ERROR';
    const message = response.status >= 500 ? 'GridBreak Online is temporarily unavailable. Try again shortly.'
      : result.error?.message ?? 'The online server rejected that request.';
    throw Object.assign(new Error(message), { code });
  }
  return result;
}

export async function createOnlineRoom(displayName: string, configuration: MatchConfiguration): Promise<RoomAdmission> {
  return request('/api/rooms', { protocolVersion: PROTOCOL_VERSION, buildVersion: GAME_BUILD_VERSION, displayName, configuration });
}

export async function joinOnlineRoom(displayName: string, roomCode: string): Promise<RoomAdmission> {
  return request(`/api/rooms/${encodeURIComponent(roomCode)}`, { protocolVersion: PROTOCOL_VERSION, buildVersion: GAME_BUILD_VERSION, displayName, roomCode });
}

export function saveOnlineSession(value: StoredOnlineSession) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}
export function loadOnlineSession(): StoredOnlineSession | null {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as StoredOnlineSession | null; } catch { return null; }
}
export function clearOnlineSession() { localStorage.removeItem(STORAGE_KEY); }

export class OnlineConnection {
  private socket: WebSocket | null = null;
  private room: PublicRoomState | null;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private pendingActionId: string | null = null;
  private attempts = 0;
  private stopped = false;

  constructor(private stored: StoredOnlineSession, initialRoom: PublicRoomState | null, private callbacks: OnlineCallbacks) {
    this.room = initialRoom;
  }

  connect() {
    if (!ONLINE_SERVER_URL || this.stopped) return;
    this.callbacks.onConnection(this.attempts ? 'reconnecting' : 'connecting');
    const wsBase = ONLINE_SERVER_URL.replace(/^http/, 'ws');
    const socket = new WebSocket(`${wsBase}/api/rooms/${encodeURIComponent(this.stored.roomCode)}/connect`);
    this.socket = socket;
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'AUTH', protocolVersion: PROTOCOL_VERSION, buildVersion: GAME_BUILD_VERSION, roomCode: this.stored.roomCode, sessionId: this.stored.credentials.sessionId, sessionToken: this.stored.credentials.sessionToken }));
    });
    socket.addEventListener('message', event => this.receive(String(event.data)));
    socket.addEventListener('close', event => {
      this.stopHeartbeat(); this.pendingActionId = null; this.callbacks.onPending(false);
      if (this.stopped || event.code === 4001 || event.code === 4400 || event.code === 4404) {
        this.callbacks.onConnection('closed');
        if (event.code >= 4400) this.callbacks.onError(event.code === 4404 ? 'ROOM_NOT_FOUND' : 'UNAUTHENTICATED', event.reason || 'The room connection closed.');
        return;
      }
      if (event.code !== 4000) this.callbacks.onError('NETWORK_ERROR', 'Connection lost. Reconnecting…');
      this.scheduleReconnect();
    });
    socket.addEventListener('error', () => { if (!this.stopped) this.callbacks.onConnection('reconnecting'); });
  }

  close() {
    this.stopped = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.stopHeartbeat(); this.socket?.close(1000, 'Left room'); this.callbacks.onConnection('closed');
  }

  sendReady(ready: boolean) { return this.send('READY', { ready }); }
  sendStart() { return this.send('START'); }
  sendGameAction(action: Action) { return this.send('GAME_ACTION', { action }); }
  sendRematch(accept = true) { return this.send('REMATCH_VOTE', { accept }); }

  private send(type: ClientCommand['type'], extra: Record<string, unknown> = {}): boolean {
    if (this.pendingActionId) return false;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) { this.callbacks.onError('NETWORK_ERROR', 'Waiting for the room connection.'); return false; }
    if (!this.room) { this.callbacks.onError('NETWORK_ERROR', 'Waiting for the authoritative room snapshot.'); return false; }
    const envelope = { type, protocolVersion: PROTOCOL_VERSION, buildVersion: GAME_BUILD_VERSION, roomCode: this.stored.roomCode, sessionId: this.stored.credentials.sessionId, actionId: crypto.randomUUID(), expectedSequence: this.room.sequence, ...extra };
    this.pendingActionId = envelope.actionId; this.socket.send(JSON.stringify(envelope)); this.callbacks.onPending(true); return true;
  }

  private receive(raw: string) {
    let event: ServerEvent;
    try { event = JSON.parse(raw) as ServerEvent; } catch { this.callbacks.onError('NETWORK_ERROR', 'The server sent an unreadable response.'); return; }
    if (event.protocolVersion !== PROTOCOL_VERSION || event.buildVersion !== GAME_BUILD_VERSION) { this.callbacks.onError('VERSION_MISMATCH', 'Refresh GridBreak to use the current online protocol.'); this.close(); return; }
    if (event.type === 'AUTHENTICATED') {
      this.attempts = 0; this.callbacks.onConnection('connected'); this.startHeartbeat(); return;
    }
    if (event.type === 'SNAPSHOT') {
      if (!this.room || event.sequence >= this.room.sequence) { this.room = event.room; this.callbacks.onSnapshot(event.room); }
      if (event.actionId && event.actionId === this.pendingActionId) { this.pendingActionId = null; this.callbacks.onPending(false); }
      return;
    }
    if (event.type === 'ACTION_REJECTED') {
      if (!event.actionId || event.actionId === this.pendingActionId) { this.pendingActionId = null; this.callbacks.onPending(false); }
      this.callbacks.onError(event.code, event.message);
      if (event.code === 'STALE_SEQUENCE') { this.socket?.close(4000, 'Resync'); }
    }
  }

  private scheduleReconnect() {
    this.callbacks.onConnection('reconnecting');
    const delay = Math.min(8_000, 500 * 2 ** this.attempts++);
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }
  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'PING', protocolVersion: PROTOCOL_VERSION, buildVersion: GAME_BUILD_VERSION, roomCode: this.stored.roomCode, sessionId: this.stored.credentials.sessionId }));
    }, 25_000);
  }
  private stopHeartbeat() { if (this.heartbeatTimer !== null) window.clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
}
