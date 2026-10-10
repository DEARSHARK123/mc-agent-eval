import { codedError, itemName, step } from './helpers.js';
export const name = 'equip';
export const description = 'Equip an inventory item in the requested slot.';
export const params = { itemName, slot: { type: 'string', enum: ['hand', 'head', 'torso', 'legs', 'feet', 'off-hand'], default: 'hand' } };
export const defaultTimeoutMs = 5000;
const MAX_ATTEMPTS = 3;
export async function run({ bot, mcData }, { itemName, slot }, signal) {
  const type = mcData.itemsByName[itemName].id;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Re-resolve every attempt: pickups can shift stacks server-side, and equipping
    // a stale Item switches the hand to a now-empty slot while still reporting ok
    // (observed on the real server: equip ok, then digs ran bare-handed).
    const item = bot.inventory.items().find(i => i.type === type);
    if (!item) throw new Error(`Item not in inventory: ${itemName}`);
    await step(signal, () => bot.equip(item, slot));
    // 'hand' equips only switch the quick-bar, so the held stack is observable;
    // the other destinations go through window clicks we cannot cheaply verify here.
    if (slot !== 'hand' || bot.heldItem?.type === type) return { itemName, slot };
  }
  throw codedError('equip_failed', `Equip of ${itemName} did not take effect after ${MAX_ATTEMPTS} attempts`);
}
