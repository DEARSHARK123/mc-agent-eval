import { goals, checkSignal } from './helpers.js';

export const name = 'follow';
export const description = 'Follow the owner while the owner remains visible.';
export const params = { range: { type: 'number', min: 0, default: 2 } };
export const defaultTimeoutMs = 600_000;

function ownerEntity(bot, ownerUuid) {
  const wanted = String(ownerUuid ?? '').toLowerCase();
  const entity = Object.values(bot?.entities ?? {}).find(value => value?.uuid?.toLowerCase() === wanted &&
    value.isValid !== false && value.position);
  if (entity) return entity;
  const player = Object.values(bot?.players ?? {}).find(value => value?.uuid?.toLowerCase() === wanted &&
    value.entity?.isValid !== false && value.entity?.position);
  return player?.entity ?? null;
}

function waitTick(signal, schedule, unschedule, ms) {
  return new Promise((resolve, reject) => {
    let timer;
    const abort = () => {
      if (timer !== undefined) unschedule(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    timer = schedule(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
  });
}

export async function run({ bot, ownerUuid: contextOwnerUuid, clock }, { range }, signal) {
  const ownerUuid = contextOwnerUuid ?? bot?.ownerUuid;
  const schedule = (clock?.setTimeout ?? setTimeout).bind(clock ?? globalThis);
  const unschedule = (clock?.clearTimeout ?? clearTimeout).bind(clock ?? globalThis);
  let target = null;
  let lostAt = null;
  try {
    for (;;) {
      checkSignal(signal);
      const visible = ownerEntity(bot, ownerUuid);
      const now = typeof clock === 'function' ? clock() : (clock?.now ?? Date.now).call(clock);
      if (!visible) {
        lostAt ??= now;
        if (now - lostAt >= 30_000) return { reason: 'owner_lost' };
      } else {
        lostAt = null;
        if (target !== visible) {
          target = visible;
          const goal = new goals.GoalFollow(target, range);
          if (typeof bot.pathfinder?.setGoal === 'function') {
            // A pending stop() flag would otherwise wipe this goal on setGoal.
            bot.pathfinder.setGoal(null);
            bot.pathfinder.setGoal(goal, true);
          }
          else if (typeof bot.pathfinder?.goto === 'function') await bot.pathfinder.goto(goal);
        }
      }
      await waitTick(signal, schedule, unschedule, 250);
    }
  } finally {
    try { bot.pathfinder?.stop?.(); } catch {}
    try { bot.pathfinder?.setGoal?.(null); } catch {}
  }
}
