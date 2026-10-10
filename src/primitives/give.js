import { itemName, navigate, goals, step, checkSignal } from './helpers.js';
import { resolveClock } from '../clock.js';
export const name = 'give';
export const description = 'Toss the requested inventory count only to the owner.';
export const params = { itemName, count: { type: 'number', integer: true, min: 1, max: 64, default: 1 } };
export const defaultTimeoutMs = 20000;
export async function run({ bot, mcData, ownerUuid, clock }, { itemName, count }, signal) {
  const type = mcData.itemsByName[itemName].id;
  const held = () => bot.inventory.items().filter(i => i.type === type).reduce((n, i) => n + i.count, 0);
  const before = held();
  if (before < count) throw new Error('not_enough_items');
  const uuid = ownerUuid ?? bot.ownerUuid;
  const owner = Object.values(bot.entities ?? {}).find(e => uuid && e.uuid?.toLowerCase() === uuid.toLowerCase() && e.isValid !== false && e.position);
  if (!owner) throw new Error('owner_not_visible');
  await navigate(bot, new goals.GoalFollow(owner, 1.2), signal);
  checkSignal(signal);
  if (bot.entity.position.distanceTo(owner.position) > 2.5) throw new Error('owner_out_of_reach');
  const timers = resolveClock(clock);
  const pause = ms => {
    let timer;
    return step(signal, () => new Promise(resolve => { timer = timers.setTimeout(resolve, ms); }))
      .finally(() => { if (timer !== undefined) timers.clearTimeout(timer); });
  };
  const strays = () => Object.values(bot.entities ?? {}).filter(e => e.isValid !== false && e.position
    && e.getDroppedItem?.()?.type === type && e.position.distanceTo(owner.position) <= 6);
  const toss = async amount => {
    await step(signal, () => bot.lookAt(owner.position.offset(0, 0.5, 0)));
    await step(signal, () => bot.toss(type, null, amount));
  };
  await toss(count);
  // A tossed stack can scatter past the owner's pickup radius and lie on the
  // ground even though the give already reported success. Pick any strays back
  // up and re-toss so the count actually reaches them.
  for (let attempt = 0; attempt < 2; attempt++) {
    await pause(1500);
    const stray = strays()[0];
    if (!stray) break;
    const move = new AbortController();
    const merged = AbortSignal.any([signal, move.signal]);
    let timer;
    const budget = new Promise(resolve => { timer = timers.setTimeout(resolve, 5000); });
    try {
      await Promise.race([navigate(bot, new goals.GoalFollow(stray, 0), merged).catch(() => {}), budget]);
    } finally {
      if (timer !== undefined) timers.clearTimeout(timer);
      move.abort();
    }
    checkSignal(signal);
    const rest = Math.min(held(), count);
    if (rest > 0) await toss(rest);
  }
  // The stray-recollect loop can pick the toss back up into her own
  // inventory — `given` must be what actually left her hands, not the
  // requested count.
  return { itemName, given: Math.max(0, before - held()) };
}
