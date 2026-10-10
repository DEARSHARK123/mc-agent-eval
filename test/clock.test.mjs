import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveClock } from '../src/clock.js';

test('resolveClock: a function clock supplies now and global timers', async () => {
  let time = 1000;
  const timers = resolveClock(() => (time += 5));
  assert.equal(timers.now(), 1005);
  assert.equal(timers.now(), 1010);
  assert.equal(timers.setTimeout, timers.setTimeout);
  let fired = false;
  const timer = timers.setTimeout(() => { fired = true; }, 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fired, true);
  const cancelled = timers.setTimeout(() => { fired = 'bad'; }, 1);
  timers.clearTimeout(cancelled);
  const interval = timers.setInterval(() => { fired = 'bad'; }, 1);
  timers.clearInterval(interval);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fired, true);
  assert.ok(timer !== undefined);
  assert.ok(Object.isFrozen(timers));
});

test('resolveClock: an object clock uses partial overrides and falls back to globals', () => {
  const calls = [];
  const clock = {
    now: () => 42,
    setTimeout(callback, ms) { calls.push(['setTimeout', ms]); return 'timer-1'; },
  };
  const timers = resolveClock(clock);
  assert.equal(timers.now(), 42);
  assert.equal(timers.setTimeout(() => {}, 7), 'timer-1');
  assert.deepEqual(calls, [['setTimeout', 7]]);
  const interval = timers.setInterval(() => {}, 5);
  timers.clearInterval(interval);
});

test('resolveClock: overrides are called with the clock as this', () => {
  const clock = {
    marker: true,
    now() { return this.marker ? 7 : -1; },
    setTimeout(callback) { assert.equal(this, clock); callback(); return 0; },
    clearTimeout() { assert.equal(this, clock); },
    setInterval() { assert.equal(this, clock); return 1; },
    clearInterval() { assert.equal(this, clock); },
  };
  const timers = resolveClock(clock);
  assert.equal(timers.now(), 7);
  let fired = false;
  timers.setTimeout(() => { fired = true; }, 0);
  assert.equal(fired, true);
  timers.clearTimeout(0);
  timers.clearInterval(timers.setInterval(() => {}, 0));
});

test('resolveClock: no clock resolves to Date.now and global timers', async () => {
  const timers = resolveClock();
  assert.ok(timers.now() <= Date.now());
  let fired = false;
  timers.setTimeout(() => { fired = true; }, 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fired, true);
});
