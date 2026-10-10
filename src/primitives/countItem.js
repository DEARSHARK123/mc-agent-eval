import { checkSignal, itemName } from './helpers.js';

export const name = 'countItem';
export const description = 'Count an item across all inventory stacks.';
export const params = { itemName };
export const defaultTimeoutMs = 2_000;
export function run({ bot, mcData }, { itemName }, signal) {
  checkSignal(signal);
  const type = mcData.itemsByName[itemName].id;
  return bot.inventory.items().filter(item => item.type === type)
    .reduce((total, item) => total + item.count, 0);
}
