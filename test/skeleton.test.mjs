import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { createEventLog } from '../src/eventlog.js';
import { createArbiter } from '../src/arbiter.js';
import { createIdentity } from '../src/identity.js';
import { createTraceId, span } from '../src/trace.js';
import { createLookAtOwner } from '../src/reflex/lookAtOwner.js';
import { createBody } from '../src/body.js';
import { startCompanion } from './fixtures/offline-main.mjs';

const OWNER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER = '11111111-2222-4333-8444-555555555555';
const tempRoot = process.env.COMPANION_TEST_TMP ?? fileURLToPath(new URL('../../.tmp/', import.meta.url));

function databaseFixture(t, options) {
  mkdirSync(tempRoot, { recursive: true });
  const directory = mkdtempSync(join(tempRoot, 't1-test-'));
  const logs = [];
  t.after(() => {
    try {
      for (const log of logs) log.close();
    } finally {
      assert.equal(dirname(directory), resolve(tempRoot));
      for (const file of readdirSync(directory)) unlinkSync(join(directory, file));
      rmdirSync(directory);
      assert.equal(existsSync(directory), false);
    }
  });
  const open = () => {
    const log = createEventLog(directory, options);
    logs.push(log);
    return log;
  };
  return { directory, open };
}

class Position {
  constructor(x, y, z) {
    Object.assign(this, { x, y, z });
  }
  offset(x, y, z) {
    return new Position(this.x + x, this.y + y, this.z + z);
  }
}

function fakeBot() {
  const bot = new EventEmitter();
  bot.username = 'Companion';
  bot.entity = { position: new Position(0, 0, 0) };
  bot.players = {};
  bot.entities = {};
  bot.looks = [];
  bot.plugins = [];
  bot.quitCount = 0;
  bot.lookAt = point => {
    bot.looks.push(point);
    return Promise.resolve();
  };
  bot.loadPlugin = plugin => bot.plugins.push(plugin);
  bot.quit = () => { bot.quitCount += 1; };
  return bot;
}

function visibleOwner(bot, distance = 4) {
  const entity = { uuid: OWNER, position: new Position(distance, 0, 0), height: 1.8 };
  bot.players.Owner = { username: 'Owner', uuid: OWNER, entity };
  return entity;
}

test('config: missing OWNER_UUID names the variable', () => {
  assert.throws(() => loadConfig({}), /OWNER_UUID/);
  assert.throws(() => loadConfig({ OWNER_UUID: '' }), /OWNER_UUID/);
});

test('config: malformed and unhyphenated UUIDs are rejected', () => {
  for (const uuid of ['Owner', OWNER.replaceAll('-', ''), `${OWNER}0`, ` ${OWNER}`]) {
    assert.throws(() => loadConfig({ OWNER_UUID: uuid }), /OWNER_UUID/);
  }
});

test('config: defaults are correct regardless of working directory', () => {
  assert.deepEqual(loadConfig({ OWNER_UUID: OWNER.toUpperCase() }), {
    host: '127.0.0.1', port: 25565, version: '1.20.4', botName: 'Companion',
    ownerUuid: OWNER,
    dataDir: fileURLToPath(new URL('../data', import.meta.url)),
  });
});

test('config: environment overrides and absolute data path', () => {
  const config = loadConfig({
    OWNER_UUID: OWNER, MC_HOST: 'localhost', MC_PORT: '25566',
    MC_VERSION: '1.21.1', BOT_NAME: 'TestBot', COMPANION_DATA_DIR: './data-test',
  });
  assert.deepEqual(config, {
    host: 'localhost', port: 25566, version: '1.21.1', botName: 'TestBot',
    ownerUuid: OWNER, dataDir: resolve('./data-test'),
  });
});

test('config: invalid port and empty settings name their variable', () => {
  for (const port of ['0', '65536', '1.5', 'abc', '', 'Infinity']) {
    assert.throws(() => loadConfig({ OWNER_UUID: OWNER, MC_PORT: port }), /MC_PORT/);
  }
  for (const name of ['MC_HOST', 'MC_VERSION', 'BOT_NAME', 'COMPANION_DATA_DIR']) {
    assert.throws(() => loadConfig({ OWNER_UUID: OWNER, [name]: ' ' }), new RegExp(name));
  }
});

test('config: proactive and learning-budget defaults, bounds and invalid values', () => {
  const config = loadConfig({ OWNER_UUID: OWNER });
  assert.equal(config.proactive, true);
  assert.equal(config.proactiveTickMs, 1000);
  assert.equal(config.proactiveIdleProposalMs, 180000);
  assert.equal(config.proactiveProposalCooldownMs, 600000);
  assert.equal(config.learningBudgetDaily, 30);
  for (const name of ['proactive', 'proactiveTickMs', 'proactiveIdleProposalMs',
    'proactiveProposalCooldownMs', 'learningBudgetDaily']) {
    assert.equal(Object.keys(config).includes(name), false, `${name} must stay non-enumerable`);
  }
  assert.equal(loadConfig({ OWNER_UUID: OWNER, PROACTIVE: '0' }).proactive, false);
  assert.equal(loadConfig({ OWNER_UUID: OWNER, LEARNING_BUDGET_DAILY: '0' }).learningBudgetDaily, 0);
  assert.equal(loadConfig({ OWNER_UUID: OWNER, LEARNING_BUDGET_DAILY: '1000' }).learningBudgetDaily, 1000);
  for (const name of ['PROACTIVE', 'PROACTIVE_TICK_MS', 'PROACTIVE_IDLE_PROPOSAL_MS',
    'PROACTIVE_PROPOSAL_COOLDOWN_MS', 'LEARNING_BUDGET_DAILY']) {
    assert.throws(() => loadConfig({ OWNER_UUID: OWNER, [name]: 'bogus' }),
      error => error.message.includes(name) && !error.message.includes('bogus'), name);
  }
  for (const value of ['0', '-1', '1.5']) {
    assert.throws(() => loadConfig({ OWNER_UUID: OWNER, PROACTIVE_TICK_MS: value }), /PROACTIVE_TICK_MS/);
  }
  for (const value of ['-1', '1001', '1.5']) {
    assert.throws(() => loadConfig({ OWNER_UUID: OWNER, LEARNING_BUDGET_DAILY: value }), /LEARNING_BUDGET_DAILY/);
  }
});

test('eventlog: payload JSON round trip, kind/since filters and limit', t => {
  let now = 100;
  const log = databaseFixture(t, { now: () => now++ }).open();
  const payload = { message: 'hello', nested: { values: [1, true, null, '\u4e3b\u4eba'] } };
  const first = log.append('chat', payload, 'trace-one');
  log.append('spawn', {}, 'trace-two');
  log.append('chat', { message: 'later' }, 'trace-three');
  assert.deepEqual(first, { id: 1, ts: 100, trace_id: 'trace-one', kind: 'chat', payload });
  assert.deepEqual(log.query({ kind: 'chat' }).map(row => row.id), [1, 3]);
  assert.deepEqual(log.query({ since: 101 }).map(row => row.id), [2, 3]);
  assert.deepEqual(log.query({ kind: 'chat', since: 101 }).map(row => row.id), [3]);
  assert.deepEqual(log.query({ since: 100, limit: 1 })[0].payload, payload);
  assert.equal(log.query({ limit: 0 }).length, 0);
  assert.equal(log.query({ kind: "chat' OR 1=1 --" }).length, 0);
});

test('eventlog: database survives close and reopen', t => {
  const fixture = databaseFixture(t);
  const log = fixture.open();
  const record = log.append('death', { count: 1 }, createTraceId());
  log.close();
  const reopened = fixture.open();
  assert.deepEqual(reopened.query(), [record]);
  assert.ok(reopened.append('spawn', {}, createTraceId()).id > record.id);
});

test('eventlog: append-only API rejects non-JSON payload and invalid query', t => {
  const log = databaseFixture(t).open();
  assert.equal(log.update, undefined);
  assert.equal(log.delete, undefined);
  assert.throws(() => log.append('chat', undefined), /JSON/);
  assert.throws(() => log.query({ limit: -1 }), /limit/);
  assert.throws(() => log.query({ since: NaN }), /since/);
  assert.equal(log.query().length, 0);
});

test('eventlog: close ignores late writes and returns empty queries without changing persisted events', t => {
  const fixture = databaseFixture(t);
  const log = fixture.open();
  const saved = log.append('before.close', { count: 1 });
  log.close();
  log.close();
  assert.equal(log.append('after.close', { count: 2 }), null);
  assert.equal(log.append('', undefined, ''), null);
  assert.deepEqual(log.query(), []);
  assert.deepEqual(log.query({ limit: -1, since: NaN }), []);
  assert.deepEqual(fixture.open().query(), [saved]);
});

test('arbiter: running tasks settle after SQLite closes, including late shutdown results', async t => {
  for (const cancelled of [false, true]) {
    const log = databaseFixture(t).open();
    let resolveRun;
    const running = new Promise(resolve => { resolveRun = resolve; });
    const arbiter = createArbiter({ eventlog: log,
      registry: { has: () => true, run: () => running } });
    const notices = [];
    arbiter.on('done', outcome => notices.push(outcome));
    const task = arbiter.submit({ source: 'owner', label: 'follow', steps: [{ primitive: 'follow' }] });
    if (cancelled) arbiter.cancel('shutdown');
    log.close();
    resolveRun({ ok: true, result: 'late success' });
    assert.equal((await task.done).status, cancelled ? 'cancelled' : 'completed');
    // Let detached execute() reach arbiter.stale and flush unhandled rejection detection.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(arbiter.current(), null);
    assert.equal(notices.length, 1);
    assert.deepEqual(log.query(), []);
  }
});

test('identity: same username with a different UUID is not the owner', () => {
  const { isOwner } = createIdentity(OWNER);
  assert.equal(isOwner({ username: 'Owner', uuid: OTHER }), false);
  assert.equal(isOwner({ username: 'Owner' }), false);
  assert.equal(isOwner(null), false);
  assert.equal(isOwner({ username: 'AnotherName', uuid: OWNER }), true);
});

test('identity: UUID comparison is case insensitive for players and entities', () => {
  const { isOwner } = createIdentity(OWNER.toUpperCase());
  assert.equal(isOwner({ uuid: OWNER }), true);
  assert.equal(isOwner({ uuid: OWNER.toUpperCase(), position: {} }), true);
});

test('trace: unique IDs and idempotent span duration record', () => {
  const traceId = createTraceId();
  assert.notEqual(traceId, createTraceId());
  const hop = span(traceId, 'body.chat');
  const record = hop.end();
  assert.equal(record.trace_id, traceId);
  assert.equal(record.name, 'body.chat');
  assert.ok(Number.isFinite(record.duration_ms) && record.duration_ms >= 0);
  assert.deepEqual(hop.end(), record);
});

test('reflex: looks at owner inside 8 blocks and aims at head height', async () => {
  const bot = fakeBot();
  visibleOwner(bot);
  const reflex = createLookAtOwner(bot, createIdentity(OWNER).isOwner);
  await reflex(1);
  assert.deepEqual(bot.looks, [new Position(4, 1.8, 0)]);
});

test('reflex: exactly 8 blocks triggers, farther away does not', async () => {
  const bot = fakeBot();
  const owner = visibleOwner(bot, 8);
  const reflex = createLookAtOwner(bot, createIdentity(OWNER).isOwner);
  await reflex(1);
  owner.position.x = 8.01;
  await reflex(2);
  assert.equal(bot.looks.length, 1);
  owner.position = new Position(6, 6, 0);
  await reflex(3);
  assert.equal(bot.looks.length, 1);
});

test('reflex: same tick cannot turn twice, next tick can', async () => {
  const bot = fakeBot();
  visibleOwner(bot);
  const reflex = createLookAtOwner(bot, createIdentity(OWNER).isOwner);
  await reflex(10);
  await reflex(10);
  assert.equal(bot.looks.length, 1);
  await reflex(11);
  assert.equal(bot.looks.length, 2);
});

test('reflex: absent/invisible owners and impostors do not move the head', async () => {
  const bot = fakeBot();
  const reflex = createLookAtOwner(bot, createIdentity(OWNER).isOwner);
  await reflex(1);
  bot.players.Owner = { uuid: OWNER };
  await reflex(2);
  bot.players.Owner = { uuid: OTHER, entity: { position: new Position(1, 0, 0) } };
  await reflex(3);
  assert.equal(bot.looks.length, 0);
  visibleOwner(bot).isValid = false;
  await reflex(4);
  assert.equal(bot.looks.length, 0);
});

test('reflex: visible owner entity UUID works without a player-list entry', async () => {
  const bot = fakeBot();
  bot.entities[1] = { uuid: OWNER, position: new Position(1, 0, 0) };
  await createLookAtOwner(bot, createIdentity(OWNER).isOwner)(1);
  assert.equal(bot.looks.length, 1);
});

test('body: offline connection settings and pathfinder loading use injected bot', t => {
  const log = databaseFixture(t).open();
  const bot = fakeBot();
  const plugin = () => {};
  let received;
  const body = createBody(loadConfig({ OWNER_UUID: OWNER }), log, {
    createBot: options => { received = options; return bot; }, pathfinderPlugin: plugin,
  });
  t.after(() => body.close());
  assert.deepEqual(received, {
    host: '127.0.0.1', port: 25565, version: '1.20.4', username: 'Companion', auth: 'offline',
  });
  assert.deepEqual(bot.plugins, [plugin]);
});

test('body: chat owner flag follows UUID, including impersonation and unknown senders', t => {
  const log = databaseFixture(t).open();
  const bot = fakeBot();
  const body = createBody(loadConfig({ OWNER_UUID: OWNER }), log, {
    createBot: () => bot, pathfinderPlugin: () => {},
  });
  t.after(() => body.close());
  bot.players.Owner = { uuid: OWNER.toUpperCase() };
  bot.emit('chat', 'Owner', 'hello');
  bot.players.Owner.uuid = OTHER;
  bot.emit('chat', 'Owner', 'impostor');
  bot.emit('chat', 'Unknown', 'hello');
  const chats = log.query({ kind: 'chat' });
  assert.deepEqual(chats.map(row => row.payload.from_owner), [true, false, false]);
  assert.equal(chats[0].payload.message, 'hello');
  assert.equal(chats[0].payload.uuid, OWNER.toUpperCase());
  const spans = log.query({ kind: 'span' });
  assert.deepEqual(spans.map(row => row.trace_id), chats.map(row => row.trace_id));
});

test('body: all required lifecycle events are persisted as JSON', t => {
  const log = databaseFixture(t).open();
  const bot = fakeBot();
  const body = createBody(loadConfig({ OWNER_UUID: OWNER }), log, {
    createBot: () => bot, pathfinderPlugin: () => {},
  });
  t.after(() => body.close());
  const player = { username: 'Owner', uuid: OWNER, entity: bot.entity };
  bot.emit('spawn');
  bot.emit('playerJoined', player);
  bot.emit('playerLeft', player);
  bot.emit('death');
  bot.emit('kicked', { text: 'test reason' }, true);
  bot.emit('error', new Error('test error'));
  assert.deepEqual(log.query().filter(row => row.kind !== 'span').map(row => row.kind), [
    'spawn', 'playerJoined', 'playerLeft', 'death', 'kicked', 'error',
  ]);
  assert.equal(log.query({ kind: 'error' })[0].payload.message, 'test error');
  assert.deepEqual(log.query({ kind: 'playerJoined' })[0].payload, {
    username: 'Owner', uuid: OWNER,
  });
});

test('body: physics ticks run reflex and rejected lookAt is logged', async t => {
  const log = databaseFixture(t).open();
  const bot = fakeBot();
  visibleOwner(bot);
  const body = createBody(loadConfig({ OWNER_UUID: OWNER }), log, {
    createBot: () => bot, pathfinderPlugin: () => {},
  });
  t.after(() => body.close());
  bot.emit('physicsTick');
  assert.equal(bot.looks.length, 1);
  bot.lookAt = () => Promise.reject(new Error('look failed'));
  bot.emit('physicsTick');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(log.query({ kind: 'error' })[0].payload.source, 'lookAtOwner');
});

test('body: close is idempotent and detaches listeners', t => {
  const log = databaseFixture(t).open();
  const bot = fakeBot();
  const body = createBody(loadConfig({ OWNER_UUID: OWNER }), log, {
    createBot: () => bot, pathfinderPlugin: () => {},
  });
  body.close();
  body.close();
  assert.equal(bot.quitCount, 1);
  assert.equal(bot.listenerCount('chat'), 0);
  assert.equal(bot.listenerCount('physicsTick'), 0);
  bot.emit('chat', 'Owner', 'after close');
  assert.equal(log.query().length, 0);
});

test('main: SIGINT closes bot and database, retains persisted events', t => {
  const fixture = databaseFixture(t);
  const signals = new EventEmitter();
  const bot = fakeBot();
  const app = startCompanion({
    config: loadConfig({ OWNER_UUID: OWNER, COMPANION_DATA_DIR: fixture.directory }),
    signals, createBot: () => bot, pathfinderPlugin: () => {},
  });
  t.after(() => app.close());
  bot.emit('spawn');
  signals.emit('SIGINT');
  app.close();
  assert.equal(bot.quitCount, 1);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.deepEqual(app.eventlog.query(), []);
  assert.equal(fixture.open().query({ kind: 'spawn' }).length, 1);
});

test('main: failed startup closes database and bot before cleanup', t => {
  const fixture = databaseFixture(t);
  const bot = fakeBot();
  bot.loadPlugin = () => { throw new Error('plugin failed'); };
  assert.throws(() => startCompanion({
    config: loadConfig({ OWNER_UUID: OWNER, COMPANION_DATA_DIR: fixture.directory }),
    signals: new EventEmitter(), createBot: () => bot, pathfinderPlugin: () => {},
  }), /plugin failed/);
  assert.equal(bot.quitCount, 1);
  assert.equal(fixture.open().query().length, 0);
});
