import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { createRequire } from 'node:module';
import { createPrimitiveRegistry, InvalidParamsError } from '../src/primitives/registry.js';
import { Vec3 } from '../src/primitives/helpers.js';
import { validateDraft } from '../src/skills/library.js';
import { interpret } from '../src/skills/interpreter.js';
import { ALLOWED } from '../src/decision/intent.js';
import { createGameTools } from '../src/brain/tools.js';
import { primitivesEnvironment, runPrimitivesScenario } from '../scripts/e2e-primitives.mjs';
const data = createRequire(import.meta.url)('minecraft-data')('1.20.4');
const uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const tick = () => new Promise(resolve => setImmediate(resolve));
const never = () => new Promise(() => {});
function clock() {
  let now = 0, id = 0;
  const timers = new Map();
  return { now: () => now, pending: () => timers.size,
    setTimeout(fn, ms) { timers.set(++id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const end = now + ms;
      await tick();
      for (;;) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await tick();
      }
      now = end; await tick();
    } };
}
const item = (name, count = 1) => ({ name, type: data.itemsByName[name].id, count });
const entity = (name, x = 1, id = 2) => ({ id, name, isValid: true, position: new Vec3(x, 0, 0) });
function fixture(overrides = {}, options = {}) {
  const calls = [], events = [];
  const record = name => (...args) => { calls.push({ name, args }); };
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0, 0, 0) }, entities: {}, health: 20, food: 10,
    inventory: { items: () => [] }, time: { isDay: false }, thunderState: 0,
    pathfinder: { goto: record('goto'), stop: record('stop'), setGoal: record('setGoal') },
    equip(it, slot) { record('equip')(it, slot); if (slot === 'hand') bot.heldItem = it; },
    unequip(slot) { record('unequip')(slot); if (slot === 'hand') bot.heldItem = null; },
    lookAt: record('lookAt'), attack: record('attack'),
    consume() { record('consume')(); bot.food = 20; }, deactivateItem: record('deactivateItem'),
    toss: record('toss'), findBlock: () => null, chat: record('chat'),
    sleep() { bot.isSleeping = true; record('sleep')(); },
    wake() { bot.isSleeping = false; record('wake')(); },
  }, overrides);
  const registry = createPrimitiveRegistry({ bot, mcData: data, ownerUuid: uuid,
    eventlog: { append: (kind, payload) => events.push({ kind, payload }) }, ...options });
  return { bot, registry, calls, events };
}
const failed = async (registry, name, params, reason) => {
  const result = await registry.run(name, params);
  assert.equal(result.ok, false); assert.equal(result.error.message, reason); return result;
};

test('registry exact metadata, owner gating and validation before bot', () => {
  const { registry, calls } = fixture();
  assert.equal(registry.list().length, 25);
  const noOwner = fixture({}, { ownerUuid: undefined }).registry;
  assert.equal(noOwner.list().length, 22);
  assert.equal(noOwner.list().includes('give'), false); assert.equal(noOwner.list().includes('follow'), false);
  assert.equal(noOwner.list().includes('withdraw'), false);
  const itemRule = { type: 'string', required: true, minLength: 1, catalog: 'itemsByName' };
  const expected = [
    ['equip', 'Equip an inventory item in the requested slot.', { itemName: itemRule, slot: { type: 'string', enum: ['hand', 'head', 'torso', 'legs', 'feet', 'off-hand'], default: 'hand' } }, 5000],
    ['eat', 'Eat a safe inventory food without unnecessary waste.', { itemName: { ...itemRule, required: false } }, 8000],
    ['attack', 'Attack one nearby allowed hostile mob or food animal.', { entityName: { type: 'string', required: true, catalog: 'entitiesByName' }, maxHits: { type: 'number', integer: true, min: 1, max: 60, default: 20 } }, 30000],
    ['give', 'Toss the requested inventory count only to the owner.', { itemName: itemRule, count: { type: 'number', integer: true, min: 1, max: 64, default: 1 } }, 20000],
    ['sleep', 'Walk to the nearest bed and sleep at night or during a thunderstorm.', {}, 30000],
  ];
  for (const [name, description, params, defaultTimeoutMs] of expected) assert.deepEqual(registry.describe(name), { name, description, params, defaultTimeoutMs });
  for (const [name, params] of [['equip', { itemName: 'stone', slot: 'bag' }], ['equip', { itemName: 1 }], ['eat', { itemName: 4 }], ['sleep', { command: 'x' }], ['give', { itemName: 'stick', count: 65 }], ['give', { itemName: 'stick', count: 0 }], ['give', { itemName: 'stick', count: 1.5 }], ['give', { itemName: 'stick', uuid }], ['attack', { entityName: 'zombie', maxHits: 61 }], ['attack', { entityName: 'zombie', maxHits: 0 }], ['attack', { entityName: 'zombie', maxHits: '1' }], ['attack', { entityName: 'unknown' }]]) assert.throws(() => registry.run(name, params), InvalidParamsError);
  assert.deepEqual(calls, []);
});

test('equip success, default slot, missing item and invalid slot', async () => {
  const stack = item('stone'); const { registry, calls } = fixture({ inventory: { items: () => [stack] } });
  assert.deepEqual((await registry.run('equip', { itemName: 'stone' })).result, { itemName: 'stone', slot: 'hand' });
  for (const slot of ['head', 'torso', 'legs', 'feet', 'off-hand']) assert.equal((await registry.run('equip', { itemName: 'stone', slot })).ok, true);
  assert.deepEqual(calls[0].args, [stack, 'hand']);
  assert.match((await registry.run('equip', { itemName: 'diamond' })).error.message, /not in inventory/);
  assert.throws(() => registry.run('equip', { itemName: 'stone', slot: 'bad' }), InvalidParamsError);
});

test('equip retries with a fresh item lookup until the held stack is right', async () => {
  const stack = item('stone'); let equips = 0;
  const { registry } = fixture({
    inventory: { items: () => [stack] },
    // First equip lands on a stale quick-bar slot (server moved the stack);
    // the second attempt resolves the fresh slot and the held stack is right.
    equip(it, slot) { equips++; if (equips === 2) this.heldItem = it; },
  });
  assert.deepEqual((await registry.run('equip', { itemName: 'stone' })).result, { itemName: 'stone', slot: 'hand' });
  assert.equal(equips, 2);
});

test('equip fails honestly when the item never lands in the hand', async () => {
  const stack = item('stone'); let equips = 0;
  const { registry } = fixture({
    inventory: { items: () => [stack] },
    equip() { equips++; },
  });
  const result = await registry.run('equip', { itemName: 'stone' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'equip_failed');
  assert.equal(equips, 3);
});

test('eat hunger, safe selection, waste and risky-food rules', async () => {
  for (const [food, names, expected] of [
    [10, ['pufferfish', 'spider_eye', 'poisonous_potato', 'suspicious_stew', 'bread', 'cooked_beef'], 'cooked_beef'],
    [15, ['bread', 'cooked_beef', 'apple'], 'bread'], [18, ['bread', 'apple'], 'apple'],
    [6, ['rotten_flesh', 'chicken'], 'rotten_flesh'], [6, ['rotten_flesh', 'chicken', 'apple'], 'apple'],
  ]) {
    const { registry } = fixture({ food, inventory: { items: () => names.map(n => item(n)) } });
    assert.deepEqual((await registry.run('eat')).result, { itemName: expected, foodBefore: food, foodAfter: 20 });
  }
  const full = fixture({ food: 20 }); await failed(full.registry, 'eat', {}, 'not_hungry'); assert.deepEqual(full.calls, []);
  for (const name of ['pufferfish', 'spider_eye', 'poisonous_potato', 'suspicious_stew']) {
    const { registry } = fixture({ inventory: { items: () => [item(name)] } });
    await failed(registry, 'eat', { itemName: name }, 'unsafe_food'); await failed(registry, 'eat', {}, 'no_food');
  }
  for (const name of ['rotten_flesh', 'chicken']) {
    await failed(fixture({ food: 7, inventory: { items: () => [item(name)] } }).registry, 'eat', {}, 'no_food');
    await failed(fixture({ food: 6, inventory: { items: () => [item(name), item('apple')] } }).registry, 'eat', { itemName: name }, 'unsafe_food');
    assert.equal((await fixture({ food: 6, inventory: { items: () => [item(name)] } }).registry.run('eat', { itemName: name })).ok, true);
  }
  await failed(fixture().registry, 'eat', {}, 'no_food');
  await failed(fixture({ inventory: { items: () => [item('stone')] } }).registry, 'eat', { itemName: 'stone' }, 'unsafe_food');
});

test('eat cancellation deactivates item and never consumes after late equip', async () => {
  for (const during of ['equip', 'consume']) {
    const { registry, calls } = fixture({ inventory: { items: () => [item('bread')] }, [during]: never });
    const controller = new AbortController(); const running = registry.run('eat', {}, { signal: controller.signal });
    await tick(); controller.abort(); assert.equal((await running).cancelled, true);
    assert.equal(calls.filter(c => c.name === 'deactivateItem').length, 1);
  }
});

test('attack safety rejects friendly and excluded mobs before bot', () => {
  const { registry, calls } = fixture();
  for (const name of ['player', 'villager', 'wandering_trader', 'iron_golem', 'snow_golem', 'wolf', 'cat', 'horse', 'donkey', 'mule', 'parrot', 'enderman', 'zombified_piglin', 'piglin', 'piglin_brute', 'warden', 'wither', 'ender_dragon', 'elder_guardian', 'ghast']) assert.throws(() => registry.run('attack', { entityName: name }), InvalidParamsError);
  for (const entityName of ['zombie', 'skeleton', 'cow', 'pig', 'sheep', 'chicken']) assert.deepEqual(registry.validate('attack', { entityName }), { entityName, maxHits: 20 });
  assert.deepEqual(calls, []);
});

test('attack nearest valid target, sword priority, cooldown and kill', async () => {
  const time = clock(), nearest = entity('cow', 1), farther = entity('cow', 2, 3);
  const hitTimes = [];
  const { registry, calls, bot, events } = fixture({ entities: { 2: nearest, 3: farther, 4: { ...entity('cow', 0.1, 4), uuid }, 5: { ...entity('cow', 0.2, 5), isValid: false }, 6: entity('zombie', 0.3, 6) },
    inventory: { items: () => ['netherite_axe', 'wooden_sword', 'diamond_sword', 'iron_sword'].map(n => item(n)) },
    attack(target) { assert.equal(target, nearest); hitTimes.push(time.now()); if (hitTimes.length === 3) bot.emit('entityGone', nearest); },
  }, { clock: time });
  const running = registry.run('attack', { entityName: 'cow' });
  await time.advance(599); assert.deepEqual(hitTimes, [0]);
  await time.advance(1); assert.deepEqual(hitTimes, [0, 600]);
  await time.advance(600); assert.deepEqual((await running).result, { entityName: 'cow', hits: 3, killed: true });
  assert.equal(calls.find(c => c.name === 'equip').args[0].name, 'diamond_sword');
  assert.equal(time.pending(), 0); assert.deepEqual(bot.eventNames(), []);
  assert.deepEqual(events.map(e => e.kind), ['primitive.start', 'primitive.end']);
});

test('attack max hits, health thresholds, range and missing targets', async () => {
  const cow = entity('cow');
  const maxClock = clock();
  const f = fixture({ entities: { 2: cow } }, { clock: maxClock });
  const maxRun = f.registry.run('attack', { entityName: 'cow', maxHits: 1 });
  await maxClock.advance(600);
  const result = await maxRun;
  assert.equal(result.ok, false); assert.equal(result.error.message, 'max_hits');
  assert.equal(result.error.hits, 1); assert.equal(f.calls.filter(c => c.name === 'attack').length, 1);
  assert.equal(f.calls.some(c => c.name === 'unequip'), true);
  const low = fixture({ health: 6, entities: { 2: cow } }); await failed(low.registry, 'attack', { entityName: 'cow' }, 'health_too_low'); assert.deepEqual(low.calls, []);
  const time = clock(); const fighting = fixture({ entities: { 2: cow } }, { clock: time });
  const run = fighting.registry.run('attack', { entityName: 'cow' }); await time.advance(100); fighting.bot.health = 4; fighting.bot.emit('health');
  await tick(); assert.equal((await run).error.message, 'health_too_low'); assert.equal(fighting.calls.filter(c => c.name === 'attack').length, 1);
  assert.equal(time.pending(), 0);
  for (const entities of [{}, { 2: entity('cow', 17) }, { 2: { ...cow, uuid } }, { 2: { ...cow, type: 'player' } }]) await failed(fixture({ entities }).registry, 'attack', { entityName: 'cow' }, 'target_not_found');
});

test('attack cancellation and timeout clear navigation, listeners and timers', async () => {
  for (const cancelled of [true, false]) for (const distance of [1, 8]) {
    const time = clock(), controller = new AbortController();
    const { registry, bot, calls } = fixture({ entities: { 2: entity('cow', distance) } }, { clock: time });
    const running = registry.run('attack', { entityName: 'cow' }, { signal: controller.signal, timeoutMs: 200 });
    await time.advance(100);
    if (cancelled) controller.abort(); else await time.advance(100);
    const result = await running; await tick();
    assert.equal(result.cancelled, cancelled); assert.equal(result.timed_out, !cancelled);
    assert.equal(time.pending(), 0); assert.deepEqual(bot.eventNames(), []);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.ok(calls.some(c => c.name === 'stop'));
    const hits = calls.filter(c => c.name === 'attack').length; await time.advance(1000);
    assert.equal(calls.filter(c => c.name === 'attack').length, hits);
  }
});

test('give exact owner, complete count, toss arguments and cancellation', async () => {
  const owner = { ...entity('player', 1), uuid: uuid.toUpperCase() };
  const stock = [item('stick', 2), item('stick', 3)];
  const f = fixture({ inventory: { items: () => stock.filter(i => i.count > 0) }, entities: { 2: owner, 3: { ...entity('player', 0.5, 3), uuid: 'other' } } });
  f.bot.toss = (type, meta, count) => {
    f.calls.push({ name: 'toss', args: [type, meta, count] });
    let left = count;
    for (const stack of stock) {
      if (stack.type !== type || left <= 0) continue;
      const take = Math.min(stack.count, left); stack.count -= take; left -= take;
    }
  };
  await failed(f.registry, 'give', { itemName: 'stick', count: 6 }, 'not_enough_items'); assert.deepEqual(f.calls, []);
  assert.deepEqual((await f.registry.run('give', { itemName: 'stick', count: 5 })).result, { itemName: 'stick', given: 5 });
  assert.deepEqual(f.calls.find(c => c.name === 'toss').args, [data.itemsByName.stick.id, null, 5]);
  assert.equal(f.calls.find(c => c.name === 'goto').args[0].entity, owner);
  stock.push(item('stick', 2));
  delete f.bot.entities[2]; await failed(f.registry, 'give', { itemName: 'stick' }, 'owner_not_visible');
  for (const field of ['uuid', 'recipient', 'player', 'ownerUuid']) assert.throws(() => f.registry.run('give', { itemName: 'stick', [field]: uuid }), InvalidParamsError);
  const cancelled = fixture({ inventory: { items: () => [item('stick')] }, entities: { 2: owner }, pathfinder: { goto: never, stop() { cancelled.calls.push({ name: 'stop' }); } } });
  const controller = new AbortController(); const running = cancelled.registry.run('give', { itemName: 'stick' }, { signal: controller.signal }); await tick(); controller.abort();
  assert.equal((await running).cancelled, true); assert.ok(cancelled.calls.some(c => c.name === 'stop')); assert.equal(cancelled.calls.some(c => c.name === 'toss'), false);
});

test('give walks over a scattered stack and re-tosses it', async () => {
  const owner = { ...entity('player', 1), uuid: uuid.toUpperCase() };
  const stray = { id: 9, name: 'item', isValid: true, position: new Vec3(1.5, 0, 0),
    getDroppedItem: () => ({ type: data.itemsByName.stick.id, count: 5 }) };
  const f = fixture({ inventory: { items: () => [item('stick', 5)] }, entities: { 2: owner, 9: stray } });
  const result = await f.registry.run('give', { itemName: 'stick', count: 5 });
  assert.equal(result.ok, true);
  assert.equal(f.calls.filter(c => c.name === 'toss').length, 3);
  const follows = f.calls.filter(c => c.name === 'goto');
  assert.equal(follows.at(-1).args[0].entity, stray);
});

test('sleep day, thunderstorm, bed search, success and game failure', async () => {
  const day = fixture({ time: { isDay: true } }); await failed(day.registry, 'sleep', {}, 'not_night'); assert.deepEqual(day.calls, []);
  await failed(fixture().registry, 'sleep', {}, 'no_bed');
  const bed = { name: 'red_bed', position: new Vec3(2, 0, 0) };
  const f = fixture({ time: { isDay: true }, isRaining: true, thunderState: 1, findBlock(options) {
    assert.equal(options.maxDistance, 32); assert.equal(options.matching(bed), true); assert.equal(options.matching({ name: 'stone' }), false); return bed;
  } });
  assert.deepEqual((await f.registry.run('sleep')).result, { x: 2, y: 0, z: 0 }); assert.equal(f.bot.isSleeping, true);
  await failed(fixture({ findBlock: () => bed, sleep() { throw new Error('bed occupied'); } }).registry, 'sleep', {}, 'bed occupied');
});

test('sleep cancellation wakes an already sleeping bot including late success', async () => {
  for (const late of [false, true]) {
    let finish;
    const f = fixture({ findBlock: () => ({ name: 'red_bed', position: new Vec3(1, 0, 0) }),
      sleep() { if (!late) f.bot.isSleeping = true; return new Promise(resolve => { finish = () => { f.bot.isSleeping = true; resolve(); }; }); } });
    const controller = new AbortController(); const running = f.registry.run('sleep', {}, { signal: controller.signal }); await tick(); controller.abort();
    assert.equal((await running).cancelled, true); finish(); await tick(); assert.equal(f.bot.isSleeping, false); assert.ok(f.calls.some(c => c.name === 'wake'));
  }
});

test('wake before other primitives, failure logged, sleep exempt', async () => {
  const f = fixture({ isSleeping: true }); await f.registry.run('say', { text: 'hello' }); assert.deepEqual(f.calls.map(c => c.name), ['wake', 'chat']);
  const bad = fixture({ isSleeping: true, wake() { throw new Error('cannot wake'); } });
  assert.equal((await bad.registry.run('say', { text: 'hello' })).ok, true); assert.ok(bad.events.some(e => e.kind === 'primitive.wake_failed'));
  f.bot.isSleeping = true; f.calls.length = 0; await f.registry.run('sleep'); assert.equal(f.calls.some(c => c.name === 'wake'), false);
});

test('skill validator and interpreter use registry for all new primitives', async () => {
  const { registry } = fixture();
  const body = [{ primitive: 'equip', params: { itemName: 'stick' } }, { primitive: 'eat', params: {} }, { primitive: 'attack', params: { entityName: 'cow' } }, { primitive: 'give', params: { itemName: 'stick' } }, { primitive: 'sleep', params: {} }];
  const draft = { name: 'new_primitives', description: 'Exercise primitives', params: {}, body };
  assert.equal(validateDraft(draft, { registry }).ok, true);
  const visited = [];
  await interpret({ program: { ...draft, args: {} }, isActive: () => true, trace: [], runPrimitive(node) { registry.validate(node.primitive, node.params); visited.push(node.primitive); } });
  assert.deepEqual(visited, body.map(n => n.primitive));
  const denied = { ...registry, has: () => false };
  assert.equal(validateDraft(draft, { registry: denied }).ok, false);
});

test('intent and brain tool whitelists remain unchanged', () => {
  assert.deepEqual([...ALLOWED], ['findBlock', 'goTo', 'dig', 'collectDrops']);
  const options = { library: { list: () => [] }, learningAutonomy: 2, jev: { ask() {} },
    goals: { obtain: () => ({ done: Promise.resolve({ status: 'succeeded' }) }) } };
  assert.deepEqual(createGameTools(options).map(t => t.name), ['list_skills', 'inventory', 'look_around', 'run_skill', 'stop', 'start_intent', 'obtain']);
  assert.deepEqual(createGameTools({ ...options, learningAutonomy: 0 }).map(t => t.name), ['list_skills', 'inventory', 'look_around', 'run_skill', 'stop']);
});

test('e2e primitives skips without opt-in, runs sequence and verifies owner pickup', async () => {
  const logs = [];
  assert.equal(primitivesEnvironment({}, value => logs.push(value)), false);
  assert.match(logs[0], /SKIP/);
  assert.equal(primitivesEnvironment({ E2E_PRIMITIVES: '1' }), true);
  const f = fixture(); let inventory = [], ownerItems = [], bed = null;
  const owner = { entity: { position: new Vec3(0, 0, 0) }, inventory: { items: () => ownerItems } };
  f.bot.inventory.items = () => inventory;
  f.bot.food = 20; f.bot.time.isDay = true; f.bot.findBlock = () => bed;
  f.bot.attack = target => { target.isValid = false; };
  f.bot.toss = (type, metadata, count) => { assert.equal(type, data.itemsByName.stick.id); ownerItems.push(item('stick', count)); };
  f.bot.entities[1] = { ...entity('player'), uuid };
  const commands = [];
  await runPrimitivesScenario({ app: { bot: f.bot, registry: f.registry, eventlog: { query: () => [] } }, owner, delay: async () => {}, log: value => logs.push(value), command(text) {
    commands.push(text);
    if (text.startsWith('give Companion wooden_sword')) inventory.push(item('wooden_sword'));
    if (text.includes('summon cow')) f.bot.entities[2] = entity('cow');
    if (text.startsWith('give Companion bread')) inventory.push(item('bread'));
    if (text.startsWith('effect give')) f.bot.food = 15;
    if (text.startsWith('give Companion stick')) inventory.push(item('stick', 5));
    if (text === 'time set night') f.bot.time.isDay = false;
    if (text.includes('red_bed')) bed = { name: 'red_bed', position: new Vec3(2, 0, 0) };
  } });
  assert.deepEqual(f.events.filter(e => e.kind === 'primitive.start').map(e => e.payload.name), ['equip', 'attack', 'eat', 'give', 'sleep', 'countItem']);
  assert.equal(ownerItems[0].count, 5); assert.equal(f.bot.isSleeping, false);
  assert.equal(logs.at(-1), 'E2E PRIMITIVES PASS');
  await assert.rejects(runPrimitivesScenario({ app: { bot: f.bot, registry: { run: async () => ({ ok: false, error: { message: 'fixture failure' } }) } }, owner,
    delay: async () => {}, command() {}, log: text => logs.push(text) }), /equip: fixture failure/);
  assert.match(logs.at(-1), /FAIL.*fixture failure/);
});
