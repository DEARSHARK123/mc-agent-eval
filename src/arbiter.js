import { EventEmitter } from 'node:events';
import { createTraceId } from './trace.js';
import { interpret } from './skills/interpreter.js';
import { resolveClock } from './clock.js';
import { MUTATING } from './cost.js';

const priorities = { reflex: 3, owner: 2, plan: 1, idle: 0 };

// Waits until no reflex (or owner) task holds the arbiter: the arbiter is idle
// or running plan/idle work that a resumed owner task may preempt. Resolves
// true when clear, 'owner' if an owner task took over meanwhile, false on timeout.
export function arbiterFree(arbiter, timers = {}, timeoutMs = 60_000) {
  const { now = Date.now, setTimeout: schedule = setTimeout, clearTimeout: clear = clearTimeout } = timers;
  return new Promise(resolve => {
    const deadline = now() + timeoutMs;
    let timer;
    const done = value => { clear(timer); arbiter.off('done', check); arbiter.off('accept', onAccept); resolve(value); };
    const check = () => {
      const current = arbiter.current();
      if (current?.source === 'owner') return done('owner');
      if (!current || current.source === 'idle' || current.source === 'plan') return done(true);
      if (now() >= deadline) return done(false);
      timer = schedule(check, 100);
    };
    // An owner task can be accepted and finish between polls — watch accepts too.
    const onAccept = task => { if (task?.source === 'owner') done('owner'); };
    arbiter.on('accept', onAccept);
    arbiter.on('done', check);
    check();
  });
}

export class InvalidIntentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidIntentError';
  }
}

export function createArbiter({ registry, eventlog, clock = {}, resolver, obtain, cost = null }) {
  const events = new EventEmitter();
  const now = resolveClock(clock).now;
  let epoch = 0;
  let active = null;

  // Self-initiated work (idle/plan) pays one action-budget point per executed
  // world-changing step; reflexes and owner orders are always free. A refused
  // step is an honest failure — the task sees a normal step error, not a skip.
  const billed = task => cost != null && (task.source === 'idle' || task.source === 'plan');
  function budgetExceeded(task, step) {
    try {
      return billed(task) && MUTATING.has(step.primitive) && cost.remaining() <= 0;
    } catch {
      return false; // A broken event log must not strand task settlement.
    }
  }
  function spendFor(task, step) {
    if (!billed(task) || !MUTATING.has(step.primitive)) return;
    try {
      cost.trySpend({ source: task.source, primitive: step.primitive }, task.traceId);
    } catch {
      // Accounting must not interrupt task settlement either.
    }
  }

  function record(kind, task, extra = {}) {
    try {
      eventlog.append(kind, {
        epoch: task.epoch, source: task.source, label: task.label, ts: now(), ...extra,
      }, task.traceId);
    } catch {
      // Logging must not interrupt task settlement, including shutdown cleanup.
    }
  }

  function finish(task, status, error, extra = {}) {
    if (task.outcome) return;
    const outcome = {
      epoch: task.epoch, status, completedSteps: task.completedSteps,
      results: [...task.results], ...(error === undefined ? {} : { error }),
      ...(task.program ? { trace: structuredClone(task.trace) } : {}), ...extra,
    };
    task.outcome = outcome;
    if (active === task) active = null;
    record('arbiter.done', task, outcome);
    task.resolve(outcome);
    // Deliver notifications after the state transition, including replacement acceptance.
    queueMicrotask(() => events.emit('done', outcome));
  }

  async function execute(task) {
    if (task.dynamic) {
      try {
        const result = await task.dynamic({ signal: task.controller.signal, isActive: () => active === task,
          epoch: task.epoch, traceId: task.traceId });
        if (active === task) {
          task.completedSteps = result?.steps ?? 0;
          const { status = 'completed', reason, actions } = result ?? {};
          finish(task, status, reason ? { code: reason } : undefined,
            { ...(reason ? { reason } : {}), ...(actions ? { actions } : {}) });
        }
      } catch (error) {
        if (active === task) finish(task, 'failed', { name: error?.name ?? 'Error', message: error?.message ?? String(error) });
      }
      return;
    }
    if (task.program) {
      await interpret({ program: task.program, library: task.library, trace: task.trace,
        isActive: () => active === task,
        async runPrimitive(step, bindings) {
          if (active !== task) return null;
          if (budgetExceeded(task, step)) {
            const error = { code: 'action_budget_exhausted' };
            task.results.push({ ok: false, error });
            finish(task, 'failed', error);
            return null;
          }
          let result;
          try {
            const resolved = resolver ? await resolver(step, bindings) : step;
            if (active !== task) {
              record('arbiter.stale', task, { primitive: step.primitive });
              return null;
            }
            registry.validate?.(resolved.primitive, resolved.params);
            // Auto-approach: a resolved step whose target sits beyond its
            // primitive's declared reach walks in via an implicit goTo first.
            // The walk runs through the registry like any primitive (logged;
            // movement is cost-free), and its failure becomes the step's.
            const approached = registry.approach ? await registry.approach(resolved, {
              signal: task.controller.signal, traceId: task.traceId, source: task.source,
            }) : null;
            if (active !== task) {
              record('arbiter.stale', task, { primitive: step.primitive });
              return null;
            }
            if (approached && !approached.ok) {
              result = approached;
            } else {
              result = await registry.run(resolved.primitive, resolved.params, {
                signal: task.controller.signal, traceId: task.traceId, timeoutMs: resolved.timeoutMs,
                source: task.source,
              });
              // A resolved run means the primitive actually attempted (its
              // primitive.end was logged): success or failure, it still costs.
              spendFor(task, step);
            }
          } catch (error) {
            result = { ok: false, error: { name: error?.name ?? 'Error', message: error?.message ?? String(error),
              ...(error?.code ? { code: error.code } : {}), ...(error?.blockName ? { blockName: error.blockName } : {}) } };
          }
          if (active !== task) {
            record('arbiter.stale', task, { primitive: step.primitive });
            return null;
          }
          task.results.push(result);
          if (!result.ok) {
            finish(task, 'failed', result.error);
            return null;
          }
          task.completedSteps++;
          if (step.id !== undefined) {
            bindings.set(step.id, result.result);
            if (step.params?.blockName) bindings.blockNames.set(step.id, step.params.blockName);
          }
          return result.result;
        },
        async obtain({ item, count }) {
          if (typeof obtain !== 'function') {
            finish(task, 'failed', { code: 'obtain_unavailable' });
            return null;
          }
          const result = await obtain({ item, count }, {
            signal: task.controller.signal, isActive: () => active === task,
            epoch: task.epoch, traceId: task.traceId, source: task.source,
          });
          if (active !== task) return null;
          task.results.push({ ok: result?.status === 'succeeded', result });
          if (result?.status !== 'succeeded') {
            finish(task, 'failed', { code: result?.reason ?? 'goal_failed',
              ...(result?.detail ? { detail: result.detail } : {}) });
            return null;
          }
          task.completedSteps++;
          return result;
        },
      });
      if (active === task) finish(task, 'completed');
      return;
    }
    const priorResults = new Map();
    // Keep source names separately so a null findBlock result still explains the failure.
    priorResults.blockNames = new Map();
    for (const step of task.steps) {
      if (active !== task) return;
      if (budgetExceeded(task, step)) {
        const error = { code: 'action_budget_exhausted' };
        task.results.push({ ok: false, error });
        finish(task, 'failed', error);
        return;
      }
      let result;
      try {
        const resolved = resolver ? await resolver(step, priorResults) : step;
        if (active !== task) return;
        result = await registry.run(resolved.primitive, resolved.params, {
          signal: task.controller.signal, traceId: task.traceId, timeoutMs: resolved.timeoutMs,
          source: task.source,
        });
        // A resolved run means the primitive actually attempted (its
        // primitive.end was logged): success or failure, it still costs.
        spendFor(task, step);
      } catch (error) {
        result = { ok: false, error: { name: error?.name ?? 'Error', message: error?.message ?? String(error),
          ...(error?.code ? { code: error.code } : {}), ...(error?.blockName ? { blockName: error.blockName } : {}) } };
      }
      if (active !== task) {
        record('arbiter.stale', task, { primitive: step.primitive });
        return;
      }
      task.results.push(result);
      if (!result.ok) {
        finish(task, 'failed', result.error);
        return;
      }
      task.completedSteps++;
      if (step.id !== undefined) {
        priorResults.set(step.id, result.result);
        if (step.params?.blockName) priorResults.blockNames.set(step.id, step.params.blockName);
      }
    }
    finish(task, 'completed');
  }

  function submit(intent) {
    if (!intent || !Object.hasOwn(priorities, intent.source)) {
      throw new InvalidIntentError('Invalid intent source');
    }
    if (typeof intent.label !== 'string') throw new InvalidIntentError('Intent label must be a string');
    if ((intent.program && intent.steps) || (intent.dynamic && (intent.program || intent.steps))) throw new InvalidIntentError('Choose one intent shape');
    if (!intent.dynamic && (intent.program ? !Array.isArray(intent.program.body) || intent.program.body.length === 0
      : !Array.isArray(intent.steps) || intent.steps.length === 0)) {
      throw new InvalidIntentError('Intent steps must be nonempty');
    }
    if (intent.dynamic && typeof intent.dynamic !== 'function') throw new InvalidIntentError('Dynamic intent must be a function');
    for (const step of intent.steps ?? []) {
      if (!step || !registry.has(step.primitive)) throw new InvalidIntentError('Unknown intent primitive');
    }
    const task = {
      source: intent.source, label: intent.label, traceId: intent.traceId ?? createTraceId(),
      steps: structuredClone(intent.steps), epoch: null, results: [], completedSteps: 0,
      program: intent.program && structuredClone(intent.program), dynamic: intent.dynamic, library: intent.library, trace: [],
      controller: new AbortController(),
    };
    const done = new Promise(resolve => { task.resolve = resolve; });
    let previous;
    if (active) {
      const difference = priorities[task.source] - priorities[active.source];
      if (difference < 0 || (difference === 0 && ['plan', 'idle'].includes(task.source))) {
        record('arbiter.reject', task, { reason: 'busy' });
        finish(task, 'rejected');
        return { accepted: false, reason: 'busy', done };
      }
      previous = active;
    }
    task.epoch = ++epoch;
    active = task;
    if (previous) {
      record('arbiter.preempt', previous, { by_source: task.source, by_label: task.label });
      finish(previous, 'preempted', undefined, { preemptedBy: task.source });
    }
    record('arbiter.accept', task);
    queueMicrotask(() => events.emit('accept', { epoch: task.epoch, source: task.source, label: task.label, traceId: task.traceId }));
    // Abort callbacks may submit again; publish the replacement before invoking them.
    previous?.controller.abort('preempted');
    void execute(task).catch(error => {
      finish(task, 'failed', {
        name: error?.name ?? 'Error', message: error?.message ?? String(error),
        ...(error?.code ? { code: error.code } : {}),
      });
    });
    return { accepted: true, epoch: task.epoch, done };
  }

  return {
    submit,
    cancel(sourceOrReason = 'cancelled') {
      const bySource = Object.hasOwn(priorities, sourceOrReason);
      const source = bySource ? sourceOrReason : null;
      const reason = bySource ? 'cancelled' : sourceOrReason;
      if (!active || (source && active.source !== source)) return false;
      const task = active;
      finish(task, 'cancelled');
      task.controller.abort(reason);
      return true;
    },
    current: () => active && ({ epoch: active.epoch, source: active.source, label: active.label, traceId: active.traceId }),
    isBusy: () => active !== null,
    on: (event, fn) => events.on(event, fn),
    off: (event, fn) => events.off(event, fn),
  };
}
