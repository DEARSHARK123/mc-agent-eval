import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDecisionScheduler } from '../src/decision/scheduler.js';
import { decide } from '../src/decision/torso.js';
import { createBody } from '../src/body.js';
import { loadConfig } from '../src/config.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function fakeClock() {
  let time = 0;
  let id = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(fn, ms) { timers.set(++id, { fn, at: time + ms }); return id; },
    clearTimeout(timer) { timers.delete(timer); },
    count: () => timers.size,
    async advance(ms) {
      const end = time + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        time = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await tick();
      }
      time = end;
      await tick();
    },
  };
}
function fixture(t, overrides = {}) {
  const clock = fakeClock();
  const calls = [];
  const decisions = [];
  const scheduler = createDecisionScheduler({
    clock, decide(state, options) { calls.push({ state, options }); return decide(state, options); },
    onDecision: result => decisions.push(result), ...overrides,
  });
  t.after(() => { scheduler.stop(); assert.equal(clock.count(), 0); });
  scheduler.start();
  return { clock, calls, decisions, scheduler };
}

test('scheduler: five events in 150ms form one complete batch with state and options', async t => {
  const choices = [{ type: 'idle' }];
  const arbiter = { busy: true, source: 'owner', label: 'working' };
  const { scheduler, clock, calls, decisions } = fixture(t, { getState: () => ({ arbiter }), options: choices });
  for (let i = 0; i < 5; i++) {
    scheduler.push({ type: 'chat', from_owner: true, message: String(i) });
    await clock.advance(29);
  }
  assert.equal(calls.length, 0);
  await clock.advance(5);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].state.events.map(event => event.message), ['0', '1', '2', '3', '4']);
  assert.deepEqual(calls[0].state.arbiter, arbiter);
  assert.deepEqual(calls[0].options, choices);
  assert.equal(decisions[0].actions.length, 5);
  scheduler.push({ type: 'death' });
  await clock.advance(149);
  assert.equal(calls.length, 1);
  await clock.advance(1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].state.events, [{ type: 'death' }]);
});

test('scheduler: heartbeat fires without events and resets after a decision', async t => {
  const { scheduler, clock, calls, decisions } = fixture(t);
  scheduler.start();
  await clock.advance(7999);
  assert.equal(calls.length, 0);
  await clock.advance(1);
  assert.deepEqual(calls[0].state.events, [{ type: 'heartbeat' }]);
  assert.deepEqual(decisions[0].actions, [{ type: 'idle' }]);
  await clock.advance(1000);
  scheduler.push({ type: 'death' });
  await clock.advance(0);
  assert.equal(calls.length, 2);
  await clock.advance(7999);
  assert.equal(calls.length, 2);
  await clock.advance(1);
  assert.equal(calls.length, 3);
});

test('scheduler: default 300ms timeout uses torso rules and discards late result', async t => {
  let finish;
  const { scheduler, clock, decisions } = fixture(t, {
    decide: () => new Promise(resolve => { finish = resolve; }),
  });
  scheduler.push({ type: 'chat', from_owner: true, message: 'come here' });
  await clock.advance(150);
  await clock.advance(299);
  assert.equal(decisions.length, 0);
  await clock.advance(1);
  assert.deepEqual(decisions[0].actions, [{ type: 'handleOwnerChat', message: 'come here' }]);
  finish({ actions: [{ type: 'late' }] });
  await tick();
  assert.equal(decisions.length, 1);
});

test('scheduler: configurable timeout passes the same batch to fallback', async t => {
  const result = { actions: [], escalate: true, reason: 'fallback' };
  let fallbackCalls = 0;
  const { scheduler, clock, decisions } = fixture(t, {
    decide: () => new Promise(() => {}), decideTimeoutMs: 20,
    fallbackDecide(state, options) {
      fallbackCalls++;
      assert.deepEqual(state.events, [{ type: 'death' }]);
      assert.deepEqual(options, ['choice']);
      return result;
    }, options: () => ['choice'],
  });
  scheduler.push({ type: 'death' });
  await clock.advance(169);
  assert.equal(fallbackCalls, 0);
  await clock.advance(1);
  assert.equal(fallbackCalls, 1);
  assert.deepEqual(decisions, [result]);
});

test('scheduler: rejected decisions use fallback immediately', async t => {
  for (const asynchronous of [false, true]) {
    const { scheduler, clock, decisions } = fixture(t, {
      decide() {
        if (asynchronous) return Promise.reject(new Error('offline'));
        throw new Error('offline');
      },
    });
    scheduler.push({ type: 'arbiter.done', status: 'failed' });
    await clock.advance(150);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].escalate, true);
    scheduler.stop();
  }
});

test('scheduler: in-flight decision serializes later events into the next batch', async t => {
  let finish;
  const batches = [];
  const { scheduler, clock, decisions } = fixture(t, {
    decide(state) {
      batches.push(state.events);
      if (batches.length === 1) return new Promise(resolve => { finish = resolve; });
      return decide(state, []);
    },
  });
  scheduler.push({ type: 'death' });
  await clock.advance(150);
  scheduler.push({ type: 'chat', from_owner: true, message: 'one' });
  scheduler.push({ type: 'chat', from_owner: true, message: 'two' });
  await clock.advance(150);
  assert.equal(batches.length, 1);
  finish({ actions: [], escalate: false, reason: 'finished' });
  await tick();
  await clock.advance(0);
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[1].map(event => event.message), ['one', 'two']);
  assert.equal(decisions.length, 2);
});

test('scheduler: flushNow bypasses interval and clears the queued timer', async t => {
  const { scheduler, clock, calls } = fixture(t);
  scheduler.push({ type: 'death' });
  await scheduler.flushNow();
  assert.equal(calls.length, 1);
  await clock.advance(150);
  assert.equal(calls.length, 1);
});

test('scheduler: stop clears timers and suppresses pushes, heartbeat and late completions', async t => {
  let finish;
  let count = 0;
  const { scheduler, clock, decisions } = fixture(t, {
    decide() { count++; return new Promise(resolve => { finish = resolve; }); },
  });
  scheduler.push({ type: 'death' });
  await clock.advance(150);
  scheduler.push({ type: 'death' });
  scheduler.stop();
  scheduler.stop();
  assert.equal(clock.count(), 0);
  finish({ actions: [{ type: 'late' }] });
  scheduler.push({ type: 'death' });
  await scheduler.flushNow();
  await clock.advance(16000);
  assert.equal(count, 1);
  assert.deepEqual(decisions, []);
});

test('scheduler: stop before dispatch prevents decide, restart gets fresh events', async t => {
  const { scheduler, clock, calls } = fixture(t);
  scheduler.push({ type: 'old' });
  scheduler.stop();
  await clock.advance(20000);
  assert.equal(calls.length, 0);
  scheduler.start();
  scheduler.push({ type: 'new' });
  await clock.advance(150);
  assert.deepEqual(calls[0].state.events, [{ type: 'new' }]);
});

const state = (events, busy = false) => ({ events, arbiter: { busy, source: busy ? 'owner' : null, label: null } });
test('torso: owner chat produces handleOwnerChat, even while busy', () => {
  assert.deepEqual(decide(state([{ type: 'chat', from_owner: true, message: 'hello' }], true), []).actions,
    [{ type: 'handleOwnerChat', message: 'hello' }]);
});
test('torso: non-owner chat is ignored with an explicit reason', () => {
  const result = decide(state([{ type: 'chat', from_owner: false, message: 'hello' }]), []);
  assert.deepEqual(result.actions, []);
  assert.equal(result.escalate, false);
  assert.match(result.reason, /non-owner/);
});
test('torso: failed done escalates; other outcomes do not', () => {
  for (const status of ['failed', 'completed', 'preempted', 'cancelled', 'rejected']) {
    const result = decide(state([{ type: 'arbiter.done', status }]), []);
    assert.equal(result.escalate, status === 'failed');
    assert.deepEqual(result.actions, []);
  }
});
test('torso: heartbeat idles only when free, remaining events do nothing', () => {
  assert.deepEqual(decide(state([{ type: 'heartbeat' }]), []).actions, [{ type: 'idle' }]);
  assert.deepEqual(decide(state([{ type: 'heartbeat' }], true), []).actions, []);
  assert.deepEqual(decide(state([{ type: 'death' }, { type: 'spawn' }]), []).actions, []);
});
test('torso: full eventlog batch preserves owner messages and failure escalation', () => {
  const result = decide(state([
    { kind: 'chat', payload: { from_owner: false, message: 'ignored' } },
    { kind: 'chat', payload: { from_owner: true, message: 'first' } },
    { kind: 'arbiter.done', payload: { status: 'failed' } },
    { kind: 'chat', payload: { from_owner: true, message: 'second' } },
    { type: 'heartbeat' },
  ]), []);
  assert.deepEqual(result.actions, [
    { type: 'handleOwnerChat', message: 'first' }, { type: 'handleOwnerChat', message: 'second' },
  ]);
  assert.equal(result.escalate, true);
  assert.match(result.reason, /non-owner/);
});

test('body: canReflex false suppresses lookAt and enabling it resumes reflex', t => {
  const ownerUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const bot = new EventEmitter();
  let looks = 0;
  let busy = true;
  Object.assign(bot, {
    entity: { position: { x: 0, y: 0, z: 0 } },
    players: { Owner: { uuid: ownerUuid, entity: {
      position: { x: 1, y: 0, z: 0, offset: () => ({ x: 1, y: 1.8, z: 0 }) },
    } } },
    lookAt: () => { looks++; }, loadPlugin() {}, quit() {},
  });
  const body = createBody(loadConfig({ OWNER_UUID: ownerUuid }), { append() {} }, {
    createBot: () => bot, pathfinderPlugin() {}, canReflex: () => !busy,
  });
  t.after(() => body.close());
  bot.emit('physicsTick');
  bot.emit('physicsTick');
  assert.equal(looks, 0);
  busy = false;
  bot.emit('physicsTick');
  assert.equal(looks, 1);
});
