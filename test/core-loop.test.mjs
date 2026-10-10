import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { displayName } from '../src/teaching/lexicon.js';
import { startCompanion } from './fixtures/offline-main.mjs';
import { offlineUuid } from '../scripts/owner-uuid.mjs';
import { mcData } from '../src/teaching/lexicon.js';

const tempRoot = process.env.COMPANION_TEST_TMP ?? fileURLToPath(new URL('../../.tmp/', import.meta.url));
const ownerUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
function removeDirectory(directory) {
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
  rmdirSync(directory);
}

function fakeBot() {
  const bot = new EventEmitter();
  bot.username = 'Companion';
  bot.entity = { position: { x: 0, y: 0, z: 0 } };
  bot.players = {};
  bot.entities = {};
  bot.chats = [];
  bot.quitCount = 0;
  bot.lookAt = () => Promise.resolve();
  bot.loadPlugin = () => {
    bot.pathfinder = { setMovements(movements) { bot.movements = movements; } };
  };
  bot.quit = () => { bot.quitCount++; };
  bot.chat = message => { bot.chats.push(message); };
  bot.registry = mcData;
  return bot;
}

function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('timed out in T6 test'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('config, lexicon, and offline UUID helpers', () => {
  const secret = 'do-not-log-this';
  const config = loadConfig({ OWNER_UUID: ownerUuid, BRAIN_BASE_URL: 'https://example.invalid',
    BRAIN_API_KEY: secret, BRAIN_MODEL: 'model' });
  assert.equal(config.brainBaseUrl, 'https://example.invalid');
  assert.equal(config.brainApiKey, secret);
  assert.equal(JSON.stringify(config).includes(secret), false);
  assert.equal(displayName('crafting_table'), '工作台');
  assert.equal(displayName('unknown_item'), 'unknown_item');
  assert.equal(offlineUuid('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f');
});

test('main assembles after spawn, routes owner events, and closes once', async t => {
  const directory = mkdtempSync(join(tempRoot, 't6-test-'));
  const bot = fakeBot();
  const signals = new EventEmitter();
  const app = startCompanion({
    config: loadConfig({ OWNER_UUID: ownerUuid, COMPANION_DATA_DIR: directory }), signals,
    createBot: () => bot, pathfinderPlugin: () => {}, mcData,
  });
  try {
    assert.equal(bot.movements, undefined);
    bot.emit('spawn');
    await app.ready;
    assert.ok(bot.movements);

    bot.players.Owner = { username: 'Owner', uuid: ownerUuid };
    bot.emit('playerJoined', bot.players.Owner);
    await waitFor(() => app.eventlog.query({ kind: 'say' }).length === 1);
    assert.equal(bot.chats.length, 0);
    bot.emit('playerJoined', { username: 'Stranger', uuid: '11111111-2222-4333-8444-555555555555' });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(bot.chats.length, 0);

    bot.emit('chat', 'Owner', '做个工作台');
    await waitFor(() => bot.chats.length === 1, 2_500);
    assert.equal(bot.chats[0], '工作台：还不会。');
    app.close();
    app.close();
    assert.equal(bot.quitCount, 1);
    assert.equal(signals.listenerCount('SIGINT'), 0);
  } finally {
    app.close();
    removeDirectory(directory);
  }
});

test('main narrates owner presence with Gemini settings and most recent owner departure', async () => {
  const directory = mkdtempSync(join(tempRoot, 't6-test-'));
  const bot = fakeBot();
  const requests = [];
  const app = startCompanion({
    config: loadConfig({ OWNER_UUID: ownerUuid, COMPANION_DATA_DIR: directory,
      BRAIN_PROVIDER: 'gemini', BRAIN_BASE_URL: 'https://example.invalid/v1beta',
      BRAIN_API_KEY: 'fake-main-key', BRAIN_MODEL: 'base-model', BRAIN_SPEAK_MODEL: 'speaker', BRAIN_SPEAK_THINKING: 'high' }),
    signals: new EventEmitter(), createBot: () => bot, pathfinderPlugin: () => {}, mcData,
    fetch: async (url, options) => {
      if (url.includes(':generateContent')) return { ok: true, status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'null' }] } }] }) };
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, body: new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '生成的叙述。' }] } }] })}\n\n`));
        controller.close();
      } }) };
    },
  });
  try {
    bot.emit('spawn');
    await app.ready;
    const player = { username: 'Owner', uuid: ownerUuid };
    bot.emit('playerJoined', player);
    await waitFor(() => bot.chats.length === 1);
    const first = JSON.parse(requests[0].body.contents[0].parts[0].text).situation;
    assert.equal(first.kind, 'owner_joined');
    assert.equal(Object.hasOwn(first, 'lastLeftAt'), false);
    assert.equal(Object.hasOwn(first, 'awayMs'), false);
    bot.emit('playerLeft', player);
    await waitFor(() => bot.chats.length === 2);
    const lastLeft = app.eventlog.query({ kind: 'playerLeft' }).at(-1);
    bot.emit('playerLeft', { username: 'Stranger', uuid: '11111111-2222-4333-8444-555555555555' });
    bot.emit('playerJoined', player);
    await waitFor(() => bot.chats.length === 3);
    const last = JSON.parse(requests[2].body.contents[0].parts[0].text).situation;
    assert.equal(last.kind, 'owner_joined');
    assert.equal(last.lastLeftAt, lastLeft.ts);
    assert.ok(last.awayMs >= 0);
    assert.equal(JSON.parse(requests[1].body.contents[0].parts[0].text).situation.kind, 'owner_left');
    assert.equal(requests[0].url, 'https://example.invalid/v1beta/models/speaker:streamGenerateContent?alt=sse');
    assert.equal(requests[0].body.generationConfig.thinkingConfig.thinkingLevel, 'high');
    assert.deepEqual(app.eventlog.query({ kind: 'say' }).map(row => row.payload), [
      { kind: 'owner_joined', usedBrain: true }, { kind: 'owner_left', usedBrain: true }, { kind: 'owner_joined', usedBrain: true },
    ]);
  } finally {
    app.close();
    removeDirectory(directory);
  }
});

for (const trigger of ['spawn', 'playerJoined', 'chat']) {
  test(`main: ${trigger} generates in background using UUID identity and persists across restart`, async () => {
    const directory = mkdtempSync(join(tempRoot, 't8-main-'));
    let app;
    let nicknameRequests = 0;
    let finishNickname;
    const speeches = [];
    const config = loadConfig({ OWNER_UUID: ownerUuid, COMPANION_DATA_DIR: directory,
      BRAIN_PROVIDER: 'gemini', BRAIN_BASE_URL: 'https://example.invalid/v1beta',
      BRAIN_API_KEY: 'fake-main-key', BRAIN_MODEL: 'base-model' });
    const create = bot => startCompanion({ config, signals: new EventEmitter(),
      createBot: () => bot, pathfinderPlugin: () => {}, mcData,
      fetch: async (url, options) => {
        const body = JSON.parse(options.body);
        if (url.includes(':generateContent')) {
          nicknameRequests++;
          assert.equal(JSON.parse(body.contents[0].parts[0].text).playerName, 'TestOwner');
          return new Promise(resolve => { finishNickname = () => resolve({ ok: true, status: 200,
            json: async () => ({ candidates: [{ content: { parts: [{ text: '{"nickname":"阿测"}' }] } }] }) }); });
        }
        speeches.push(JSON.parse(body.contents[0].parts[0].text).situation);
        return { ok: true, status: 200, body: new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: '现场生成。' }] } }] })}\n\n`));
          controller.close();
        } }) };
      },
    });
    try {
      const bot = fakeBot();
      const owner = { username: 'TestOwner', uuid: ownerUuid.toUpperCase() };
      if (trigger === 'spawn') bot.players.TestOwner = owner;
      app = create(bot);
      bot.emit('spawn');
      await app.ready;
      // A matching display name alone must never grant owner identity.
      bot.emit('playerJoined', { username: 'TestOwner', uuid: '11111111-2222-4333-8444-555555555555' });
      if (trigger !== 'spawn') assert.equal(nicknameRequests, 0);
      bot.players.TestOwner = owner;
      if (trigger === 'playerJoined') bot.emit('playerJoined', owner);
      else bot.emit('chat', 'TestOwner', '做个工作台');
      await waitFor(() => nicknameRequests === 1 && bot.chats.length === 1);
      assert.equal(app.eventlog.query({ kind: 'relationship.nickname' }).length, 0);
      assert.deepEqual(speeches[0].owner, { playerName: 'TestOwner', nickname: 'TestOwner' });
      assert.equal(speeches[0].taughtBy, null);
      finishNickname();
      await waitFor(() => app.eventlog.query({ kind: 'relationship.nickname' }).length === 1);
      app.close();
      const restartedBot = fakeBot();
      restartedBot.players.TestOwner = owner;
      app = create(restartedBot);
      restartedBot.emit('spawn');
      await app.ready;
      restartedBot.emit('chat', 'TestOwner', '做个工作台');
      await waitFor(() => restartedBot.chats.length === 1);
      assert.equal(nicknameRequests, 1);
      assert.deepEqual(speeches.at(-1).owner, { playerName: 'TestOwner', nickname: '阿测' });
      assert.equal(app.eventlog.query({ kind: 'relationship.nickname' }).length, 1);
      restartedBot.emit('playerLeft', owner);
      await waitFor(() => restartedBot.chats.length === 2);
      assert.deepEqual(speeches.at(-1).owner, { playerName: null, nickname: null });
    } finally {
      app?.close();
      removeDirectory(directory);
    }
  });
}
