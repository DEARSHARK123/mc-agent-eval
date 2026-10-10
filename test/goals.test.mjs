import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from '../src/primitives/helpers.js';
import { createPrimitiveRegistry } from '../src/primitives/registry.js';
import { createProtection } from '../src/safety/protection.js';
import { createBodySensors } from '../src/body/sensors.js';
import { createSafeMovements, NATURAL_BREAKABLE, naturalBlockName } from '../src/body/movements.js';
import { unsafeReason } from '../src/primitives/dig.js';
import { decide } from '../src/survival/decide.js';
import { createSurvival } from '../src/survival/index.js';
import { generateCandidates } from '../src/decision/stepper.js';

const require = createRequire(import.meta.url);
const mcData = require('minecraft-data')('1.20.4');
const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function botFixture(overrides = {}) {
  const bot = new EventEmitter();
  bot.entity = { id: 1, position: new Vec3(0, 0, 0), onGround: true, effects: {} };
  bot.entities = {};
  bot.blocks = new Map();
  bot.blockAt = p => bot.blocks.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? null;
  bot.setBlock = (x, y, z, block) => bot.blocks.set(`${x},${y},${z}`, { position: new Vec3(x, y, z), boundingBox: 'block', diggable: true, getProperties: () => ({}), ...block });
  bot._client = new EventEmitter();
  Object.assign(bot, overrides);
  return bot;
}

const eventsOf = () => {
  const events = [];
  return { events, eventlog: { append: (kind, payload) => events.push({ kind, payload }) } };
};

test('movements: non-natural blocks are unbreakable, zones cost Infinity, parkour off', () => {
  const protection = createProtection();
  const bot = botFixture({ registry: mcData });
  const mv = createSafeMovements(bot, { protection, mcData });
  assert.equal(mv.allowParkour, false);
  assert.equal(mv.maxDropDown, 3);
  for (const name of NATURAL_BREAKABLE) {
    const id = mcData.blocksByName[name]?.id;
    assert.equal(mv.blocksCantBreak.has(id), false, `${name} should stay breakable`);
  }
  for (const name of ['oak_planks', 'chest', 'fence', 'oak_log', 'cobblestone', 'obsidian', 'glass', 'iron_block']) {
    const id = mcData.blocksByName[name]?.id;
    if (id !== undefined) assert.equal(mv.blocksCantBreak.has(id), true, `${name} must be unbreakable`);
  }
  assert.equal(mv.blocksCantBreak.has(mcData.blocksByName.oak_leaves.id), false);
  protection.add({ x: 10, y: 0, z: 10, radius: 4, reason: 'owner' });
  const inside = { position: new Vec3(10, 0, 10) };
  const outside = { position: new Vec3(100, 0, 100) };
  assert.equal(mv.exclusionBreak(inside), Infinity);
  assert.equal(mv.exclusionPlace(inside), Infinity);
  assert.equal(mv.exclusionBreak(outside), 0);
  assert.ok(mv.blocksToAvoid.has(mcData.blocksByName.magma_block.id));
  assert.equal(naturalBlockName('oak_leaves'), true);
  assert.equal(naturalBlockName('oak_log'), false);
});

test('protection.onChange fires on add so movements can be re-applied', () => {
  const protection = createProtection();
  let calls = 0;
  protection.onChange(() => calls++);
  protection.add({ x: 0, y: 0, z: 0, radius: 2, reason: 'owner' });
  assert.equal(calls, 1);
});

test('dig: unsafe_below / liquid_adjacent / falling_above reject at submission', () => {
  const bot = botFixture();
  const registry = createPrimitiveRegistry({ bot, eventlog: eventsOf().eventlog, mcData });
  const digCalls = [];
  bot.dig = (...args) => { digCalls.push(args); return Promise.resolve(); };
  bot.entity.position = new Vec3(5, 10, 5);
  const rejects = (x, y, z, why) => assert.throws(() => registry.validate('dig', { x, y, z }), new RegExp(why));
  rejects(5, 9, 5, 'unsafe_below');              // the block under her feet
  bot.setBlock(6, 10, 6, { name: 'lava' });      // lava beside the target
  rejects(5, 10, 6, 'liquid_adjacent');
  bot.blocks.clear();
  bot.setBlock(5, 13, 5, { name: 'gravel' });    // gravity block above a block over her head
  rejects(5, 12, 5, 'falling_above');
  bot.blocks.clear();
  assert.doesNotThrow(() => registry.validate('dig', { x: 8, y: 10, z: 5 }));
  assert.deepEqual(digCalls, []);
});

test('unsafeReason: flowing water counts, source water does not; her own cells are skipped', () => {
  const bot = botFixture();
  bot.entity.position = new Vec3(0, 0, 0);
  bot.setBlock(1, 0, 1, { name: 'water', getProperties: () => ({ level: 3 }) });
  assert.equal(unsafeReason(bot, { x: 0, y: 0, z: 1 }), 'liquid_adjacent');
  bot.setBlock(1, 0, 1, { name: 'water', getProperties: () => ({ level: 0 }) });
  assert.equal(unsafeReason(bot, { x: 0, y: 0, z: 1 }), null);
  // Water occupying her own cell never blocks the dig.
  bot.setBlock(0, 0, 0, { name: 'water', getProperties: () => ({ level: 3 }) });
  assert.equal(unsafeReason(bot, { x: 0, y: 0, z: 1 }), null);
});

test('stepper: unsafe dig targets produce no dig candidate', () => {
  const bot = botFixture();
  bot.entity.position = new Vec3(0, 0, 0);
  const stone = { position: new Vec3(0, -1, 0), name: 'stone' };
  bot.findBlocks = () => [stone.position];
  bot.blockAt = () => stone;
  const candidates = generateCandidates({
    bot, mcData,
    intent: { goal: 'Collect stone', goalText: 'Collect stone', target: { blocks: ['stone'], item: 'cobblestone' },
      success: { hasItem: 'cobblestone', atLeast: 1 }, allowed: ['findBlock', 'goTo', 'dig', 'collectDrops'], maxSteps: 40 },
  });
  assert.equal(candidates.some(c => c.primitive === 'dig'), false, 'no dig under her feet');
});

test('sensors: hurt attribution owner/mob/env and knocked uses last source', () => {
  const bot = botFixture();
  const { events, eventlog } = eventsOf();
  const sensors = createBodySensors({ bot, eventlog, ownerUuid: UUID });
  bot.emit('entityHurt', bot.entity, { uuid: UUID.toUpperCase(), type: 'player', name: 'TestOwner' });
  assert.deepEqual(events.at(-1), { kind: 'body.hurt', payload: { by: 'owner', health: undefined } });
  bot.emit('entityHurt', bot.entity, { type: 'mob', name: 'zombie' });
  assert.equal(events.at(-1).payload.by, 'mob');
  assert.equal(events.at(-1).payload.mob, 'zombie');
  bot.emit('entityHurt', bot.entity, undefined);
  assert.equal(events.at(-1).payload.by, 'env');
  // A velocity spike within 1 s attributes the knock to the last hurt source.
  bot.emit('entityHurt', bot.entity, { uuid: UUID, type: 'player' });
  bot._client.emit('entity_velocity', { entityId: bot.entity.id, velocity: { x: 4000, y: 0, z: 0 } });
  const knocked = events.at(-1);
  assert.equal(knocked.kind, 'body.knocked');
  assert.equal(knocked.payload.by, 'owner');
  assert.ok(knocked.payload.speed > 0);
  assert.ok(sensors.state.disturbed());
  sensors.stop();
});

test('sensors: ground_lost by owner swing and items_taken bookkeeping', () => {
  const bot = botFixture();
  const { events, eventlog } = eventsOf();
  const sensors = createBodySensors({ bot, eventlog, ownerUuid: UUID });
  const ownerEntity = { uuid: UUID, position: new Vec3(1, 0, 0) };
  bot.players = { TestOwner: { uuid: UUID, entity: ownerEntity } };
  bot.setBlock(0, -1, 0, { name: 'stone' });
  const feet = bot.blocks.get('0,-1,0');
  bot.emit('entitySwingArm', ownerEntity);
  bot.emit('blockUpdate', feet, { position: new Vec3(0, -1, 0), name: 'air' });
  assert.deepEqual(events.at(-1).payload, { by: 'owner' });
  assert.equal(events.at(-1).kind, 'body.ground_lost');
  sensors.noteTaken({ where: 'drops', item: 'white_wool', count: 2 });
  assert.deepEqual(events.at(-1).payload, { by: 'owner', where: 'drops', item: 'white_wool', count: 2 });
  assert.equal(sensors.state.itemsTaken.length, 1);
  sensors.stop();
});

test('sensors: fell reports drop distance and damage flag', () => {
  const bot = botFixture();
  const { events, eventlog } = eventsOf();
  const sensors = createBodySensors({ bot, eventlog, ownerUuid: UUID });
  bot.health = 20;
  bot.entity.onGround = false;
  bot.entity.position = new Vec3(0, 10, 0);
  bot.emit('physicsTick');
  bot.entity.position = new Vec3(0, 5, 0);
  bot.emit('physicsTick');
  bot.health = 18;
  bot.entity.onGround = true;
  bot.entity.position = new Vec3(0, 4, 0);
  bot.emit('physicsTick');
  const fell = events.at(-1);
  assert.equal(fell.kind, 'body.fell');
  assert.equal(fell.payload.damaged, true);
  assert.ok(fell.payload.distance > 5);
  sensors.stop();
});

const snap = more => ({
  now: 1000, health: 20, food: 20, oxygen: 20, isSleeping: false, hostiles: [],
  weapon: 'iron', hasFood: true, arbiter: { busy: false }, isNight: false, ...more,
});
const conf = { fleeHealth: 6, foodUrgent: 6, foodComfort: 15 };

test('decide: suffocating outranks creeper and fight', () => {
  const action = decide(snap({ suffocating: true, hostiles: [{ name: 'creeper', distance: 3 }] }), conf);
  assert.equal(action.kind, 'suffocating');
});

test('decide: trapped natural digs, artificial only says', () => {
  const natural = decide(snap({ trap: { kind: 'natural', dig: { x: 1, y: 0, z: 0 } } }), conf);
  assert.equal(natural.steps[0].primitive, 'dig');
  const artificial = decide(snap({ trap: { kind: 'artificial', text: '被围住了，出不去。' } }), conf);
  assert.equal(artificial.steps[0].primitive, 'say');
  assert.equal(decide(snap({ trap: { kind: 'artificial' } }), conf), null);
});

test('decide: vehicle unsafe dismounts; neutral mob hit means flee not fight', () => {
  assert.equal(decide(snap({ vehicleUnsafe: true }), conf).kind, 'vehicle_dismount');
  const flee = decide(snap({ neutralThreat: { name: 'enderman', dx: 5, dz: 0 },
    hostiles: [{ name: 'zombie', distance: 6, dx: -6, dz: 0 }] }), conf);
  assert.equal(flee.kind, 'flee');
  assert.equal(flee.reason, 'neutral');
  assert.ok(flee.steps[0].params.x < 0, 'flees away from the enderman');
});

test('decide: bad_omen drinks milk when carried, otherwise states the fact once', () => {
  const milk = decide(snap({ badOmen: true, hasMilk: true }), conf);
  assert.deepEqual(milk.steps, [{ primitive: 'eat', params: { itemName: 'milk_bucket' } }]);
  const tell = decide(snap({ badOmen: true, hasMilk: false }), conf);
  assert.equal(tell.kind, 'bad_omen');
  assert.equal(tell.steps, null);
  const again = decide(snap({ badOmen: true, hasMilk: false, lastAction: { kind: 'bad_omen', reason: 'no_milk', at: 900 } }), conf);
  assert.equal(again, null);
});

test('lookAt: a gaze within 10 degrees of an enderman head is rejected', () => {
  const bot = botFixture();
  bot.entities[9] = { name: 'enderman', position: new Vec3(10, 0, 0), isValid: true };
  const registry = createPrimitiveRegistry({ bot, eventlog: eventsOf().eventlog, mcData });
  assert.throws(() => registry.validate('lookAt', { x: 10, y: 0.9, z: 0 }), /gaze_enderman/);
  assert.doesNotThrow(() => registry.validate('lookAt', { x: -10, y: 0, z: 0 }));
  assert.doesNotThrow(() => registry.validate('lookAt', { x: 10, y: 40, z: 10 }));
});

test('disturbed: a knocked bot retries a failed goTo once', async () => {
  const bot = botFixture();
  const { eventlog } = eventsOf();
  const sensors = createBodySensors({ bot, eventlog, ownerUuid: UUID });
  const registry = createPrimitiveRegistry({ bot, eventlog, mcData, body: sensors });
  const calls = [];
  bot.pathfinder = {
    setGoal() {}, stop() {},
    goto: () => { calls.push(1); return Promise.reject(Object.assign(new Error('nope'), { name: 'NoPath' })); },
    getPathTo: () => Promise.resolve({ status: 'noPath' }),
  };
  bot.emit('entityHurt', bot.entity, { uuid: UUID, type: 'player' });
  const r = await registry.run('goTo', { x: 5, y: 0, z: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.error?.disturbed, true);
  sensors.stop();
});

test('sensors: knockback needs >0.1 b/t; velocity units are 1/8000', () => {
  const bot = botFixture();
  const { events, eventlog } = eventsOf();
  const sensors = createBodySensors({ bot, eventlog, ownerUuid: UUID });
  // 400 units = 0.05 blocks/tick — gravity/idle noise, not a knock.
  bot._client.emit('entity_velocity', { entityId: bot.entity.id, velocity: { x: 400, y: 0, z: 0 } });
  assert.equal(events.at(-1)?.kind !== 'body.knocked', true);
  bot._client.emit('entity_velocity', { entityId: bot.entity.id, velocity: { x: 8000, y: 0, z: 0 } });
  assert.equal(events.at(-1).kind, 'body.knocked');
  assert.equal(events.at(-1).payload.speed, 20);
  sensors.stop();
});

test('sensors: bad_omen effect resolves camelCase registry names to snake_case', () => {
  const bot = botFixture({ registry: { effects: { 30: { name: 'BadOmen' } } } });
  const { eventlog } = eventsOf();
  const sensors = createBodySensors({ bot, eventlog, ownerUuid: UUID });
  bot.emit('entityEffect', bot.entity, { id: 30, amplifier: 0 });
  assert.equal(sensors.state.effects.has('bad_omen'), true);
  bot.emit('entityEffectEnd', bot.entity, { id: 30 });
  assert.equal(sensors.state.effects.has('bad_omen'), false);
  sensors.stop();
});

test('bad_omen reflex: milk gets eaten, no milk only speaks — both idle', () => {
  const make = items => {
    const tasks = [], timers = new Map();
    const bot = Object.assign(botFixture(), {
      health: 20, food: 20, oxygenLevel: 20,
      time: { isDay: true }, entities: {}, players: {},
      inventory: { items: () => items },
      findBlock: () => null, setControlState: () => {},
      blockAt: p => p.y < 0 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' },
    });
    bot.entity.effects = { [mcData.effectsByName.BadOmen.id]: { id: mcData.effectsByName.BadOmen.id } };
    const clock = { now: () => 20_000, setInterval: (fn, ms) => { timers.set(1, fn); return 1; }, clearInterval: id => timers.delete(id) };
    const survival = createSurvival({
      bot, registry: { validate() {} }, eventlog: eventsOf().eventlog, mcData, clock,
      config: { survivalTickMs: 250 }, protection: null,
      arbiter: { current: () => null, submit: t => { tasks.push(t); return { accepted: true, done: new Promise(() => {}) }; } },
    });
    return { tasks, timers, survival, tick: () => timers.get(1)?.() };
  };
  const withMilk = make([{ name: 'milk_bucket', type: 1 }]);
  withMilk.tick();
  assert.deepEqual(withMilk.tasks[0]?.steps, [{ primitive: 'eat', params: { itemName: 'milk_bucket' } }]);
  assert.equal(withMilk.tasks[0]?.source, 'idle');
  withMilk.survival.stop();
  const noMilk = make([]);
  noMilk.tick();
  assert.equal(noMilk.tasks[0]?.steps?.[0]?.primitive, 'say');
  assert.equal(noMilk.tasks[0]?.source, 'idle');
  noMilk.survival.stop();
});
