import { resolveClock } from '../clock.js';

// The budget is derived from the event log so restarts do not reset it.
export function createLearningBudget({ eventlog, limit, clock = {} }) {
  const now = resolveClock(clock).now;
  const reserve = Math.max(1, Math.ceil(limit * 0.25));
  function todayStart() {
    const date = new Date(now());
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }
  function remaining() {
    const spent = eventlog.query({ kind: 'budget.learning_spent', since: todayStart(), limit: Number.MAX_SAFE_INTEGER }).length;
    return Math.max(0, limit - spent);
  }
  function spend({ kind, item }, traceId) {
    if (remaining() <= 0) return false;
    eventlog.append('budget.learning_spent', { kind, item }, traceId);
    return true;
  }
  return Object.freeze({ limit, remaining, spend, reserve });
}
