import test from 'node:test';
import assert from 'node:assert/strict';
import { createArbiter, InvalidIntentError, arbiterFree } from '../src/arbiter.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const intent = (source, label = source, steps = [{ primitive: 'move', params: {} }]) => ({ source, label, steps });
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(run = () => ({ ok: true, result: 'ok' }), options = {}) {
  const calls = [];
  const logs = [];
  const arbiter = createArbiter({
    registry: {
      has: name => ['move', 'look', 'say'].includes(name),
      run(primitive, params, options) {
        calls.push({ primitive, params, options });
        return run(primitive, params, options);
      },
    },
    eventlog: { append: (kind, payload, traceId) => logs.push({ kind, payload, traceId }) },
    clock: { now: () => 42 },
    ...options,
  });
  return { arbiter, calls, logs };
}

test('arbiter: idle accepts, runs sequentially, passes execution options and increments epochs', async () => {
  const { arbiter, calls, logs } = fixture();
  const submitted = arbiter.submit({
    ...intent('plan', 'two steps', [
      { primitive: 'move', params: { x: 1 }, timeoutMs: 50 },
      { primitive: 'say', params: { text: 'hello' } },
    ]), traceId: 'trace-t3',
  });
  assert.equal(submitted.accepted, true);
  assert.equal(arbiter.isBusy(), true);
  assert.equal(arbiter.current().label, 'two steps');
  assert.deepEqual(await submitted.done, {
    epoch: 1, status: 'completed', completedSteps: 2,
    results: [{ ok: true, result: 'ok' }, { ok: true, result: 'ok' }],
  });
  assert.deepEqual(calls.map(call => call.primitive), ['move', 'say']);
  assert.deepEqual(calls[0].params, { x: 1 });
  assert.equal(calls[0].options.timeoutMs, 50);
  assert.equal(calls[0].options.traceId, 'trace-t3');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(arbiter.current(), null);
  assert.equal(arbiter.isBusy(), false);
  const next = arbiter.submit(intent('idle'));
  assert.equal(next.epoch, 2);
  await next.done;
  for (const log of logs) {
    assert.ok(Object.hasOwn(log.payload, 'epoch'));
    assert.equal(typeof log.payload.source, 'string');
    assert.equal(typeof log.payload.label, 'string');
    assert.equal(log.payload.ts, 42);
  }
});

test('arbiter: invalid intents throw before changing state or logging', async () => {
  const waiting = deferred();
  const { arbiter, calls, logs } = fixture(() => waiting.promise);
  const invalid = [
    null, intent('constructor'), intent('stranger'), intent('reflex', 'empty', []),
    intent('reflex', 'unknown', [{ primitive: 'fly' }]),
    intent('reflex', 'missing', [null]), { ...intent('owner'), label: 3 },
  ];
  for (const value of invalid) assert.throws(() => arbiter.submit(value), InvalidIntentError);
  assert.equal(arbiter.current(), null);
  assert.deepEqual(logs, []);
  const current = arbiter.submit(intent('plan'));
  const snapshot = arbiter.current();
  const count = logs.length;
  for (const value of invalid) assert.throws(() => arbiter.submit(value), InvalidIntentError);
  assert.deepEqual(arbiter.current(), snapshot);
  assert.equal(logs.length, count);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.signal.aborted, false);
  arbiter.cancel();
  await current.done;
  waiting.resolve({ ok: true });
  await tick();
});

test('arbiter: complete priority matrix includes same-level owner and reflex preemption', async () => {
  const sources = ['idle', 'plan', 'owner', 'reflex'];
  for (let oldPriority = 0; oldPriority < sources.length; oldPriority++) {
    for (let newPriority = 0; newPriority < sources.length; newPriority++) {
      const pending = [];
      const { arbiter, calls } = fixture(() => {
        const waiting = deferred();
        pending.push(waiting);
        return waiting.promise;
      });
      const first = arbiter.submit(intent(sources[oldPriority], 'first'));
      const second = arbiter.submit(intent(sources[newPriority], 'second'));
      const preempts = newPriority > oldPriority || (newPriority === oldPriority && newPriority >= 2);
      assert.equal(second.accepted, preempts, `${sources[newPriority]} against ${sources[oldPriority]}`);
      assert.equal(calls[0].options.signal.aborted, preempts);
      if (preempts) {
        assert.equal((await first.done).status, 'preempted');
        assert.ok(second.epoch > first.epoch);
        pending[1].resolve({ ok: true, result: 'second' });
        assert.equal((await second.done).status, 'completed');
      } else {
        assert.equal(second.reason, 'busy');
        assert.equal((await second.done).status, 'rejected');
        assert.equal(arbiter.current().epoch, first.epoch);
        pending[0].resolve({ ok: true, result: 'first' });
        assert.equal((await first.done).status, 'completed');
      }
      for (const waiting of pending) waiting.resolve({ ok: true });
      await tick();
    }
  }
});

test('arbiter: stale success and rejection never affect replacement or start old later steps', async () => {
  for (const rejects of [false, true]) {
    const old = deferred();
    const replacement = deferred();
    const { arbiter, calls, logs } = fixture((name, params) => params.old ? old.promise : replacement.promise);
    const first = arbiter.submit(intent('plan', 'old', [
      { primitive: 'move', params: { old: true } }, { primitive: 'say', params: {} },
    ]));
    const second = arbiter.submit(intent('owner', 'new'));
    const outcome = await first.done;
    if (rejects) old.reject(new Error('late failure'));
    else old.resolve({ ok: true, result: 'late success' });
    await tick();
    assert.equal(arbiter.current().epoch, second.epoch);
    assert.equal(arbiter.isBusy(), true);
    assert.equal(calls.length, 2);
    replacement.resolve({ ok: true, result: 'new result' });
    assert.deepEqual((await second.done).results, [{ ok: true, result: 'new result' }]);
    assert.deepEqual(outcome.results, []);
    const stale = logs.filter(log => log.kind === 'arbiter.stale');
    assert.equal(stale.length, 1);
    assert.equal(stale[0].payload.epoch, first.epoch);
    assert.equal(stale[0].payload.source, 'plan');
    assert.ok(logs.some(log => log.kind === 'arbiter.preempt'));
  }
});

test('arbiter: middle failure counts only completed steps and stops the plan', async () => {
  const error = { name: 'Error', message: 'failed' };
  const { arbiter, calls } = fixture(name => name === 'look' ? { ok: false, error } : { ok: true });
  const submitted = arbiter.submit(intent('plan', 'failing', [
    { primitive: 'move' }, { primitive: 'look' }, { primitive: 'say' },
  ]));
  const outcome = await submitted.done;
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.completedSteps, 1);
  assert.deepEqual(outcome.error, error);
  assert.equal(outcome.results.length, 2);
  assert.deepEqual(calls.map(call => call.primitive), ['move', 'look']);
  assert.equal(arbiter.isBusy(), false);
});

test('arbiter: synchronous throws and asynchronous rejections become failed outcomes', async () => {
  for (const asynchronous of [false, true]) {
    const { arbiter } = fixture(() => {
      const error = new Error('registry failed');
      if (asynchronous) return Promise.reject(error);
      throw error;
    });
    const outcome = await arbiter.submit(intent('owner')).done;
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.completedSteps, 0);
    assert.equal(outcome.error.message, 'registry failed');
  }
});

test('arbiter: cancel aborts immediately, notifies once, and clears busy state', async () => {
  const waiting = deferred();
  const { arbiter, calls, logs } = fixture(() => waiting.promise);
  const notices = [];
  const removed = [];
  const listener = outcome => notices.push(outcome);
  const removedListener = outcome => removed.push(outcome);
  arbiter.on('done', listener);
  arbiter.on('done', removedListener);
  arbiter.off('done', removedListener);
  const submitted = arbiter.submit(intent('owner'));
  arbiter.cancel('shutdown');
  arbiter.cancel('again');
  assert.equal(arbiter.isBusy(), false);
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(calls[0].options.signal.reason, 'shutdown');
  assert.equal((await submitted.done).status, 'cancelled');
  waiting.resolve({ ok: true });
  await tick();
  assert.equal(notices.length, 1);
  assert.deepEqual(removed, []);
  assert.equal(logs.filter(log => log.kind === 'arbiter.done').length, 1);
});

test('arbiter: snapshots cannot mutate queued steps or current identity', async () => {
  const waiting = deferred();
  const { arbiter, calls } = fixture(name => name === 'move' ? waiting.promise : { ok: true });
  const submittedIntent = intent('plan', 'snapshot', [{ primitive: 'move' }, { primitive: 'say', params: { text: 'original' } }]);
  const submitted = arbiter.submit(submittedIntent);
  submittedIntent.steps[1].params.text = 'changed';
  arbiter.current().source = 'reflex';
  assert.equal(arbiter.current().source, 'plan');
  waiting.resolve({ ok: true });
  await submitted.done;
  assert.deepEqual(calls[1].params, { text: 'original' });
});

test('arbiter: failing eventlog cannot strand completion or reject late stale execution', async () => {
  for (const cancelled of [false, true]) {
    const waiting = deferred();
    let closed = false;
    const attempted = [];
    const arbiter = createArbiter({
      registry: { has: () => true, run: () => waiting.promise },
      eventlog: { append(kind) {
        attempted.push(kind);
        if (closed) throw new Error('statement has been finalized');
      } },
    });
    const submitted = arbiter.submit(intent('owner'));
    if (cancelled) arbiter.cancel('shutdown');
    closed = true;
    waiting.resolve({ ok: true });
    assert.equal((await submitted.done).status, cancelled ? 'cancelled' : 'completed');
    await tick();
    assert.equal(arbiter.isBusy(), false);
    assert.ok(attempted.includes(cancelled ? 'arbiter.stale' : 'arbiter.done'));
  }
});

test('arbiter: detached execute rejection settles the task even when recording fails', async () => {
  const arbiter = createArbiter({
    registry: { has: () => true,
      run: () => ({ get ok() { throw new Error('unexpected result failure'); } }) },
    eventlog: { append() { throw new Error('logging failed'); } },
  });
  const outcome = await arbiter.submit(intent('owner')).done;
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error.message, 'unexpected result failure');
  assert.equal(arbiter.isBusy(), false);
  await tick();
});

test('arbiter: reentrant abort submissions cannot leave two writers active', async () => {
  let emergency;
  const waiting = deferred();
  const { arbiter, calls } = fixture((primitive, params, { signal }) => {
    if (params.old) {
      signal.addEventListener('abort', () => { emergency = arbiter.submit(intent('reflex', 'emergency')); });
      return waiting.promise;
    }
    return { ok: true, result: 'emergency' };
  });
  const old = arbiter.submit(intent('plan', 'old', [{ primitive: 'move', params: { old: true } }]));
  const owner = arbiter.submit(intent('owner'));
  assert.equal((await old.done).status, 'preempted');
  assert.equal((await owner.done).status, 'preempted');
  assert.equal((await emergency.done).status, 'completed');
  assert.equal(calls.length, 2);
  waiting.resolve({ ok: true });
  await tick();
  assert.equal(arbiter.isBusy(), false);
});

test('arbiter obtain seam runs the goal executor inside the task', async () => {
  const obtained = [];
  const { arbiter } = fixture(undefined, { obtain: async (args, context) => {
    obtained.push({ args, hasSignal: context.signal instanceof AbortSignal,
      active: context.isActive(), epoch: context.epoch, traceId: context.traceId });
    return { status: 'succeeded', have: { stone: 5 } };
  } });
  const outcome = await arbiter.submit({ source: 'owner', label: 'make_stone', traceId: 'trace-obtain',
    program: { body: [{ obtain: { item: 'stone', count: '$count' } }],
      params: { count: { type: 'quantity', default: 5 } }, args: {} } }).done;
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.completedSteps, 1);
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].ok, true);
  assert.equal(outcome.results[0].result.status, 'succeeded');
  assert.deepEqual(obtained.map(entry => entry.args), [{ item: 'stone', count: 5 }]);
  assert.equal(obtained[0].hasSignal, true);
  assert.equal(obtained[0].active, true);
  assert.equal(obtained[0].epoch, outcome.epoch);
  assert.equal(obtained[0].traceId, 'trace-obtain');
  assert.ok(outcome.trace.some(entry => entry.node === 'obtain' && entry.item === 'stone' && entry.count === 5));
});

test('arbiter obtain seam finishes the task on goal failure, bad args, or no dep', async () => {
  const failed = fixture(undefined, { obtain: async () => ({ status: 'failed', reason: 'no_source' }) });
  const goal = await failed.arbiter.submit({ source: 'owner', label: 'goal',
    program: { body: [{ obtain: { item: 'stone', count: 1 } }], params: {}, args: {} } }).done;
  assert.equal(goal.status, 'failed');
  assert.equal(goal.error.code, 'no_source');
  const reasonless = fixture(undefined, { obtain: async () => ({ status: 'failed' }) });
  const fallback = await reasonless.arbiter.submit({ source: 'owner', label: 'goal',
    program: { body: [{ obtain: { item: 'stone', count: 1 } }], params: {}, args: {} } }).done;
  assert.equal(fallback.error.code, 'goal_failed');
  const missing = fixture();
  const unavailable = await missing.arbiter.submit({ source: 'owner', label: 'goal',
    program: { body: [{ obtain: { item: 'stone', count: 1 } }], params: {}, args: {} } }).done;
  assert.equal(unavailable.status, 'failed');
  assert.equal(unavailable.error.code, 'obtain_unavailable');
  let calls = 0;
  const invalid = fixture(undefined, { obtain: async () => { calls++; return { status: 'succeeded' }; } });
  for (const count of [0, 65, 'two']) {
    const outcome = await invalid.arbiter.submit({ source: 'owner', label: 'goal',
      program: { body: [{ obtain: { item: 'stone', count } }], params: {}, args: {} } }).done;
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.error.code, 'invalid_args');
  }
  const unknown = await invalid.arbiter.submit({ source: 'owner', label: 'goal',
    program: { body: [{ obtain: { item: 'unobtainium', count: 1 } }], params: {}, args: {} } }).done;
  assert.equal(unknown.error.code, 'invalid_args');
  assert.equal(calls, 0);
});

test('a preempted outcome carries preemptedBy and arbiterFree waits out reflex work', async () => {
  const pending = [];
  const { arbiter } = fixture(() => { const d = deferred(); pending.push(d); return d.promise; });
  const owner = arbiter.submit(intent('owner', 'work'));
  arbiter.submit(intent('reflex', 'fight'));
  const outcome = await owner.done;
  assert.equal(outcome.status, 'preempted');
  assert.equal(outcome.preemptedBy, 'reflex');
  const free = arbiterFree(arbiter);
  let settled = false;
  free.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  pending[1].resolve({ ok: true });
  assert.equal(await free, true);
  // A new owner task accepted in the reflex's finish window reports 'owner'.
  let second;
  second = fixture(undefined, { eventlog: { append: (kind, payload) => {
    if (kind === 'arbiter.done' && payload.source === 'reflex') second.arbiter.submit(intent('owner', 'interrupt'));
  } } });
  const fight = second.arbiter.submit({ source: 'reflex', label: 'fight', dynamic: async () => ({ status: 'succeeded' }) });
  assert.equal(await arbiterFree(second.arbiter), 'owner');
  assert.equal((await fight.done).status, 'succeeded');
});
