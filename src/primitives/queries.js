import { blockCoordinates, checkSignal, point, positionResult } from './helpers.js';

// P1 §1 free query primitives: side-effect-free reads over the live bot state.
// All are `free: true` — registry.query() validates them through the shared
// checked() path and runs them directly (no arbiter task, no primitive.start/end
// rows, no cost), and programs may bind their results to ids like any primitive.
const TIMEOUT_MS = 2_000;

// entity.effects keys are numeric effect ids and minecraft-data names them
// PascalCase (MiningFatigue -> mining_fatigue); same mapping as eat.js.
const effectName = (mcData, id) => (mcData.effects?.[id]?.name ?? mcData.effectsById?.[id]?.name ?? '')
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

export const pos = Object.freeze({
  name: 'pos',
  description: 'Return her current position.',
  params: {},
  defaultTimeoutMs: TIMEOUT_MS,
  free: true,
  run({ bot }, params, signal) {
    checkSignal(signal);
    const position = bot?.entity?.position;
    return position ? positionResult(position) : null;
  },
});

export const blockAt = Object.freeze({
  name: 'blockAt',
  description: 'Return the block name at a position, air when unloaded or empty.',
  params: blockCoordinates,
  defaultTimeoutMs: TIMEOUT_MS,
  free: true,
  run({ bot }, { x, y, z }, signal) {
    checkSignal(signal);
    let blockName = 'air';
    try { blockName = bot?.blockAt?.(point({ x, y, z }))?.name ?? 'air'; } catch {}
    return { x, y, z, blockName };
  },
});

export const findEntity = Object.freeze({
  name: 'findEntity',
  description: 'Return the nearest visible entity with the given Minecraft entity name, or null. '
    + 'Optional integer x/y/z re-center the search on a bound position (default: hers); '
    + 'the center must stay within 32 blocks.',
  params: {
    entityName: { type: 'string', required: true, minLength: 1, catalog: 'entitiesByName' },
    radius: { type: 'number', exclusiveMin: 0, max: 32, default: 32 },
    // P2 B: optional search-center override — all three or none, enforced at
    // validation; this is also what `at` merges into.
    x: { type: 'number', integer: true },
    y: { type: 'number', integer: true },
    z: { type: 'number', integer: true },
  },
  defaultTimeoutMs: TIMEOUT_MS,
  free: true,
  run({ bot }, { entityName, radius, x, y, z }, signal) {
    checkSignal(signal);
    // P2 B: a validated x/y/z triple re-centers the search on that point.
    const origin = x === undefined ? bot?.entity?.position : { x, y, z };
    if (!origin) return null;
    let best = null;
    let bestDistance = Infinity;
    for (const entity of Object.values(bot?.entities ?? {})) {
      if (entity?.name !== entityName || entity.isValid === false || !entity.position) continue;
      const distance = Math.hypot(entity.position.x - origin.x,
        entity.position.y - origin.y, entity.position.z - origin.z);
      if (distance <= radius && distance < bestDistance) {
        best = entity;
        bestDistance = distance;
      }
    }
    if (!best) return null;
    return { ...positionResult(best.position), entityName: best.name, uuid: best.uuid };
  },
});

export const inventory = Object.freeze({
  name: 'inventory',
  description: 'Return the inventory stacks and the free slot count.',
  params: {},
  defaultTimeoutMs: TIMEOUT_MS,
  free: true,
  run({ bot }, params, signal) {
    checkSignal(signal);
    const slots = (bot?.inventory?.items?.() ?? [])
      .map(item => ({ name: item.name, count: item.count }));
    const free = typeof bot?.inventory?.emptySlotCount === 'function'
      ? bot.inventory.emptySlotCount() : null;
    return { slots, free };
  },
});

export const heldItem = Object.freeze({
  name: 'heldItem',
  description: 'Return the currently held item, or null.',
  params: {},
  defaultTimeoutMs: TIMEOUT_MS,
  free: true,
  run({ bot }, params, signal) {
    checkSignal(signal);
    const item = bot?.heldItem;
    return item ? { name: item.name, count: item.count } : null;
  },
});

export const body = Object.freeze({
  name: 'body',
  description: 'Return health, food, oxygen, ground contact and active effect names.',
  params: {},
  defaultTimeoutMs: TIMEOUT_MS,
  free: true,
  run({ bot, mcData }, params, signal) {
    checkSignal(signal);
    const entity = bot?.entity;
    return {
      health: bot?.health ?? null,
      food: bot?.food ?? null,
      oxygen: bot?.oxygenLevel ?? null,
      onGround: entity?.onGround ?? null,
      effects: Object.keys(entity?.effects ?? {})
        .map(id => effectName(mcData, id))
        .filter(Boolean),
    };
  },
});

export const queryPrimitives = Object.freeze([pos, blockAt, findEntity, inventory, heldItem, body]);
