import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createPrimitiveRegistry, UnknownPrimitiveError, InvalidParamsError } from '../src/primitives/registry.js';
import { createProtection } from '../src/safety/protection.js';
import { Vec3 } from '../src/primitives/helpers.js';

const mcData = createRequire(import.meta.url)('minecraft-data')('1.20.4');
const OWNER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const QUERY_NAMES = ['pos', 'blockAt', 'findEntity', 'inventory', 'heldItem', 'body'];

function fixture(overrides = {}, options = {}) {
  const bot = new EventEmitter();
  const calls = [];
  const record = (name, result) => (...args) => { calls.push({ name, args }); return result; };
  Object.assign(bot, {
    entity: { id: 1, position: new Vec3(0, 0, 0), onGround: true, effects: {} },
    entities: {},
    inventory: { items: record('items', []), emptySlotCount: record('emptySlotCount', 0) },
    blockAt: record('blockAt', null), findBlock: record('findBlock', null),
    canDigBlock: record('canDigBlock', true), dig: record('dig', Promise.resolve()),
    stopDigging: record('stopDigging'), chat: record('chat'),
    health: 20, food: 17, oxygenLevel: 15, heldItem: null,
  }, overrides);
  const events = [];
  const eventlog = { append(kind, payload, traceId) { events.push({ kind, payload: structuredClone(payload), traceId }); } };
  const registry = createPrimitiveRegistry({ bot, eventlog, mcData, ...options });
  return { bot, calls, events, registry };
}

test('P1 queries: the six free primitives answer from a fake bot', async () => {
  const { registry, calls } = fixture({
    entity: { id: 1, position: new Vec3(1, 2, 3), onGround: true, effects: { 5: { amplifier: 0, duration: 100 } } },
    entities: {
      2: { name: 'zombie', uuid: 'u-far', position: new Vec3(10, 0, 0), isValid: true },
      3: { name: 'zombie', uuid: 'u-near', position: new Vec3(4, 0, 0), isValid: true },
      4: { name: 'creeper', uuid: 'u-other', position: new Vec3(3, 0, 0), isValid: true },
      5: { name: 'zombie', uuid: 'u-gone', position: new Vec3(1, 0, 0), isValid: false },
    },
    inventory: {
      items: () => [{ name: 'stone', count: 64 }, { name: 'oak_log', count: 3 }],
      emptySlotCount: () => 30,
    },
    heldItem: { name: 'iron_sword', count: 1 },
    blockAt: position => (position.x === 9 ? null : { name: 'stone' }),
  });
  assert.deepEqual(await registry.query('pos', {}), { x: 1, y: 2, z: 3 });
  assert.deepEqual(await registry.query('blockAt', { x: 1, y: 0, z: 0 }),
    { x: 1, y: 0, z: 0, blockName: 'stone' });
  assert.deepEqual(await registry.query('blockAt', { x: 9, y: 0, z: 0 }),
    { x: 9, y: 0, z: 0, blockName: 'air' }, 'unloaded cells report air instead of null');
  assert.deepEqual(await registry.query('findEntity', { entityName: 'zombie' }),
    { x: 4, y: 0, z: 0, entityName: 'zombie', uuid: 'u-near' }, 'nearest valid match wins');
  assert.equal(await registry.query('findEntity', { entityName: 'skeleton' }), null);
  assert.equal(await registry.query('findEntity', { entityName: 'zombie', radius: 3 }), null,
    'the radius bound applies');
  assert.deepEqual(await registry.query('inventory', {}),
    { slots: [{ name: 'stone', count: 64 }, { name: 'oak_log', count: 3 }], free: 30 });
  assert.deepEqual(await registry.query('heldItem', {}), { name: 'iron_sword', count: 1 });
  const expected = mcData.effects[5].name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  assert.deepEqual(await registry.query('body', {}),
    { health: 20, food: 17, oxygen: 15, onGround: true, effects: [expected] });
  assert.deepEqual(calls, [], 'queries must not drive mutating bot calls');
});

test('P1 queries: heldItem reports null on an empty hand and queries write no events', async () => {
  const { registry, events } = fixture();
  assert.equal(await registry.query('heldItem', {}), null);
  for (const name of QUERY_NAMES) {
    const input = name === 'blockAt' ? { x: 0, y: 0, z: 0 } : name === 'findEntity' ? { entityName: 'zombie' } : {};
    await registry.query(name, input);
  }
  assert.deepEqual(events.filter(event => event.kind.startsWith('primitive.')), [],
    'registry.query appends no primitive.start/end rows');
  assert.deepEqual(events, [], 'free queries write nothing at all');
});

test('P1 queries: countItem and findBlock are marked free and answer via query()', async () => {
  const { registry } = fixture({
    inventory: { items: () => [
      { type: mcData.itemsByName.oak_planks.id, count: 64 },
      { type: mcData.itemsByName.stone.id, count: 10 },
      { type: mcData.itemsByName.oak_planks.id, count: 12 },
    ] },
    findBlock: () => ({ position: new Vec3(2, 3, 4) }),
  });
  assert.equal(await registry.query('countItem', { itemName: 'oak_planks' }), 76);
  assert.deepEqual(await registry.query('findBlock', { blockName: 'stone' }), { x: 2, y: 3, z: 4 });
  for (const name of [...QUERY_NAMES, 'countItem', 'findBlock']) {
    assert.equal(registry.describe(name).free, true, `${name} is described as free`);
  }
  assert.equal(registry.describe('dig').free, undefined, 'non-free primitives carry no flag');
});

test('P1 queries: only free primitives may be queried and params still validate', async () => {
  const { registry } = fixture();
  for (const name of ['dig', 'say', 'goTo']) {
    await assert.rejects(() => registry.query(name, {}), error =>
      error instanceof InvalidParamsError && error.code === 'not_queryable',
    `${name} must not be queryable`);
  }
  // Even when enabled, command is an action, not a free query.
  const withCommands = fixture({}, { commands: true });
  await assert.rejects(() => withCommands.registry.query('command', {}), error =>
    error instanceof InvalidParamsError && error.code === 'not_queryable');
  await assert.rejects(() => registry.query('fly', {}), UnknownPrimitiveError);
  await assert.rejects(() => registry.query('findEntity', { entityName: 'zombie', radius: 40 }), error =>
    error instanceof InvalidParamsError && error.field === 'radius', 'radius is capped at 32');
  await assert.rejects(() => registry.query('findEntity', { entityName: 'not_a_mob' }), InvalidParamsError);
  await assert.rejects(() => registry.query('blockAt', { x: 1.5, y: 0, z: 0 }), InvalidParamsError);
});

test('P1 ambit: world-mutating targets beyond 32 blocks are rejected out_of_ambit', async () => {
  const { registry, calls } = fixture();
  assert.throws(() => registry.run('dig', { x: 35, y: 0, z: 0 }),
    error => error.code === 'out_of_ambit');
  assert.throws(() => registry.run('place', { itemName: 'oak_planks', x: 0, y: 0, z: 33 }),
    error => error.code === 'out_of_ambit');
  // Inside the ambit the tighter dig reach (4.5) still binds first.
  const reach = await registry.run('dig', { x: 5, y: 0, z: 0 });
  assert.equal(reach.ok, false);
  assert.equal(reach.error.code, 'out_of_reach');
  assert.equal(calls.some(call => call.name === 'dig'), false);
});

test('P1 ambit: entity-targeted primitives resolve positions from bot.entities', async () => {
  const far = fixture({
    entities: { 2: { name: 'zombie', type: 'hostile', uuid: 'u-z', position: new Vec3(40, 0, 0), isValid: true } },
  });
  assert.throws(() => far.registry.run('attack', { entityName: 'zombie' }),
    error => error.code === 'out_of_ambit');
  // Within the ambit the primitive's own target rules take over (attack reach is 16).
  const near = fixture({
    entities: { 2: { name: 'zombie', type: 'hostile', uuid: 'u-z', position: new Vec3(20, 0, 0), isValid: true } },
  });
  const inside = await near.registry.run('attack', { entityName: 'zombie' });
  assert.equal(inside.ok, false);
  assert.match(inside.error.message, /target_not_found/);
  // give resolves the owner entity the same way follow does.
  const owned = fixture({
    entities: { 9: { name: 'Alex', type: 'player', uuid: OWNER, position: new Vec3(40, 0, 0), isValid: true } },
  }, { ownerUuid: OWNER });
  assert.throws(() => owned.registry.run('give', { itemName: 'stone' }),
    error => error.code === 'out_of_ambit');
  const close = fixture({
    entities: { 9: { name: 'Alex', type: 'player', uuid: OWNER, position: new Vec3(2, 0, 0), isValid: true } },
  }, { ownerUuid: OWNER });
  assert.doesNotThrow(() => close.registry.validate('give', { itemName: 'stone' }),
    'a nearby owner is not blocked by the backstop');
});

test('P1 command: whitelisted targets inside a protection zone are rejected', async () => {
  const eventlog = { append() {}, query: () => [] };
  const protection = createProtection({ eventlog });
  protection.add({ x: 10, y: 0, z: 0, radius: 3, reason: 'owner' });
  const { registry, calls } = fixture({
    blockAt: () => ({ name: 'light_blue_stained_glass' }),
  }, { commands: true, protection });
  assert.throws(() => registry.run('command',
    { kind: 'setblock', marker: 'light_blue_stained_glass', from: { x: 10, y: 0, z: 0 } }),
    error => error.code === 'protected');
  // A fill whose corners sit outside still rejects when the box encloses the zone.
  assert.throws(() => registry.run('command',
    { kind: 'fill', marker: 'light_blue_stained_glass', from: { x: 8, y: -1, z: -1 }, to: { x: 12, y: 1, z: 1 } }),
    error => error.code === 'protected');
  const placed = await registry.run('command',
    { kind: 'setblock', marker: 'light_blue_stained_glass', from: { x: 20, y: 0, z: 0 } });
  assert.equal(placed.ok, true);
  assert.equal(placed.result.placed, true);
  assert.deepEqual(calls.map(call => call.args[0]), ['/setblock 20 0 0 light_blue_stained_glass keep']);
});
