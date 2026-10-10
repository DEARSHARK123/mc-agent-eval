import test from 'node:test';
import assert from 'node:assert/strict';
import { mcData } from '../src/teaching/lexicon.js';
import { createJev } from '../src/decision/jev.js';
import { parseCollectIntent, validateIntent } from '../src/decision/intent.js';
import { generateCandidates, runIntent } from '../src/decision/stepper.js';
import { createArbiter } from '../src/arbiter.js';
import { createOwnerChatHandler } from '../src/teaching/handler.js';
import { loadConfig } from '../src/config.js';

const baseIntent = { goal: 'Collect 3 dirt blocks for the owner', goalText: '挖3个泥土',
  success: { hasItem: 'dirt', atLeast: 3 }, target: { block: 'dirt', item: 'dirt' },
  allowed: ['findBlock', 'goTo', 'dig', 'collectDrops'], maxSteps: 40, deadlineMs: 180000 };
const response = answers => ({ ok: true, status: 200, json: async () => ({ model: 'jev-latest', answers, usage: { input_tokens: 3, output_tokens: 2 } }) });
const answers = choice => ({ next_action: { choice, confidence: 0.95 }, danger: { score: 0, confidence: 0.95 } });
const fakeBot = () => ({ entity: { position: { x: 0, y: 64, z: 0 } },
  findBlocks: () => [{ x: 2, y: 64, z: 0 }], entities: {} });

test('Jev parses, validates typed answers, handles timeout/cancel/http once, and redacts event payload', async () => {
  const logs = [];
  const question = { next_action: { type: 'choice', instructions: 'Choose one action.', criteria: { a: 'do a' } } };
  const good = createJev({ apiKey: 'secret', fetch: async () => response({ next_action: { choice: 'a', confidence: 0.8 } }), eventlog: { append: (...args) => logs.push(args) } });
  assert.equal((await good.ask({ state: '中文主人原话', questions: question })).ok, true);
  for (const bad of [
    { choice: 'b', confidence: 0.8 }, { choice: 'a', confidence: 1.1 },
  ]) assert.equal((await createJev({ apiKey: 'secret', fetch: async () => response({ next_action: bad }) }).ask({ state: 'x', questions: question })).error.code, 'bad_response');
  const scoreQuestion = { danger: { type: 'score', instructions: 'Score danger.', criteria: ['none', 'some'] } };
  assert.equal((await createJev({ apiKey: 'secret', fetch: async () => response({ danger: { score: 2, confidence: 0.8 } }) }).ask({ state: 'x', questions: scoreQuestion })).error.code, 'bad_response');
  const threeLevels = { danger: { type: 'score', instructions: 'Score danger.', criteria: ['none', 'some', 'immediate'] } };
  assert.equal((await createJev({ apiKey: 'secret', fetch: async () => response({ danger: { score: 2.03 } }) }).ask({ state: 'x', questions: threeLevels })).ok, true);
  assert.equal((await createJev({ apiKey: 'secret', fetch: async () => response({ danger: { score: -0.1 } }) }).ask({ state: 'x', questions: threeLevels })).error.code, 'bad_response');
  assert.equal((await createJev({ apiKey: 'secret', fetch: async () => response({ danger: { score: 2.5 } }) }).ask({ state: 'x', questions: threeLevels })).error.code, 'bad_response');
  assert.equal((await createJev({ apiKey: 'secret', timeoutMs: 5, fetch: () => new Promise(() => {}) }).ask({ state: 'x', questions: question })).error.code, 'timeout');
  const controller = new AbortController(); controller.abort();
  assert.equal((await createJev({ apiKey: 'secret', fetch: () => new Promise(() => {}) }).ask({ state: 'x', questions: question, signal: controller.signal })).error.code, 'cancelled');
  for (const status of [429, 503]) {
    let calls = 0;
    const result = await createJev({ apiKey: 'secret', fetch: async () => { calls++; return { ok: false, status }; } }).ask({ state: 'x', questions: question });
    assert.equal(result.error.code, `http_${status}`); assert.equal(calls, 1);
  }
  const payload = logs.at(-1)[1];
  assert.equal(JSON.stringify(payload).includes('secret'), false);
  assert.equal(JSON.stringify(payload).includes('中文主人原话'), false);
  assert.deepEqual(payload.question_ids, ['next_action']);
});

test('request keeps Chinese owner text in state while all question prose and criteria stay English', async () => {
  let sent;
  const client = createJev({ apiKey: 'key', fetch: async (_url, options) => { sent = JSON.parse(options.body); return response({ next_action: { choice: 'goto_block_1', confidence: 0.9 } }); } });
  const questions = { next_action: { type: 'choice', instructions: 'Choose one candidate action.', criteria: { goto_block_1: 'go to dirt' } } };
  await client.ask({ state: JSON.stringify({ goalText: '挖3个泥土' }), questions });
  assert.match(sent.state, /挖3个泥土/u);
  assert.doesNotMatch(JSON.stringify(sent.questions), /[\u3400-\u9fff]/u);
  assert.deepEqual(Object.keys(sent.questions.next_action.criteria), ['goto_block_1']);
});

test('validateIntent rejects unsafe primitives, unknown names, and bounds; parser caps at 16', () => {
  assert.deepEqual(parseCollectIntent('挖100个泥土').success.atLeast, 16);
  for (const change of [
    { allowed: ['say'] }, { allowed: ['follow'] }, { target: { block: 'nope', item: 'nope' } },
    { success: { hasItem: 'dirt', atLeast: 2305 } }, { maxSteps: 61 }, { deadlineMs: 600001 },
  ]) assert.equal(validateIntent({ ...baseIntent, ...change }).ok, false);
});

test('configuration defaults and validates Jev key, model, timeout, confidence, and autonomy', () => {
  const owner = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const defaults = loadConfig({ OWNER_UUID: owner });
  assert.equal(defaults.jevModel, 'jev-latest');
  assert.equal(defaults.jevTimeoutMs, 2000);
  assert.equal(defaults.jevConfidenceMin, 0.7);
  assert.equal(defaults.learningAutonomy, 2);
  assert.equal(defaults.typesafeApiKey, '');
  const custom = loadConfig({ OWNER_UUID: owner, TYPESAFE_API_KEY: 'key', JEV_MODEL: 'custom', JEV_TIMEOUT_MS: '55', JEV_CONFIDENCE_MIN: '0.4', LEARNING_AUTONOMY: '1' });
  assert.equal(custom.jevModel, 'custom'); assert.equal(custom.jevTimeoutMs, 55);
  assert.equal(custom.jevConfidenceMin, 0.4); assert.equal(custom.learningAutonomy, 1);
  assert.throws(() => loadConfig({ OWNER_UUID: owner, JEV_CONFIDENCE_MIN: '1.1' }), /JEV_CONFIDENCE_MIN/u);
  assert.throws(() => loadConfig({ OWNER_UUID: owner, LEARNING_AUTONOMY: '3' }), /LEARNING_AUTONOMY/u);
});

test('stepper runs approach, dig, collect and records matching actions through success', async () => {
  let count = 0; const calls = []; const logs = [];
  const registry = { run: async (name, params) => {
    calls.push({ name, params });
    if (name === 'countItem') return { ok: true, result: count };
    if (name === 'collectDrops') count = 3;
    return { ok: true, result: params };
  } };
  const choices = ['dig_block_1', 'dig_block_1', 'collect_drops'];
  const jev = { ask: async () => ({ ok: true, answers: answers(choices.shift()) }) };
  const bot = fakeBot(); bot.entities = { drop: { position: { x: 1, y: 64, z: 0 }, getDroppedItem: () => ({ name: 'dirt' }) } };
  const result = await runIntent({ intent: baseIntent, registry, jev, bot, mcData, eventlog: { append: (kind, payload) => logs.push({ kind, payload }) } });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.actions.map(action => action.primitive), ['dig', 'dig', 'collectDrops']);
  assert.deepEqual(calls.filter(call => call.name !== 'countItem').map(call => call.name), result.actions.map(action => action.primitive));
  assert.equal(logs.filter(log => log.kind === 'intent.start').length, 1);
  assert.equal(logs.filter(log => log.kind === 'intent.end')[0].payload.status, 'succeeded');
});

test('candidates deduplicate targets and classify by distance', () => {
  const bot = fakeBot();
  bot.findBlocks = () => [{ x: 2, y: 64, z: 0 }, { x: 8, y: 64, z: 0 }, { x: 12, y: 64, z: 0 }];
  const candidates = generateCandidates({ bot, intent: baseIntent, mcData });
  const targets = candidates.filter(candidate => /^(dig|goto)_block_/.test(candidate.key));
  assert.equal(candidates.some(candidate => candidate.key.startsWith('find_block_')), false);
  assert.deepEqual(targets.map(candidate => candidate.key), ['dig_block_1', 'goto_block_2', 'goto_block_3']);
  assert.deepEqual(targets.map(candidate => candidate.category), ['dig', 'approach', 'approach']);
});

test('aggregates probabilities by category and executes highest key', async () => {
  const logs = []; const calls = [];
  // This test exercises the 40-step budget in a deliberately static world;
  // T29's same-state stall guard (its own tests) is opted out here.
  const result = await runIntent({ intent: baseIntent, bot: fakeBot(), mcData, sameStateLimit: Infinity,
    registry: { run: async (name) => { calls.push(name); return name === 'countItem' ? { ok: true, result: 0 } : { ok: true }; } },
    jev: { ask: async () => ({ ok: true, answers: { next_action: { choice: 'search', confidence: 0.4,
      probabilities: { dig_block_1: 0.85, search: 0.1, escalate: 0.05 } }, danger: { score: 0 } } }) },
    eventlog: { append: (kind, payload) => logs.push({ kind, payload }) }, confidenceMin: 0.7 });
  assert.equal(result.reason, 'step_budget');
  assert.equal(calls.filter(name => name === 'dig').length, 40);
  const step = logs.find(log => log.kind === 'intent.step').payload;
  assert.equal(step.chosen, 'dig_block_1'); assert.equal(step.category, 'dig'); assert.equal(step.category_prob, 0.85);
});

test('routes probabilities whose best category is below threshold to rules', async () => {
  let primitiveCalls = 0; const logs = [];
  const result = await runIntent({ intent: baseIntent, bot: fakeBot(), mcData,
    registry: { run: async name => { if (name === 'countItem') return { ok: true, result: 0 }; primitiveCalls++; return { ok: true }; } },
    jev: { ask: async () => ({ ok: true, answers: { next_action: { choice: 'dig_block_1', confidence: 0.99,
      probabilities: { dig_block_1: 0.25, goto_block_1: 0.25, search: 0.25, escalate: 0.25 } }, danger: { score: 0 } } }) },
    eventlog: { append: (kind, payload) => logs.push({ kind, payload }) }, confidenceMin: 0.7 });
  assert.equal(result.reason, 'low_confidence'); assert.equal(primitiveCalls, 6);
  const step = logs.find(log => log.kind === 'intent.step').payload;
  assert.equal(step.category_prob, 0.25); assert.equal(step.decided_by, 'rule');
});

test('routes absent low confidence to rules while preserving high confidence Jev behavior', async () => {
  let primitiveCalls = 0;
  const low = await runIntent({ intent: baseIntent, bot: fakeBot(), mcData,
    registry: { run: async name => { if (name === 'countItem') return { ok: true, result: 0 }; primitiveCalls++; return { ok: true }; } },
    jev: { ask: async () => ({ ok: true, answers: { next_action: { choice: 'dig_block_1', confidence: 0.4 }, danger: { score: 0 } } }) } });
  assert.equal(low.reason, 'low_confidence'); assert.equal(primitiveCalls, 6);
  const high = await runIntent({ intent: { ...baseIntent, maxSteps: 1 }, bot: fakeBot(), mcData,
    registry: { run: async name => name === 'countItem' ? { ok: true, result: 0 } : (primitiveCalls++, { ok: true }) },
    jev: { ask: async () => ({ ok: true, answers: { next_action: { choice: 'dig_block_1', confidence: 0.8 }, danger: { score: 0 } } }) } });
  assert.equal(high.reason, 'step_budget'); assert.equal(primitiveCalls, 7);
});

test('intent.step records candidate descriptions alongside keys', async () => {
  const logs = [];
  const result = await runIntent({ intent: baseIntent, registry: { run: async name => name === 'countItem'
    ? { ok: true, result: 0 } : { ok: false, error: { code: 'blocked' } } }, bot: fakeBot(), mcData,
  jev: { ask: async () => ({ ok: true, answers: answers('dig_block_1') }) }, eventlog: { append: (kind, payload) => logs.push({ kind, payload }) } });
  assert.equal(result.reason, 'repeated_failure');
  const step = logs.find(log => log.kind === 'intent.step').payload;
  assert.ok(Array.isArray(step.candidates));
  assert.ok(step.candidates.length <= 12);
  assert.ok(step.candidates.some(candidate => candidate.key === 'dig_block_1' && candidate.description));
});

test('gates low confidence, escalation, Jev failure, removed done, repeated failure, budgets, deadlines, and invalid keys', async () => {
  const registry = { run: async () => ({ ok: false, error: { code: 'nope' } }) };
  const run = jev => runIntent({ intent: baseIntent, registry, jev, bot: fakeBot(), mcData });
  assert.equal((await run({ ask: async () => ({ ok: true, answers: { next_action: { choice: 'dig_block_1', confidence: 0.2 }, danger: { score: 0 } } }) })).reason, 'repeated_failure');
  assert.equal((await run({ ask: async () => ({ ok: true, answers: { next_action: { choice: 'escalate', confidence: 0.9 }, danger: { score: 0 } } }) })).reason, 'escalated');
  assert.equal((await run({ ask: async () => ({ ok: false, error: { code: 'network' } }) })).reason, 'jev_failed');
  let doneCalls = 0;
  const invalidDone = await runIntent({ intent: baseIntent, registry: { run: async name => name === 'countItem' ? { ok: true, result: 0 } : (++doneCalls, { ok: true }) }, bot: fakeBot(), jev: { ask: async () => ({ ok: true, answers: answers('done') }) } });
  assert.equal(invalidDone.reason, 'jev_failed');
  assert.equal(doneCalls, 0);
  assert.equal(invalidDone.steps, 0);
  assert.equal((await run({ ask: async () => ({ ok: true, answers: answers('dig_block_1') }) })).reason, 'repeated_failure');
  assert.equal((await runIntent({ intent: { ...baseIntent, maxSteps: 1 }, registry: { run: async name => name === 'countItem' ? { ok: true, result: 0 } : { ok: true } }, jev: { ask: async () => ({ ok: true, answers: answers('search') }) }, bot: fakeBot() })).reason, 'step_budget');
  let time = 0;
  assert.equal((await runIntent({ intent: { ...baseIntent, deadlineMs: 1 }, registry, jev: { ask: async () => { time = 2; return { ok: true, answers: answers('search') }; } }, bot: fakeBot(), clock: { now: () => time }, mcData })).reason, 'deadline');
  assert.equal((await run({ ask: async () => ({ ok: true, answers: answers('forged') }) })).reason, 'jev_failed');
});

test('candidate whitelist and hostile flee behavior are code generated', () => {
  const hostile = fakeBot(); hostile.entities = { zombie: { position: { x: 10, y: 64, z: 0 }, type: 'mob', name: 'zombie' } };
  const candidates = generateCandidates({ bot: hostile, intent: baseIntent, mcData });
  assert.ok(candidates.some(candidate => candidate.key === 'flee'));
  const calm = generateCandidates({ bot: fakeBot(), intent: baseIntent, mcData });
  assert.equal(calm.some(candidate => candidate.key === 'flee'), false);
  for (const candidate of candidates) if (candidate.primitive) assert.ok(baseIntent.allowed.includes(candidate.primitive));
  assert.ok(candidates.length <= 12);
  const otherDrop = fakeBot(); otherDrop.entities = { item: { position: { x: 1, y: 64, z: 0 }, getDroppedItem: () => ({ name: 'stone' }) } };
  assert.equal(generateCandidates({ bot: otherDrop, intent: baseIntent, mcData }).some(candidate => candidate.key === 'collect_drops'), false);
  const first = generateCandidates({ bot: fakeBot(), intent: baseIntent, mcData, searchCount: 0 }).find(candidate => candidate.key === 'search');
  const second = generateCandidates({ bot: fakeBot(), intent: baseIntent, mcData, searchCount: 1 }).find(candidate => candidate.key === 'search');
  assert.notDeepEqual(first.params, second.params);
});

test('repeated failure is keyed by primitive and target coordinates', async () => {
  const calls = [];
  const bot = fakeBot();
  const registry = { run: async (name, params) => { calls.push({ name, params }); return name === 'countItem' ? { ok: true, result: 0 } : { ok: false, error: { code: 'nope' } }; } };
  const jev = { ask: async () => ({ ok: true, answers: answers('dig_block_1') }) };
  const result = await runIntent({ intent: baseIntent, registry, jev, bot, mcData });
  assert.equal(result.reason, 'repeated_failure');
  assert.equal(calls.filter(call => call.name === 'dig').length, 2);
});

test('dynamic arbiter cancels after stop and marks higher priority takeover preempted', async () => {
  const pending = []; const calls = [];
  const registry = { has: () => true, run: async (name, params, { signal }) => { calls.push(name); await new Promise(resolve => setTimeout(resolve, 2)); signal.throwIfAborted(); return { ok: true, result: params }; } };
  const arbiter = createArbiter({ registry, eventlog: { append() {} } });
  const options = { intent: { ...baseIntent, maxSteps: 20 }, registry, bot: fakeBot(), mcData, eventlog: { append() {} }, jev: { ask: async () => ({ ok: true, answers: answers('search') }) } };
  const first = arbiter.submit({ source: 'owner', label: 'intent', dynamic: context => runIntent({ ...options, ...context }) });
  await new Promise(resolve => setTimeout(resolve, 3)); arbiter.cancel('owner');
  assert.equal((await first.done).status, 'cancelled');
  const second = arbiter.submit({ source: 'plan', label: 'intent2', dynamic: context => runIntent({ ...options, ...context }) });
  const takeover = arbiter.submit({ source: 'reflex', label: 'urgent', steps: [{ primitive: 'search', params: {} }] });
  assert.equal((await second.done).status, 'preempted');
  await takeover.done;
  assert.ok(calls.length >= 1);
  pending.length = 0;
});

function handlerFixture({ jev, autonomy, logs, brain } = {}) {
  let count = 0;
  const registry = { has: () => true, run: async (name) => {
    if (name === 'countItem') return { ok: true, result: count };
    count = 3; return { ok: true, result: {} };
  } };
  const arbiter = createArbiter({ registry, eventlog: { append: (kind, payload) => logs.push({ kind, payload }) } });
  const speech = [];
  const handler = createOwnerChatHandler({ library: { list: () => [], has: () => false }, arbiter, registry,
    bot: fakeBot(), jev, learningAutonomy: autonomy, mouth: { say: async text => { speech.push(text); return text; } },
    brain: brain ?? { enabled: false }, eventlog: { append: (kind, payload) => logs.push({ kind, payload }), query: () => logs },
    ownerUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', relationship: { ownerName: () => 'Owner', nickname: () => null } });
  return { handler, speech };
}

test('handler routes unlearned block collection only with Jev and autonomy 2, keeps craft/dont-know behavior, and caps N at 16', async () => {
  const logs = [];
  const good = handlerFixture({ autonomy: 2, logs, jev: { ask: async () => ({ ok: true, answers: answers('dig_block_1') }) } });
  assert.equal((await good.handler.handle('挖3个泥土', 'h1')).kind, 'self_try');
  assert.equal(good.speech.at(-1).includes('不会'), false);
  const capped = handlerFixture({ autonomy: 2, logs, jev: { ask: async () => ({ ok: true, answers: answers('escalate') }) } });
  await capped.handler.handle('挖100个泥土', 'h2');
  assert.equal(logs.filter(event => event.kind === 'intent.start').at(-1).payload.success.atLeast, 16);
  for (const options of [{ autonomy: 2 }, { autonomy: 1, jev: { ask: async () => ({}) } }, { autonomy: 0, jev: { ask: async () => ({}) } }]) {
    const fixture = handlerFixture({ ...options, logs });
    assert.equal((await fixture.handler.handle('挖3个泥土', 'h3')).kind, 'dont_know');
  }
  const craft = handlerFixture({ autonomy: 2, logs, jev: { ask: async () => ({ ok: true, answers: answers('escalate') }) } });
  assert.equal((await craft.handler.handle('做个箱子', 'h4')).kind, 'dont_know');
});

test('self_try fallback is factual, contains no teaching claim, and passes no teacher field to the model', async () => {
  const logs = []; let situation;
  const fixture = handlerFixture({ autonomy: 2, logs, jev: { ask: async () => ({ ok: true, answers: answers('escalate') }) },
    brain: { enabled: true, speak: async ({ situation: value }) => { situation = value; return null; } } });
  const result = await fixture.handler.handle('挖3个泥土', 'h5');
  assert.equal(result.kind, 'self_try');
  assert.doesNotMatch(result.text, /教/u);
  assert.equal(Object.hasOwn(situation, 'teacher'), false);
  assert.equal(situation.taughtBy, null);
});
