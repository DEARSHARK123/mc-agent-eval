import { checkSignal, point, positionResult } from './helpers.js';

export const name = 'findBlock';
export const description = 'Find the nearest matching block, or return null. Optional integer x/y/z '
  + 're-center the search on a bound position (default: hers); the center must stay within 32 blocks.';
export const params = {
  blockName: { type: 'string', required: true, minLength: 1, catalog: 'blocksByName' },
  maxDistance: { type: 'number', exclusiveMin: 0, default: 32 },
  // P2 B: optional search-center override — all three or none, enforced at
  // validation; this is also what `at` merges into.
  x: { type: 'number', integer: true },
  y: { type: 'number', integer: true },
  z: { type: 'number', integer: true },
};
export const defaultTimeoutMs = 5_000;

export const LOG_NAME = /(?:_log|_stem)$/u;
const LEAF_RANGE = 3;

// Only logs crowned by natural (persistent=false) leaves count: a placed log
// house or player-built stem column never does. Unreadable properties fail safe.
export function naturalLog(bot, position) {
  for (let dx = -LEAF_RANGE; dx <= LEAF_RANGE; dx++) {
    for (let dy = -LEAF_RANGE; dy <= LEAF_RANGE; dy++) {
      for (let dz = -LEAF_RANGE; dz <= LEAF_RANGE; dz++) {
        const leaf = bot.blockAt(position.offset(dx, dy, dz));
        if (!leaf || !leaf.name.endsWith('_leaves')) continue;
        try {
          if (leaf.getProperties?.().persistent === false) return true;
        } catch {}
      }
    }
  }
  return false;
}

export function run({ bot, mcData, protection }, { blockName, maxDistance, x, y, z }, signal) {
  checkSignal(signal);
  const matching = mcData.blocksByName[blockName].id;
  // P2 B: a validated x/y/z triple re-centers the search on that point instead
  // of hers; mineflayer's `point` option defaults to the bot position anyway.
  const center = x === undefined ? null : point({ x, y, z });
  const options = { matching, maxDistance, ...(center ? { point: center } : {}) };
  let positions;
  if (typeof bot.findBlocks === 'function') {
    positions = bot.findBlocks({ ...options, count: 256 });
  } else {
    const block = bot.findBlock(options);
    positions = block ? [block.position] : [];
  }
  const origin = center ?? bot.entity?.position;
  const isLog = LOG_NAME.test(blockName);
  const found = [];
  for (const position of positions ?? []) {
    checkSignal(signal);
    if (protection?.contains({ x: position.x, y: position.y, z: position.z })) continue;
    if (isLog && !naturalLog(bot, position)) continue;
    found.push(position);
  }
  if (origin) found.sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin));
  return found[0] ? positionResult(found[0]) : null;
}
