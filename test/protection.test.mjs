import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Vec3 } from '../src/primitives/helpers.js';
import { createProtection } from '../src/safety/protection.js';
import { createPrimitiveRegistry, InvalidParamsError } from '../src/primitives/registry.js';
import { BLUEPRINTS } from '../src/build/blueprints.js';
import { findSite } from '../src/build/site.js';

const mcData = createRequire(import.meta.url)('minecraft-data')('1.20.4');
const flatWorld = () => (x, y, z) => {
  const name = y < 0 ? 'grass_block' : 'air';
  return { name, boundingBox: name === 'air' ? 'empty' : 'block' };
};

function log(rows = []) {
  return {
    rows,
    append(kind, payload, traceId) { rows.push({ kind, payload: structuredClone(payload), traceId }); },
    query({ kind, limit = Number.MAX_SAFE_INTEGER } = {}) {
      return rows.filter(row => kind === undefined || row.kind === kind).slice(0, limit);
    },
  };
}

test('zones add, validate, cap at 32, are spherical and survive a reload', () => {
  const eventlog = log();
  const protection = createProtection({ eventlog });
  assert.equal(protection.add({ x: 0, y: 64, z: 0, radius: 12, reason: 'owner' }, 'tr') !== null, true);
  assert.equal(protection.contains({ x: 12, y: 64, z: 0 }), true, 'radius is inclusive');
  assert.equal(protection.contains({ x: 12.1, y: 64, z: 0 }), false);
  assert.equal(protection.contains({ x: 0, y: 64, z: -12 }), true);
  for (const bad of [null, {}, { x: 0, y: 64, z: 0, radius: 0, reason: 'owner' },
    { x: 0, y: 64, z: 0, radius: 25, reason: 'owner' }, { x: 0, y: 64, z: 0, radius: 5 },
    { x: 'a', y: 64, z: 0, radius: 5, reason: 'owner' }]) {
    assert.equal(protection.add(bad), null, JSON.stringify(bad));
  }
  for (let i = 0; i < 40; i++) protection.add({ x: 1000 + i * 60, y: 64, z: 0, radius: 1, reason: 'owner' });
  assert.equal(protection.zones().length, 32);
  const zones = protection.zones();
  zones[0].radius = 999;
  assert.equal(protection.zones()[0].radius, 12, 'zones() returns copies');
  const row = eventlog.rows.find(r => r.kind === 'protection.zone_added');
  assert.deepEqual(row.payload, { x: 0, y: 64, z: 0, radius: 12, reason: 'owner' });
  assert.equal(row.traceId, 'tr');
  const reloaded = createProtection({ eventlog: log(eventlog.rows) });
  assert.equal(reloaded.contains({ x: 5, y: 64, z: 0 }), true, 'zones persist across restarts');
  assert.equal(reloaded.zones().length, 32);
  const corrupt = log([{ kind: 'protection.zone_added', payload: { x: 1, radius: 'x' } }]);
  assert.equal(createProtection({ eventlog: corrupt }).zones().length, 0);
});

test('intersects is an inclusive box test and own_build can be allowed', () => {
  const protection = createProtection({ eventlog: log() });
  protection.add({ x: 0, y: 64, z: 0, radius: 12, reason: 'owner' });
  protection.add({ x: 100, y: 64, z: 0, radius: 5, reason: 'own_build' });
  assert.equal(protection.intersects({ from: { x: 10, y: 64, z: -2 }, to: { x: 14, y: 66, z: 2 } }), true);
  assert.equal(protection.intersects({ from: { x: 13, y: 64, z: -2 }, to: { x: 17, y: 66, z: 2 } }), false);
  assert.equal(protection.intersects({ from: { x: 98, y: 64, z: -2 }, to: { x: 102, y: 66, z: 2 } }), true);
  assert.equal(protection.intersects({ from: { x: 98, y: 64, z: -2 }, to: { x: 102, y: 66, z: 2 } },
    { allow: ['own_build'] }), false);
});

function digFixture(protection) {
  const bot = new EventEmitter();
  const calls = [];
  Object.assign(bot, {
    entity: { position: new Vec3(0, 0, 0), onGround: true }, entities: {},
    dig: (...args) => { calls.push(['dig', ...args]); return Promise.resolve(); },
    canDigBlock: () => true,
    blockAt: pos => ({ name: 'stone', position: pos }),
    findBlock: () => null,
    inventory: { items: () => [] },
  });
  const registry = createPrimitiveRegistry({ bot, eventlog: log(), mcData, protection });
  return { bot, calls, registry };
}

test('registry dig is rejected inside a zone before bot.dig and works outside', async () => {
  const protection = createProtection({ eventlog: log() });
  protection.add({ x: 50, y: 0, z: 0, radius: 5, reason: 'owner' });
  const { calls, registry } = digFixture(protection);
  assert.throws(() => registry.run('dig', { x: 50, y: 0, z: 0 }),
    error => error instanceof InvalidParamsError && error.message.includes('protected'));
  assert.equal(calls.length, 0, 'bot.dig was never called');
  const free = await registry.run('dig', { x: 1, y: 0, z: 0 });
  assert.equal(free.ok, true);
  assert.equal(calls.length, 1, 'outside the zone digs normally');
  const open = digFixture(null);
  await open.registry.run('dig', { x: 1, y: 0, z: 0 });
  assert.equal(open.calls.length, 1, 'no protection means no restriction');
});

function findBlockFixture(positions, blocks = new Map(), protection = null) {
  const bot = new EventEmitter();
  Object.assign(bot, {
    entity: { position: new Vec3(0, 64, 0) }, entities: {},
    findBlocks: () => positions,
    blockAt: pos => blocks.get(`${pos.x},${pos.y},${pos.z}`) ?? { name: 'air' },
    inventory: { items: () => [] },
  });
  const registry = createPrimitiveRegistry({ bot, eventlog: log(), mcData, protection });
  return { bot, registry };
}

test('findBlock skips protected candidates and returns the nearest free one', async () => {
  const protection = createProtection({ eventlog: log() });
  protection.add({ x: 3, y: 64, z: 0, radius: 4, reason: 'owner' });
  const { registry } = findBlockFixture([new Vec3(3, 64, 0), new Vec3(9, 64, 0)], new Map(), protection);
  assert.deepEqual((await registry.run('findBlock', { blockName: 'stone' })).result, { x: 9, y: 64, z: 0 });
});

test('findBlock only returns logs crowned by natural leaves', async () => {
  const natural = new Map([['10,65,0', { name: 'oak_leaves', getProperties: () => ({ persistent: false }) }]]);
  const { registry } = findBlockFixture([new Vec3(3, 64, 0), new Vec3(10, 64, 0)], natural);
  assert.deepEqual((await registry.run('findBlock', { blockName: 'oak_log' })).result, { x: 10, y: 64, z: 0 },
    'the bare log column (a house wall) is skipped, the tree log is not');
  const placed = findBlockFixture([new Vec3(4, 64, 0)],
    new Map([['5,65,0', { name: 'oak_leaves', getProperties: () => ({ persistent: true }) }]]));
  assert.equal((await placed.registry.run('findBlock', { blockName: 'oak_log' })).result, null,
    'player-placed leaves (persistent=true) do not make a log natural');
  const opaque = findBlockFixture([new Vec3(4, 64, 0)],
    new Map([['5,65,0', { name: 'oak_leaves', getProperties: () => { throw new Error('nope'); } }]]));
  assert.equal((await opaque.registry.run('findBlock', { blockName: 'oak_log' })).result, null,
    'unreadable properties fail safe');
  const stem = findBlockFixture([new Vec3(4, 64, 0)],
    new Map([['5,65,0', { name: 'oak_leaves', getProperties: () => ({ persistent: false }) }]]));
  assert.deepEqual((await stem.registry.run('findBlock', { blockName: 'crimson_stem' })).result, { x: 4, y: 64, z: 0 },
    'the same rule covers *_stem');
  const stone = findBlockFixture([new Vec3(4, 64, 0)]);
  assert.deepEqual((await stone.registry.run('findBlock', { blockName: 'stone' })).result, { x: 4, y: 64, z: 0 },
    'non-log blocks need no leaves');
});

test('findSite rejects volumes overlapping a zone but allows a resumed own_build', () => {
  const hut = BLUEPRINTS.hut;
  const protection = createProtection({ eventlog: log() });
  protection.add({ x: 0, y: 0, z: 0, radius: 12, reason: 'owner' });
  const site = findSite({ blueprint: hut, origin: { x: 0, y: 0, z: 0 }, blockAt: flatWorld(), protection });
  assert.equal(site.ok, true);
  for (const cell of [{ x: site.origin.x, y: site.origin.y, z: site.origin.z },
    { x: site.origin.x + 4, y: site.origin.y + 2, z: site.origin.z + 4 }]) {
    assert.equal(protection.contains({ x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 }), false,
      `site cell ${JSON.stringify(cell)} overlaps the zone`);
  }
  const walled = createProtection({ eventlog: log() });
  walled.add({ x: 0, y: 0, z: 0, radius: 24, reason: 'owner' });
  assert.deepEqual(findSite({ blueprint: hut, origin: { x: 0, y: 0, z: 0 }, blockAt: flatWorld(),
    radius: 4, protection: walled }), { ok: false, reason: 'no_site' });
  const own = createProtection({ eventlog: log() });
  own.add({ x: 8, y: 0, z: 8, radius: 5, reason: 'own_build' });
  const resumed = findSite({ blueprint: hut, origin: { x: 0, y: 0, z: 0 }, blockAt: flatWorld(),
    remembered: { origin: { x: 6, y: 0, z: 6 }, rotation: 1 }, protection: own });
  assert.equal(resumed.resumed, true, 'a resumed site may sit inside its own_build zone');
  const blocked = findSite({ blueprint: hut, origin: { x: 0, y: 0, z: 0 }, blockAt: flatWorld(),
    remembered: { origin: { x: 6, y: 0, z: 6 }, rotation: 1 },
    protection: createProtection({ eventlog: log([{ kind: 'protection.zone_added',
      payload: { x: 8, y: 0, z: 8, radius: 5, reason: 'owner' } }]) }) });
  assert.equal(blocked.resumed, false, 'a remembered site inside somebody else zone is skipped');
});

test('a finished build registers its own_build zone', async () => {
  const eventlog = log();
  const protection = createProtection({ eventlog });
  const { createBuilder } = await import('../src/build/builder.js');
  const { createArbiter } = await import('../src/arbiter.js');
  const world = new Map();
  const key = p => `${p.x},${p.y},${p.z}`;
  const read = (x, y, z) => world.get(key({ x, y, z })) ?? (y < 0 ? 'grass_block' : 'air');
  const inventory = { oak_planks: 60 };
  const bot = { entity: { position: new Vec3(0.5, 0, 0.5) },
    inventory: { items: () => Object.entries(inventory).filter(([, n]) => n > 0).map(([name, count]) => ({ name, count })) },
    blockAt: pos => { const name = read(pos.x, pos.y, pos.z); return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: pos }; } };
  const registry = { has: () => false, run: async (name, params) => {
    if (name === 'goTo') bot.entity.position = new Vec3(params.x + 0.5, params.y, params.z + 0.5);
    if (name === 'place') { inventory[params.itemName]--; world.set(key(params), params.itemName); }
    return { ok: true, result: {} };
  } };
  const builder = createBuilder({ registry, arbiter: createArbiter({ registry, eventlog }), bot, mcData,
    goals: { preferredLog: () => 'oak_log', obtainInline: async () => ({ status: 'succeeded' }) },
    eventlog, protection });
  const result = await builder.build({ blueprint: 'hut' }).done;
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  const zones = protection.zones();
  assert.equal(zones.length, 1);
  assert.equal(zones[0].reason, 'own_build');
  assert.equal(zones[0].radius, 5);
  assert.deepEqual({ x: zones[0].x, y: zones[0].y, z: zones[0].z },
    { x: result.site.origin.x + 2, y: result.site.origin.y, z: result.site.origin.z + 2 });
});

test('e2e.mjs wires the v1 scenario, enables every subsystem and reads stdin stop', () => {
  const source = readFileSync(new URL('../scripts/e2e.mjs', import.meta.url), 'utf8');
  assert.match(source, /E2E_SCENARIO[^]*'v1'/u);
  assert.match(source, /scenario === 'v1' && !v1Environment/u);
  assert.match(source, /LEARNING_AUTONOMY: \['jev', 'goals', 'proactive', 'v1'\]/u);
  assert.match(source, /SURVIVAL: \['survival', 'v1', 'edges', 'stance'\]/u);
  assert.match(source, /PROACTIVE: \['proactive', 'v1'\]/u);
  assert.match(source, /COMMANDS: \['commands', 'build', 'v1'\]/u);
  assert.match(source, /E2E_STDIN_STOP === '1'[^]*cleanupOnce\(\)/u);
  assert.match(source, /runV1Scenario\(\{[^]*restart:/u);
});

test('collect candidates never offer a protected block or a non-natural log', async () => {
  const { generateCandidates } = await import('../src/decision/stepper.js');
  const protection = createProtection({ eventlog: log() });
  protection.add({ x: 3, y: 64, z: 0, radius: 4, reason: 'owner' });
  const blocks = [new Vec3(3, 64, 0), new Vec3(-5, 64, 0), new Vec3(9, 64, 0)];
  const names = new Map([['3,64,0', 'oak_log'], ['-5,64,0', 'oak_log'], ['9,64,0', 'oak_log']]);
  const leaves = new Map([['9,65,0', { name: 'oak_leaves', getProperties: () => ({ persistent: false }) }]]);
  const bot = { entity: { position: new Vec3(0, 64, 0) }, entities: {},
    findBlocks: () => blocks,
    blockAt: pos => leaves.get(`${pos.x},${pos.y},${pos.z}`) ?? { name: names.get(`${pos.x},${pos.y},${pos.z}`) ?? 'air' },
    inventory: { items: () => [], emptySlotCount: () => 10 } };
  const intent = { target: { blocks: ['oak_log'], item: 'oak_log' }, allowed: ['findBlock', 'goTo', 'dig', 'collectDrops'] };
  const candidates = generateCandidates({ bot, intent, mcData, protection });
  const offered = candidates.filter(c => c.key.startsWith('dig_block') || c.key.startsWith('goto_block'))
    .map(c => c.params);
  assert.deepEqual(offered.map(p => ({ x: p.x, y: p.y, z: p.z })), [{ x: 9, y: 64, z: 0 }],
    'protected log and the leafless house log are never offered');
  const open = generateCandidates({ bot, intent, mcData, protection: null });
  const openBlocks = open.filter(c => c.key.startsWith('dig_block') || c.key.startsWith('goto_block'));
  assert.equal(openBlocks.length, 1, 'without protection only the natural log is offered');
});
