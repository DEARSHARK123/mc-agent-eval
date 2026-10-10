import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { createPrimitiveRegistry, InvalidParamsError } from '../src/primitives/registry.js';
import { resolveStep } from '../src/skills/bindings.js';
import { validateDraft } from '../src/skills/format.js';
import { Vec3 } from '../src/primitives/helpers.js';
import { createSim, createProbeContext } from '../scripts/probe/sim.js';

const mcData = createRequire(import.meta.url)('minecraft-data')('1.20.4');

// P2 workflow B: findBlock/findEntity take an optional integer x/y/z search-
// center override (which is also what `at` merges into), all-or-none, inside
// the same 32-block perception ambit as mutating targets.
function fixture(overrides = {}, options = {}) {
  const bot = new EventEmitter();
  const calls = [];
  const record = (name, result) => (...args) => { calls.push({ name, args }); return result; };
  Object.assign(bot, {
    entity: { id: 1, position: new Vec3(0, 0, 0), onGround: true, effects: {} },
    entities: {},
    inventory: { items: record('items', []), emptySlotCount: record('emptySlotCount', 0) },
    blockAt: record('blockAt', null), findBlock: record('findBlock', null),
    health: 20, food: 20, oxygenLevel: 15, heldItem: null,
  }, overrides);
  const eventlog = { append() {} };
  const registry = createPrimitiveRegistry({ bot, eventlog, mcData, ...options });
  return { bot, calls, registry };
}

test('P2 B schema: findBlock/findEntity expose optional integer x/y/z; blockAt stays required', () => {
  const { registry } = fixture();
  for (const name of ['findBlock', 'findEntity']) {
    const { params, description } = registry.describe(name);
    for (const axis of ['x', 'y', 'z']) {
      assert.equal(params[axis].type, 'number', `${name}.${axis}`);
      assert.equal(params[axis].integer, true, `${name}.${axis} must be an integer`);
      assert.equal(params[axis].required, undefined, `${name}.${axis} stays optional`);
    }
    assert.match(description, /32 blocks/, `${name} description documents the ambit`);
  }
  for (const axis of ['x', 'y', 'z']) {
    assert.equal(registry.describe('blockAt').params[axis].required, true,
      `blockAt.${axis} is still required — a point query, not a search`);
  }
});

test('P2 B findEntity: x/y/z re-center the search away from the bot', async () => {
  const { registry } = fixture({
    entities: {
      2: { name: 'zombie', uuid: 'u-near', position: new Vec3(2, 0, 0), isValid: true },
      3: { name: 'zombie', uuid: 'u-far', position: new Vec3(30, 0, 0), isValid: true },
      // Beyond the bot's own maximum radius (39 > 32): only reachable via a
      // legal in-ambit center at (24,0,0) — distance 15 from it.
      4: { name: 'skeleton', uuid: 'u-edge', position: new Vec3(39, 0, 0), isValid: true },
    },
  });
  assert.deepEqual(await registry.query('findEntity', { entityName: 'zombie' }),
    { x: 2, y: 0, z: 0, entityName: 'zombie', uuid: 'u-near' }, 'default center is her position');
  assert.deepEqual(await registry.query('findEntity', { entityName: 'zombie', x: 28, y: 0, z: 0 }),
    { x: 30, y: 0, z: 0, entityName: 'zombie', uuid: 'u-far' }, 'nearest to the center wins');
  // The skeleton is 39 blocks from the bot — invisible to a default search —
  // but 15 from the center, inside radius 20.
  assert.equal(await registry.query('findEntity', { entityName: 'skeleton' }), null,
    'unreachable from the bot position alone');
  assert.deepEqual(await registry.query('findEntity', { entityName: 'skeleton', radius: 20, x: 24, y: 0, z: 0 }),
    { x: 39, y: 0, z: 0, entityName: 'skeleton', uuid: 'u-edge' },
    'radius is measured from the center, not from the bot');
});

test('P2 B findBlock: x/y/z are forwarded as the mineflayer point and order results', async () => {
  let seen;
  const { registry } = fixture({
    findBlocks: options => { seen = options; return [new Vec3(1, 0, 0), new Vec3(22, 0, 0)]; },
  });
  assert.deepEqual(await registry.query('findBlock', { blockName: 'stone' }), { x: 1, y: 0, z: 0 });
  assert.equal(seen.point, undefined, 'no override -> no point option (bot position)');
  assert.deepEqual(await registry.query('findBlock', { blockName: 'stone', x: 24, y: 0, z: 0 }),
    { x: 22, y: 0, z: 0 }, 'nearest to the center wins');
  assert.deepEqual({ x: seen.point.x, y: seen.point.y, z: seen.point.z }, { x: 24, y: 0, z: 0 },
    'the override reaches mineflayer as options.point');
});

test('P2 B validation: the x/y/z center is all-or-none and integer', async () => {
  const { registry } = fixture();
  for (const partial of [{ x: 1 }, { y: 0 }, { z: 2 }, { x: 1, z: 2 }]) {
    assert.throws(() => registry.validate('findBlock', { blockName: 'stone', ...partial }),
      InvalidParamsError, JSON.stringify(partial));
    await assert.rejects(() => registry.query('findEntity', { entityName: 'zombie', ...partial }),
      InvalidParamsError, JSON.stringify(partial));
    assert.throws(() => registry.run('findEntity', { entityName: 'zombie', ...partial }),
      InvalidParamsError, JSON.stringify(partial));
  }
  assert.throws(() => registry.validate('findBlock', { blockName: 'stone', x: 1.5, y: 0, z: 0 }),
    InvalidParamsError, 'non-integer center rejected by the schema itself');
  assert.doesNotThrow(() => registry.validate('findBlock', { blockName: 'stone', x: 8, y: 0, z: 8 }),
    'a complete in-ambit triple validates');
});

test('P2 B ambit: a search center beyond 32 blocks fails out_of_ambit', async () => {
  const { registry } = fixture(); // bot at (0,0,0)
  assert.throws(() => registry.validate('findBlock', { blockName: 'stone', x: 33, y: 0, z: 0 }),
    error => error.code === 'out_of_ambit');
  assert.throws(() => registry.validate('findEntity', { entityName: 'zombie', x: 0, y: 0, z: 40 }),
    error => error.code === 'out_of_ambit');
  await assert.rejects(() => registry.query('findEntity', { entityName: 'zombie', x: 0, y: 0, z: 40 }),
    error => error.code === 'out_of_ambit', 'the free-query path checks it too');
  // The boundary is inclusive — exactly 32 stays legal.
  assert.doesNotThrow(() => registry.validate('findEntity', { entityName: 'zombie', x: 32, y: 0, z: 0 }));
});

test('P2 B at: a bound position becomes the search center through resolveStep', async () => {
  const { registry } = fixture(); // bot at (0,0,0)
  const draft = body => ({ name: 'test_skill', description: 't', params: {}, body });
  // Once the schema takes x/y/z the existing at machinery is legal on its own.
  assert.equal(validateDraft(draft([
    { primitive: 'findBlock', params: { blockName: 'stone' }, id: 'b' },
    { primitive: 'findEntity', params: { entityName: 'zombie' }, at: 'b' },
    { primitive: 'findBlock', params: { blockName: 'coal_ore' }, at: '$b' },
  ]), { registry }).ok, true, 'at:"id" and at:"$id" are legal on the find* queries');
  const resolved = resolveStep({ primitive: 'findBlock', params: { blockName: 'stone' }, at: 'b' },
    new Map([['b', { x: 10, y: 0, z: 10 }]]));
  assert.deepEqual(resolved.params, { blockName: 'stone', x: 10, y: 0, z: 10 });
  assert.doesNotThrow(() => registry.validate(resolved.primitive, resolved.params),
    'an in-ambit bound position passes (14.1 < 32)');
  const far = resolveStep({ primitive: 'findEntity', params: { entityName: 'zombie' }, at: '$e' },
    new Map([['e', { x: 100, y: 0, z: 0, entityName: 'zombie' }]]));
  assert.throws(() => registry.validate(far.primitive, far.params),
    error => error.code === 'out_of_ambit', 'an at-bound center obeys the same ambit');
});

test('P2 B sim parity: findBlock/findEntity re-center with identical rules', async () => {
  const sim = createSim();
  sim.flat();
  sim.setBlock(13, 1, 13, 'chest');  // ~1.4 from the bot at (12,1,12)
  sim.setBlock(20, 1, 20, 'chest');  // ~11.3 from the bot, ~1.4 from (21,1,21)
  sim.addEntity({ name: 'zombie', uuid: 'z-near', x: 13, y: 1, z: 13 });
  sim.addEntity({ name: 'zombie', uuid: 'z-far', x: 20, y: 1, z: 20 });
  const { registry, executeBody } = createProbeContext(sim);
  assert.equal(registry.describe('findEntity').params.x.integer, true,
    'the sim schema mirror exposes the override too');

  assert.deepEqual((await registry.run('findBlock', { blockName: 'chest' })).result,
    { x: 13, y: 1, z: 13, blockName: 'chest' }, 'default center is the bot');
  assert.equal((await registry.run('findEntity', { entityName: 'zombie' })).result.uuid, 'z-near');
  assert.deepEqual((await registry.run('findBlock', { blockName: 'chest', x: 21, y: 1, z: 21 })).result,
    { x: 20, y: 1, z: 20, blockName: 'chest' });
  assert.equal((await registry.run('findEntity', { entityName: 'zombie', x: 22, y: 1, z: 22 })).result.uuid,
    'z-far');

  for (const [name, params] of [
    ['findBlock', { blockName: 'chest', x: 5 }],
    ['findEntity', { entityName: 'zombie', z: 5 }],
  ]) {
    const partial = await registry.run(name, params);
    assert.equal(partial.ok, false, `${name} partial center`);
    assert.equal(partial.error.name, 'InvalidParamsError', `${name} partial center`);
  }
  // The sim world is only 24x24x10 — an out-of-ambit center sits outside it.
  for (const [name, params] of [
    ['findBlock', { blockName: 'chest', x: 60, y: 1, z: 12 }],
    ['findEntity', { entityName: 'zombie', x: 60, y: 1, z: 12 }],
  ]) {
    const result = await registry.run(name, params);
    assert.equal(result.ok, false, `${name} out-of-ambit center`);
    assert.equal(result.error.code, 'out_of_ambit', `${name} out-of-ambit center`);
  }

  // End-to-end in the sim: `at` on a query binds the found position as center.
  const run = await executeBody({ body: [
    { primitive: 'findBlock', params: { blockName: 'chest' }, id: 'c' },
    { primitive: 'findEntity', params: { entityName: 'zombie' }, at: 'c' },
  ] });
  assert.equal(run.executed, true);
  assert.equal(run.results[1].result.uuid, 'z-near', 'at:"c" searched around the chest');
});

test('P2 B blockAt: point query unchanged — far coordinates read air, never out_of_ambit', async () => {
  const { registry } = fixture(); // bot at (0,0,0), blockAt reads nothing
  assert.deepEqual(await registry.query('blockAt', { x: 100, y: 0, z: 0 }),
    { x: 100, y: 0, z: 0, blockName: 'air' }, 'a point query has no ambit to violate');
  await assert.rejects(() => registry.query('blockAt', { x: 1.5, y: 0, z: 0 }), InvalidParamsError);
});
