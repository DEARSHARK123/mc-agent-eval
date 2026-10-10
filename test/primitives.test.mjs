import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readdirSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEventLog } from '../src/eventlog.js';
import { createPrimitiveRegistry, UnknownPrimitiveError, InvalidParamsError } from '../src/primitives/registry.js';
import { Vec3, goals } from '../src/primitives/helpers.js';

const require = createRequire(import.meta.url);
const mcData = require('minecraft-data')('1.20.4');
const Recipe = require('prismarine-recipe')(mcData).Recipe;
const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const names = ['goTo', 'goToEntity', 'lookAt', 'say', 'findBlock', 'dig', 'collectDrops', 'countItem', 'craft', 'place', 'equip', 'eat', 'attack', 'sleep', 'deposit', 'smelt', 'pos', 'blockAt', 'findEntity', 'inventory', 'heldItem', 'body'];
const ownerNames = ['goTo', 'goToEntity', 'lookAt', 'say', 'findBlock', 'dig', 'collectDrops', 'countItem', 'craft', 'place', 'follow', 'equip', 'eat', 'attack', 'give', 'sleep', 'deposit', 'withdraw', 'smelt', 'pos', 'blockAt', 'findEntity', 'inventory', 'heldItem', 'body'];
const target = { x: 1, y: 0, z: 0 };
const tick = () => new Promise(resolve => setImmediate(resolve));
const never = () => new Promise(() => {});

function fixture(overrides = {}, options = {}) {
  const bot = new EventEmitter();
  const calls = [];
  const record = (name, result) => (...args) => { calls.push({ name, args }); return result; };
  Object.assign(bot, {
    entity: { id: 1, position: new Vec3(0, 0, 0) }, entities: {},
    pathfinder: { goto: record('goto', Promise.resolve()), stop: record('stop') },
    chat: record('chat'), lookAt: record('lookAt', Promise.resolve()),
    findBlock: record('findBlock', null), blockAt: record('blockAt', null),
    canDigBlock: record('canDigBlock', true), dig: record('dig', Promise.resolve()),
    stopDigging: record('stopDigging'), inventory: { items: record('items', []) },
    recipesFor: record('recipesFor', []), craft: record('craft', Promise.resolve()),
    equip: record('equip', Promise.resolve()), placeBlock: record('placeBlock', Promise.resolve()),
    closeWindow: record('closeWindow', Promise.resolve()),
  }, overrides);
  const events = [];
  const eventlog = { append(kind, payload, traceId) { events.push({ kind, payload: structuredClone(payload), traceId }); } };
  const registry = createPrimitiveRegistry({ bot, eventlog, mcData, ...options });
  return { bot, calls, events, registry };
}

function realLog(t) {
  const root = process.env.COMPANION_TEST_TMP ?? fileURLToPath(new URL('../../.tmp/', import.meta.url));
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 't2-test-'));
  const log = createEventLog(directory);
  t.after(() => {
    try { log.close(); } finally {
      assert.equal(dirname(directory), resolve(root));
      for (const file of readdirSync(directory)) unlinkSync(join(directory, file));
      rmdirSync(directory);
      assert.equal(existsSync(directory), false);
    }
  });
  return log;
}

test('registry: whitelist and descriptions are exact and cannot mutate the registry', () => {
  const { registry, calls } = fixture();
  assert.deepEqual(registry.list(), names);
  registry.list().pop();
  for (const name of names) {
    assert.equal(registry.has(name), true);
    const description = registry.describe(name);
    assert.equal(description.name, name);
    assert.ok(description.description && description.defaultTimeoutMs > 0);
    assert.ok(description.params);
  }
  registry.describe('say').params.text.maxLength = 1000;
  assert.equal(registry.describe('say').params.text.maxLength, 200);
  assert.equal(registry.has('fly'), false);
  assert.throws(() => registry.run('fly', {}), error =>
    error instanceof UnknownPrimitiveError && error.primitiveName === 'fly' && /fly/.test(error.message)
  );
  assert.throws(() => registry.describe('fly'), UnknownPrimitiveError);
  assert.deepEqual(calls, []);
});

test('registry: invalid required fields, types, ranges and Minecraft names never touch bot', () => {
  const { registry, calls, events } = fixture();
  const cases = [
    ['goTo', { y: 0, z: 0 }, 'x'], ['goTo', { ...target, x: '1' }, 'x'],
    ['goTo', { ...target, y: Infinity }, 'y'], ['goTo', { ...target, range: -1 }, 'range'],
    ['goToEntity', {}, 'uuid'], ['goToEntity', { uuid: 'player' }, 'uuid'],
    ['lookAt', { x: 0, y: 0 }, 'z'], ['say', {}, 'text'], ['say', { text: 42 }, 'text'],
    ['say', { text: '' }, 'text'], ['say', { text: 'x'.repeat(201) }, 'text'],
    ['say', { text: 'hi', command: true }, 'command'],
    ['findBlock', { blockName: 'not_a_block' }, 'blockName'],
    ['findBlock', { blockName: 'stone', maxDistance: 0 }, 'maxDistance'],
    ['dig', { ...target, x: 0.5 }, 'x'], ['collectDrops', { radius: -2 }, 'radius'],
    ['collectDrops', { settleMs: 0 }, 'settleMs'], ['collectDrops', { settleMs: -1 }, 'settleMs'],
    ['collectDrops', { settleMs: Infinity }, 'settleMs'], ['collectDrops', { settleMs: '100' }, 'settleMs'],
    ['countItem', { itemName: 'not_an_item' }, 'itemName'],
    ['craft', { itemName: 'oak_planks', count: 0 }, 'count'],
    ['craft', { itemName: 'oak_planks', count: 1.5 }, 'count'],
    ['craft', { itemName: 'oak_planks', useTable: 'yes' }, 'useTable'],
    ['place', target, 'itemName'], ['say', null, 'params'], ['say', [], 'params'],
    ['findBlock', { blockName: 'constructor' }, 'blockName'],
  ];
  for (const [name, params, field] of cases) {
    assert.throws(() => registry.run(name, params), error =>
      error instanceof InvalidParamsError && error.field === field && error.message.includes(field)
    );
  }
  for (const [field, value] of [['timeoutMs', 0], ['timeoutMs', Infinity], ['traceId', ''], ['signal', {}]]) {
    assert.throws(() => registry.run('say', { text: 'hi' }, { [field]: value }), error =>
      error instanceof InvalidParamsError && error.field === field
    );
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(events, []);
});

test('registry: success persists exactly start/end with shared trace and duration, cleans SQLite', async t => {
  const eventlog = realLog(t);
  let now = 100;
  const { registry, calls } = fixture({}, { eventlog, clock: { now: () => now++ } });
  assert.deepEqual(await registry.run('say', { text: 'hello' }, { traceId: 't2-trace' }), {
    ok: true, result: null, cancelled: false, timed_out: false,
  });
  const events = eventlog.query();
  assert.deepEqual(events.map(event => event.kind), ['primitive.start', 'primitive.end']);
  assert.deepEqual(events.map(event => event.trace_id), ['t2-trace', 't2-trace']);
  assert.deepEqual(events[0].payload, { name: 'say', params: { text: 'hello' } });
  assert.equal(events[1].payload.duration_ms, 1);
  assert.equal(events[1].payload.ok, true);
  assert.deepEqual(calls, [{ name: 'chat', args: ['hello'] }]);
});

test('registry: default params are logged and generated trace IDs match', async () => {
  const { registry, events } = fixture();
  await registry.run('goTo', target);
  assert.equal(events[0].payload.params.range, 1);
  assert.ok(events[0].traceId);
  assert.equal(events[0].traceId, events[1].traceId);
  assert.ok(events[1].payload.duration_ms >= 0);
});

test('registry: runtime throw and rejection return logged errors', async () => {
  for (const lookAt of [() => { throw new Error('look failed'); }, () => Promise.reject('look failed')]) {
    const { registry, events } = fixture({ lookAt });
    const result = await registry.run('lookAt', target);
    assert.equal(result.ok, false);
    assert.match(result.error.message, /look failed/);
    assert.equal(result.cancelled, false);
    assert.equal(result.timed_out, false);
    assert.deepEqual(events.map(event => event.kind), ['primitive.start', 'primitive.end']);
    assert.deepEqual(events[1].payload.error, result.error);
  }
});

test('registry: eventlog failure returns an error without bot calls', async () => {
  const { registry, calls } = fixture({}, { eventlog: { append() { throw new Error('disk unavailable'); } } });
  const result = await registry.run('say', { text: 'hi' });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /disk unavailable/);
  assert.deepEqual(calls, []);
});

test('registry: SQLite closing during a primitive does not reject its result', async t => {
  const eventlog = realLog(t);
  let finish;
  const { registry } = fixture({ lookAt: () => new Promise(resolve => { finish = resolve; }) }, { eventlog });
  const running = registry.run('lookAt', target);
  await tick();
  assert.deepEqual(eventlog.query().map(row => row.kind), ['primitive.start']);
  eventlog.close();
  finish();
  assert.equal((await running).ok, true);
  assert.deepEqual(eventlog.query(), []);
});

test('registry: primitive.end append failure returns ok:false without rejecting', async () => {
  const attempted = [];
  const { registry, calls } = fixture({}, { eventlog: { append(kind) {
    attempted.push(kind);
    if (kind === 'primitive.end') throw new Error('statement has been finalized');
  } } });
  const result = await registry.run('say', { text: 'hi' });
  assert.equal(result.ok, false);
  assert.equal(result.error.message, 'statement has been finalized');
  assert.equal(Object.hasOwn(result, 'result'), false);
  assert.deepEqual(attempted, ['primitive.start', 'primitive.end']);
  assert.deepEqual(calls, [{ name: 'chat', args: ['hi'] }]);
});

test('goTo: forever-pending path times out at 50ms and stops navigation', async () => {
  let stopped = 0;
  const { registry, events } = fixture({ pathfinder: { goto: never, stop: () => stopped++ } });
  const result = await registry.run('goTo', target, { timeoutMs: 50 });
  assert.equal(result.ok, false);
  assert.equal(result.timed_out, true);
  assert.equal(result.cancelled, false);
  assert.equal(stopped, 1);
  assert.equal(events[1].payload.timed_out, true);
});

test('goTo: abort stops navigation promptly and removes the external listener', async () => {
  let stopped = 0;
  const controller = new AbortController();
  const { registry, events } = fixture({ pathfinder: { goto: never, stop: () => stopped++ } });
  const running = registry.run('goTo', target, { signal: controller.signal });
  await tick();
  controller.abort();
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.equal(result.timed_out, false);
  assert.equal(stopped, 1);
  assert.equal(events[1].payload.cancelled, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('registry: already aborted signals log cancellation but never touch any bot API', async () => {
  const valid = {
    goTo: target, goToEntity: { uuid: UUID }, lookAt: target, say: { text: 'hi' },
    findBlock: { blockName: 'stone' }, dig: target, collectDrops: {},
    countItem: { itemName: 'oak_planks' }, craft: { itemName: 'oak_planks' },
    place: { itemName: 'oak_planks', ...target },
    equip: { itemName: 'stone' }, eat: {}, attack: { entityName: 'cow' }, sleep: {},
    deposit: { itemName: 'cobblestone' }, withdraw: { itemName: 'cobblestone', count: 1 },
    smelt: { itemName: 'cobblestone', fuel: 'coal' },
    pos: {}, blockAt: target, findEntity: { entityName: 'zombie' },
    inventory: {}, heldItem: {}, body: {},
  };
  for (const name of names) {
    const controller = new AbortController();
    controller.abort();
    const { registry, calls, events } = fixture();
    assert.equal((await registry.run(name, valid[name], { signal: controller.signal })).cancelled, true);
    // Submission-time dig safety may legitimately read blockAt; nothing else.
    assert.deepEqual(calls.filter(call => call.name !== 'blockAt'), []);
    assert.equal(events.length, 2);
  }
});

test('registry: abort before the first microtask also prevents bot calls', async () => {
  const { registry, calls } = fixture();
  const controller = new AbortController();
  const running = registry.run('say', { text: 'hi' }, { signal: controller.signal });
  controller.abort();
  assert.equal((await running).cancelled, true);
  assert.deepEqual(calls, []);
});

test('registry: injected clock schedules default deadline and clears it on success', async () => {
  let scheduled;
  let cleared;
  const clock = {
    now: () => 50,
    setTimeout(callback, ms) { scheduled = { callback, ms }; return 17; },
    clearTimeout(timer) { cleared = timer; },
  };
  const { registry } = fixture({}, { clock });
  assert.equal((await registry.run('say', { text: 'hi' })).ok, true);
  assert.equal(scheduled.ms, registry.describe('say').defaultTimeoutMs);
  assert.equal(cleared, 17);
});

test('goTo and goToEntity: correct goals, UUID matching, missing entity failure', async () => {
  const { bot, registry, calls } = fixture();
  await registry.run('goTo', { ...target, range: 3 });
  assert.ok(calls[0].args[0] instanceof goals.GoalNear);
  assert.equal(calls[0].args[0].rangeSq, 9);
  const entity = { id: 2, uuid: UUID.toUpperCase(), position: new Vec3(2, 0, 0) };
  bot.entities[2] = entity;
  assert.equal((await registry.run('goToEntity', { uuid: UUID })).ok, true);
  assert.ok(calls[1].args[0] instanceof goals.GoalFollow);
  assert.equal(calls[1].args[0].entity, entity);
  entity.isValid = false;
  const result = await registry.run('goToEntity', { uuid: UUID });
  assert.match(result.error.message, /Entity not found/);
  assert.equal(calls.length, 2);
});

test('lookAt: uses a Vec3 and say accepts the length boundaries', async () => {
  const { registry, calls } = fixture();
  await registry.run('lookAt', target);
  assert.deepEqual(calls[0].args[0], new Vec3(1, 0, 0));
  assert.equal((await registry.run('say', { text: 'x' })).ok, true);
  assert.equal((await registry.run('say', { text: 'x'.repeat(200) })).ok, true);
});

test('findBlock: real block ID and default distance, plain coordinate result or null', async () => {
  const { registry, bot, calls } = fixture();
  assert.equal((await registry.run('findBlock', { blockName: 'stone' })).result, null);
  assert.deepEqual(calls[0].args[0], { matching: mcData.blocksByName.stone.id, maxDistance: 32 });
  bot.findBlock = () => ({ position: new Vec3(2, 3, 4) });
  assert.deepEqual((await registry.run('findBlock', { blockName: 'stone', maxDistance: 8 })).result, { x: 2, y: 3, z: 4 });
});

test('dig: out of reach, absent and undiggable blocks never call dig', async () => {
  const { registry, bot, calls } = fixture();
  const outOfReach = await registry.run('dig', { x: 5, y: 0, z: 0 });
  assert.match(outOfReach.error.message, /reach/);
  assert.equal(outOfReach.error.code, 'out_of_reach');
  assert.deepEqual(calls.filter(call => call.name !== 'blockAt'), []);
  assert.match((await registry.run('dig', target)).error.message, /not diggable/);
  bot.blockAt = () => ({ position: new Vec3(1, 0, 0) });
  bot.canDigBlock = () => false;
  assert.match((await registry.run('dig', target)).error.message, /not diggable/);
  assert.equal(calls.some(call => call.name === 'dig'), false);
});

test('dig: success calls dig with target block', async () => {
  const block = { name: 'stone', position: new Vec3(1, 0, 0) };
  const { registry, calls } = fixture({ blockAt: () => block });
  assert.equal((await registry.run('dig', target)).ok, true);
  assert.deepEqual(calls.find(call => call.name === 'dig').args, [block]);
});

test('dig: abort and timeout call stopDigging even when stop throws', async () => {
  for (const cancelled of [true, false]) {
    let stopped = 0;
    const { registry } = fixture({
      blockAt: () => ({ position: new Vec3(1, 0, 0) }), dig: never,
      stopDigging() { stopped++; throw new Error('stop failed'); },
    });
    const controller = new AbortController();
    const running = registry.run('dig', target, { signal: controller.signal, timeoutMs: 50 });
    if (cancelled) { await tick(); controller.abort(); }
    const result = await running;
    assert.equal(result.cancelled, cancelled);
    assert.equal(result.timed_out, !cancelled);
    assert.equal(stopped, 1);
  }
});

test('dig: waits for a transient airborne bot before digging', async () => {
  const clock = fakeClock();
  const block = { name: 'stone', position: new Vec3(1, 0, 0) };
  const { registry, bot, calls } = fixture({
    entity: { id: 1, position: new Vec3(0, 0, 0), onGround: false },
    blockAt: () => block,
  }, { clock });
  const running = registry.run('dig', target);
  await clock.advance(1_000);
  assert.equal(calls.some(call => call.name === 'dig'), false);
  bot.entity.onGround = true;
  await clock.advance(100);
  assert.equal((await running).ok, true);
  assert.equal(calls.filter(call => call.name === 'dig').length, 1);
  assert.equal(clock.pending(), 0);
});

test('dig: a dig stalled past its live digTime is aborted and retried', async () => {
  const block = { name: 'stone', position: new Vec3(1, 0, 0) };
  const { registry, bot } = fixture({ blockAt: () => block, digTime: () => 100 });
  let attempts = 0;
  let rejectDig;
  bot.dig = () => {
    attempts++;
    if (attempts === 1) {
      bot.targetDigBlock = block;
      return new Promise((_, reject) => { rejectDig = reject; });
    }
    return Promise.resolve();
  };
  bot.stopDigging = () => {
    bot.targetDigBlock = null;
    rejectDig?.(new Error('Digging aborted'));
  };
  const result = await registry.run('dig', target);
  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
});

test('dig: a permanently stalled dig fails with dig_stalled after retries', async () => {
  const block = { name: 'stone', position: new Vec3(1, 0, 0) };
  const { registry, bot } = fixture({ blockAt: () => block, digTime: () => 100 });
  let attempts = 0;
  let rejectDig;
  bot.dig = () => {
    attempts++;
    bot.targetDigBlock = block;
    return new Promise((_, reject) => { rejectDig = reject; });
  };
  bot.stopDigging = () => {
    bot.targetDigBlock = null;
    rejectDig?.(new Error('Digging aborted'));
  };
  const result = await registry.run('dig', target);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'dig_stalled');
  assert.equal(attempts, 3);
});

// Mirrors mineflayer-pathfinder: stop() only flags; the flag kills the next setGoal(goal).
function flagPathfinder() {
  const pathfinder = {
    stopped: false,
    pending: null,
    setGoal(goal) {
      pathfinder.stateGoal = goal;
      if (pathfinder.stopped) {
        pathfinder.stopped = false;
        if (goal !== null) { pathfinder.wiped = goal; pathfinder.pending?.(); }
        pathfinder.stateGoal = null;
      }
    },
    goto(goal) {
      return new Promise((resolve, reject) => {
        let rejected = false;
        pathfinder.pending = () => { rejected = true; reject(new Error('Path was stopped before it could be completed!')); };
        pathfinder.setGoal(goal);
        if (!rejected) { pathfinder.pending = null; resolve(); }
      });
    },
    stop() { pathfinder.stopped = true; },
  };
  return pathfinder;
}

test('goTo: flushes a pending pathfinder stop flag before navigating', async () => {
  const pathfinder = flagPathfinder();
  const { registry } = fixture({ pathfinder });
  pathfinder.stop();
  assert.equal((await registry.run('goTo', target)).ok, true);
});

test('attack: a pending stop flag cannot wipe the follow goal (v1 attack_failed root cause)', async () => {
  const pathfinder = flagPathfinder();
  const sheep = { name: 'sheep', position: new Vec3(1, 0, 0), isValid: true, height: 1 };
  const { registry } = fixture({
    entities: { 2: sheep }, pathfinder,
    attack: t => { t.isValid = false; },
  });
  pathfinder.stop(); // a finished reflex task's cleanup left the flag pending
  const result = await registry.run('attack', { entityName: 'sheep', maxHits: 1 });
  assert.equal(result.ok, true);
  // Without the flush, setGoal(GoalFollow) was consumed by the stale flag and
  // she stood still until the primitive timed out — twice => attack_failed.
  assert.equal(pathfinder.wiped, undefined);
});

test('countItem: sums multiple stacks by real item ID and excludes other items', async () => {
  const { registry } = fixture({ inventory: { items: () => [
    { type: mcData.itemsByName.oak_planks.id, count: 64 },
    { type: mcData.itemsByName.stone.id, count: 30 },
    { type: mcData.itemsByName.oak_planks.id, count: 12 },
  ] } });
  assert.equal((await registry.run('countItem', { itemName: 'oak_planks' })).result, 76);
  assert.equal((await registry.run('countItem', { itemName: 'diamond' })).result, 0);
});

test('craft: missing recipe or table reports reason and never crafts', async () => {
  const { registry, calls } = fixture();
  const noRecipe = await registry.run('craft', { itemName: 'oak_planks' });
  assert.match(noRecipe.error.message, /No available recipe/);
  assert.equal(noRecipe.error.code, 'missing_ingredients');
  const noTable = await registry.run('craft', { itemName: 'crafting_table', useTable: true });
  assert.match(noTable.error.message, /No crafting table/);
  assert.equal(noTable.error.code, 'no_table');
  assert.equal(calls.some(call => call.name === 'craft'), false);
});

const matchShape = (recipe, w) => grid => {
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const want = recipe.inShape?.[y]?.[x];
    const got = grid[x + w * y];
    if (!want || want.id === -1) { if (got) return null; }
    else if (!got || got.type !== want.id) return null;
  }
  return { type: recipe.result.id, count: recipe.result.count };
};
const matchShapeless = recipe => grid => {
  const need = (recipe.ingredients ?? []).map(i => i.id);
  const have = grid.filter(Boolean).map(i => i.type);
  return have.length === need.length && need.every(id => have.includes(id))
    ? { type: recipe.result.id, count: recipe.result.count } : null;
};
const recipeResult = (recipe, w, grid) => (recipe.inShape ? matchShape(recipe, w) : matchShapeless(recipe))(grid);

function craftFixture({ stock = [], resultFor = () => null, dropClicks = () => false, syncWindow = () => Promise.resolve(), ...overrides } = {}) {
  // inv is the player's 36 storage slots; a window maps grid slots locally and inventory slots onto inv.
  const inv = new Array(36).fill(null);
  stock.forEach((item, i) => { inv[i] = item; });
  const clicks = [];
  const state = { window: null, closed: [], opened: 0, resultAt: -1 };
  class FakeWindow extends EventEmitter {
    constructor(gridSize, invStart) {
      super();
      this.gridSlots = new Array(gridSize + 1).fill(null);
      this.gridSize = gridSize;
      this.inventoryStart = invStart;
      this.inventoryEnd = invStart + inv.length;
      this.selectedItem = null;
      this.closed = false;
      const self = this;
      this.slots = new Proxy([], {
        get(t, k) {
          if (typeof k === 'string' && /^\d+$/u.test(k)) {
            const s = +k;
            return s <= self.gridSize ? self.gridSlots[s] : inv[s - self.inventoryStart];
          }
          return t[k];
        },
        set(t, k, v) {
          const s = +k;
          if (s <= self.gridSize) self.gridSlots[s] = v; else inv[s - self.inventoryStart] = v;
          return true;
        },
      });
    }
    updateSlot(slot, item) {
      this.slots[slot] = item;
      if (slot === 0 && item) state.resultAt = clicks.length;
      this.emit(`updateSlot:${slot}`, null, item);
    }
    refreshResult() { this.updateSlot(0, resultFor(Math.sqrt(this.gridSize), this.gridSlots.slice(1)) ?? null); }
    firstEmptyInventorySlot() { const i = inv.indexOf(null); return i === -1 ? null : this.inventoryStart + i; }
  }
  const inventoryWindow = new FakeWindow(4, 9);
  inventoryWindow.items = () => inv.filter(Boolean);
  const clickWindow = (slot, button, mode) => {
    clicks.push([slot, button, mode]);
    const w = state.window ?? inventoryWindow;
    if (dropClicks(slot, button, mode, w)) return Promise.resolve();
    if (mode === 1) {
      const it = w.slots[slot];
      if (it) {
        w.updateSlot(slot, null);
        if (slot === 0) for (let s = 1; s <= w.gridSize; s++) w.updateSlot(s, null);
        let left = it.count;
        for (let i = 0; i < inv.length && left; i++) {
          if (inv[i]?.type === it.type) { inv[i] = { type: it.type, count: inv[i].count + left }; left = 0; }
        }
        if (left) { const e = w.firstEmptyInventorySlot(); if (e != null) w.updateSlot(e, it); }
      }
    } else if (button === 0) {
      const held = w.selectedItem, it = w.slots[slot];
      if (!held) { w.selectedItem = it; w.updateSlot(slot, null); }
      else if (!it) { w.updateSlot(slot, held); w.selectedItem = null; }
      else if (it.type === held.type) { w.updateSlot(slot, { type: it.type, count: it.count + held.count }); w.selectedItem = null; }
      else { w.selectedItem = it; w.updateSlot(slot, held); }
    } else if (w.selectedItem && (!w.slots[slot] || w.slots[slot].type === w.selectedItem.type)) {
      w.updateSlot(slot, { type: w.selectedItem.type, count: (w.slots[slot]?.count ?? 0) + 1 });
      if (--w.selectedItem.count === 0) w.selectedItem = null;
    }
    if (slot <= w.gridSize) w.refreshResult();
    return Promise.resolve();
  };
  const f = fixture({
    inventory: inventoryWindow,
    clickWindow,
    _syncWindow: window => syncWindow(window),
    openBlock() {
      state.opened++;
      const w = new FakeWindow(9, 10);
      state.window = w;
      return Promise.resolve(w);
    },
    closeWindow(w) { w.closed = true; state.closed.push(w); if (state.window === w) state.window = null; return Promise.resolve(); },
    ...overrides,
  });
  return { ...f, inv, clicks, state, inventoryWindow };
}

test('craft: table craft fills the pickaxe shape and grabs only after the server result', async () => {
  const recipe = Recipe.find(mcData.itemsByName.wooden_pickaxe.id, null)[0];
  const table = { name: 'crafting_table', position: new Vec3(3, 0, 0) };
  const { registry, clicks, state, inventoryWindow } = craftFixture({
    findBlock: () => table,
    recipesFor: () => [recipe],
    resultFor: (size, grid) => matchShape(recipe, size)(grid),
    stock: [{ type: 36, count: 6 }, { type: 844, count: 4 }],
  });
  // A real bot.inventory stays stale while a container window is open; the grab must count via the window.
  inventoryWindow.items = () => [];
  const result = await registry.run('craft', { itemName: 'wooden_pickaxe', count: 1, useTable: true });
  assert.equal(result.ok, true);
  assert.equal(result.result.attempts, 1);
  assert.equal(result.result.count, 1);
  assert.deepEqual(clicks.filter(c => c[1] === 1).map(c => c[0]), [1, 2, 3, 5, 8]);
  const grab = clicks.findIndex(c => c[2] === 1 && c[0] === 0);
  assert.ok(state.resultAt > -1 && state.resultAt <= grab);
  assert.deepEqual(clicks.at(-1), [0, 0, 1]);
  assert.equal(state.opened, 1);
  assert.equal(state.closed.length, 1);
  assert.equal(state.closed[0].gridSlots.slice(1).every(s => !s), true);
});

test('craft: inventory 2x2 crafts planks and a crafting table without openBlock', async () => {
  const table = { name: 'crafting_table', position: new Vec3(3, 0, 0) };
  for (const [itemName, stock] of [
    ['oak_planks', [{ type: 131, count: 2 }]],
    ['crafting_table', [{ type: 36, count: 8 }]],
  ]) {
    const recipe = Recipe.find(mcData.itemsByName[itemName].id, null)[0];
    const { registry, state } = craftFixture({
      findBlock: () => table,
      recipesFor: () => [recipe],
      resultFor: (size, grid) => recipeResult(recipe, size, grid),
      stock,
    });
    const result = await registry.run('craft', { itemName, count: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.result.attempts, 1);
    assert.equal(result.result.count, recipe.result.count);
    assert.equal(state.opened, 0);
    assert.equal(state.closed.length, 0);
  }
});

test('craft: retries when the server produces no result on the first attempt', async () => {
  const recipe = Recipe.find(mcData.itemsByName.wooden_pickaxe.id, null)[0];
  const table = { name: 'crafting_table', position: new Vec3(3, 0, 0) };
  const { registry, clicks, state } = craftFixture({
    findBlock: () => table,
    recipesFor: () => [recipe],
    resultFor: (size, grid) => clicks.some(c => c[2] === 1 && c[0] >= 1 && c[0] <= size)
      ? matchShape(recipe, size)(grid) : null,
    stock: [{ type: 36, count: 8 }, { type: 844, count: 6 }],
  });
  const result = await registry.run('craft', { itemName: 'wooden_pickaxe', count: 1, useTable: true });
  assert.equal(result.ok, true);
  assert.equal(result.result.attempts, 2);
  assert.equal(result.result.count, 1);
  assert.equal(state.closed[0].gridSlots.slice(1).every(s => !s), true);
});

test('craft: fails honestly when the server never produces a result', async () => {
  const recipe = Recipe.find(mcData.itemsByName.wooden_pickaxe.id, null)[0];
  const table = { name: 'crafting_table', position: new Vec3(3, 0, 0) };
  const { registry, state } = craftFixture({
    findBlock: () => table,
    recipesFor: () => [recipe],
    stock: [{ type: 36, count: 12 }, { type: 844, count: 8 }],
  });
  const result = await registry.run('craft', { itemName: 'wooden_pickaxe', count: 1, useTable: true });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /produced nothing/);
  assert.equal(result.error.code, 'craft_rejected');
  assert.equal(state.closed.length, 1);
});

test('craft: re-places a slot when the server ignored the placement click', async () => {
  const recipe = Recipe.find(mcData.itemsByName.wooden_pickaxe.id, null)[0];
  const table = { name: 'crafting_table', position: new Vec3(3, 0, 0) };
  let dropped = false;
  const { registry, clicks, state } = craftFixture({
    findBlock: () => table,
    recipesFor: () => [recipe],
    resultFor: (size, grid) => matchShape(recipe, size)(grid),
    // The server applied this right-click with an empty cursor: the slot stays empty after sync.
    dropClicks: (slot, button) => {
      if (!dropped && button === 1 && slot === 8) { dropped = true; return true; }
      return false;
    },
    stock: [{ type: 36, count: 6 }, { type: 844, count: 4 }],
  });
  const result = await registry.run('craft', { itemName: 'wooden_pickaxe', count: 1, useTable: true });
  assert.equal(result.ok, true);
  assert.equal(result.result.attempts, 1);
  assert.equal(clicks.filter(c => c[0] === 8 && c[1] === 1).length, 2);
  assert.equal(state.closed.length, 1);
});

test('craft: puts back a cursor item the server resync disagrees with and places the right one', async () => {
  const recipe = Recipe.find(mcData.itemsByName.wooden_pickaxe.id, null)[0];
  const table = { name: 'crafting_table', position: new Vec3(3, 0, 0) };
  let swapped = false;
  const { registry, state } = craftFixture({
    findBlock: () => table,
    recipesFor: () => [recipe],
    resultFor: (size, grid) => matchShape(recipe, size)(grid),
    // The authoritative resync says the cursor holds planks and the sticks were never picked up.
    syncWindow: window => {
      if (!swapped && window.selectedItem?.type === 844) {
        swapped = true;
        window.updateSlot(window.firstEmptyInventorySlot(), window.selectedItem);
        window.selectedItem = { type: 36, count: 2 };
      }
      return Promise.resolve();
    },
    stock: [{ type: 36, count: 6 }, { type: 844, count: 4 }],
  });
  const result = await registry.run('craft', { itemName: 'wooden_pickaxe', count: 1, useTable: true });
  assert.equal(result.ok, true);
  assert.equal(result.result.attempts, 1);
  assert.equal(state.closed.length, 1);
  assert.equal(state.closed[0].selectedItem, null);
});

test('craft: retries a whole attempt when the synced grid does not match the recipe', async () => {
  const recipe = Recipe.find(mcData.itemsByName.wooden_pickaxe.id, null)[0];
  const table = { name: 'crafting_table', position: new Vec3(3, 0, 0) };
  let dropped = 0;
  const { registry, state } = craftFixture({
    findBlock: () => table,
    recipesFor: () => [recipe],
    resultFor: (size, grid) => matchShape(recipe, size)(grid),
    // Every retry of the slot-8 placement is ignored on the first attempt, so the grid verify fails.
    dropClicks: (slot, button) => button === 1 && slot === 8 && dropped++ < 3,
    stock: [{ type: 36, count: 6 }, { type: 844, count: 4 }],
  });
  const result = await registry.run('craft', { itemName: 'wooden_pickaxe', count: 1, useTable: true });
  assert.equal(result.ok, true);
  assert.equal(result.result.attempts, 2);
  assert.equal(state.closed[0].gridSlots.slice(1).every(s => !s), true);
});

test('craft: empties the cursor before closing the window after a failure', async () => {
  const recipe = Recipe.find(mcData.itemsByName.wooden_pickaxe.id, null)[0];
  const table = { name: 'crafting_table', position: new Vec3(3, 0, 0) };
  const { registry, clicks, state } = craftFixture({
    findBlock: () => table,
    recipesFor: () => [recipe],
    resultFor: () => null,
    // A resync during clearGrid leaves an item on the cursor; it must be put back before close.
    syncWindow: window => {
      const last = clicks.at(-1);
      if (window !== null && last?.[2] === 1 && last[0] >= 1 && last[0] <= 9 && !window.selectedItem) {
        window.selectedItem = { type: 844, count: 1 };
      }
      return Promise.resolve();
    },
    stock: [{ type: 36, count: 6 }, { type: 844, count: 4 }],
  });
  const result = await registry.run('craft', { itemName: 'wooden_pickaxe', count: 1, useTable: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'craft_rejected');
  assert.equal(state.closed.length, 1);
  assert.equal(state.closed[0].selectedItem, null);
});

test('craft: falls back to settling when _syncWindow is unavailable', async () => {
  const recipe = Recipe.find(mcData.itemsByName.wooden_pickaxe.id, null)[0];
  const table = { name: 'crafting_table', position: new Vec3(3, 0, 0) };
  const { registry, state } = craftFixture({
    findBlock: () => table,
    recipesFor: () => [recipe],
    resultFor: (size, grid) => matchShape(recipe, size)(grid),
    _syncWindow: undefined,
    stock: [{ type: 36, count: 6 }, { type: 844, count: 4 }],
  });
  const result = await registry.run('craft', { itemName: 'wooden_pickaxe', count: 1, useTable: true });
  assert.equal(result.ok, true);
  assert.equal(result.result.attempts, 1);
  assert.equal(state.closed.length, 1);
});

test('craft: a hung window sync fails the attempt and retries', async () => {
  const recipe = Recipe.find(mcData.itemsByName.wooden_pickaxe.id, null)[0];
  const table = { name: 'crafting_table', position: new Vec3(3, 0, 0) };
  let calls = 0;
  const { registry, state } = craftFixture({
    findBlock: () => table,
    recipesFor: () => [recipe],
    resultFor: (size, grid) => matchShape(recipe, size)(grid),
    syncWindow: () => (++calls === 1 ? never() : Promise.resolve()),
    stock: [{ type: 36, count: 6 }, { type: 844, count: 4 }],
  });
  const result = await registry.run('craft', { itemName: 'wooden_pickaxe', count: 1, useTable: true });
  assert.equal(result.ok, true);
  assert.equal(result.result.attempts, 2);
  assert.equal(state.closed[0].gridSlots.slice(1).every(s => !s), true);
});

test('craft: a resync arriving one packet late cannot poison the window view', async () => {
  const recipe = Recipe.find(mcData.itemsByName.wooden_pickaxe.id, null)[0];
  const table = { name: 'crafting_table', position: new Vec3(3, 0, 0) };
  // Mirrors the real server: _syncWindow resolves on the first window_items, which can be a
  // resync emitted for the PREVIOUS click — the view lands one packet behind. Each pair of
  // calls here is stale-then-fresh; a single sync would leave the stale view in place.
  let prev = null;
  let pending = null;
  let odd = true;
  const { registry, clicks, state, inv } = craftFixture({
    findBlock: () => table,
    recipesFor: () => [recipe],
    resultFor: (size, grid) => matchShape(recipe, size)(grid),
    syncWindow: window => {
      const snap = () => ({ sel: window.selectedItem ? { ...window.selectedItem } : null, grid: window.gridSlots.slice(), inv: inv.slice() });
      const apply = s => {
        s.grid.forEach((it, i) => window.updateSlot(i, it ? { ...it } : null));
        s.inv.forEach((it, i) => { inv[i] = it ? { ...it } : null; });
        window.selectedItem = s.sel ? { ...s.sel } : null;
      };
      if (odd) {
        const cur = snap();
        if (prev) apply(prev);
        pending = cur;
      } else {
        apply(pending);
        prev = pending;
        pending = null;
      }
      odd = !odd;
      return Promise.resolve();
    },
    stock: [{ type: 36, count: 6 }, { type: 844, count: 4 }],
  });
  const result = await registry.run('craft', { itemName: 'wooden_pickaxe', count: 1, useTable: true });
  assert.equal(result.ok, true);
  assert.equal(result.result.attempts, 1);
  assert.deepEqual(clicks.filter(c => c[1] === 1).map(c => c[0]), [1, 2, 3, 5, 8]);
  assert.equal(state.closed.length, 1);
});

test('craft: aborting while openBlock is in flight closes the window when it lands', async () => {
  const recipe = Recipe.find(mcData.itemsByName.wooden_pickaxe.id, null)[0];
  const table = { name: 'crafting_table', position: new Vec3(3, 0, 0) };
  let release;
  const opening = new Promise(resolve => { release = resolve; });
  const { registry, clicks, state } = craftFixture({
    findBlock: () => table,
    recipesFor: () => [recipe],
    openBlock: () => { state.opened++; return opening; },
    stock: [{ type: 36, count: 6 }, { type: 844, count: 4 }],
  });
  const controller = new AbortController();
  const running = registry.run('craft', { itemName: 'wooden_pickaxe', useTable: true }, { signal: controller.signal });
  while (state.opened === 0) await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.deepEqual(clicks, []);
  const lateWindow = { id: 99 };
  release(lateWindow);
  await tick();
  assert.equal(state.closed[0], lateWindow);
});

test('craft: cancellation while waiting for the result closes the window', async () => {
  const recipe = Recipe.find(mcData.itemsByName.wooden_pickaxe.id, null)[0];
  const table = { name: 'crafting_table', position: new Vec3(3, 0, 0) };
  const { registry, clicks, state } = craftFixture({
    findBlock: () => table,
    recipesFor: () => [recipe],
    stock: [{ type: 36, count: 6 }, { type: 844, count: 4 }],
  });
  const controller = new AbortController();
  const running = registry.run('craft', { itemName: 'wooden_pickaxe', useTable: true }, { signal: controller.signal });
  while (clicks.length < 9) await new Promise(resolve => setTimeout(resolve, 10));
  const atAbort = clicks.length;
  controller.abort();
  const result = await running;
  await tick();
  assert.equal(result.cancelled, true);
  assert.equal(state.closed.length, 1);
  assert.ok(clicks.slice(atAbort).every(c => c[2] === 1 || c[0] >= 9));
});

test('craft: uses real mcData oak_planks and crafting_table recipes with correct counts', async () => {
  for (const [itemName, stock] of [
    ['oak_planks', [{ type: 131, count: 8 }]],
    ['crafting_table', [{ type: 36, count: 64 }]],
  ]) {
    const type = mcData.itemsByName[itemName].id;
    assert.ok(mcData.recipes[type].length > 0);
    const recipe = Recipe.find(type, null)[0];
    const table = { name: 'crafting_table', position: new Vec3(3, 0, 0) };
    const lookups = [];
    const { registry, bot } = craftFixture({
      findBlock: () => table,
      recipesFor(id, metadata, count, receivedTable) {
        lookups.push(count);
        assert.deepEqual([id, metadata, receivedTable], [type, null, table]);
        return [recipe];
      },
      resultFor: (size, grid) => recipeResult(recipe, size, grid),
      stock,
    });
    const result = await registry.run('craft', { itemName, count: 5, useTable: true });
    assert.equal(result.ok, true);
    const wanted = Math.ceil(5 / recipe.result.count);
    assert.equal(result.result.attempts, wanted);
    assert.equal(result.result.count, wanted * recipe.result.count);
    assert.equal(lookups[0], 5);
    assert.ok(lookups.slice(1).every(count => count === 1));
    bot.findBlock = () => ({ position: new Vec3(5, 0, 0) });
    assert.match((await registry.run('craft', { itemName, useTable: true })).error.message, /within 4 blocks/);
  }
});

test('craft: defaults request one item without table', async () => {
  const recipe = Recipe.find(mcData.itemsByName.crafting_table.id, null)[0];
  const lookups = [];
  const { registry, state } = craftFixture({
    recipesFor: (...args) => {
      lookups.push(args);
      assert.deepEqual(args, [mcData.itemsByName.crafting_table.id, null, 1, null]);
      return [recipe];
    },
    resultFor: (size, grid) => matchShape(recipe, size)(grid),
    stock: [{ type: 36, count: 4 }],
  });
  const result = await registry.run('craft', { itemName: 'crafting_table' });
  assert.equal(result.ok, true);
  assert.equal(result.result.attempts, 1);
  assert.equal(state.opened, 0);
});

function placeFixture() {
  const item = { type: mcData.itemsByName.oak_planks.id, count: 10 };
  const reference = { name: 'stone', boundingBox: 'block', position: new Vec3(1, -1, 0) };
  return { item, reference, ...fixture({
    inventory: { items: () => [item] },
    blockAt: point => point.equals(reference.position) ? reference : { name: 'air', position: point },
  }) };
}

test('place: equips the requested inventory stack and selects an adjacent solid face', async () => {
  const { registry, calls, item, reference } = placeFixture();
  assert.equal((await registry.run('place', { itemName: 'oak_planks', ...target })).ok, true);
  assert.deepEqual(calls, [
    { name: 'equip', args: [item, 'hand'] },
    { name: 'placeBlock', args: [reference, new Vec3(0, 1, 0)] },
  ]);
});

test('place: occupied, unreachable, missing item and absent solid face fail before equip', async () => {
  for (const failure of ['occupied', 'unreachable', 'missing', 'no-face']) {
    const { registry, calls, bot } = placeFixture();
    let params = { itemName: 'oak_planks', ...target };
    if (failure === 'occupied') bot.blockAt = () => ({ name: 'stone' });
    if (failure === 'unreachable') params.x = 6;
    if (failure === 'missing') bot.inventory.items = () => [];
    if (failure === 'no-face') bot.blockAt = point => ({ name: 'air', position: point });
    assert.equal((await registry.run('place', params)).ok, false);
    assert.deepEqual(calls, []);
  }
});

test('place: abort during equip returns promptly and a late completion never places', async () => {
  const { registry, bot, calls } = placeFixture();
  let finish;
  bot.equip = () => new Promise(resolve => { finish = resolve; });
  const controller = new AbortController();
  const running = registry.run('place', { itemName: 'oak_planks', ...target }, { signal: controller.signal });
  await tick();
  controller.abort();
  assert.equal((await running).cancelled, true);
  finish();
  await tick();
  assert.deepEqual(calls, []);
});

function drop(id, x, count) {
  return { id, name: 'item', position: new Vec3(x, 0, 0), getDroppedItem: () => ({ count }) };
}

function fakeClock() {
  let time = 0;
  let id = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(callback, ms) { timers.set(++id, { callback, at: time + ms }); return id; },
    clearTimeout(timer) { timers.delete(timer); },
    pending: () => timers.size,
    async advance(ms) {
      const end = time + ms;
      await tick();
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        time = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await tick();
      }
      time = end;
      await tick();
    },
  };
}

test('collectDrops: rescans every 100ms and collects a drop appearing at 200ms', async () => {
  const clock = fakeClock();
  const entity = drop(2, 1, 5);
  const { registry, bot, calls, events } = fixture({}, { clock });
  clock.setTimeout(() => { bot.entities[2] = entity; }, 200);
  bot.pathfinder.goto = async goal => {
    calls.push({ name: 'goto', entity: goal.entity });
    bot.emit('playerCollect', bot.entity, goal.entity);
  };
  let completed = false;
  const running = registry.run('collectDrops', {}).then(result => { completed = true; return result; });
  await clock.advance(199);
  assert.equal(completed, false);
  assert.deepEqual(calls, []);
  await clock.advance(1);
  assert.deepEqual(await running, { ok: true, result: { count: 5, takenByOwner: {} }, cancelled: false, timed_out: false });
  assert.deepEqual(calls, [{ name: 'goto', entity }]);
  assert.equal(events[0].payload.params.settleMs, 1500);
  assert.equal(events[1].payload.duration_ms, 200);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(bot.eventNames(), []);
});

test('collectDrops: no drops returns zero exactly at settleMs without navigation', async () => {
  const clock = fakeClock();
  const { registry, bot, calls, events } = fixture({}, { clock });
  let completed = false;
  const running = registry.run('collectDrops', { settleMs: 250 })
    .then(result => { completed = true; return result; });
  await clock.advance(249);
  assert.equal(completed, false);
  assert.deepEqual(calls, []);
  await clock.advance(1);
  assert.deepEqual(await running, { ok: true, result: { count: 0, takenByOwner: {} }, cancelled: false, timed_out: false });
  assert.equal(events[1].payload.duration_ms, 250);
  assert.deepEqual(calls, []);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(bot.eventNames(), []);
});

test('collectDrops: rescans after a batch and excludes collected and gone entities', async () => {
  const clock = fakeClock();
  const first = drop(2, 1, 3);
  const second = drop(3, 2, 5);
  const vanished = drop(4, 3, 20);
  const { registry, bot } = fixture({ entities: { 2: first } }, { clock });
  const visited = [];
  bot.pathfinder.goto = async goal => {
    visited.push(goal.entity.id);
    if (goal.entity === first) {
      bot.entities[3] = second;
      bot.entities[4] = vanished;
      bot.emit('entityGone', vanished);
    }
    bot.emit('playerCollect', bot.entity, goal.entity);
    bot.emit('playerCollect', bot.entity, first);
  };
  assert.deepEqual(await registry.run('collectDrops', {}),
    { ok: true, result: { count: 8, takenByOwner: {} }, cancelled: false, timed_out: false });
  assert.deepEqual(visited, [2, 3]);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(bot.eventNames(), []);
});

test('collectDrops: cancellation during settling clears timers and all listeners', async () => {
  const clock = fakeClock();
  const controller = new AbortController();
  const { registry, bot, calls } = fixture({}, { clock });
  const running = registry.run('collectDrops', {}, { signal: controller.signal });
  await clock.advance(50);
  assert.equal(bot.listenerCount('playerCollect'), 1);
  assert.equal(bot.listenerCount('entityGone'), 1);
  assert.equal(clock.pending(), 2);
  controller.abort();
  const result = await running;
  await tick();
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(result.timed_out, false);
  assert.deepEqual(bot.eventNames(), []);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(clock.pending(), 0);
  await clock.advance(1500);
  assert.deepEqual(calls, []);
});

test('collectDrops: primitive timeout bounds settling and clears timers and listeners', async () => {
  const clock = fakeClock();
  const { registry, bot, calls } = fixture({}, { clock });
  const running = registry.run('collectDrops', {}, { timeoutMs: 150 });
  await clock.advance(150);
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.timed_out, true);
  assert.equal(result.cancelled, false);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(bot.eventNames(), []);
  assert.deepEqual(calls, []);
});

test('collectDrops: processes at most 32 entities across newly appearing batches', async () => {
  const clock = fakeClock();
  const { registry, bot } = fixture({ entities: { 2: drop(2, 1, 1) } }, { clock });
  const visited = [];
  bot.pathfinder.goto = async goal => {
    visited.push(goal.entity.id);
    const nextId = goal.entity.id + 1;
    bot.entities[nextId] = drop(nextId, 1, 1);
    bot.emit('playerCollect', bot.entity, goal.entity);
  };
  assert.deepEqual(await registry.run('collectDrops', {}),
    { ok: true, result: { count: 32, takenByOwner: {} }, cancelled: false, timed_out: false });
  assert.deepEqual(visited, Array.from({ length: 32 }, (_, i) => i + 2));
  assert.ok(bot.entities[34]);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(bot.eventNames(), []);
});

test('collectDrops: collects only items inside radius and counts confirmed self pickups once', async () => {
  const first = drop(2, 2, 3);
  const second = drop(3, 4, 5);
  const outside = drop(4, 7, 20);
  const { registry, bot } = fixture({ entities: { 2: first, 3: second, 4: outside, 5: { position: new Vec3(1, 0, 0) } } });
  const visited = [];
  bot.pathfinder.goto = async goal => {
    assert.ok(goal instanceof goals.GoalFollow);
    visited.push(goal.entity.id);
    bot.emit('playerCollect', bot.entity, goal.entity);
    bot.emit('playerCollect', bot.entity, goal.entity);
  };
  assert.equal((await registry.run('collectDrops', {})).result.count, 8);
  assert.deepEqual(visited, [2, 3]);
  assert.equal(bot.listenerCount('playerCollect'), 0);
  assert.equal(bot.listenerCount('entityGone'), 0);
});

test('collectDrops: reaching a goal waits for pickup confirmation; other collectors do not count', async () => {
  const entity = drop(2, 1, 5);
  const { registry, bot } = fixture({ entities: { 2: entity } });
  let completed = false;
  const running = registry.run('collectDrops', {}).then(result => { completed = true; return result; });
  await tick();
  assert.equal(completed, false);
  bot.emit('playerCollect', { id: 99 }, entity);
  assert.equal((await running).result.count, 0);
});

test('collectDrops: confirmed pickup wins over a pending or rejected path to a vanished entity', async () => {
  for (const rejected of [false, true]) {
    const entity = drop(2, 1, 5);
    let stopped = 0;
    const { registry, bot } = fixture({ entities: { 2: entity } });
    bot.pathfinder.stop = () => stopped++;
    bot.pathfinder.goto = () => {
      bot.emit('playerCollect', bot.entity, entity);
      return rejected ? Promise.reject(new Error('Entity disappeared')) : never();
    };
    const result = await registry.run('collectDrops', {});
    assert.equal(result.ok, true);
    assert.equal(result.result.count, 5);
    assert.equal(stopped, rejected ? 0 : 1);
    assert.equal(bot.listenerCount('playerCollect'), 0);
  }
});

test('collectDrops: vanished entities count zero; no drops requires no path', async () => {
  const clock = fakeClock();
  const { registry, bot, calls } = fixture({}, { clock });
  const empty = registry.run('collectDrops', {});
  await clock.advance(1500);
  assert.equal((await empty).result.count, 0);
  assert.deepEqual(calls, []);
  const entity = drop(2, 1, 5);
  bot.entities[2] = entity;
  const running = registry.run('collectDrops', {});
  await tick();
  bot.emit('entityGone', entity);
  assert.equal((await running).result.count, 0);
});

test('collectDrops: cancellation stops navigation and removes both event listeners', async () => {
  let stopped = 0;
  const { registry, bot } = fixture({
    entities: { 2: drop(2, 1, 5) }, pathfinder: { goto: never, stop: () => stopped++ },
  });
  const controller = new AbortController();
  const running = registry.run('collectDrops', {}, { signal: controller.signal });
  await tick();
  controller.abort();
  assert.equal((await running).cancelled, true);
  await tick();
  assert.equal(stopped, 1);
  assert.equal(bot.listenerCount('playerCollect'), 0);
  assert.equal(bot.listenerCount('entityGone'), 0);
});

test('collectDrops: pickup wait times out and removes listeners', async () => {
  const { registry, bot } = fixture({ entities: { 2: drop(2, 1, 5) } });
  assert.equal((await registry.run('collectDrops', {}, { timeoutMs: 50 })).timed_out, true);
  await tick();
  assert.equal(bot.listenerCount('playerCollect'), 0);
  assert.equal(bot.listenerCount('entityGone'), 0);
});

test('collectDrops: picks up a second drop after a mid-follow pickup leaves a stop flag', async () => {
  const first = drop(2, 1, 3);
  const second = drop(3, 2, 5);
  const pathfinder = flagPathfinder();
  const { registry, bot } = fixture({ entities: { 2: first, 3: second }, pathfinder });
  pathfinder.goto = goal => new Promise((resolve, reject) => {
    let rejected = false;
    pathfinder.pending = () => { rejected = true; reject(new Error('Path was stopped before it could be completed!')); };
    pathfinder.setGoal(goal);
    if (rejected) return;
    bot.emit('playerCollect', bot.entity, goal.entity);
    if (goal.entity === second) resolve();
    // The first follow stays pending; collectDrops aborts it once the pickup lands.
  });
  assert.deepEqual(await registry.run('collectDrops', {}),
    { ok: true, result: { count: 8, takenByOwner: {} }, cancelled: false, timed_out: false });
});

test('collectDrops: a PathStopped follow skips the drop and still collects the next one', async () => {
  const first = drop(2, 1, 3);
  const second = drop(3, 2, 5);
  const { registry, bot } = fixture({ entities: { 2: first, 3: second } });
  const visited = [];
  bot.pathfinder.goto = goal => {
    visited.push(goal.entity.id);
    if (goal.entity === first) {
      const error = new Error('Path was stopped before it could be completed! Thus, the desired goal was not reached.');
      error.name = 'PathStopped';
      return Promise.reject(error);
    }
    bot.emit('playerCollect', bot.entity, goal.entity);
    return Promise.resolve();
  };
  assert.deepEqual(await registry.run('collectDrops', {}),
    { ok: true, result: { count: 5, takenByOwner: {} }, cancelled: false, timed_out: false });
  assert.deepEqual(visited, [2, 3]);
  assert.equal(bot.listenerCount('playerCollect'), 0);
  assert.equal(bot.listenerCount('entityGone'), 0);
});

test('collectDrops: an uncollectable drop is skipped after its follow budget', async () => {
  const clock = fakeClock();
  const entity = drop(2, 1, 5);
  let stopped = 0;
  const { registry, bot } = fixture({
    entities: { 2: entity },
    pathfinder: { goto: never, stop: () => stopped++ },
  }, { clock });
  let completed = false;
  const running = registry.run('collectDrops', {}).then(result => { completed = true; return result; });
  await clock.advance(7_999);
  assert.equal(completed, false);
  await clock.advance(1);
  assert.deepEqual(await running, { ok: true, result: { count: 0, takenByOwner: {} }, cancelled: false, timed_out: false });
  assert.equal(stopped, 1);
  assert.equal(clock.pending(), 0);
  assert.deepEqual(bot.eventNames(), []);
});

test('collectDrops: NoPath and Timeout follow failures skip the drop like PathStopped', async () => {
  for (const name of ['NoPath', 'Timeout']) {
    const entity = drop(2, 1, 5);
    const { registry, bot } = fixture({ entities: { 2: entity } });
    bot.pathfinder.goto = () => Promise.reject(Object.assign(new Error('No path to the goal!'), { name }));
    assert.deepEqual(await registry.run('collectDrops', {}),
      { ok: true, result: { count: 0, takenByOwner: {} }, cancelled: false, timed_out: false });
    assert.equal(bot.listenerCount('playerCollect'), 0);
    assert.equal(bot.listenerCount('entityGone'), 0);
  }
});

// --- T18b: containers and furnace --------------------------------------------

const items = (name, count) => ({ name, type: mcData.itemsByName[name].id, count });
const worldBlock = (name, x, z) => ({ name, position: new Vec3(x, 0, z), type: mcData.blocksByName[name].id, boundingBox: 'block' });
const stackOf = (list, id) => list.filter(i => i?.type === id).reduce((n, i) => n + i.count, 0);
const waitUntil = async (fn, tries = 200) => {
  for (let i = 0; i < tries && !fn(); i++) await tick();
  if (!fn()) throw new Error('condition never became true');
};

// A window split in two regions: [0, containerSize) is the container, the rest the
// player's 36 slots. Clicks apply vanilla-like semantics and state is authoritative.
function containerFixture({ containerSize = 27, containerStock = [], stock = [], blocks = [],
  dropClicks = () => false, onSync, syncAvailable = true, ...overrides } = {}) {
  const container = new Array(containerSize).fill(null);
  containerStock.forEach((item, i) => { container[i] = item; });
  const inv = new Array(36).fill(null);
  stock.forEach((item, i) => { inv[i] = item; });
  const clicks = [];
  const state = { window: null, closed: [], opened: 0 };
  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      this.inventoryStart = containerSize;
      this.inventoryEnd = containerSize + inv.length;
      this.selectedItem = null;
      this.closed = false;
      this.slots = new Proxy([], {
        get(t, k) {
          if (typeof k === 'string' && /^\d+$/u.test(k)) {
            const s = +k;
            return s < containerSize ? container[s] : inv[s - containerSize];
          }
          return t[k];
        },
        set(t, k, v) {
          const s = +k;
          if (s < containerSize) container[s] = v; else inv[s - containerSize] = v;
          return true;
        },
      });
    }
    updateSlot(slot, item) { this.slots[slot] = item; this.emit(`updateSlot:${slot}`, null, item); }
    firstEmptyInventorySlot() { const i = inv.indexOf(null); return i === -1 ? null : this.inventoryStart + i; }
  }
  const moveStack = (w, slot) => {
    const it = w.slots[slot];
    if (!it) return;
    const [start, end] = slot >= w.inventoryStart ? [0, w.inventoryStart] : [w.inventoryStart, w.inventoryEnd];
    let left = it.count;
    for (let s = start; s < end && left; s++) {
      const target = w.slots[s];
      if (target?.type === it.type && target.count < (target.stackSize ?? 64)) {
        const n = Math.min((target.stackSize ?? 64) - target.count, left);
        target.count += n; left -= n;
      }
    }
    for (let s = start; s < end && left; s++) {
      if (!w.slots[s]) { w.updateSlot(s, { ...it, count: left }); left = 0; }
    }
    w.updateSlot(slot, left > 0 ? { ...it, count: left } : null);
  };
  const clickWindow = (slot, button, mode) => {
    clicks.push([slot, button, mode]);
    const w = state.window;
    if (!w || dropClicks(slot, button, mode, w)) return Promise.resolve();
    if (mode === 1) moveStack(w, slot);
    else if (button === 0) {
      const held = w.selectedItem;
      const it = w.slots[slot];
      if (!held) { w.selectedItem = it; w.updateSlot(slot, null); }
      else if (!it) { w.updateSlot(slot, held); w.selectedItem = null; }
      else if (it.type === held.type && it.count < (it.stackSize ?? 64)) {
        const n = Math.min((it.stackSize ?? 64) - it.count, held.count);
        it.count += n; held.count -= n;
        if (!held.count) w.selectedItem = null;
      } else { w.selectedItem = it; w.updateSlot(slot, held); }
    } else if (button === 1 && w.selectedItem) {
      const it = w.slots[slot];
      if (!it || (it.type === w.selectedItem.type && it.count < (it.stackSize ?? 64))) {
        w.updateSlot(slot, { ...w.selectedItem, count: (it?.count ?? 0) + 1 });
        if (--w.selectedItem.count === 0) w.selectedItem = null;
      }
    }
    return Promise.resolve();
  };
  const f = fixture({
    findBlock: ({ matching, maxDistance }) => {
      const origin = f.bot.entity.position;
      return [...blocks]
        .filter(b => b.position.distanceTo(origin) <= (maxDistance ?? Infinity))
        .filter(b => typeof matching === 'function' ? matching(b)
          : Array.isArray(matching) ? matching.includes(b.type) : matching === b.type)
        .sort((a, b) => a.position.distanceTo(origin) - b.position.distanceTo(origin))[0] ?? null;
    },
    openContainer() { state.opened++; const w = new FakeWindow(); state.window = w; return Promise.resolve(w); },
    openFurnace() { state.opened++; const w = new FakeWindow(); state.window = w; return Promise.resolve(w); },
    clickWindow,
    _syncWindow: syncAvailable ? window => { onSync?.(window); return Promise.resolve(); } : undefined,
    closeWindow(w) { w.closed = true; state.closed.push(w); if (state.window === w) state.window = null; return Promise.resolve(); },
    inventory: { items: () => inv.filter(Boolean) },
    ...overrides,
  });
  return { ...f, inv, container, clicks, state };
}

test('registry: deposit, withdraw and smelt describe exactly; withdraw is owner-only', () => {
  const { registry } = fixture();
  assert.deepEqual(registry.list(), names);
  const owned = fixture({}, { ownerUuid: UUID });
  assert.deepEqual(owned.registry.list(), ownerNames);
  const deposit = registry.describe('deposit');
  assert.deepEqual(Object.keys(deposit.params), ['itemName', 'count']);
  assert.equal(deposit.params.count.max, 2304);
  assert.equal(deposit.defaultTimeoutMs, 30_000);
  const withdraw = owned.registry.describe('withdraw');
  assert.deepEqual(Object.keys(withdraw.params), ['itemName', 'count']);
  assert.equal(withdraw.params.count.default, 1);
  assert.equal(withdraw.params.count.max, 2304);
  assert.equal(withdraw.defaultTimeoutMs, 30_000);
  const smelt = registry.describe('smelt');
  assert.deepEqual(Object.keys(smelt.params), ['itemName', 'count', 'fuel', 'x', 'y', 'z']);
  assert.equal(smelt.params.count.max, 64);
  assert.equal(smelt.reach, 4);
  assert.equal(smelt.defaultTimeoutMs, 120_000);
});

test('smelt: non-smeltable inputs and non-fuels fail in the validate phase', () => {
  const { registry, calls } = fixture();
  for (const [params, field] of [
    [{ itemName: 'dirt', fuel: 'coal' }, 'itemName'],
    [{ itemName: 'iron_ingot', fuel: 'coal' }, 'itemName'],
    [{ itemName: 'raw_iron', fuel: 'dirt' }, 'fuel'],
    [{ itemName: 'raw_iron', fuel: 'wheat' }, 'fuel'],
  ]) {
    assert.throws(() => registry.run('smelt', params), error =>
      error instanceof InvalidParamsError && error.field === field);
  }
  assert.deepEqual(calls, []);
});

test('deposit: moves every requested item into the nearest allowlisted container', async () => {
  const { registry, container, inv, state } = containerFixture({
    blocks: [worldBlock('ender_chest', 1, 0), worldBlock('chest', 3, 0)],
    stock: [items('cobblestone', 30), items('oak_planks', 5)],
  });
  const result = await registry.run('deposit', { itemName: 'cobblestone' });
  assert.equal(result.ok, true);
  assert.equal(result.result.moved, 30);
  assert.deepEqual(result.result.container, { x: 3, y: 0, z: 0 });
  assert.equal(stackOf(container, mcData.itemsByName.cobblestone.id), 30);
  assert.equal(stackOf(inv, mcData.itemsByName.cobblestone.id), 0);
  assert.equal(stackOf(inv, mcData.itemsByName.oak_planks.id), 5);
  assert.equal(state.closed.length, 1);
});

test('deposit: a count splits the stack exactly with a right-click transfer', async () => {
  const { registry, container, inv, clicks } = containerFixture({
    blocks: [worldBlock('barrel', 2, 0)],
    stock: [items('cobblestone', 30)],
  });
  const result = await registry.run('deposit', { itemName: 'cobblestone', count: 20 });
  assert.equal(result.ok, true);
  assert.equal(result.result.moved, 20);
  assert.equal(stackOf(container, mcData.itemsByName.cobblestone.id), 20);
  assert.equal(stackOf(inv, mcData.itemsByName.cobblestone.id), 10);
  assert.ok(clicks.filter(c => c[1] === 1).length >= 20);
});

test('deposit: not_enough_items fails before touching the container', async () => {
  const { registry, state, clicks } = containerFixture({
    blocks: [worldBlock('chest', 1, 0)],
    stock: [items('cobblestone', 5)],
  });
  const result = await registry.run('deposit', { itemName: 'cobblestone', count: 8 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'not_enough_items');
  assert.equal(state.opened, 0);
  assert.equal(clicks.length, 0);
});

test('deposit: no allowlisted container nearby fails honestly', async () => {
  const { registry, state } = containerFixture({
    blocks: [worldBlock('ender_chest', 1, 0), worldBlock('shulker_box', 1, 2)],
    stock: [items('cobblestone', 5)],
  });
  const result = await registry.run('deposit', { itemName: 'cobblestone' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'no_container');
  assert.equal(state.opened, 0);
});

test('deposit: a full container reports what actually moved', async () => {
  const full = Array(26).fill(null).map(() => items('dirt', 64));
  full.push(items('cobblestone', 63));
  const { registry, container } = containerFixture({
    blocks: [worldBlock('chest', 1, 0)],
    containerStock: full,
    stock: [items('cobblestone', 10)],
  });
  const result = await registry.run('deposit', { itemName: 'cobblestone' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'container_full');
  assert.equal(result.error.moved, 1);
  assert.equal(stackOf(container, mcData.itemsByName.cobblestone.id), 64);
});

test('deposit: moves that never take effect retry then fail container_desync', async () => {
  const { registry } = containerFixture({
    blocks: [worldBlock('chest', 1, 0)],
    stock: [items('cobblestone', 5)],
    dropClicks: () => true,
  });
  const result = await registry.run('deposit', { itemName: 'cobblestone' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'container_desync');
  assert.equal(result.error.moved, 0);
});

test('deposit: a rejected initial sync still closes the container window', async () => {
  const { registry, state } = containerFixture({
    blocks: [worldBlock('chest', 1, 0)],
    stock: [items('cobblestone', 5)],
    onSync: () => { throw new Error('sync rejected'); },
  });
  const result = await registry.run('deposit', { itemName: 'cobblestone' });
  assert.equal(result.ok, false);
  assert.equal(state.opened, 1);
  assert.equal(state.closed.length, 1);
});

test('deposit: aborting while the container opens still cancels cleanly', async () => {
  const { registry, state } = containerFixture({
    blocks: [worldBlock('chest', 1, 0)],
    stock: [items('cobblestone', 5)],
    openContainer() { return new Promise(() => {}); },
  });
  const controller = new AbortController();
  const running = registry.run('deposit', { itemName: 'cobblestone' }, { signal: controller.signal });
  await tick();
  controller.abort();
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  assert.equal(state.closed.length, 0);
});

test('deposit: cancelling with a held cursor item empties the cursor before closing', async () => {
  const controller = new AbortController();
  const { registry, state, inv, container } = containerFixture({
    blocks: [worldBlock('chest', 1, 0)],
    stock: [items('cobblestone', 30)],
    onSync: window => { if (window.selectedItem) controller.abort(); },
  });
  const result = await registry.run('deposit', { itemName: 'cobblestone', count: 5 }, { signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  // run() resolves on the abort race while the primitive still unwinds its finally.
  await waitUntil(() => state.closed.length === 1);
  assert.equal(state.closed[0].selectedItem, null);
  assert.equal(stackOf(inv, mcData.itemsByName.cobblestone.id), 30);
  assert.equal(stackOf(container, mcData.itemsByName.cobblestone.id), 0);
});

test('withdraw: takes the requested count out of the chest', async () => {
  const { registry, container, inv, state } = containerFixture({
    blocks: [worldBlock('chest', 2, 0)],
    containerStock: [items('cobblestone', 16)],
  }, { ownerUuid: UUID });
  const result = await registry.run('withdraw', { itemName: 'cobblestone', count: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.result.moved, 5);
  assert.equal(stackOf(inv, mcData.itemsByName.cobblestone.id), 5);
  assert.equal(stackOf(container, mcData.itemsByName.cobblestone.id), 11);
  assert.equal(state.closed.length, 1);
});

test('withdraw: whole stacks shift-move when they fit the count', async () => {
  const { registry, clicks } = containerFixture({
    blocks: [worldBlock('barrel', 2, 0)],
    containerStock: [items('cobblestone', 3)],
  }, { ownerUuid: UUID });
  const result = await registry.run('withdraw', { itemName: 'cobblestone', count: 3 });
  assert.equal(result.ok, true);
  assert.ok(clicks.some(c => c[2] === 1));
  assert.equal(result.result.moved, 3);
});

test('withdraw: not_enough_in_container takes nothing', async () => {
  const { registry, container, inv, clicks } = containerFixture({
    blocks: [worldBlock('chest', 1, 0)],
    containerStock: [items('cobblestone', 2)],
  }, { ownerUuid: UUID });
  const result = await registry.run('withdraw', { itemName: 'cobblestone', count: 5 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'not_enough_in_container');
  assert.equal(result.error.moved, 0);
  assert.equal(stackOf(container, mcData.itemsByName.cobblestone.id), 2);
  assert.equal(stackOf(inv, mcData.itemsByName.cobblestone.id), 0);
  assert.equal(clicks.length, 0);
});

test('withdraw: a full inventory reports what actually moved', async () => {
  const { registry } = containerFixture({
    blocks: [worldBlock('chest', 1, 0)],
    containerStock: [items('cobblestone', 10)],
    stock: new Array(36).fill(null).map(() => items('dirt', 64)),
  }, { ownerUuid: UUID });
  const result = await registry.run('withdraw', { itemName: 'cobblestone', count: 5 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'inventory_full');
  assert.equal(result.error.moved, 0);
});

test('smelt: cooks the exact count and pulls leftovers out before closing', async () => {
  const { registry, inv, state } = containerFixture({
    containerSize: 3,
    blocks: [worldBlock('furnace', 1, 0)],
    stock: [items('raw_iron', 3), items('coal', 1)],
  });
  const running = registry.run('smelt', { itemName: 'raw_iron', count: 3, fuel: 'coal' });
  await waitUntil(() => (state.window?.slots[0]?.count ?? 0) === 3 && (state.window?.slots[1]?.count ?? 0) === 1);
  for (let i = 0; i < 3; i++) {
    state.window.updateSlot(0, { ...state.window.slots[0], count: state.window.slots[0].count - 1 });
    state.window.updateSlot(2, items('iron_ingot', 1));
    await tick();
  }
  const result = await running;
  assert.equal(result.ok, true);
  assert.equal(result.result.count, 3);
  assert.equal(result.result.output, 'iron_ingot');
  assert.equal(stackOf(inv, mcData.itemsByName.iron_ingot.id), 3);
  assert.equal(state.closed.length, 1);
  assert.equal(state.closed[0].slots[0] ?? null, null);
  assert.equal(state.closed[0].slots[1] ?? null, null);
});

test('smelt: output taken by someone else is counted and the smelt continues', async () => {
  const { registry, inv, state, events } = containerFixture({
    containerSize: 3,
    blocks: [worldBlock('furnace', 1, 0)],
    stock: [items('raw_iron', 3), items('coal', 1)],
  });
  const running = registry.run('smelt', { itemName: 'raw_iron', count: 3, fuel: 'coal' });
  await waitUntil(() => (state.window?.slots[0]?.count ?? 0) === 3);
  // First ingot she collects normally.
  state.window.updateSlot(2, items('iron_ingot', 1));
  await tick();
  // Second ingot: the owner grabs it in the gap between the slot update and
  // her shift-click (the update event fires before her click runs).
  state.window.updateSlot(0, { ...state.window.slots[0], count: 2 });
  state.window.updateSlot(2, items('iron_ingot', 1));
  state.window.updateSlot(2, null);
  await tick();
  state.window.updateSlot(0, { ...state.window.slots[0], count: 1 });
  state.window.updateSlot(2, items('iron_ingot', 1));
  await tick();
  const result = await running;
  assert.equal(result.ok, true);
  assert.equal(result.result.taken, 1);
  assert.equal(result.result.count, 2);
  assert.ok(events.some(e => e.kind === 'body.items_taken'
    && e.payload.where === 'furnace' && e.payload.item === 'iron_ingot' && e.payload.count === 1));
});

test('smelt: a furnace holding different items is furnace_busy', async () => {
  for (const furnaceStock of [
    [items('raw_gold', 1)],
    [null, items('oak_planks', 1)],
    [null, null, items('cooked_beef', 1)],
  ]) {
    const { registry, inv, state } = containerFixture({
      containerSize: 3,
      blocks: [worldBlock('furnace', 1, 0)],
      containerStock: furnaceStock,
      stock: [items('raw_iron', 2), items('coal', 1)],
    });
    const result = await registry.run('smelt', { itemName: 'raw_iron', count: 2, fuel: 'coal' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'furnace_busy');
    assert.equal(stackOf(inv, mcData.itemsByName.raw_iron.id), 2);
    assert.equal(state.closed.length, 1);
  }
});

test('smelt: no furnace in reach and missing stock fail before opening', async () => {
  const { registry, state } = containerFixture({ containerSize: 3, stock: [items('raw_iron', 2), items('coal', 1)] });
  const result = await registry.run('smelt', { itemName: 'raw_iron', count: 1, fuel: 'coal' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'no_furnace');
  const missing = containerFixture({
    containerSize: 3, blocks: [worldBlock('furnace', 1, 0)], stock: [items('raw_iron', 2)],
  });
  const failed = await missing.registry.run('smelt', { itemName: 'raw_iron', count: 2, fuel: 'coal' });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, 'missing_ingredients');
  assert.equal(missing.state.opened, 0);
});

test('smelt: output already in the furnace is taken but not counted', async () => {
  const { registry, state, inv } = containerFixture({
    containerSize: 3,
    blocks: [worldBlock('furnace', 1, 0)],
    containerStock: [null, null, items('iron_ingot', 2)],
    stock: [items('raw_iron', 2), items('coal', 1)],
  });
  const running = registry.run('smelt', { itemName: 'raw_iron', count: 2, fuel: 'coal' });
  await waitUntil(() => (state.window?.slots[0]?.count ?? 0) === 2);
  for (let i = 0; i < 2; i++) {
    state.window.updateSlot(2, items('iron_ingot', 1));
    await tick();
  }
  const result = await running;
  assert.equal(result.ok, true);
  assert.equal(result.result.count, 2);
  assert.equal(stackOf(inv, mcData.itemsByName.iron_ingot.id), 4);
});

test('smelt: no output for the stall window fails smelt_stalled and cleans up', async () => {
  const clock = fakeClock();
  const { registry, state, inv } = containerFixture({
    containerSize: 3,
    blocks: [worldBlock('furnace', 1, 0)],
    stock: [items('raw_iron', 3), items('coal', 1)],
  }, { clock });
  const running = registry.run('smelt', { itemName: 'raw_iron', count: 3, fuel: 'coal' });
  await waitUntil(() => (state.window?.slots[0]?.count ?? 0) === 3);
  await waitUntil(() => state.window?.listenerCount('updateSlot:2') > 0);
  await clock.advance(15_000);
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'smelt_stalled');
  assert.equal(state.closed.length, 1);
  assert.equal(stackOf(inv, mcData.itemsByName.raw_iron.id), 3);
  assert.equal(stackOf(inv, mcData.itemsByName.coal.id), 1);
});

test('smelt: cancelling mid-run takes the input and fuel back before closing', async () => {
  const controller = new AbortController();
  const { registry, state, inv } = containerFixture({
    containerSize: 3,
    blocks: [worldBlock('furnace', 1, 0)],
    stock: [items('raw_iron', 3), items('coal', 1)],
  });
  const running = registry.run('smelt', { itemName: 'raw_iron', count: 3, fuel: 'coal' }, { signal: controller.signal });
  await waitUntil(() => (state.window?.slots[0]?.count ?? 0) === 3 && state.window?.listenerCount('updateSlot:2') > 0);
  controller.abort();
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
  // run() resolves on the abort race while the primitive still unwinds its finally.
  await waitUntil(() => state.closed.length === 1);
  assert.equal(stackOf(inv, mcData.itemsByName.raw_iron.id), 3);
  assert.equal(stackOf(inv, mcData.itemsByName.coal.id), 1);
});

test('smelt: a lost placement click is retried inside the same run', async () => {
  let dropped = false;
  const { registry, state, inv } = containerFixture({
    containerSize: 3,
    blocks: [worldBlock('furnace', 1, 0)],
    stock: [items('raw_iron', 2), items('coal', 1)],
    dropClicks: (slot, button, mode) => {
      if (!dropped && slot === 1 && button === 0 && mode === 0) { dropped = true; return true; }
      return false;
    },
  });
  const running = registry.run('smelt', { itemName: 'raw_iron', count: 2, fuel: 'coal' });
  await waitUntil(() => (state.window?.slots[0]?.count ?? 0) === 2);
  for (let i = 0; i < 2; i++) {
    state.window.updateSlot(2, items('iron_ingot', 1));
    await tick();
  }
  const result = await running;
  assert.equal(result.ok, true);
  assert.equal(result.result.count, 2);
  assert.equal(stackOf(inv, mcData.itemsByName.iron_ingot.id), 2);
});

test('registry.query: a synchronous primitive still returns a thenable', async () => {
  const { registry } = fixture();
  const pending = registry.query('countItem', { itemName: 'oak_log' });
  assert.equal(typeof pending.then, 'function');
  assert.equal(await pending, 0);
  await assert.rejects(() => registry.query('dig', { x: 0, y: 0, z: 0 }), /not queryable/);
});
