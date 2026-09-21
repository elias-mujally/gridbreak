import { DurableObject } from 'cloudflare:workers';
import { generateRoomCode, hashSessionToken, randomToken } from '../src/online/identity';
import {
  GAME_BUILD_VERSION, MAX_MESSAGE_BYTES, PROTOCOL_VERSION, ROOM_CODE_PATTERN,
  normalizeRoomCode, parseClientMessage, rejection, validateCreateRoomRequest, validateJoinRoomRequest,
  type AuthMessage, type OnlineErrorCode, type RoomAdmission, type ServerEvent,
} from '../src/online/protocol';
import { ABANDON_AFTER_MS, OnlineRoom, RECONNECT_GRACE_MS, ROOM_EXPIRY_MS, type StoredRoom } from '../src/online/room';
import type { MatchConfiguration } from '../src/game/modes';

export interface Env {
  ROOMS: DurableObjectNamespace<RoomDurableObject>;
  ALLOWED_ORIGINS: string;
}

type SocketAttachment = { sessionId: string | null; violations: number };
type InternalCreate = { code: string; configuration: MatchConfiguration; sessionId: string; tokenHash: string; displayName: string; now: number };
type InternalJoin = { sessionId: string; tokenHash: string; displayName: string; now: number };

const json = (value: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const errorBody = (code: OnlineErrorCode, message: string) => ({ error: { code, message }, protocolVersion: PROTOCOL_VERSION, buildVersion: GAME_BUILD_VERSION });

async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_MESSAGE_BYTES) return { ok: false, response: json(errorBody('PAYLOAD_TOO_LARGE', 'Request exceeds the 8 KB limit.'), 413) };
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_MESSAGE_BYTES) return { ok: false, response: json(errorBody('PAYLOAD_TOO_LARGE', 'Request exceeds the 8 KB limit.'), 413) };
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false, response: json(errorBody('INVALID_REQUEST', 'Malformed JSON.'), 400) }; }
}

function allowedOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  return env.ALLOWED_ORIGINS.split(',').map(value => value.trim()).includes(origin) ? origin : '';
}

function corsHeaders(origin: string | null): HeadersInit {
  return origin ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400', vary: 'Origin' } : {};
}

function addCors(response: Response, cors: HeadersInit): Response {
  const headers = new Headers(response.headers);
  new Headers(cors).forEach((value, key) => headers.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function forwardJson(stub: DurableObjectStub<RoomDurableObject>, path: string, body: unknown) {
  return stub.fetch(`https://room.internal${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export class RoomDurableObject extends DurableObject<Env> {
  private room: OnlineRoom | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<StoredRoom>('room');
      // Protocol V1 rooms stored Convergence-only metadata and cannot be projected safely as V2.
      if (stored && 'configuration' in stored) this.room = OnlineRoom.restore(stored);
      else { if (stored) await ctx.storage.deleteAll(); this.room = null; }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/create' && request.method === 'POST') {
      if (this.room && !this.room.isExpired()) return json(errorBody('INVALID_REQUEST', 'Room code already exists.'), 409);
      const body = await request.json<InternalCreate>();
      this.room = OnlineRoom.create(body);
      await this.persist();
      return json({ room: this.room.snapshot(body.sessionId, body.now) }, 201);
    }
    if (url.pathname === '/join' && request.method === 'POST') {
      if (!this.room || this.room.isExpired()) return json(errorBody('ROOM_NOT_FOUND', 'Room not found.'), 404);
      const body = await request.json<InternalJoin>();
      const result = this.room.join(body);
      if (!result.ok) return json(errorBody(result.code, result.message), result.code === 'ROOM_FULL' ? 409 : 403);
      await this.persist();
      this.broadcastSnapshots(body.now);
      return json({ room: result.value }, 201);
    }
    if (url.pathname === '/socket') {
      if (!this.room || this.room.isExpired()) return json(errorBody('ROOM_NOT_FOUND', 'Room not found.'), 404);
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json(errorBody('INVALID_REQUEST', 'Expected a WebSocket upgrade.'), 426);
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ sessionId: null, violations: 0 } satisfies SocketAttachment);
      return new Response(null, { status: 101, webSocket: client });
    }
    return json(errorBody('ROOM_NOT_FOUND', 'Room endpoint not found.'), 404);
  }

  async webSocketMessage(ws: WebSocket, raw: ArrayBuffer | string) {
    if (!this.room) { ws.close(4404, 'Room not found'); return; }
    const attachment = (ws.deserializeAttachment() as SocketAttachment | null) ?? { sessionId: null, violations: 0 };
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) { this.violation(ws, attachment, parsed.code, parsed.message); return; }
    const message = parsed.value;
    if (!attachment.sessionId) {
      if (message.type !== 'AUTH') { this.violation(ws, attachment, 'UNAUTHENTICATED', 'Authenticate before sending room actions.'); return; }
      await this.authenticateSocket(ws, attachment, message);
      return;
    }
    if (message.type === 'AUTH') { this.violation(ws, attachment, 'INVALID_REQUEST', 'Connection is already authenticated.'); return; }
    if (message.roomCode.toUpperCase() !== this.room.code() || message.sessionId !== attachment.sessionId) { this.violation(ws, attachment, 'UNAUTHENTICATED', 'Message identity does not match this connection.'); return; }
    if (message.type === 'PING') {
      this.send(ws, { type: 'PONG', protocolVersion: PROTOCOL_VERSION, buildVersion: GAME_BUILD_VERSION, sequence: this.room.sequence() });
      return;
    }
    const result = this.room.command(attachment.sessionId, message, Date.now());
    await this.persist();
    if (!result.accepted) { this.send(ws, rejection(result.code, result.message, result.sequence, message.actionId)); return; }
    this.broadcastSnapshots(Date.now(), { sessionId: attachment.sessionId, actionId: message.actionId });
  }

  async webSocketClose(ws: WebSocket) { await this.handleDisconnect(ws); }
  async webSocketError(ws: WebSocket) { await this.handleDisconnect(ws); }

  async alarm() {
    if (!this.room) return;
    const now = Date.now();
    const changed = this.room.sweep(now);
    const state = this.room.persisted();
    if (changed) this.broadcastSnapshots(now);
    if (state.phase === 'expired') {
      for (const socket of this.ctx.getWebSockets()) socket.close(4404, 'Room expired');
      await this.ctx.storage.deleteAll(); this.room = null; return;
    }
    await this.persist();
    if (!changed) this.broadcastSnapshots(now);
  }

  private async authenticateSocket(ws: WebSocket, attachment: SocketAttachment, message: AuthMessage) {
    if (!this.room || message.roomCode.toUpperCase() !== this.room.code() || !ROOM_CODE_PATTERN.test(message.roomCode.toUpperCase())) { this.violation(ws, attachment, 'ROOM_NOT_FOUND', 'Room not found.'); return; }
    const tokenHash = await hashSessionToken(message.sessionToken);
    if (!this.room.authenticate(message.sessionId, tokenHash)) { this.violation(ws, attachment, 'UNAUTHENTICATED', 'Session token is invalid.'); return; }
    for (const existing of this.ctx.getWebSockets()) {
      if (existing === ws) continue;
      const prior = existing.deserializeAttachment() as SocketAttachment | null;
      if (prior?.sessionId === message.sessionId) existing.close(4001, 'Reconnected elsewhere');
    }
    attachment.sessionId = message.sessionId; attachment.violations = 0; ws.serializeAttachment(attachment);
    const result = this.room.connect(message.sessionId, Date.now());
    await this.persist();
    if (!result.accepted) { this.violation(ws, attachment, result.code, result.message); return; }
    this.send(ws, { type: 'AUTHENTICATED', protocolVersion: PROTOCOL_VERSION, buildVersion: GAME_BUILD_VERSION, sequence: result.snapshot.sequence, sessionId: message.sessionId });
    this.broadcastSnapshots(Date.now());
  }

  private async handleDisconnect(ws: WebSocket) {
    if (!this.room) return;
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!attachment?.sessionId) return;
    const replacement = this.ctx.getWebSockets().some(other => other !== ws && (other.deserializeAttachment() as SocketAttachment | null)?.sessionId === attachment.sessionId && other.readyState === WebSocket.OPEN);
    if (replacement) return;
    const result = this.room.disconnect(attachment.sessionId, Date.now());
    if (!result.accepted) return;
    await this.persist();
    this.broadcastSnapshots(Date.now());
  }

  private violation(ws: WebSocket, attachment: SocketAttachment, code: OnlineErrorCode, message: string) {
    attachment.violations++; ws.serializeAttachment(attachment);
    this.send(ws, rejection(code, message, this.room?.sequence() ?? 0));
    if (attachment.violations >= 3) ws.close(4400, 'Too many invalid messages');
  }
  private send(ws: WebSocket, event: ServerEvent) { try { ws.send(JSON.stringify(event)); } catch { /* socket already closed */ } }
  private broadcastSnapshots(now: number, acknowledgement?: { sessionId: string; actionId: string }) {
    if (!this.room) return;
    for (const socket of this.ctx.getWebSockets()) {
      const sessionId = (socket.deserializeAttachment() as SocketAttachment | null)?.sessionId;
      if (!sessionId) continue;
      const room = this.room.snapshot(sessionId, now);
      this.send(socket, { type: 'SNAPSHOT', protocolVersion: PROTOCOL_VERSION, buildVersion: GAME_BUILD_VERSION, sequence: room.sequence, ...(acknowledgement?.sessionId === sessionId ? { actionId: acknowledgement.actionId } : {}), room });
    }
  }
  private async persist() {
    if (!this.room) return;
    await this.ctx.storage.put('room', this.room.persisted());
    const state = this.room.persisted();
    const now = Date.now();
    const reconnectAt = state.members
      .filter(member => !member.connected && member.disconnectedAt !== null && member.disconnectedAt + RECONNECT_GRACE_MS > now)
      .map(member => member.disconnectedAt! + RECONNECT_GRACE_MS);
    const abandonAt = state.phase === 'playing' && state.allDisconnectedAt !== null ? state.allDisconnectedAt + ABANDON_AFTER_MS : Infinity;
    const expiryAt = state.lastActivityAt + ROOM_EXPIRY_MS;
    await this.ctx.storage.setAlarm(Math.min(expiryAt, abandonAt, ...reconnectAt));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);
    if (origin === '') return json(errorBody('INVALID_REQUEST', 'Origin is not allowed.'), 403);
    const cors = corsHeaders(origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/health') return json({ ok: true, protocolVersion: PROTOCOL_VERSION, buildVersion: GAME_BUILD_VERSION }, 200, cors);

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const body = await readJson(request); if (!body.ok) return addCors(body.response, cors);
      const valid = validateCreateRoomRequest(body.value); if (!valid.ok) return json(errorBody(valid.code, valid.message), 400, cors);
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = generateRoomCode(); const sessionId = crypto.randomUUID(); const sessionToken = randomToken(); const tokenHash = await hashSessionToken(sessionToken);
        const stub = env.ROOMS.getByName(code);
        const response = await forwardJson(stub, '/create', { code, configuration: valid.value.configuration, sessionId, tokenHash, displayName: valid.value.displayName, now: Date.now() } satisfies InternalCreate);
        if (response.status === 409) continue;
        if (!response.ok) return json(errorBody('INTERNAL_ERROR', 'Room creation failed.'), 500, cors);
        const result = await response.json<{ room: RoomAdmission['room'] }>();
        return json({ credentials: { sessionId, sessionToken }, room: result.room } satisfies RoomAdmission, 201, cors);
      }
      return json(errorBody('INTERNAL_ERROR', 'Could not allocate a unique room code.'), 503, cors);
    }

    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(connect))?$/);
    if (match) {
      const code = normalizeRoomCode(decodeURIComponent(match[1]));
      if (!ROOM_CODE_PATTERN.test(code)) return json(errorBody('ROOM_NOT_FOUND', 'Room not found.'), 404, cors);
      const stub = env.ROOMS.getByName(code);
      if (match[2] === 'connect') {
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json(errorBody('INVALID_REQUEST', 'Expected WebSocket upgrade.'), 426, cors);
        const forwarded = new Request('https://room.internal/socket', request);
        return stub.fetch(forwarded);
      }
      if (request.method === 'POST') {
        const body = await readJson(request); if (!body.ok) return addCors(body.response, cors);
        const valid = validateJoinRoomRequest({ ...(body.value as object), roomCode: code });
        if (!valid.ok) return json(errorBody(valid.code, valid.message), 400, cors);
        const sessionId = crypto.randomUUID(); const sessionToken = randomToken(); const tokenHash = await hashSessionToken(sessionToken);
        const response = await forwardJson(stub, '/join', { sessionId, tokenHash, displayName: valid.value.displayName, now: Date.now() } satisfies InternalJoin);
        const result = await response.json<{ room?: RoomAdmission['room']; error?: { code: OnlineErrorCode; message: string } }>();
        if (!response.ok || !result.room) return json(errorBody(result.error?.code ?? 'ROOM_NOT_FOUND', result.error?.message ?? 'Room not found.'), response.status, cors);
        return json({ credentials: { sessionId, sessionToken }, room: result.room } satisfies RoomAdmission, 201, cors);
      }
    }
    return json(errorBody('ROOM_NOT_FOUND', 'Endpoint not found.'), 404, cors);
  },
};
