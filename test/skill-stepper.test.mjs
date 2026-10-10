import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCollectIntent } from '../src/decision/intent.js';
import { runIntent } from '../src/decision/stepper.js';
import { mcData } from '../src/teaching/lexicon.js';

const point = (x, y = 64, z = 0) => ({ x, y, z });
const answer = (choice, extra = {}) => ({ next_action: { choice, confidence: 0.95, ...extra }, danger: { score: 0 } });

// Static fake bot: findBlocks always offers the same near block, nothing in
// the world ever changes unless the test mutates it — so repeated identical
// picks produce repeated identical Jev states once recent_actions saturates.
function fixture({ blocks = [point(2)], entities = {}, maxSteps = 10 } = {}) {
  const bot = { entity: { position: point(0) }, entities, findBlocks: () => blocks,
    inventory: { emptySlotCount: () => 36 } };
  const calls = [];
  const registry = { run: async (name, params) => {
    calls.push({ name, params });
    return name === 'countItem' ? { ok: true, result: 0 } : { ok: true, result: params };
  } };
  return { bot, calls, registry, intent: { ...parseCollectIntent('挖3个泥土'), maxSteps } };
}

function fakeJev(select) {
  const requests = [];
  let index = 0;
  const jev = { ask: async request => {
    requests.push(request);
    return { ok: true, answers: select(JSON.parse(request.state), index++) };
  } };
  return { jev, requests };
}

async function runCase({ intent, bot, registry, select, events = [] }) {
  const { jev, requests } = fakeJev(select);
  const result = await runIntent({ intent, bot, registry, jev, mcData,
    eventlog: { append: (kind, payload) => events.push({ kind, payload }) } });
  return { result, requests, events };
}

test('identical state suppresses jev.ask and three in a row end no_progress', async () => {
  const { bot, calls, registry, intent } = fixture({ maxSteps: 40 });
  const events = [];
  const { result, requests } = await runCase({ intent, bot, registry, events, select: () => answer('dig_block_1') });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'no_progress');
  // Asks only happen while the state is still changing; once the last three
  // history entries saturate the observation repeats and the ask is skipped.
  // Skipped turns still take a rule-decided step, so the world gets a fresh
  // chance to change before the third identical observation ends the intent.
  assert.equal(requests.length, 4);
  assert.equal(result.actions.length, 6);
  assert.equal(calls.filter(call => call.name === 'dig').length, 6);
  const end = events.find(event => event.kind === 'intent.end');
  assert.equal(end.payload.status, 'failed');
  assert.equal(end.payload.reason, 'no_progress');
  const cached = events.filter(event => event.kind === 'intent.step' && event.payload.decided_by === 'state_cache');
  assert.equal(cached.length, 1);
  assert.equal(cached[0].payload.error_code, 'no_progress');
  assert.equal(cached[0].payload.same_state, 3);
  const suppressed = events.filter(event => event.kind === 'intent.step' && event.payload.same_state && event.payload.decided_by === 'rule');
  assert.deepEqual(suppressed.map(event => event.payload.same_state), [1, 2]);
});

test('a real world change resets the counter and asks continue', async () => {
  const { bot, registry, intent } = fixture({ maxSteps: 4 });
  const originalRun = registry.run;
  registry.run = async (name, params) => {
    const result = await originalRun(name, params);
    if (name === 'goTo') bot.entity.position = { x: bot.entity.position.x + 10, y: 64, z: 0 };
    return result;
  };
  const { result, requests } = await runCase({ intent, bot, registry, select: () => answer('search') });
  assert.equal(result.reason, 'step_budget');
  assert.equal(requests.length, 4);
});

test('without a Jev there is no model call to suppress', async () => {
  const { bot, calls, registry, intent } = fixture({ maxSteps: 3 });
  const result = await runIntent({ intent, bot, registry, jev: null, mcData });
  assert.equal(result.reason, 'step_budget');
  assert.equal(result.actions.length, 3);
  assert.equal(calls.filter(call => call.name === 'dig').length, 3);
});

test('free primitive results surface into recent_actions while failures keep the message', async () => {
  const { bot, registry, intent } = fixture({ maxSteps: 10 });
  // No query candidates exist yet (P3), so exercise the path through a
  // registry that describes goTo as free — the surfacing rule is driven by
  // describe() first, with the known free set as fallback.
  registry.describe = name => ({ name, free: name === 'goTo' });
  const originalRun = registry.run;
  registry.run = async (name, params) => {
    if (name === 'countItem') return originalRun(name, params);
    return { ok: true, result: { x: 12, y: 64, z: 3, raw: { huge: 'bot object' }, noise: [1, 2, 3] } };
  };
  const { requests } = await runCase({ intent, bot, registry,
    select: (_state, index) => index ? answer('escalate') : answer('search') });
  assert.equal(requests.length, 2);
  const recent = JSON.parse(requests[1].state).recent_actions;
  assert.equal(recent[0].chosen, 'search');
  assert.deepEqual(recent[0].result, { x: 12, y: 64, z: 3 });

  const failing = fixture({ maxSteps: 10 });
  failing.registry.run = async (name, params) => name === 'countItem'
    ? { ok: true, result: 0 }
    : { ok: false, error: { message: 'stuck', code: 'nope' } };
  const second = await runCase({ intent: failing.intent, bot: failing.bot, registry: failing.registry,
    select: () => answer('dig_block_1') });
  assert.equal(second.result.reason, 'repeated_failure');
  const failureEntry = JSON.parse(second.requests[1].state).recent_actions[0];
  assert.equal(failureEntry.ok, false);
  assert.equal(failureEntry.result, 'stuck');
});

test('countItem goes through registry.query and falls back to run', async () => {
  const { bot, registry, intent } = fixture({ maxSteps: 4 });
  const queries = [];
  const runs = [];
  registry.query = async (name, params) => { queries.push({ name, params }); return 0; };
  registry.run = async name => { runs.push(name); return { ok: true }; };
  const { result } = await runCase({ intent, bot, registry, select: () => answer('escalate') });
  assert.equal(result.reason, 'escalated');
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0], { name: 'countItem', params: { itemName: 'dirt' } });
  assert.equal(runs.includes('countItem'), false);

  const legacy = fixture({ maxSteps: 4 });
  await runCase({ intent: legacy.intent, bot: legacy.bot, registry: legacy.registry, select: () => answer('escalate') });
  assert.equal(legacy.calls.some(call => call.name === 'countItem'), true);
});

test('regressions: search rotation, flee override, escalate and repeated_failure unchanged', async () => {
  const rotation = fixture({ maxSteps: 4 });
  const originalRun = rotation.registry.run;
  rotation.registry.run = async (name, params) => {
    const result = await originalRun(name, params);
    if (name === 'goTo') rotation.bot.entity.position = { x: params.x, y: params.y, z: params.z };
    return result;
  };
  const spin = await runCase({ intent: rotation.intent, bot: rotation.bot, registry: rotation.registry,
    select: () => answer('search') });
  // Four rotated search legs while the position keeps updating the state.
  assert.equal(spin.result.reason, 'step_budget');
  assert.equal(spin.requests.length, 4);
  assert.deepEqual(rotation.calls.filter(call => call.name === 'goTo').map(call => [call.params.x, call.params.z]),
    [[10, 0], [10, 10], [0, 10], [0, 0]]);

  const flee = fixture({ entities: { zombie: { position: point(3), type: 'mob', name: 'zombie' } }, maxSteps: 1 });
  const fleeEvents = [];
  const fleeRun = await runCase({ intent: flee.intent, bot: flee.bot, registry: flee.registry, events: fleeEvents,
    select: () => ({ next_action: { choice: 'dig_block_1', confidence: 0.9 }, danger: { score: 2 } }) });
  assert.equal(fleeRun.result.actions[0].primitive, 'goTo');
  const fleeStep = fleeEvents.find(event => event.kind === 'intent.step').payload;
  assert.equal(fleeStep.chosen, 'flee');
  assert.equal(fleeStep.decided_by, 'safety');

  const esc = fixture({ maxSteps: 4 });
  const escRun = await runCase({ intent: esc.intent, bot: esc.bot, registry: esc.registry, select: () => answer('escalate') });
  assert.equal(escRun.result.reason, 'escalated');
  assert.equal(escRun.requests.length, 1);

  const fail = fixture({ maxSteps: 10 });
  fail.registry.run = async (name, params) => {
    fail.calls.push({ name, params });
    return name === 'countItem' ? { ok: true, result: 0 } : { ok: false, error: { code: 'nope' } };
  };
  const failRun = await runCase({ intent: fail.intent, bot: fail.bot, registry: fail.registry, select: () => answer('dig_block_1') });
  assert.equal(failRun.result.reason, 'repeated_failure');
  assert.equal(fail.calls.filter(call => call.name === 'dig').length, 2);
});
