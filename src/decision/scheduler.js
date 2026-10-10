import { decide as ruleDecide } from './torso.js';
import { resolveClock } from '../clock.js';

export function createDecisionScheduler({
  decide, onDecision, clock = {}, minIntervalMs = 150, heartbeatMs = 8000,
  decideTimeoutMs = 300, fallbackDecide = ruleDecide,
  getState = () => ({ arbiter: { busy: false, source: null, label: null } }), options = [],
}) {
  const timers = resolveClock(clock);
  const now = timers.now;
  const schedule = (fn, ms) => timers.setTimeout(fn, ms);
  const clear = timer => { if (timer !== undefined) timers.clearTimeout(timer); };
  let running = false;
  let pending = [];
  let lastDecision;
  let batchTimer;
  let heartbeatTimer;
  let active = null;

  function armHeartbeat() {
    clear(heartbeatTimer);
    heartbeatTimer = undefined;
    if (!running || active) return;
    heartbeatTimer = schedule(() => {
      heartbeatTimer = undefined;
      push({ type: 'heartbeat' });
    }, Math.max(0, heartbeatMs - (now() - lastDecision)));
  }

  function armBatch() {
    if (!running || active || batchTimer !== undefined || pending.length === 0) return;
    batchTimer = schedule(() => {
      batchTimer = undefined;
      flushNow();
    }, Math.max(0, minIntervalMs - (now() - lastDecision)));
  }

  function push(event) {
    if (!running) return;
    pending.push(event);
    armBatch();
  }

  function flushNow() {
    if (!running) return Promise.resolve();
    if (active) return active.done;
    clear(batchTimer);
    clear(heartbeatTimer);
    batchTimer = heartbeatTimer = undefined;
    const state = { ...getState(), events: pending };
    pending = [];
    const choices = typeof options === 'function' ? options(state) : options;
    const task = {};
    task.done = new Promise(resolve => { task.resolve = resolve; });
    active = task;
    lastDecision = now();

    function complete(result) {
      if (!running || active !== task) return;
      clear(task.timer);
      active = null;
      task.resolve(result);
      try {
        onDecision(result);
      } finally {
        armBatch();
        armHeartbeat();
      }
    }
    function fallback() {
      if (!running || active !== task || task.fallingBack) return;
      task.fallingBack = true;
      clear(task.timer);
      Promise.resolve().then(() => fallbackDecide(state, choices)).then(complete);
    }
    task.timer = schedule(fallback, decideTimeoutMs);
    Promise.resolve().then(() => {
      if (running && active === task) return decide(state, choices);
    }).then(result => {
      if (!task.fallingBack) complete(result);
    }, fallback);
    return task.done;
  }

  return {
    push, flushNow,
    start() {
      if (running) return;
      running = true;
      lastDecision = now();
      armHeartbeat();
    },
    stop() {
      running = false;
      clear(batchTimer);
      clear(heartbeatTimer);
      clear(active?.timer);
      active?.resolve();
      active = null;
      batchTimer = heartbeatTimer = undefined;
      pending = [];
    },
  };
}
