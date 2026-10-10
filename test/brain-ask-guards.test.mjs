import test from 'node:test';
import assert from 'node:assert/strict';
import { createJev } from '../src/decision/jev.js';
import { parseCollectIntent, validateIntent } from '../src/decision/intent.js';
import { generateCandidates, runIntent } from '../src/decision/stepper.js';
import { createArbiter } from '../src/arbiter.js';
import { createOwnerChatHandler } from '../src/teaching/handler.js';
import { mcData } from '../src/teaching/lexicon.js';

const scoreQuestion = { danger: { type: 'score', instructions: 'Score danger.', criteria: ['none', 'some', 'immediate'] } };
const response = answers => ({ ok: true, status: 200, json: async () => ({ answers }) });
const scoreResult = (answer, questions = scoreQuestion) => createJev({ apiKey: 'fake-key',
  fetch: async () => response({ danger: answer }) }).ask({ state: 'offline', questions });
const intent = () => parseCollectIntent('挖3个泥土');
const bot = () => ({ entity: { position: { x: 0, y: 64, z: 0 } }, entities: {},
  findBlocks: () => [{ x: 2, y: 64, z: 0 }] });
function choosing(select) {
  let calls = 0;
  return createJev({ apiKey: 'fake-key', fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    const choice = select(body, calls++);
    return response({ next_action: { choice, confidence: 0.95 }, danger: { score: 1.03 } });
  } });
}

test('R1 score accepts finite fractional values and optional confidence', async () => {
  for (const score of [0, 1.03, 2]) {
    assert.equal((await scoreResult({ score })).ok, true);
    assert.equal((await scoreResult({ score, confidence: 0.8 })).ok, true);
  }
  assert.equal((await scoreResult({ score: 2.03 }, { danger: { ...scoreQuestion.danger,
    criteria: ['none', 'some', 'high', 'immediate'] } })).ok, true);
});

test('R1 score rejects negative, over-range, nonfinite values and invalid present confidence', async () => {
  for (const score of [-0.1, 2.5, Infinity, -Infinity, NaN, '1', null]) {
    assert.equal((await scoreResult({ score })).error.code, 'bad_response');
  }
  for (const confidence of [-0.1, 1.1, Infinity, NaN, null, '0.8']) {
    assert.equal((await scoreResult({ score: 1.03, confidence })).error.code, 'bad_response');
  }
});

function handlerFixture({ initialCount = 5, gain = 3, select = () => 'dig_block_1', countFails = false } = {}) {
  let count = initialCount;
  const calls = [], logs = [], situations = [], requests = [];
  const registry = { has: () => true, run: async (primitive, params) => {
    calls.push({ primitive, params });
    if (primitive === 'countItem') return countFails ? { ok: false } : { ok: true, result: count };
    count += gain;
    return { ok: true };
  } };
  const eventlog = { append: (kind, payload) => logs.push({ kind, payload }), query: () => logs };
  const arbiter = createArbiter({ registry, eventlog });
  const jev = choosing((body, call) => { requests.push(body); return select(body, call); });
  const handler = createOwnerChatHandler({ library: { list: () => [], has: () => false }, arbiter, registry,
    bot: bot(), jev, learningAutonomy: 2, mouth: { say: async text => text },
    brain: { enabled: true, speak: async ({ situation }) => { situations.push(situation); return null; } },
    eventlog, ownerUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    relationship: { ownerName: () => 'Owner', nickname: () => null } });
  return { handler, calls, logs, situations, requests };
}

test('R2 existing five plus requested three requires eight and reports only three gained', async () => {
  const fixture = handlerFixture();
  const result = await fixture.handler.handle('挖3个泥土', 'r2');
  assert.equal(result.kind, 'self_try');
  assert.equal(fixture.logs.find(event => event.kind === 'intent.start').payload.success.atLeast, 8);
  assert.equal(fixture.requests.length, 1, 'existing inventory must not finish the intent before Jev acts');
  assert.deepEqual(fixture.calls.filter(call => call.primitive !== 'countItem').map(call => call.primitive), ['dig']);
  assert.equal(fixture.calls[0].primitive, 'countItem', 'read baseline before execution');
  const situation = fixture.situations.at(-1);
  assert.equal(situation.status, 'succeeded');
  assert.equal(situation.got, 3);
  assert.equal(situation.wanted, 3);
  assert.match(result.text, /3\/3/u);
});

test('R2 requested count caps at base plus sixteen and failed attempt reports zero gained', async () => {
  const fixture = handlerFixture({ select: () => 'escalate' });
  await fixture.handler.handle('挖100个泥土', 'r2-cap');
  assert.equal(fixture.logs.find(event => event.kind === 'intent.start').payload.success.atLeast, 21);
  assert.equal(fixture.situations.at(-1).got, 0);
  assert.equal(fixture.situations.at(-1).wanted, 16);
  assert.equal(parseCollectIntent('挖100个泥土', { baseCount: 5 }).success.atLeast, 21);
});

test('R2 validateIntent accepts 2304 and rejects 2305 and invalid lower or fractional counts', () => {
  for (const atLeast of [1, 65, 2304]) assert.equal(validateIntent({ ...intent(), success: { hasItem: 'dirt', atLeast } }).ok, true);
  for (const atLeast of [0, -1, 1.5, 2305]) assert.equal(validateIntent({ ...intent(), success: { hasItem: 'dirt', atLeast } }).ok, false);
});

test('R2 unreadable baseline cannot start an intent or claim old inventory as newly gained', async () => {
  const fixture = handlerFixture({ countFails: true });
  assert.equal((await fixture.handler.handle('挖3个泥土', 'r2-fail')).kind, 'dont_know');
  assert.equal(fixture.logs.some(event => event.kind === 'intent.start'), false);
});

test('R3 executed searches rotate east south west north by ten blocks and then repeat', async () => {
  const moves = [], searches = [];
  const registry = { run: async (primitive, params) => {
    if (primitive === 'countItem') return { ok: true, result: 0 };
    moves.push(params); return { ok: true };
  } };
  const result = await runIntent({ intent: { ...intent(), maxSteps: 5 }, bot: bot(), mcData, registry,
    jev: choosing(body => {
      searches.push(JSON.parse(body.state).candidates.find(candidate => candidate.key === 'search'));
      return 'search';
    }) });
  assert.equal(result.reason, 'step_budget');
  assert.equal(searches.length, 5);
  assert.deepEqual(moves, [[10, 0], [0, 10], [-10, 0], [0, -10], [10, 0]]
    .map(([x, z]) => ({ x, y: 64, z, range: 1 })));
  assert.notDeepEqual(moves[0], moves[1]);
});

test('R4 unrelated or nameless typed drops never create collect_drops while target drops do', () => {
  const fakeBot = bot();
  for (const dropped of [{ name: 'cobblestone', type: mcData.itemsByName.cobblestone.id },
    { type: mcData.itemsByName.dirt.id }, undefined]) {
    fakeBot.entities = { drop: { position: { x: 1, y: 64, z: 0 }, getDroppedItem: () => dropped } };
    assert.equal(generateCandidates({ bot: fakeBot, intent: intent(), mcData }).some(candidate => candidate.key === 'collect_drops'), false);
  }
  fakeBot.entities.drop.getDroppedItem = () => ({ name: 'dirt', type: mcData.itemsByName.dirt.id });
  assert.equal(generateCandidates({ bot: fakeBot, intent: intent(), mcData }).some(candidate => candidate.key === 'collect_drops'), true);
});

test('R5 same dig coordinate fails twice even when candidate keys change', async () => {
  const fakeBot = bot();
  const target = { x: 2, y: 64, z: 0 };
  const calls = [], keys = [];
  fakeBot.findBlocks = () => calls.length ? [{ x: 1, y: 64, z: 0 }, target] : [target];
  const result = await runIntent({ intent: intent(), bot: fakeBot, mcData,
    registry: { run: async (primitive, params) => {
      if (primitive === 'countItem') return { ok: true, result: 0 };
      calls.push(params); return { ok: false, error: { code: 'cannot_dig' } };
    } }, jev: choosing(() => { const key = calls.length ? 'dig_block_2' : 'dig_block_1'; keys.push(key); return key; }) });
  assert.equal(result.reason, 'repeated_failure');
  assert.deepEqual(keys, ['dig_block_1', 'dig_block_2']);
  assert.deepEqual(calls, [target, target]);
});

test('R5 same candidate key at different coordinates does not count as repeated failure', async () => {
  const fakeBot = bot(), calls = [];
  fakeBot.findBlocks = () => [{ x: 1 + calls.length, y: 64, z: 0 }];
  const result = await runIntent({ intent: { ...intent(), maxSteps: 2 }, bot: fakeBot, mcData,
    registry: { run: async (primitive, params) => {
      if (primitive === 'countItem') return { ok: true, result: 0 };
      calls.push(params); return { ok: false };
    } }, jev: choosing(() => 'dig_block_1') });
  assert.equal(result.reason, 'step_budget');
  assert.notDeepEqual(calls[0], calls[1]);
});

test('R5 success or another target breaks a consecutive failure streak', async () => {
  for (const choices of [['dig_block_1', 'dig_block_1', 'dig_block_1'], ['dig_block_1', 'dig_block_2', 'dig_block_1']]) {
    const fakeBot = bot(); let actions = 0;
    fakeBot.findBlocks = () => [{ x: 1, y: 64, z: 0 }, { x: 2, y: 64, z: 0 }];
    const result = await runIntent({ intent: { ...intent(), maxSteps: 3 }, bot: fakeBot, mcData,
      registry: { run: async primitive => {
        if (primitive === 'countItem') return { ok: true, result: 0 };
        const ok = choices[1] === 'dig_block_1' && actions === 1;
        actions++; return { ok };
      } }, jev: choosing((_body, call) => choices[call]) });
    assert.equal(result.reason, 'step_budget');
    assert.equal(actions, 3);
  }
});
