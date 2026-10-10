import test from 'node:test';
import assert from 'node:assert/strict';
import { createArbiter } from '../src/arbiter.js';
import { createActionCost, MUTATING } from '../src/cost.js';

// P1 §4 action cost: self-initiated (idle/plan) world-changing steps pay one
// point each; reflex/owner are always free; the budget lives in the event log.

function eventlogFake(now = () => Date.now()) {
  const rows = [];
  return {
    rows,
    append(kind, payload, traceId) { rows.push({ id: rows.length + 1, ts: now(), kind, payload, trace_id: traceId }); },
    query({ kind, since, limit = 100 } = {}) {
      return rows.filter(row => (kind === undefined || row.kind === kind)
        && (since === undefined || row.ts >= since)).slice(0, limit);
    },
  };
}

function fixture({ limit = 300, run, now } = {}) {
  const calls = [];
  const eventlog = eventlogFake(now);
  const cost = createActionCost({ eventlog, limit, clock: now ? { now } : {} });
  const arbiter = createArbiter({
    registry: {
      has: () => true,
      run(primitive, params, options) {
        calls.push({ primitive, params, options });
        return (run ?? (() => ({ ok: true, result: 'ok' })))(primitive, params, options);
      },
    },
    eventlog,
    cost,
  });
  const spent = () => eventlog.rows.filter(row => row.kind === 'budget.action_spent');
  return { arbiter, calls, cost, spent };
}

test('P1 cost: idle-source dig charges one point and logs budget.action_spent', async () => {
  const { arbiter, calls, cost, spent } = fixture();
  const outcome = await arbiter.submit({ source: 'idle', label: 'dig a hole',
    steps: [{ primitive: 'dig', params: { x: 1, y: 64, z: 2 } },
      { primitive: 'say', params: { text: 'done' } }] }).done;
  assert.equal(outcome.status, 'completed');
  assert.equal(cost.remaining(), 299);
  assert.equal(spent().length, 1);
  assert.deepEqual(spent()[0].payload, { source: 'idle', primitive: 'dig' });
  assert.equal(typeof spent()[0].trace_id, 'string');
  // The task source travels with the run options so downstream can see it too.
  assert.equal(calls[0].options.source, 'idle');
  assert.deepEqual(calls.map(call => call.primitive), ['dig', 'say'], 'free steps still run uncharged');
});

test('P1 cost: reflex and owner sources are never checked and never charged', async () => {
  for (const source of ['reflex', 'owner']) {
    const { arbiter, cost, spent } = fixture({ limit: 0 });
    const outcome = await arbiter.submit({ source, label: source,
      steps: [{ primitive: 'dig', params: {} }, { primitive: 'place', params: {} }] }).done;
    assert.equal(outcome.status, 'completed', `${source} mutations run even at zero budget`);
    assert.equal(spent().length, 0);
    assert.equal(cost.remaining(), 0);
  }
});

test('P1 cost: an attempted mutation still costs when the step fails', async () => {
  const { arbiter, cost, spent } = fixture({
    run: name => name === 'dig'
      ? { ok: false, error: { name: 'Error', message: 'no block' } }
      : { ok: true, result: 'ok' },
  });
  const outcome = await arbiter.submit({ source: 'plan', label: 'dig',
    steps: [{ primitive: 'dig', params: {} }] }).done;
  assert.equal(outcome.status, 'failed');
  assert.equal(spent().length, 1);
  assert.equal(cost.remaining(), 299);
});

test('P1 cost: exhausted budget fails mutating steps while free steps still run', async () => {
  const { arbiter, calls, spent } = fixture({ limit: 0 });
  const outcome = await arbiter.submit({ source: 'idle', label: 'mixed',
    steps: [{ primitive: 'say', params: { text: 'hi' } },
      { primitive: 'findBlock', params: { blockName: 'dirt' } },
      { primitive: 'dig', params: {} }] }).done;
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error.code, 'action_budget_exhausted');
  assert.equal(outcome.completedSteps, 2);
  assert.deepEqual(calls.map(call => call.primitive), ['say', 'findBlock'], 'speech and queries are free');
  assert.equal(outcome.results.at(-1).ok, false);
  assert.equal(outcome.results.at(-1).error.code, 'action_budget_exhausted');
  assert.equal(spent().length, 0, 'a refused step never reaches the spend hook');
});

test('P1 cost: spending the last point blocks the next mutating step', async () => {
  const { arbiter, calls, cost } = fixture({ limit: 1 });
  const outcome = await arbiter.submit({ source: 'plan', label: 'two digs',
    steps: [{ primitive: 'dig', params: {} }, { primitive: 'dig', params: {} }] }).done;
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error.code, 'action_budget_exhausted');
  assert.equal(outcome.completedSteps, 1);
  assert.equal(calls.length, 1, 'the second dig is refused before registry.run');
  assert.equal(cost.remaining(), 0);
});

test('P1 cost: program-path steps pay by the same rule', async () => {
  const { arbiter, cost, spent } = fixture();
  const outcome = await arbiter.submit({ source: 'plan', label: 'program',
    program: { body: [{ primitive: 'say', params: { text: 'x' } },
      { primitive: 'dig', params: {} }], params: {}, args: {} } }).done;
  assert.equal(outcome.status, 'completed');
  assert.equal(spent().length, 1);
  assert.deepEqual(spent()[0].payload, { source: 'plan', primitive: 'dig' });
  assert.equal(cost.remaining(), 299);
  const denied = fixture({ limit: 0 });
  const blocked = await denied.arbiter.submit({ source: 'idle', label: 'program',
    program: { body: [{ primitive: 'dig', params: {} }], params: {}, args: {} } }).done;
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.error.code, 'action_budget_exhausted');
});

test('P1 cost: spends persist across restarts through the shared event log', () => {
  const noon = new Date(2026, 9, 10, 12).getTime();
  const now = () => noon;
  const eventlog = eventlogFake(now);
  const first = createActionCost({ eventlog, limit: 5, clock: { now } });
  assert.equal(first.limit, 5);
  assert.equal(first.trySpend({ source: 'idle', primitive: 'dig' }, 't1'), true);
  assert.equal(first.trySpend({ source: 'plan', primitive: 'craft' }, 't2'), true);
  assert.equal(first.remaining(), 3);
  const restarted = createActionCost({ eventlog, limit: 5, clock: { now } });
  assert.equal(restarted.remaining(), 3, 'a second instance sees the same spent count');
  // Events from before local midnight do not count against today.
  eventlog.rows[0].ts = noon - 86_400_000;
  assert.equal(restarted.remaining(), 4);
});

test('P1 cost: trySpend refuses when exhausted and writes nothing', () => {
  const eventlog = eventlogFake();
  const cost = createActionCost({ eventlog, limit: 1 });
  assert.equal(cost.trySpend({ source: 'idle', primitive: 'dig' }, 't1'), true);
  assert.equal(cost.trySpend({ source: 'idle', primitive: 'dig' }, 't2'), false);
  assert.equal(eventlog.rows.filter(row => row.kind === 'budget.action_spent').length, 1);
  assert.equal(cost.remaining(), 0);
});

test('P1 cost: a missing cost object leaves the arbiter untouched', async () => {
  const calls = [];
  const arbiter = createArbiter({
    registry: { has: () => true, run(name) { calls.push(name); return { ok: true, result: 'ok' }; } },
    eventlog: { append() {} },
  });
  const outcome = await arbiter.submit({ source: 'idle', label: 'x',
    steps: [{ primitive: 'dig', params: {} }] }).done;
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(calls, ['dig']);
});

test('P1 cost: MUTATING names exactly the world-changing primitives', () => {
  assert.deepEqual([...MUTATING].sort(),
    ['attack', 'command', 'craft', 'deposit', 'dig', 'give', 'place', 'smelt', 'withdraw']);
  for (const free of ['say', 'findBlock', 'countItem', 'lookAt', 'goTo', 'goToEntity',
    'follow', 'equip', 'eat', 'sleep', 'collectDrops']) {
    assert.equal(MUTATING.has(free), false, free);
  }
});
