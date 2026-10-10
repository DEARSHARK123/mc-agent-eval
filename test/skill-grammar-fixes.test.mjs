import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { createGoalRunner } from '../src/decision/goals.js';
import { createArbiter } from '../src/arbiter.js';
import { createPrimitiveRegistry, InvalidParamsError } from '../src/primitives/registry.js';
import { createProtection } from '../src/safety/protection.js';
import { createActionCost } from '../src/cost.js';
import { interpret } from '../src/skills/interpreter.js';

const mcData = createRequire(import.meta.url)('minecraft-data')('1.20.4');

function eventlogFake(now = () => Date.now()) {
  const rows = [];
  return {
    rows,
    append(kind, payload, traceId) { rows.push({ id: rows.length + 1, ts: now(), kind, payload, trace_id: traceId }); },
    query({ kind, since, limit = Number.MAX_SAFE_INTEGER } = {}) {
      return rows.filter(row => (kind === undefined || row.kind === kind)
        && (since === undefined || row.ts >= since)).slice(0, limit);
    },
  };
}

// A lone dirt block one step away: obtain('dirt') plans a single collect step,
// the intent's rule fallback picks the dig candidate — so the dig travels the
// toolRegistry wrapper, not the outer `run` helper. Both bill through `cost`.
function goalWorld({ stock = {}, limit = 300 } = {}) {
  const inv = { ...stock };
  const calls = [];
  const bot = {
    entity: { position: new Vec3(0, 1, 0) },
    entities: {},
    inventory: {
      items: () => Object.entries(inv).filter(([, n]) => n > 0)
        .map(([name, count]) => ({ name, count, type: mcData.itemsByName[name].id })),
      emptySlotCount: () => 9,
    },
    findBlocks: () => [new Vec3(1, 1, 0)],
    blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
  };
  const impl = async (name, p = {}) => {
    calls.push({ name, p });
    if (name === 'countItem') return { ok: true, result: inv[p.itemName] ?? 0 };
    if (name === 'dig') { inv.dirt = (inv.dirt ?? 0) + 1; return { ok: true, result: { x: p.x, y: p.y, z: p.z } }; }
    if (name === 'goTo') { bot.entity.position = new Vec3(p.x, p.y, p.z); return { ok: true, result: {} }; }
    if (name === 'craft') { inv.oak_planks = (inv.oak_planks ?? 0) + 4; return { ok: true, result: {} }; }
    return { ok: true, result: {} };
  };
  const registry = {
    has: () => true,
    run: (name, params) => impl(name, params),
    query: async (name, params) => (await impl(name, params)).result,
  };
  const eventlog = eventlogFake();
  const cost = createActionCost({ eventlog, limit });
  const arbiter = createArbiter({ registry, eventlog });
  const goals = createGoalRunner({ registry, arbiter, bot, mcData, eventlog, cost });
  const spent = () => eventlog.rows.filter(row => row.kind === 'budget.action_spent');
  return { bot, calls, cost, goals, spent };
}

test('obtain bills its inner dig under plan/idle sources', async () => {
  for (const source of ['plan', 'idle']) {
    const w = goalWorld();
    const result = await w.goals.obtainInline({ item: 'dirt', count: 1,
      context: { source, isActive: () => true, traceId: `t29-${source}` } });
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    assert.ok(w.calls.some(call => call.name === 'dig'), 'the collect step dug');
    assert.deepEqual(w.spent().map(row => row.payload), [{ source, primitive: 'dig' }]);
    assert.equal(w.cost.remaining(), 299);
  }
});

test('owner/reflex obtains are never checked and never charged', async () => {
  for (const source of ['owner', 'reflex']) {
    const w = goalWorld({ limit: 0 });
    const result = await w.goals.obtainInline({ item: 'dirt', count: 1,
      context: { source, isActive: () => true } });
    assert.equal(result.status, 'succeeded', `${source}: ${JSON.stringify(result)}`);
    assert.ok(w.calls.some(call => call.name === 'dig'), `${source} dig still ran at zero budget`);
    assert.equal(w.spent().length, 0);
  }
});

test('an exhausted budget fails the mutating step honestly', async () => {
  const w = goalWorld({ stock: { oak_log: 1 }, limit: 0 });
  const result = await w.goals.obtainInline({ item: 'oak_planks', count: 1,
    context: { source: 'plan', isActive: () => true } });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'action_budget_exhausted');
  assert.equal(result.failedStep, 0);
  assert.equal(w.calls.length, 0, 'the craft step was refused before registry.run');
  assert.equal(w.spent().length, 0, 'a refused step never reaches trySpend');
});

// --- place protection --------------------------------------------------------

function placeWorld(zones) {
  const eventlog = eventlogFake();
  const protection = createProtection({ eventlog });
  for (const zone of zones) protection.add(zone);
  const calls = [];
  const bot = {
    entity: { position: new Vec3(0, 1, 0) },
    entities: {},
    inventory: { items: () => [{ name: 'oak_planks', type: mcData.itemsByName.oak_planks.id, count: 5 }] },
    blockAt: pos => pos.y === 0
      ? { name: 'stone', boundingBox: 'block', position: pos }
      : { name: 'air', boundingBox: 'empty', position: pos },
    equip: (...args) => { calls.push(['equip', ...args]); return Promise.resolve(); },
    placeBlock: (...args) => { calls.push(['placeBlock', ...args]); return Promise.resolve(); },
  };
  const registry = createPrimitiveRegistry({ bot, eventlog, mcData, protection });
  return { calls, registry };
}

test('place inside a foreign protection zone is rejected at submission', async () => {
  const { calls, registry } = placeWorld([{ x: 4, y: 1, z: 0, radius: 3, reason: 'owner' }]);
  assert.throws(() => registry.run('place', { itemName: 'oak_planks', x: 4, y: 1, z: 0 }),
    error => error instanceof InvalidParamsError && error.message.includes('protected'));
  assert.equal(calls.length, 0, 'bot.placeBlock was never called');
});

test('place inside her own_build zone is exempt; digging there still is not', async () => {
  const { calls, registry } = placeWorld([{ x: 1, y: 1, z: 2, radius: 2, reason: 'own_build' }]);
  const placed = await registry.run('place', { itemName: 'oak_planks', x: 1, y: 1, z: 2 });
  assert.equal(placed.ok, true, JSON.stringify(placed));
  assert.deepEqual(placed.result, { x: 1, y: 1, z: 2 });
  assert.equal(calls.filter(call => call[0] === 'placeBlock').length, 1);
  // Dig has no own_build exemption: breaking inside any zone stays protected.
  assert.throws(() => registry.run('dig', { x: 1, y: 1, z: 2 }),
    error => error instanceof InvalidParamsError && error.message.includes('protected'));
});

// --- $id.count scalar binding ------------------------------------------------

function stubbed(impls = {}) {
  const calls = [];
  const runPrimitive = async (step, bindings) => {
    calls.push({ primitive: step.primitive, params: step.params });
    const result = impls[step.primitive]?.(step) ?? null;
    if (step.id !== undefined) bindings.set(step.id, result);
    return result;
  };
  const run = body => interpret({
    program: { body, params: {}, args: {} },
    isActive: () => true, trace: [], runPrimitive,
  });
  return { calls, run };
}

test('$id.count resolves a bare countItem number to itself', async () => {
  const { calls, run } = stubbed({ countItem: () => 7 });
  await run([
    { primitive: 'countItem', params: { itemName: 'oak_log' }, id: 'n' },
    { primitive: 'goTo', params: { x: 1, y: 64, z: 2, range: '$n.count' } },
  ]);
  assert.equal(calls[1].params.range, 7, 'the bound scalar answers its own count field');
});

test('other fields on a scalar binding still fail target_not_found', async () => {
  for (const ref of ['$n.uuid', '$n.name', '$n.blockName']) {
    const { calls, run } = stubbed({ countItem: () => 7 });
    await assert.rejects(run([
      { primitive: 'countItem', params: { itemName: 'oak_log' }, id: 'n' },
      { primitive: 'goToEntity', params: { uuid: ref } },
    ]), error => error.code === 'target_not_found', ref);
    assert.equal(calls.length, 1, `${ref}: the referencing step never dispatched`);
  }
});

// --- findEntity entityName ----------------------------------------------------

test('findEntity takes entityName end-to-end through the registry', async () => {
  const bot = {
    entity: { position: new Vec3(0, 0, 0), isValid: true },
    entities: {
      2: { name: 'zombie', uuid: 'u-far', position: new Vec3(9, 0, 0), isValid: true },
      3: { name: 'zombie', uuid: 'u-near', position: new Vec3(3, 0, 0), isValid: true },
      4: { name: 'cow', uuid: 'u-cow', position: new Vec3(1, 0, 0), isValid: true },
    },
  };
  const registry = createPrimitiveRegistry({ bot, eventlog: eventlogFake(), mcData });
  const found = await registry.run('findEntity', { entityName: 'zombie' });
  assert.equal(found.ok, true);
  assert.deepEqual(found.result, { x: 3, y: 0, z: 0, entityName: 'zombie', uuid: 'u-near' });
  assert.deepEqual(await registry.query('findEntity', { entityName: 'zombie' }), found.result,
    'the free query path resolves the same param');
  // The old `name` field is gone from the schema.
  assert.throws(() => registry.run('findEntity', { name: 'zombie' }), InvalidParamsError);
});
