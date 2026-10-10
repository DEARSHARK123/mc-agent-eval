import { itemName, step, checkSignal } from './helpers.js';
export const name = 'eat';
export const description = 'Eat a safe inventory food without unnecessary waste.';
export const params = { itemName: { ...itemName, required: false } };
export const defaultTimeoutMs = 8000;
const banned = new Set(['pufferfish', 'spider_eye', 'poisonous_potato', 'suspicious_stew']);
const risky = new Set(['rotten_flesh', 'chicken']);
export function selectFood(bot, mcData, requested) {
  const foodBefore = bot.food;
  if (foodBefore >= 20) throw new Error('not_hungry');
  const foods = bot.inventory.items().map(item => ({ item, food: mcData.foods[item.type],
    name: item.name ?? mcData.items[item.type]?.name })).filter(i => i.food && !banned.has(i.name));
  const safe = foods.filter(i => !risky.has(i.name));
  const eligible = safe.length ? safe : foodBefore <= 6 ? foods : [];
  let chosen;
  if (requested) {
    chosen = eligible.find(i => i.name === requested);
    if (!chosen) throw new Error(banned.has(requested) || risky.has(requested) || !mcData.foods[mcData.itemsByName[requested].id] ? 'unsafe_food' : 'no_food');
  } else {
    const gap = 20 - foodBefore;
    const fitting = eligible.filter(i => i.food.foodPoints <= gap);
    chosen = (fitting.length ? fitting.sort((a, b) => b.food.foodPoints - a.food.foodPoints) :
      eligible.sort((a, b) => a.food.foodPoints - b.food.foodPoints))[0];
  }
  if (!chosen) throw new Error('no_food');
  return chosen;
}
const negative = new Set(['bad_omen', 'raid_omen', 'trial_omen', 'slowness', 'mining_fatigue',
  'nausea', 'blindness', 'hunger', 'weakness', 'poison', 'wither', 'bad_luck', 'unluck',
  'levitation', 'darkness', 'wind_charged', 'weaving', 'oozing', 'infested', 'instant_damage']);
const effectName = (mcData, id) => (mcData.effects?.[id]?.name ?? mcData.effectsById?.[id]?.name ?? '')
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const hasNegativeEffect = (bot, mcData) => Object.keys(bot.entity?.effects ?? {})
  .some(id => negative.has(effectName(mcData, id)));

export async function run({ bot, mcData }, { itemName: requested }, signal) {
  if (requested === 'milk_bucket') {
    if (!hasNegativeEffect(bot, mcData)) throw new Error('no_bad_effect');
    const milk = bot.inventory.items().find(item => item.name === 'milk_bucket');
    if (!milk) throw new Error('no_food');
    const stop = () => { try { bot.deactivateItem(); } catch {} };
    await step(signal, () => bot.equip(milk, 'hand'), stop);
    checkSignal(signal);
    await step(signal, () => bot.consume(), stop);
    return { itemName: 'milk_bucket' };
  }
  const foodBefore = bot.food;
  const chosen = selectFood(bot, mcData, requested);
  const stop = () => { try { bot.deactivateItem(); } catch {} };
  await step(signal, () => bot.equip(chosen.item, 'hand'), stop);
  checkSignal(signal);
  await step(signal, () => bot.consume(), stop);
  return { itemName: chosen.name, foodBefore, foodAfter: bot.food };
}
