import WebSocket from 'ws';
import assert from 'node:assert/strict';

const endpoint = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const protocolVersion = 1;
const buildVersion = 'convergence-online-v1';
const wsEndpoint = endpoint.replace(/^http/, 'ws');

async function post(path, body) {
  const response = await fetch(`${endpoint}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(result)}`);
  return result;
}

class Client {
  constructor(admission) {
    this.admission = admission;
    this.room = admission.room;
    this.queue = [];
    this.waiters = [];
  }

  async connect() {
    this.queue = [];
    this.socket = new WebSocket(`${wsEndpoint}/api/rooms/${this.admission.room.code}/connect`);
    this.socket.on('message', value => {
      const event = JSON.parse(String(value));
      if (event.type === 'SNAPSHOT') this.room = event.room;
      const index = this.waiters.findIndex(waiter => waiter.predicate(event));
      if (index >= 0) this.waiters.splice(index, 1)[0].resolve(event);
      else this.queue.push(event);
    });
    await new Promise((resolve, reject) => { this.socket.once('open', resolve); this.socket.once('error', reject); });
    this.socket.send(JSON.stringify({ type: 'AUTH', protocolVersion, buildVersion, roomCode: this.room.code, ...this.admission.credentials }));
    const authenticated = await this.waitFor(event => event.type === 'AUTHENTICATED');
    await this.waitFor(event => event.type === 'SNAPSHOT' && event.sequence >= authenticated.sequence);
    return this;
  }

  waitFor(predicate, timeout = 5000) {
    const queued = this.queue.findIndex(predicate);
    if (queued >= 0) return Promise.resolve(this.queue.splice(queued, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve: event => { clearTimeout(timer); resolve(event); } };
      const timer = setTimeout(() => { this.waiters = this.waiters.filter(item => item !== waiter); reject(new Error('Timed out waiting for WebSocket event')); }, timeout);
      this.waiters.push(waiter);
    });
  }

  envelope(type, extra = {}, options = {}) {
    return {
      type, protocolVersion, buildVersion, roomCode: this.room.code,
      sessionId: this.admission.credentials.sessionId,
      actionId: options.actionId ?? crypto.randomUUID(),
      expectedSequence: options.expectedSequence ?? this.room.sequence,
      ...extra,
    };
  }

  async command(type, extra = {}, options = {}) {
    const envelope = this.envelope(type, extra, options);
    const previousSequence = this.room.sequence;
    this.socket.send(JSON.stringify(envelope));
    const event = await this.waitFor(item =>
      (item.type === 'SNAPSHOT' && item.sequence > previousSequence)
      || (item.type === 'ACTION_REJECTED' && item.actionId === envelope.actionId));
    return { envelope, event };
  }

  close() { this.socket?.close(1000, 'smoke reconnect'); }
}

async function admissionSet(playerCount, mapId) {
  const admissions = [];
  admissions.push(await post('/api/rooms', { protocolVersion, buildVersion, displayName: 'Host One', mapId, playerCount }));
  for (let index = 1; index < playerCount; index++) {
    admissions.push(await post(`/api/rooms/${admissions[0].room.code.toLowerCase()}`, { protocolVersion, buildVersion, displayName: `Guest ${index + 1}`, roomCode: admissions[0].room.code }));
  }
  return admissions;
}

async function synchronize(clients, minimumSequence) {
  await Promise.all(clients.map(async client => {
    if (client.room.sequence >= minimumSequence) return;
    await client.waitFor(event => event.type === 'SNAPSHOT' && event.sequence >= minimumSequence);
  }));
  assert.equal(new Set(clients.map(client => client.room.sequence)).size, 1, 'client sequences diverged');
  assert.equal(new Set(clients.map(client => JSON.stringify(client.room.game))).size, 1, 'authoritative game snapshots diverged');
}

async function readyAndStart(clients) {
  for (const client of clients) {
    const { event } = await client.command('READY', { ready: true });
    assert.equal(event.type, 'SNAPSHOT');
    await synchronize(clients, event.sequence);
  }
  const { event } = await clients[0].command('START');
  assert.equal(event.type, 'SNAPSHOT');
  assert.equal(event.room.phase, 'playing');
  await synchronize(clients, event.sequence);
}

function currentClient(clients) {
  const currentId = clients[0].room.game.turnOrder[clients[0].room.game.currentTurnIndex];
  return clients.find(client => client.room.members.some(member => member.sessionId === client.admission.credentials.sessionId && member.playerId === currentId));
}

function directMove(game) {
  const playerId = game.turnOrder[game.currentTurnIndex];
  const player = game.players.find(item => item.id === playerId);
  const goal = player.goal.cell;
  const deltaRow = Math.sign(goal.row - player.position.row);
  const deltaCol = deltaRow === 0 ? Math.sign(goal.col - player.position.col) : 0;
  return { type: 'move', to: { row: player.position.row + deltaRow, col: player.position.col + deltaCol } };
}

async function runTwoPlayer() {
  const admissions = await admissionSet(2, 'arena');
  const clients = [];
  for (const admission of admissions) clients.push(await new Client(admission).connect());
  assert.equal(clients[0].room.members.length, 2);
  await readyAndStart(clients);

  const wrong = clients.find(client => client !== currentClient(clients));
  const wrongResult = await wrong.command('GAME_ACTION', { action: directMove(wrong.room.game) });
  assert.equal(wrongResult.event.code, 'NOT_YOUR_TURN');

  const actor = currentClient(clients);
  const accepted = await actor.command('GAME_ACTION', { action: directMove(actor.room.game) });
  assert.equal(accepted.event.type, 'SNAPSHOT');
  await synchronize(clients, accepted.event.sequence);
  actor.socket.send(JSON.stringify(accepted.envelope));
  const duplicate = await actor.waitFor(event => event.type === 'ACTION_REJECTED' && event.actionId === accepted.envelope.actionId);
  assert.equal(duplicate.code, 'DUPLICATE_ACTION');

  const reconnecting = clients[1];
  reconnecting.close();
  const disconnected = await clients[0].waitFor(event => event.type === 'SNAPSHOT' && event.room.members.some(member => member.connection === 'reconnecting'));
  reconnecting.room = disconnected.room;
  await reconnecting.connect();
  await synchronize(clients, reconnecting.room.sequence);
  assert.equal(reconnecting.room.members.length, 2, 'reconnect duplicated a pawn');

  while (clients[0].room.phase === 'playing') {
    const current = currentClient(clients);
    const result = await current.command('GAME_ACTION', { action: directMove(current.room.game) });
    assert.equal(result.event.type, 'SNAPSHOT');
    await synchronize(clients, result.event.sequence);
  }
  assert.equal(clients[0].room.phase, 'finished');
  assert.ok(clients[0].room.game.winner);

  for (const client of clients) {
    const vote = await client.command('REMATCH_VOTE', { accept: true });
    assert.equal(vote.event.type, 'SNAPSHOT');
    await synchronize(clients, vote.event.sequence);
  }
  assert.equal(clients[0].room.phase, 'playing');
  assert.equal(clients[0].room.game.winner, null);
  clients.forEach(client => client.close());
  return { code: clients[0].room.code, sequence: clients[0].room.sequence };
}

async function runFourPlayer() {
  const admissions = await admissionSet(4, 'grand');
  const clients = [];
  for (const admission of admissions) clients.push(await new Client(admission).connect());
  await readyAndStart(clients);

  const wallActor = currentClient(clients);
  const wall = await wallActor.command('GAME_ACTION', { action: { type: 'wall', wall: { row: 0, col: 0, orientation: 'horizontal' } } });
  assert.equal(wall.event.type, 'SNAPSHOT');
  await synchronize(clients, wall.event.sequence);
  for (let index = 0; index < 8; index++) {
    const actor = currentClient(clients);
    const moved = await actor.command('GAME_ACTION', { action: directMove(actor.room.game) });
    assert.equal(moved.event.type, 'SNAPSHOT');
    await synchronize(clients, moved.event.sequence);
  }
  assert.equal(clients[0].room.game.walls.length, 1);
  clients.forEach(client => client.close());
  return { code: clients[0].room.code, sequence: clients[0].room.sequence };
}

const health = await fetch(`${endpoint}/health`).then(response => response.json());
assert.deepEqual(health, { ok: true, protocolVersion, buildVersion });
const two = await runTwoPlayer();
const four = await runFourPlayer();
console.log(JSON.stringify({ endpoint, health, twoPlayer: two, fourPlayer: four, result: 'PASS' }, null, 2));
