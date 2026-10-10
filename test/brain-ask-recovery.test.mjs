import test from 'node:test';
import assert from 'node:assert/strict';
import { createJev } from '../src/decision/jev.js';
import { parseCollectIntent } from '../src/decision/intent.js';
import { runIntent } from '../src/decision/stepper.js';
import { mcData } from '../src/teaching/lexicon.js';

const point = (x, y = 64, z = 0) => ({ x, y, z });
const drop = (name, count, x) => ({ position: point(x), getDroppedItem: () => ({ name, count }) });

function fixture({ blocks = [point(2)], entities = {}, maxSteps = 10 } = {}) {
  const bot = { entity: { position: point(0) }, entities, findBlocks: () => blocks,
    inventory: { emptySlotCount: () => 36 } };
  const calls = [];
  const registry = { run: async name => {
    calls.push(name);
    return name === 'countItem' ? { ok: true, result: 0 } : { ok: true };
  } };
  return { bot, calls, registry, intent: { ...parseCollectIntent('挖1个泥土'), maxSteps } };
}

function fakeJev(select) {
  const requests = [];
  let index = 0;
  const jev = createJev({ apiKey: 'fake-key', fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const answer = select(body, index++);
    return { ok: true, status: 200, json: async () => ({ answers: {
      next_action: { choice: answer.choice, confidence: answer.confidence, ...(answer.probabilities ? { probabilities: answer.probabilities } : {}) },
      danger: { score: answer.danger ?? 0 },
    } }) };
  } });
  return { jev, requests };
}

async function runCase({ intent, bot, registry, select, events = [] }) {
  const { jev, requests } = fakeJev(select);
  // These cases exercise decision paths in a deliberately static world;
  // T29's same-state stall guard (its own tests) is opted out here.
  const result = await runIntent({ intent, bot, registry, jev, mcData, sameStateLimit: Infinity,
    eventlog: { append: (kind, payload) => events.push({ kind, payload }) } });
  return { result, requests, events };
}

test('low confidence chooses collect when drops cover the remaining count', async () => {
  const { bot, registry, calls, intent } = fixture({ entities: { dirt: drop('dirt', 1, 1) }, maxSteps: 1 });
  const events = [];
  const { result } = await runCase({ intent, bot, registry, events, select: () => ({
    choice: 'collect_drops', confidence: 0.46,
    probabilities: { collect_drops: 0.46, dig_block_1: 0.44, search: 0.1 },
  }) });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'step_budget');
  assert.deepEqual(result.actions.map(action => action.primitive), ['collectDrops']);
  assert.equal(calls.filter(name => name === 'collectDrops').length, 1);
  const step = events.find(event => event.kind === 'intent.step').payload;
  assert.equal(step.decided_by, 'rule');
  assert.equal(step.chosen, 'collect_drops');
});

test('low confidence chooses the nearest dig when no target drops exist', async () => {
  const { bot, registry, intent } = fixture({ blocks: [point(2), point(4)], maxSteps: 1 });
  const events = [];
  const { result } = await runCase({ intent, bot, registry, events, select: () => ({
    choice: 'dig_block_1', confidence: 0.46,
    probabilities: { dig_block_1: 0.44, dig_block_2: 0.1 },
  }) });
  assert.equal(result.actions[0].primitive, 'dig');
  assert.deepEqual(result.actions[0].params, point(2));
  assert.equal(events.find(event => event.kind === 'intent.step').payload.decided_by, 'rule');
});

test('rule order falls through to nearest goto and search, then no_candidate', async () => {
  const approach = fixture({ blocks: [point(8)], maxSteps: 1 });
  const approachRun = await runCase({ ...approach, select: () => ({ choice: 'search', confidence: 0.2 }) });
  assert.equal(approachRun.result.actions[0].primitive, 'goTo');
  assert.deepEqual(approachRun.result.actions[0].params, { ...point(8), range: 1 });

  const search = fixture({ blocks: [], maxSteps: 1 });
  const searchRun = await runCase({ ...search, select: () => ({ choice: 'escalate', confidence: 0.2 }) });
  assert.equal(searchRun.result.actions[0].primitive, 'goTo');
  assert.equal(searchRun.result.actions[0].params.x, 10);

  const noCandidate = fixture({ blocks: [], maxSteps: 1 });
  noCandidate.intent.allowed = ['collectDrops'];
  const noCandidateRun = await runCase({ ...noCandidate, select: () => ({ choice: 'escalate', confidence: 0.2 }) });
  assert.equal(noCandidateRun.result.reason, 'no_candidate');
  assert.deepEqual(noCandidateRun.result.actions, []);
});

test('danger at 2.0 forces flee with safety provenance', async () => {
  const { bot, registry, intent } = fixture({ entities: { zombie: { position: point(3), type: 'mob', name: 'zombie' } }, maxSteps: 1 });
  const events = [];
  const { result } = await runCase({ intent, bot, registry, events, select: () => ({ choice: 'dig_block_1', confidence: 0.9, danger: 2 }) });
  assert.equal(result.actions[0].primitive, 'goTo');
  assert.equal(events.find(event => event.kind === 'intent.step').payload.chosen, 'flee');
  assert.equal(events.find(event => event.kind === 'intent.step').payload.decided_by, 'safety');
});

test('six consecutive rule steps end low_confidence and a Jev step clears the counter', async () => {
  const first = fixture({ maxSteps: 10 });
  const events = [];
  const run = await runCase({ ...first, events, select: () => ({ choice: 'dig_block_1', confidence: 0.2 }) });
  assert.equal(run.result.reason, 'low_confidence');
  assert.equal(run.result.actions.length, 6);
  assert.ok(events.filter(event => event.kind === 'intent.step').every(event => event.payload.decided_by === 'rule'));

  const reset = fixture({ maxSteps: 20 });
  const resetEvents = [];
  const resetRun = await runCase({ ...reset, events: resetEvents, select: (_body, index) => index === 3
    ? { choice: 'dig_block_1', confidence: 0.9 }
    : { choice: 'dig_block_1', confidence: 0.2 } });
  assert.equal(resetRun.result.reason, 'low_confidence');
  assert.equal(resetRun.result.actions.length, 10);
  assert.deepEqual(resetEvents.filter(event => event.kind === 'intent.step').map(event => event.payload.decided_by), [
    'rule', 'rule', 'rule', 'jev', 'rule', 'rule', 'rule', 'rule', 'rule', 'rule',
  ]);
});

test('high confidence remains Jev-selected and escalation only applies above the threshold', async () => {
  const jevCase = fixture({ maxSteps: 1 });
  const jevEvents = [];
  const jevRun = await runCase({ ...jevCase, events: jevEvents, select: () => ({ choice: 'dig_block_1', confidence: 0.9 }) });
  assert.equal(jevRun.result.actions[0].primitive, 'dig');
  assert.equal(jevEvents.find(event => event.kind === 'intent.step').payload.decided_by, 'jev');

  const highEscalate = fixture({ maxSteps: 1 });
  const highRun = await runCase({ ...highEscalate, select: () => ({ choice: 'escalate', confidence: 0.9 }) });
  assert.equal(highRun.result.reason, 'escalated');

  const lowEscalate = fixture({ maxSteps: 1 });
  const lowEvents = [];
  const lowRun = await runCase({ ...lowEscalate, events: lowEvents, select: () => ({ choice: 'escalate', confidence: 0.2 }) });
  assert.equal(lowRun.result.actions[0].primitive, 'dig');
  assert.equal(lowEvents.find(event => event.kind === 'intent.step').payload.decided_by, 'rule');
});
