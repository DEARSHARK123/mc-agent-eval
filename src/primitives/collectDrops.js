import { checkSignal, codedError, goals, navigate, step } from './helpers.js';
import { resolveClock } from '../clock.js';

export const name = 'collectDrops';
export const description = 'Collect nearby dropped items and count confirmed pickups.';
export const params = {
  radius: { type: 'number', exclusiveMin: 0, default: 6 },
  settleMs: { type: 'number', exclusiveMin: 0, default: 1500 },
};
export const defaultTimeoutMs = 30_000;
// GoalFollow(entity, 0) can keep re-pathing forever to a drop that is reachable
// on paper but untouchable (on top of a column, inside a block), so one bad drop
// used to consume the whole primitive timeout. Bound each drop's follow instead
// and skip it when the budget runs out.
const FOLLOW_BUDGET_MS = 8_000;
export async function run({ bot, clock = {}, eventlog, ownerUuid }, { radius, settleMs }, signal) {
  const origin = bot.entity.position.clone();
  const timers = resolveClock(clock);
  const now = timers.now;
  const schedule = timers.setTimeout;
  const unschedule = timers.clearTimeout;
  const items = new Map();
  const finished = new Set();
  const scan = () => Object.values(bot.entities).filter(entity =>
    !finished.has(entity.id) && entity.isValid !== false && entity.position &&
    origin.distanceTo(entity.position) <= radius && entity.getDroppedItem?.()
  ).sort((a, b) => origin.distanceTo(a.position) - origin.distanceTo(b.position));
  let count = 0;
  const takenByOwner = {};
  let wake;
  const collected = (collector, entity) => {
    if (!entity) return;
    const isSelf = collector?.id === bot.entity.id;
    // entityGone may beat playerCollect on instant pickups — owner steals are
    // still credited; her own pickups keep the finished guard (one packet
    // per entity anyway, but tests rely on it).
    if (isSelf && finished.has(entity.id)) return;
    const dropped = items.get(entity.id) ?? entity.getDroppedItem?.();
    if (!dropped) return;
    if (!items.has(entity.id) && isSelf) return;
    finished.add(entity.id);
    if (isSelf) {
      count += dropped.count;
    } else if (ownerUuid && collector?.uuid?.toLowerCase() === ownerUuid.toLowerCase()) {
      const item = dropped.name ?? 'item';
      takenByOwner[item] = (takenByOwner[item] ?? 0) + dropped.count;
      try { eventlog?.append('body.items_taken', { by: 'owner', where: 'drops', item, count: dropped.count }); } catch {}
    }
    wake?.();
  };
  const gone = entity => {
    finished.add(entity.id);
    wake?.();
  };
  bot.on('playerCollect', collected);
  bot.on('entityGone', gone);
  try {
    const deadline = now() + settleMs;
    let drops = scan();
    while (!drops.length && now() < deadline) {
      let timer;
      try {
        await step(signal, () => new Promise(resolve => {
          timer = schedule(resolve, Math.min(100, deadline - now()));
        }));
      } finally {
        if (timer !== undefined) unschedule(timer);
      }
      checkSignal(signal);
      drops = scan();
    }
    let processed = 0;
    while (drops.length && processed < 32) {
      const batch = drops.slice(0, 32 - processed);
      for (const entity of batch) items.set(entity.id, entity.getDroppedItem());
      for (const entity of batch) {
        checkSignal(signal);
        if (finished.has(entity.id) || entity.isValid === false) continue;
        processed++;
        const movement = new AbortController();
        const movementSignal = AbortSignal.any([signal, movement.signal]);
        let settled = false;
        let budgetTimer;
        const budget = new Promise((_, reject) => {
          budgetTimer = schedule(() => reject(
            codedError('drop_unreachable', 'Drop could not be reached or picked up in time', { entityId: entity.id })
          ), FOLLOW_BUDGET_MS);
        });
        budget.catch(() => {});
        const pickup = new Promise(resolve => {
          wake = () => { if (finished.has(entity.id)) resolve(); };
        });
        try {
          // Pickup/despawn can precede goal completion; stop following the vanished entity.
          const navigation = navigate(bot, new goals.GoalFollow(entity, 0), movementSignal).then(
            () => { settled = true; },
            error => {
              settled = true;
              checkSignal(signal);
              // Losing a follow (e.g. monitorMovement stopping on an invalid entity)
              // or failing to reach the drop must not fail the batch — skip it.
              if (['PathStopped', 'NoPath', 'Timeout'].includes(error.name) || error.message?.startsWith('Path was stopped')) {
                finished.add(entity.id);
                wake?.();
                return;
              }
              if (!finished.has(entity.id)) throw error;
            }
          );
          try {
            await Promise.race([navigation, pickup, budget]);
            if (!finished.has(entity.id)) await step(signal, () => Promise.race([pickup, budget]));
          } catch (error) {
            if (error?.code !== 'drop_unreachable') throw error;
            finished.add(entity.id);
            wake?.();
          }
        } finally {
          if (budgetTimer !== undefined) unschedule(budgetTimer);
          if (!settled) movement.abort();
          wake = undefined;
        }
      }
      checkSignal(signal);
      drops = scan();
    }
    return { count, takenByOwner };
  } finally {
    bot.off('playerCollect', collected);
    bot.off('entityGone', gone);
  }
}
