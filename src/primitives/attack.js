import { goals, step, checkSignal } from './helpers.js';
export const name = 'attack';
export const description = 'Attack one nearby allowed hostile mob or food animal.';
export const params = { entityName: { type: 'string', required: true, catalog: 'entitiesByName' }, maxHits: { type: 'number', integer: true, min: 1, max: 60, default: 20 } };
export const defaultTimeoutMs = 30000;
const excluded = new Set(['player', 'villager', 'wandering_trader', 'iron_golem', 'snow_golem', 'wolf', 'cat', 'horse', 'donkey', 'mule', 'skeleton_horse', 'zombie_horse', 'parrot', 'enderman', 'zombified_piglin', 'piglin', 'piglin_brute', 'warden', 'wither', 'ender_dragon', 'elder_guardian', 'ghast']);
export function allowed(name, data) { return !excluded.has(name) && (['cow', 'pig', 'sheep', 'chicken'].includes(name) || data.entitiesByName[name]?.type === 'hostile'); }
function pause(clock, ms, signal, bot, target) {
  const schedule = (clock?.setTimeout ?? setTimeout).bind(clock ?? globalThis);
  const clear = (clock?.clearTimeout ?? clearTimeout).bind(clock ?? globalThis);
  let timer;
  let changed;
  const cleanup = () => {
    clear(timer);
    if (changed) { bot.removeListener('entityGone', changed); bot.removeListener('health', changed); }
  };
  return step(signal, () => new Promise(resolve => {
    changed = () => { if (target.isValid === false || bot.health <= 4) resolve(); };
    bot.on('entityGone', changed);
    bot.on('health', changed);
    timer = schedule(resolve, ms);
  }), cleanup).finally(cleanup);
}
export async function run({ bot, mcData, clock, ownerUuid }, { entityName, maxHits }, signal) {
  ownerUuid ??= bot.ownerUuid;
  if (bot.health <= 6) throw new Error('health_too_low');
  const target = Object.values(bot.entities ?? {}).filter(e => e.name === entityName && e.type !== 'player' &&
    e.isValid !== false && e.position && (!ownerUuid || e.uuid?.toLowerCase() !== ownerUuid.toLowerCase()) &&
    bot.entity.position.distanceTo(e.position) <= 16).sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position))[0];
  if (!target) throw new Error('target_not_found');
  const inventory = bot.inventory.items();
  let weapon;
  for (const kind of ['sword', 'axe']) {
    for (const material of ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']) {
      weapon = inventory.find(i => i.type === mcData.itemsByName[`${material}_${kind}`]?.id);
      if (weapon) break;
    }
    if (weapon) break;
  }
  let hits = 0;
  const stop = () => { try { bot.pathfinder.stop(); } catch {} try { bot.pathfinder.setGoal?.(null); } catch {} };
  const gone = e => { if (e === target || e.id === target.id) target.isValid = false; };
  bot.on('entityGone', gone);
  signal.addEventListener('abort', stop, { once: true });
  try {
    if (weapon) await step(signal, () => bot.equip(weapon, 'hand'));
    else if (bot.unequip) await step(signal, () => bot.unequip('hand'));
    checkSignal(signal);
    // A stop() left pending by any earlier task wipes the goal set below
    // (resetPath sees stopPathing and nulls stateGoal) — flush it first.
    bot.pathfinder.setGoal?.(null);
    bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true);
    for (;;) {
      checkSignal(signal);
      if (bot.health <= 4) throw new Error('health_too_low');
      if (target.isValid === false) return { entityName, hits, killed: true };
      if (hits >= maxHits) { const error = new Error('max_hits'); error.hits = hits; throw error; }
      if (bot.entity.position.distanceTo(target.position) > 3) { await pause(clock, 50, signal, bot, target); continue; }
      await step(signal, () => bot.lookAt(target.position.offset(0, (target.height ?? 1) / 2, 0)));
      checkSignal(signal);
      if (bot.health <= 4) throw new Error('health_too_low');
      if (target.isValid === false) continue;
      bot.attack(target);
      hits++;
      if (target.isValid !== false) await pause(clock, 600, signal, bot, target);
    }
  } finally {
    stop();
    bot.removeListener('entityGone', gone);
    signal.removeEventListener('abort', stop);
  }
}
