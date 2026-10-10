import { createRequire } from 'node:module';
import { itemNames } from './itemNames.js';

const require = createRequire(import.meta.url);
export const mcData = require('minecraft-data')('1.20.4');

const aliases = new Map([
  ['木板', 'oak_planks'], ['橡木木板', 'oak_planks'], ['planks', 'oak_planks'],
  ['plank', 'oak_planks'], ['oak planks', 'oak_planks'],
  ['原木', 'oak_log'], ['木头', 'oak_log'], ['log', 'oak_log'], ['logs', 'oak_log'],
  ['工作台', 'crafting_table'], ['crafting table', 'crafting_table'],
  ['木棍', 'stick'], ['棍子', 'stick'], ['stick', 'stick'], ['sticks', 'stick'],
  ['箱子', 'chest'], ['chest', 'chest'], ['chests', 'chest'],
  ['火把', 'torch'], ['torch', 'torch'], ['torches', 'torch'],
  ['草方块', 'grass_block'], ['泥土', 'dirt'], ['石头', 'stone'], ['圆石', 'cobblestone'],
  ['沙子', 'sand'], ['沙砾', 'gravel'], ['橡木原木', 'oak_log'], ['树叶', 'oak_leaves'],
]);
for (const [name, item] of itemNames) if (!aliases.has(name)) aliases.set(name, item);

const displayNames = new Map([
  ['crafting_table', '工作台'], ['oak_planks', '木板'], ['oak_log', '原木'],
  ['stick', '木棍'], ['chest', '箱子'], ['torch', '火把'],
  ['grass_block', '草方块'], ['dirt', '泥土'], ['stone', '石头'], ['cobblestone', '圆石'],
  ['sand', '沙子'], ['gravel', '沙砾'], ['oak_leaves', '树叶'],
]);
for (const [name, item] of itemNames) if (!displayNames.has(item)) displayNames.set(item, name);

export function displayName(itemName) {
  return displayNames.get(itemName) ?? itemName;
}

export function resolveItem(text) {
  if (typeof text !== 'string') return null;
  const name = text.trim().toLowerCase().replace(/\s+/g, ' ');
  // T29 A5: model output sometimes arrives namespaced; `minecraft:` is the
  // only namespace this lexicon resolves.
  const bare = name.startsWith('minecraft:') ? name.slice('minecraft:'.length) : name;
  const item = aliases.get(bare) ?? bare;
  return Object.hasOwn(mcData.itemsByName, item) || Object.hasOwn(mcData.blocksByName, item) ? item : null;
}

// T29 A3: the catalog names a message talks about — alias keys found as
// substrings plus ascii tokens resolved against items/blocks/entities. Used to
// build a task-relevant name slice for the teach prompt.
export function resolveNamesInText(text) {
  if (typeof text !== 'string') return [];
  const lower = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const found = new Set();
  for (const key of aliases.keys()) {
    // Single-word ascii keys are covered by the token pass below; phrases and
    // non-ascii keys need a substring check.
    if (!/^[a-z0-9_]+$/u.test(key) && lower.includes(key)) {
      const item = resolveItem(key);
      if (item) found.add(item);
    }
  }
  for (const token of lower.match(/[a-z][a-z0-9_]*/gu) ?? []) {
    const item = resolveItem(token);
    if (item) found.add(item);
    else if (Object.hasOwn(mcData.entitiesByName ?? {}, token)) found.add(token);
  }
  return [...found];
}

// Goals may only name items; block-only names stay unknown rather than guessed.
export function resolveGoalItem(text) {
  const item = resolveItem(text);
  return item && Object.hasOwn(mcData.itemsByName, item) ? item : null;
}

export function validateTeaching(value, allowedItems = Object.keys(mcData.itemsByName)) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = new Set(Array.from(allowedItems, resolveItem).filter(Boolean));
  const item = resolveItem(value.item);
  if (!item || !allowed.has(item) || !Array.isArray(value.ingredients) ||
      value.ingredients.length === 0 || value.ingredients.length > 32) return null;
  const ingredients = [];
  for (const ingredient of value.ingredients) {
    const name = resolveItem(ingredient?.item);
    if (!name || !allowed.has(name) || !Number.isSafeInteger(ingredient.count) || ingredient.count < 1) {
      return null;
    }
    ingredients.push({ item: name, count: ingredient.count });
  }
  return { item, ingredients };
}
