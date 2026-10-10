import { createRequire } from 'node:module';
import { PLANT_NAMES } from '../build/site.js';

const require = createRequire(import.meta.url);

// Blocks the pathfinder may break to open a way: natural terrain only, so a
// goTo can never chew through the owner's walls, fences or a protected zone.
export const NATURAL_BREAKABLE = [
  'dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mud',
  'sand', 'red_sand', 'gravel', 'clay',
  'stone', 'deepslate', 'granite', 'diorite', 'andesite', 'tuff', 'calcite',
  'netherrack',
  'snow', 'snow_block',
];

export const naturalBlockName = name => typeof name === 'string'
  && (NATURAL_BREAKABLE.includes(name) || name.endsWith('_leaves') || PLANT_NAMES.includes(name));

const DANGEROUS = ['magma_block', 'campfire', 'soul_campfire', 'sweet_berry_bush',
  'powder_snow', 'cobweb', 'wither_rose', 'fire', 'soul_fire', 'lava'];

export function createSafeMovements(bot, { protection, mcData } = {}) {
  const Movements = require('mineflayer-pathfinder').Movements;
  const movements = new Movements(bot);
  const data = mcData ?? bot.registry;
  const natural = new Set();
  for (const name of [...NATURAL_BREAKABLE, ...PLANT_NAMES]) {
    const id = data.blocksByName?.[name]?.id;
    if (id !== undefined) natural.add(id);
  }
  for (const [name, block] of Object.entries(data.blocksByName ?? {})) {
    if (name.endsWith('_leaves')) natural.add(block.id);
  }
  for (const block of data.blocksArray ?? []) {
    if (!natural.has(block.id)) movements.blocksCantBreak.add(block.id);
  }
  const inside = block => protection?.contains?.(block.position) ? Infinity : 0;
  movements.exclusionAreasBreak.push(inside);
  movements.exclusionAreasPlace.push(inside);
  movements.allowParkour = false;
  movements.maxDropDown = 3;
  for (const name of DANGEROUS) {
    const id = data.blocksByName?.[name]?.id;
    if (id !== undefined) movements.blocksToAvoid.add(id);
  }
  return movements;
}
