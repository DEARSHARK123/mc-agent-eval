import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDraft, substitute } from '../src/skills/format.js';
import { resolveStep } from '../src/skills/bindings.js';
import { interpret } from '../src/skills/interpreter.js';
import { createPrimitiveRegistry } from '../src/primitives/registry.js';
import { mcData } from '../src/teaching/lexicon.js';

// P1 §2 grammar extensions: `at:"$id.below|above"` (2a), `$id.field` params
// references (2b) and body-predicate conditions (2c) — all additive.
const OWNER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const registry = createPrimitiveRegistry({ mcData, ownerUuid: OWNER });
const ok = value => validateDraft(value, { registry });
const drop = () => ({ primitive: 'collectDrops', params: {} });
const find = (id = 'ore') => ({ primitive: 'findBlock', params: { blockName: 'stone' }, id });
const findEntity = (id = 'e') => ({ primitive: 'findEntity', params: { entityName: 'zombie', radius: 16 }, id });
const draft = (body, params = {}, name = 'test_skill') => ({ name, description: 'test', params, body });

// runPrimitive stub mirroring the arbiter contract: resolved step via
// resolveStep, bound results recorded under step.id for later refs.
function stubbed(impls = {}) {
  const calls = [];
  const runPrimitive = async (step, bindings) => {
    const resolved = resolveStep(step, bindings, {});
    calls.push({ primitive: resolved.primitive, params: resolved.params });
    const result = impls[resolved.primitive]?.(resolved) ?? null;
    if (step.id !== undefined) {
      bindings.set(step.id, result);
      if (step.params?.blockName) bindings.blockNames?.set(step.id, step.params.blockName);
    }
    return result;
  };
  const run = async (body, { args = {}, params = {}, trace = [] } = {}) => {
    await interpret({ program: { body, params, args }, isActive: () => true, trace, runPrimitive });
    return { calls, trace };
  };
  return { calls, run, runPrimitive };
}

// --- §2a `at` offsets --------------------------------------------------------

test('P1 2a validateDraft accepts $id.below/$id.above on earlier visible ids', () => {
  for (const at of ['$ore.below', '$ore.above']) {
    assert.deepEqual(ok(draft([find('ore'), { primitive: 'dig', params: {}, at }])), { ok: true, errors: [] });
  }
  // Outer ids stay visible inside nested bodies.
  assert.equal(ok(draft([find('ore'), { repeat: 2, body: [{ primitive: 'dig', params: {}, at: '$ore.below' }] }])).ok, true);
  assert.equal(ok(draft([find('ore'), { primitive: 'goTo', params: {}, at: '$ore.above' }])).ok, true);
  // Existing targets unchanged; P2 A1 makes bare `$id` equivalent to `id`.
  for (const at of ['ore', '$ore', '$self.below', '$self.front', '$owner']) {
    assert.equal(ok(draft([find('ore'), { primitive: 'dig', params: {}, at }])).ok, true, at);
  }
});

test('P1 2a validateDraft rejects unknown suffixes, forward and invisible ids', () => {
  const bad = [
    [find('ore'), { primitive: 'dig', params: {}, at: '$ore.north' }],                    // unknown suffix
    [find('ore'), { primitive: 'dig', params: {}, at: '$ore.side' }],
    [find('ore'), { primitive: 'dig', params: {}, at: '$ore.abovee' }],
    [{ primitive: 'dig', params: {}, at: '$ore.below' }, find('ore')],                    // forward id
    [{ primitive: 'dig', params: {}, at: '$ore.below' }],                                 // never bound
    [{ primitive: 'dig', params: {}, id: 'ore', at: '$ore.below' }],                      // self reference
    [find('ore'), { primitive: 'dig', params: { x: 1 }, at: '$ore.below' }],              // x/y/z conflict still applies
    [{ primitive: 'dig', params: {}, at: '$self.above' }],                                // 'self' is not a bound id
    [find('ore'), { primitive: 'dig', params: {}, at: 'ore.below' }],                     // missing $
  ];
  for (const body of bad) assert.equal(ok(draft(body)).ok, false, JSON.stringify(body));
});

test('P1 2a resolveStep offsets bound positions and keeps goTo range handling', () => {
  const prior = new Map([['b', { x: 3, y: 62, z: -8 }]]);
  prior.blockNames = new Map([['b', 'coal_ore']]);
  assert.deepEqual(resolveStep({ primitive: 'dig', params: {}, at: '$b.below' }, prior).params, { x: 3, y: 61, z: -8 });
  assert.deepEqual(resolveStep({ primitive: 'dig', params: {}, at: '$b.above' }, prior).params, { x: 3, y: 63, z: -8 });
  assert.deepEqual(resolveStep({ primitive: 'goTo', params: { range: 9 }, at: '$b.below' }, prior).params,
    { x: 3, y: 61, z: -8, range: 1 });
  // Plain-object prior results work the same way.
  assert.deepEqual(resolveStep({ primitive: 'dig', params: {}, at: '$b.below' }, { b: { x: 1, y: 64, z: 2 } }).params,
    { x: 1, y: 63, z: 2 });
});

test('P1 2a resolveStep rejects unknown offsets, missing bindings and coordinate conflicts', () => {
  const prior = new Map([['b', { x: 3, y: 62, z: -8 }]]);
  assert.throws(() => resolveStep({ primitive: 'dig', params: {}, at: '$b.north' }, prior), error => error.code === 'invalid_binding');
  assert.throws(() => resolveStep({ primitive: 'dig', params: {}, at: '$b.0' }, prior), error => error.code === 'invalid_binding');
  for (const at of ['$b.below', '$b.above']) {
    assert.throws(() => resolveStep({ primitive: 'dig', params: {}, at }, new Map()), error => error.code === 'target_not_found');
    assert.throws(() => resolveStep({ primitive: 'dig', params: {}, at }, new Map([['b', null]])),
      error => error.code === 'target_not_found');
  }
  assert.throws(() => resolveStep({ primitive: 'dig', params: { x: 0 }, at: '$b.below' }, prior), error => error.code === 'invalid_binding');
});

// --- §2b `$id.field` params references --------------------------------------

test('P1 2b validateDraft accepts whitelisted field refs on earlier visible ids', () => {
  const good = [
    draft([findEntity('e'), { primitive: 'attack', params: { entityName: '$e.entityName' } }]),
    draft([findEntity('e'), { primitive: 'goToEntity', params: { uuid: '$e.uuid' } }]),
    draft([find('e'), { primitive: 'findBlock', params: { blockName: '$e.blockName' } }]),
    draft([find('e'), { primitive: 'countItem', params: { itemName: '$e.name' } }]),
    draft([find('e'), { primitive: 'goTo', params: { x: 1, y: 64, z: 2, range: '$e.count' } }]),
    // A declared param sharing the id's name does not capture a dotted ref.
    draft([findEntity('e'), { primitive: 'attack', params: { entityName: '$e.entityName' } }],
      { e: { type: 'item', default: 'stick' } }),
    // Outer ids stay visible inside nested bodies.
    draft([findEntity('e'), { repeat: 2, body: [{ primitive: 'goToEntity', params: { uuid: '$e.uuid' } }] }]),
  ];
  for (const value of good) assert.deepEqual(ok(value), { ok: true, errors: [] }, JSON.stringify(value.body));
  // Declared-param refs unchanged.
  assert.deepEqual(ok(draft([{ primitive: 'findBlock', params: { blockName: '$block' } }],
    { block: { type: 'block', default: 'dirt' } })), { ok: true, errors: [] });
});

test('P1 2b validateDraft rejects non-whitelisted fields, forward and param-only ids', () => {
  const e = findEntity('e');
  const bad = [
    draft([e, { primitive: 'attack', params: { entityName: '$e.position' } }]),          // non-whitelisted field
    draft([e, { primitive: 'attack', params: { entityName: '$e.entityname' } }]),        // case-sensitive
    draft([e, { primitive: 'attack', params: { entityName: '$e.uuid.extra' } }]),        // two dots is not a ref
    draft([{ primitive: 'goToEntity', params: { uuid: '$e.uuid' } }, e]),                // forward id
    draft([{ primitive: 'goToEntity', params: { uuid: '$e.uuid' } }]),                   // never bound
    draft([{ primitive: 'goToEntity', params: { uuid: '$e.uuid' } }],
      { e: { type: 'number', default: 1 } }),                                            // param name is not a step id
  ];
  for (const value of bad) assert.equal(ok(value).ok, false, JSON.stringify(value.body));
});

test('P1 2b field refs only apply to primitive params, not conditions/repeat/call args', () => {
  const e = findEntity('e');
  const bad = [
    draft([e, { if: { hasItem: '$e.name', atLeast: 1 }, then: [drop()] }]),
    draft([e, { if: { hasItem: 'dirt', atLeast: '$e.count' }, then: [drop()] }]),
    draft([e, { repeat: '$e.count', body: [drop()] }]),
  ];
  for (const value of bad) assert.equal(ok(value).ok, false, JSON.stringify(value.body));
  // Call args reject step refs even when the callee declares a matching param.
  const child = { name: 'child', params: { item: { type: 'item', required: true } }, body: [drop()] };
  const call = draft([e, { call: 'child', args: { item: '$e.name' } }]);
  assert.equal(validateDraft(call, { registry, skills: [child] }).ok, false);
});

test('P1 2b substitute leaves $id.field for the interpreter bindings pass', () => {
  assert.deepEqual(substitute({ a: '$p', b: '$e.uuid', c: 3, d: 'plain' }, { p: 5 }),
    { a: 5, b: '$e.uuid', c: 3, d: 'plain' });
});

test('P1 2b interpret resolves $id.field params from bound step results', async () => {
  const bound = { x: 1, y: 64, z: 2, entityName: 'zombie', uuid: OWNER };
  const { calls, run } = stubbed({ findEntity: () => bound });
  await run([
    findEntity('e'),
    { primitive: 'attack', params: { entityName: '$e.entityName' } },
    { primitive: 'goToEntity', params: { uuid: '$e.uuid', range: 3 } },
  ]);
  assert.deepEqual(calls[1], { primitive: 'attack', params: { entityName: 'zombie' } });
  assert.deepEqual(calls[2], { primitive: 'goToEntity', params: { uuid: OWNER, range: 3 } });
});

test('P1 2b interpret fails target_not_found for unbound ids or missing fields', async () => {
  for (const [label, body, impls] of [
    ['unbound', [{ primitive: 'attack', params: { entityName: '$e.entityName' } }], {}],
    ['null result', [findEntity('e'), { primitive: 'attack', params: { entityName: '$e.entityName' } }],
      { findEntity: () => null }],
    ['missing field', [find('e'), { primitive: 'attack', params: { entityName: '$e.entityName' } }],
      { findBlock: () => ({ x: 1, y: 2, z: 3 }) }],
    ['missing field on null', [findEntity('e'), { primitive: 'goToEntity', params: { uuid: '$e.uuid' } }],
      { findEntity: () => null }],
  ]) {
    const { run, calls } = stubbed(impls);
    await assert.rejects(run(body), error => error.code === 'target_not_found', label);
    assert.equal(calls.length, body.length - 1, label); // the ref step never dispatched
  }
});

// --- §2c body predicates -----------------------------------------------------

test('P1 2c validateDraft accepts body predicates, nested and mixed with old shapes', () => {
  const good = [
    { healthBelow: 10 }, { healthBelow: 1 }, { healthBelow: 20 },
    { foodBelow: 6 }, { foodBelow: 20 },
    { hasEffect: 'bad_omen' }, { hasEffect: 'speed' }, { hasEffect: 'mining_fatigue' },
    { not: { healthBelow: 5 } },
    { all: [{ healthBelow: 5 }, { hasEffect: 'bad_omen' }] },
    { any: [{ foodBelow: 2 }, { found: 'ore' }] },
    { not: { all: [{ healthBelow: 8 }, { any: [{ foodBelow: 4 }, { hasEffect: 'hunger' }] }] } },
    { all: [{ healthBelow: 5 }, { hasItem: 'dirt', atLeast: 1 }] },
  ];
  for (const cond of good) assert.equal(ok(draft([find('ore'), { if: cond, then: [drop()] }])).ok, true, JSON.stringify(cond));
});

test('P1 2c validateDraft rejects invalid thresholds, names and mixed shapes', () => {
  const bad = [
    { healthBelow: 0 }, { healthBelow: 21 }, { healthBelow: 2.5 }, { healthBelow: '10' }, { healthBelow: '$p' },
    { foodBelow: 0 }, { foodBelow: 21 }, { foodBelow: 'x' },
    { hasEffect: 5 }, { hasEffect: null }, { hasEffect: 'made_up_effect' }, { hasEffect: 'BadOmen' },
    { healthBelow: 5, foodBelow: 5 }, { healthBelow: 5, extra: 1 }, { hasEffect: 'bad_omen', found: 'ore' },
    { not: { not: { not: { not: { healthBelow: 5 } } } } }, // same depth limit as other conditions
  ];
  for (const cond of bad) assert.equal(ok(draft([find('ore'), { if: cond, then: [drop()] }])).ok, false, JSON.stringify(cond));
});

test('P1 2c conditions evaluate through the body query primitive', async () => {
  const state = { health: 10, food: 5, oxygen: 20, onGround: true, effects: ['bad_omen'] };
  const branch = async cond => {
    const { calls, runPrimitive } = stubbed({ body: () => state });
    const trace = [];
    await interpret({
      program: { body: [{ if: cond, then: [{ primitive: 'say', params: { text: 'yes' } }],
        else: [{ primitive: 'say', params: { text: 'no' } }] }], params: {}, args: {} },
      isActive: () => true, trace, runPrimitive,
    });
    return { calls, branch: trace[0].branch, said: calls.filter(call => call.primitive === 'say').at(-1)?.params.text };
  };
  for (const [cond, want] of [
    [{ healthBelow: 20 }, 'then'], [{ healthBelow: 10 }, 'else'], [{ healthBelow: 9 }, 'else'],
    [{ foodBelow: 6 }, 'then'], [{ foodBelow: 5 }, 'else'],
    [{ hasEffect: 'bad_omen' }, 'then'], [{ hasEffect: 'speed' }, 'else'],
    [{ not: { healthBelow: 20 } }, 'else'], [{ not: { healthBelow: 9 } }, 'then'],
    [{ all: [{ healthBelow: 20 }, { hasEffect: 'bad_omen' }] }, 'then'],
    [{ all: [{ healthBelow: 20 }, { hasEffect: 'speed' }] }, 'else'],
    [{ any: [{ foodBelow: 1 }, { hasEffect: 'bad_omen' }] }, 'then'],
    [{ any: [{ foodBelow: 1 }, { hasEffect: 'speed' }] }, 'else'],
  ]) {
    const result = await branch(cond);
    assert.equal(result.branch, want, JSON.stringify(cond));
    assert.equal(result.said, want === 'then' ? 'yes' : 'no');
    assert.ok(result.calls.some(call => call.primitive === 'body'), 'body query dispatched');
  }
  // Short-circuit: the second predicate never queries body.
  const { calls, run } = stubbed({ body: () => state });
  await run([{ if: { all: [{ healthBelow: 5 }, { foodBelow: 1 }] }, then: [drop()], else: [drop()] }]);
  assert.equal(calls.filter(call => call.primitive === 'body').length, 1);
});

test('P1 2c null body snapshot is false and invalid values fail invalid_args', async () => {
  const { calls, run } = stubbed({ body: () => null });
  const trace = [];
  await run([{ if: { healthBelow: 20 }, then: [drop()], else: [{ primitive: 'say', params: { text: 'no' } }] }], { trace });
  assert.equal(trace[0].branch, 'else');
  assert.equal(calls.at(-1).params.text, 'no');
  for (const cond of [{ healthBelow: 'x' }, { healthBelow: 0 }, { hasEffect: 5 }]) {
    await assert.rejects(run([{ if: cond, then: [drop()], else: [drop()] }]), error => error.code === 'invalid_args');
  }
});

// --- regression: pre-P1 drafts and programs unchanged ------------------------

test('P1 regression: pre-P1 drafts validate and programs dispatch as before', async () => {
  const drafts = [
    draft([find('target'), { primitive: 'dig', params: {}, at: 'target' }]),
    draft([{ primitive: 'dig', params: {}, at: '$self.below' }]),
    draft([{ primitive: 'place', params: { itemName: 'dirt' }, at: '$self.front' }]),
    draft([{ primitive: 'goTo', params: {}, at: '$owner' }]),
    draft([find('target'), { if: { found: 'target' }, then: [drop()], else: [{ fail: 'target_not_found' }] }]),
    draft([{ if: { hasItem: 'dirt', atLeast: 3 }, then: [drop()] }]),
    draft([{ if: { not: { all: [{ hasItem: 'dirt', atLeast: 1 }] } }, then: [drop()] }]),
    draft([{ primitive: 'findBlock', params: { blockName: '$block' } }, { repeat: '$count', body: [drop()] }],
      { block: { type: 'block', default: 'dirt' }, count: { type: 'count', default: 2 } }),
  ];
  for (const value of drafts) assert.deepEqual(ok(value), { ok: true, errors: [] }, JSON.stringify(value.body));

  // findBlock -> bound `at` dig, `$param` substitution and `found` all unchanged.
  const { calls, run } = stubbed({ findBlock: () => ({ x: 1, y: 2, z: 3 }), countItem: () => 2 });
  const trace = [];
  await run([
    { primitive: 'findBlock', params: { blockName: '$block' }, id: 't' },
    { if: { found: 't' }, then: [{ primitive: 'dig', params: {}, at: 't' }], else: [{ fail: 'target_not_found' }] },
    { if: { hasItem: 'dirt', atLeast: 1 }, then: [drop()], else: [{ fail: 'missing_item' }] },
  ], { params: { block: { type: 'block', required: true } }, args: { block: 'stone' }, trace });
  assert.deepEqual(calls.map(call => call.primitive), ['findBlock', 'dig', 'countItem', 'collectDrops']);
  assert.deepEqual(calls[0].params, { blockName: 'stone' });
  assert.deepEqual(calls[1].params, { x: 1, y: 2, z: 3 });
  assert.deepEqual(calls[2].params, { itemName: 'dirt' });
  assert.deepEqual(trace.map(entry => entry.branch), ['then', 'then']);
});
