import { resolveClock } from './clock.js';

// Primitives that change the world or her inventory. Perception, movement and
// speech stay free — she may look around and go where she likes, she just does
// not rearrange the world on her own initiative. craft/smelt count because they
// consume inputs to produce outputs; `command` only exists when COMMANDS=1.
export const MUTATING = new Set([
  'dig', 'place', 'attack', 'give', 'deposit', 'withdraw', 'command', 'craft', 'smelt',
]);

// The action budget is derived from the event log so restarts do not reset it:
// every budget.action_spent event since local midnight counts against `limit`.
export function createActionCost({ eventlog, limit, clock = {} }) {
  const now = resolveClock(clock).now;
  function todayStart() {
    const date = new Date(now());
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }
  function remaining() {
    const spent = eventlog.query({ kind: 'budget.action_spent', since: todayStart(), limit: Number.MAX_SAFE_INTEGER }).length;
    return Math.max(0, limit - spent);
  }
  function trySpend({ source, primitive }, traceId) {
    if (remaining() <= 0) return false;
    eventlog.append('budget.action_spent', { source, primitive }, traceId);
    return true;
  }
  return Object.freeze({ limit, remaining, trySpend });
}
