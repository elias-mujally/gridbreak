import WebSocket from 'ws';
import assert from 'node:assert/strict';

const endpoint = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const protocolVersion = 2;
const buildVersion = 'online-modes-v2';
const wsEndpoint = endpoint.replace(/^http/, 'ws');
const remote = count => Array.from({ length: count }, () => 'HUMAN_REMOTE');
const config = (mode, mapId, layout, playerCount = 2) => ({ mode, mapId, layout, playerCount, controllers: remote(playerCount) });

async function post(path, body) {
  const response = await fetch(`${endpoint}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(result)}`); return result;
}

class Client {
  constructor(admission) { this.admission = admission; this.room = admission.room; this.queue = []; this.waiters = []; this.rawEvents = []; }
  async connect() {
    this.queue = []; this.socket = new WebSocket(`${wsEndpoint}/api/rooms/${this.admission.room.code}/connect`);
    this.socket.on('message', value => { const raw = String(value); this.rawEvents.push(raw); const event = JSON.parse(raw); if (event.type === 'SNAPSHOT') this.room = event.room; const index = this.waiters.findIndex(waiter => waiter.predicate(event)); if (index >= 0) this.waiters.splice(index, 1)[0].resolve(event); else this.queue.push(event); });
    await new Promise((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject); });
    this.socket.send(JSON.stringify({ type: 'AUTH', protocolVersion, buildVersion, roomCode: this.room.code, ...this.admission.credentials }));
    const authenticated = await this.waitFor(event => event.type === 'AUTHENTICATED'); await this.waitFor(event => event.type === 'SNAPSHOT' && event.sequence >= authenticated.sequence); return this;
  }
  waitFor(predicate, timeout = 7000) {
    const queued = this.queue.findIndex(predicate); if (queued >= 0) return Promise.resolve(this.queue.splice(queued, 1)[0]);
    return new Promise((resolve, reject) => { const waiter = { predicate, resolve: event => { clearTimeout(timer); resolve(event); } }; const timer = setTimeout(() => { this.waiters = this.waiters.filter(item => item !== waiter); reject(new Error('Timed out waiting for WebSocket event')); }, timeout); this.waiters.push(waiter); });
  }
  envelope(type, extra = {}, options = {}) { return { type, protocolVersion, buildVersion, roomCode: this.room.code, sessionId: this.admission.credentials.sessionId, actionId: options.actionId ?? crypto.randomUUID(), expectedSequence: options.expectedSequence ?? this.room.sequence, ...extra }; }
  async command(type, extra = {}, options = {}) { const envelope = this.envelope(type, extra, options); this.socket.send(JSON.stringify(envelope)); const event = await this.waitFor(item => (item.type === 'SNAPSHOT' && item.actionId === envelope.actionId) || (item.type === 'ACTION_REJECTED' && item.actionId === envelope.actionId)); return { envelope, event }; }
  close() { this.socket?.close(1000, 'smoke close'); }
}

async function admissionSet(configuration) {
  const admissions = [await post('/api/rooms', { protocolVersion, buildVersion, displayName: 'Host One', configuration })];
  for (let index = 1; index < configuration.playerCount; index++) admissions.push(await post(`/api/rooms/${admissions[0].room.code.toLowerCase()}`, { protocolVersion, buildVersion, displayName: `Guest ${index + 1}`, roomCode: admissions[0].room.code }));
  return admissions;
}
async function synchronize(clients, minimumSequence) {
  await Promise.all(clients.map(async client => { if (client.room.sequence < minimumSequence) await client.waitFor(event => event.type === 'SNAPSHOT' && event.sequence >= minimumSequence); }));
  assert.equal(new Set(clients.map(client => client.room.sequence)).size, 1, 'client sequences diverged');
  const positions = clients.map(client => JSON.stringify({ turn: client.room.game?.turn, ply: client.room.game?.ply, winner: client.room.game?.winner, players: client.room.game?.players.map(player => ({ id: player.id, position: player.position, wallsRemaining: player.wallsRemaining })), walls: client.room.game?.walls.map(wall => ({ row: wall.row, col: wall.col, orientation: wall.orientation, owner: wall.owner })) }));
  assert.equal(new Set(positions).size, 1, 'public authoritative positions diverged');
}
async function readyAndStart(clients) {
  for (const client of clients) { const { event } = await client.command('READY', { ready: true }); assert.equal(event.type, 'SNAPSHOT', JSON.stringify(event)); await synchronize(clients, event.sequence); }
  const { event } = await clients[0].command('START'); assert.equal(event.type, 'SNAPSHOT', JSON.stringify(event)); assert.equal(event.room.phase, 'playing'); await synchronize(clients, event.sequence);
}
function currentClient(clients) { const turn = clients[0].room.game.turn; return clients.find(client => client.room.selfPlayerId === turn); }
function directMove(game) {
  const player = game.players.find(item => item.id === game.turn); const goal = player.goal; let row = player.position.row; let col = player.position.col;
  if (goal.kind === 'cell') { const dr = Math.sign(goal.cell.row - row); const dc = dr === 0 ? Math.sign(goal.cell.col - col) : 0; row += dr; col += dc; }
  else if (goal.edge === 'top') row--; else if (goal.edge === 'bottom') row++; else if (goal.edge === 'left') col--; else col++;
  return { type: 'move', to: { row, col } };
}
async function openMatch(configuration) {
  const admissions = await admissionSet(configuration); const clients = [];
  for (const admission of admissions) clients.push(await new Client(admission).connect());
  await synchronize(clients, Math.max(...clients.map(client => client.room.sequence)));
  await readyAndStart(clients); return clients;
}

async function runClassic(configuration) {
  const clients = await openMatch(configuration); const wrong = clients.find(client => client !== currentClient(clients)); const rejected = await wrong.command('GAME_ACTION', { action: directMove(wrong.room.game) }); assert.equal(rejected.event.code, 'NOT_YOUR_TURN');
  const actor = currentClient(clients); const moved = await actor.command('GAME_ACTION', { action: directMove(actor.room.game) }); assert.equal(moved.event.type, 'SNAPSHOT'); await synchronize(clients, moved.event.sequence);
  actor.socket.send(JSON.stringify(moved.envelope)); const duplicate = await actor.waitFor(event => event.type === 'ACTION_REJECTED' && event.actionId === moved.envelope.actionId); assert.equal(duplicate.code, 'DUPLICATE_ACTION');
  clients.forEach(client => client.close()); return { code: actor.room.code, sequence: actor.room.sequence, configuration };
}

async function runRush() {
  const clients = await openMatch(config('rush', 'sprint', 'opposite')); const actor = currentClient(clients);
  const placed = await actor.command('GAME_ACTION', { action: { type: 'phantom', wall: { row: 0, col: 0, orientation: 'horizontal' } } }); assert.equal(placed.event.type, 'SNAPSHOT'); await synchronize(clients, placed.event.sequence);
  const owner = clients.find(client => client.room.selfPlayerId === 'blue'); const opponent = clients.find(client => client.room.selfPlayerId === 'red');
  assert.equal(owner.room.game.walls.some(wall => wall.knownPhantom), true, 'owner lost Phantom identity');
  assert.equal(opponent.room.game.walls.some(wall => wall.knownPhantom), false, 'opponent received Phantom identity');
  const opponentPayload = opponent.rawEvents.at(-1); assert.equal(opponentPayload.includes('"phantoms"'), false); assert.equal(opponentPayload.includes('"knownPhantom":true'), false);
  opponent.close(); const disconnected = await owner.waitFor(event => event.type === 'SNAPSHOT' && event.room.members.some(member => member.connection === 'reconnecting')); opponent.room = disconnected.room; await opponent.connect(); await synchronize(clients, opponent.room.sequence); assert.equal(opponent.room.game.walls.some(wall => wall.knownPhantom), false, 'reconnect leaked Phantom identity');
  clients.forEach(client => client.close()); return { code: owner.room.code, sequence: owner.room.sequence, phantomPrivacy: 'PASS' };
}

async function runConvergence(playerCount) {
  const clients = await openMatch(config('convergence', playerCount === 2 ? 'arena' : 'grand', 'convergence', playerCount));
  const actor = currentClient(clients); const moved = await actor.command('GAME_ACTION', { action: directMove(actor.room.game) }); assert.equal(moved.event.type, 'SNAPSHOT'); await synchronize(clients, moved.event.sequence);
  clients.forEach(client => client.close()); return { code: actor.room.code, sequence: actor.room.sequence, playerCount };
}

const health = await fetch(`${endpoint}/health`).then(response => response.json()); assert.deepEqual(health, { ok: true, protocolVersion, buildVersion });
const classicSprint = await runClassic(config('classic', 'sprint', 'opposite'));
const classicWideParallel = await runClassic(config('classic', 'wide', 'parallel'));
const classicGauntletParallel = await runClassic(config('classic', 'gauntlet', 'parallel'));
const rush = await runRush(); const convergence2 = await runConvergence(2); const convergence4 = await runConvergence(4);
console.log(JSON.stringify({ endpoint, health, classicSprint, classicWideParallel, classicGauntletParallel, rush, convergence2, convergence4, result: 'PASS' }, null, 2));
