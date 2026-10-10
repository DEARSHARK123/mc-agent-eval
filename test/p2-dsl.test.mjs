import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDraft, validateArgs, substitute } from '../src/skills/format.js';
import { resolveStep, resultFields } from '../src/skills/bindings.js';
import { interpret } from '../src/skills/interpreter.js';
import { normalizeDraft } from '../src/skills/repair.js';
import { createSkillLibrary } from '../src/skills/library.js';
import { createPrimitiveRegistry } from '../src/primitives/registry.js';
import { mcData } from '../src/teaching/lexicon.js';
import { removePathRobust } from '../src/fsutil.js';

// P2 workflow A: DSL conformance — `at:"$id"`, `$id.x`/`$id.y`/`$id.z` result
// fields, the `minecraft:` namespace alias and say.text interpolation.
const OWNER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const registry = createPrimitiveRegistry({ mcData, ownerUuid: OWNER });
const ok = value => validateDraft(value, { registry });
const drop = () => ({ primitive: 'collectDrops', params: {} });
const find = (id = 'ore') => ({ primitive: 'findBlock', params: { blockName: 'stone' }, id });
const findEntity = (id = 'e') => ({ primitive: 'findEntity', params: { entityName: 'zombie', radius: 16 }, id });
const draft = (body, params = {}, name = 'test_skill') => ({ name, description: 'test', params, body });
const ownerBot = {
  entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0 },
  entities: {},
  players: { TestOwner: { uuid: OWNER, username: 'TestOwner' } },
};

// runPrimitive stub mirroring the arbiter contract: resolved step via
// resolveStep, bound results recorded under step.id for later refs.
function stubbed(impls = {}, resolverOptions = {}) {
  const calls = [];
  const runPrimitive = async (step, bindings) => {
    const resolved = resolveStep(step, bindings, resolverOptions);
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

// --- A1 `at:"$id"` -----------------------------------------------------------

test('P2 A1 validateDraft accepts at:"$id" equivalent to at:"id"', () => {
  for (const at of ['ore', '$ore']) {
    assert.deepEqual(ok(draft([find('ore'), { primitive: 'dig', params: {}, at }])), { ok: true, errors: [] });
  }
  // Outer ids stay visible inside nested bodies and other at forms are untouched.
  assert.equal(ok(draft([find('ore'), { repeat: 2, body: [{ primitive: 'dig', params: {}, at: '$ore' }] }])).ok, true);
  assert.equal(ok(draft([find('ore'), { primitive: 'goTo', params: {}, at: '$ore' }])).ok, true);
  assert.equal(ok(draft([find('ore'), { primitive: 'dig', params: {}, at: '$ore.below' }])).ok, true);
});

test('P2 A1 validateDraft rejects $at ids that are not earlier visible ids', () => {
  const bad = [
    [{ primitive: 'dig', params: {}, at: '$ore' }],                                    // never bound
    [{ primitive: 'dig', params: {}, at: '$ore' }, find('ore')],                       // forward id
    [{ primitive: 'dig', params: {}, id: 'ore', at: '$ore' }],                         // self reference
    [find('ore'), { primitive: 'dig', params: { x: 1 }, at: '$ore' }],                 // x/y/z conflict still applies
    [find('ore'), { primitive: 'dig', params: {}, at: '$Ore' }],                       // case-sensitive
    [find('ore'), { primitive: 'dig', params: {}, at: '$ore.abovee' }],                // not a known suffix
    [{ primitive: 'say', params: { text: 'hi' }, at: '$ore' }],                        // say takes no 'at'
  ];
  for (const body of bad) assert.equal(ok(draft(body)).ok, false, JSON.stringify(body));
});

test('P2 A1 resolveStep resolves at:"$id" to the bound position like at:"id"', () => {
  const prior = new Map([['b', { x: 3, y: 62, z: -8 }]]);
  prior.blockNames = new Map([['b', 'coal_ore']]);
  assert.deepEqual(resolveStep({ primitive: 'dig', params: {}, at: '$b' }, prior).params, { x: 3, y: 62, z: -8 });
  assert.deepEqual(resolveStep({ primitive: 'goTo', params: { range: 9 }, at: '$b' }, prior).params,
    { x: 3, y: 62, z: -8, range: 1 });
  assert.deepEqual(resolveStep({ primitive: 'dig', params: {}, at: '$b' }, { b: { x: 1, y: 64, z: 2 } }).params,
    { x: 1, y: 64, z: 2 });
});

test('P2 A1 goTo at a block-bound target lands beside it, an entity target does not', () => {
  const bot = { entity: { position: { x: 10.5, y: 62, z: -8.5 } } };
  const blocks = new Map([['b', { x: 3, y: 62, z: -8 }]]);
  blocks.blockNames = new Map([['b', 'coal_ore']]);
  assert.deepEqual(resolveStep({ primitive: 'goTo', params: {}, at: '$b' }, blocks, { bot }).params,
    { x: 4, y: 62, z: -8, range: 1.2 });
  const mobs = new Map([['e', { x: 5, y: 62, z: -8, entityName: 'zombie', uuid: 'u1' }]]);
  assert.deepEqual(resolveStep({ primitive: 'goTo', params: {}, at: '$e' }, mobs, { bot }).params,
    { x: 5, y: 62, z: -8, range: 1 });
  // No bot position to aim from → the old stay-close clamp still applies.
  assert.deepEqual(resolveStep({ primitive: 'goTo', params: {}, at: '$b' }, blocks).params,
    { x: 3, y: 62, z: -8, range: 1 });
});

test('P2 A1 resolveStep fails unbound, malformed or conflicting $at cleanly', () => {
  const prior = new Map([['b', { x: 3, y: 62, z: -8 }]]);
  prior.blockNames = new Map([['b', 'coal_ore']]);
  // An unbound `$id` fails like a bare id — target_not_found, not a syntax error.
  assert.throws(() => resolveStep({ primitive: 'dig', params: {}, at: '$b' }, new Map()),
    error => error.code === 'target_not_found');
  const missing = new Map([['b', null]]);
  missing.blockNames = new Map([['b', 'coal_ore']]);
  assert.throws(() => resolveStep({ primitive: 'dig', params: {}, at: '$b' }, missing),
    error => error.code === 'target_not_found' && error.blockName === 'coal_ore');
  // Malformed `$` shapes stay invalid_binding; coordinate conflicts still fire.
  for (const at of ['$B', '$$b', '$.b', '$']) {
    assert.throws(() => resolveStep({ primitive: 'dig', params: {}, at }, prior),
      error => error.code === 'invalid_binding', at);
  }
  assert.throws(() => resolveStep({ primitive: 'dig', params: { x: 0 }, at: '$b' }, prior),
    error => error.code === 'invalid_binding');
});

test('P2 A1 interpret dispatches at:"$id" end-to-end', async () => {
  const { calls, run } = stubbed({ findBlock: () => ({ x: 4, y: 63, z: -2 }) });
  await run([find('ore'), { primitive: 'dig', params: {}, at: '$ore' }]);
  assert.deepEqual(calls[1], { primitive: 'dig', params: { x: 4, y: 63, z: -2 } });
});

// --- A2 `$id.x`/`$id.y`/`$id.z` ----------------------------------------------

test('P2 A2 resultFields whitelists x/y/z and validateDraft accepts them as numbers', () => {
  for (const field of ['x', 'y', 'z']) assert.equal(resultFields.has(field), true, field);
  for (const field of ['x', 'y', 'z']) {
    const body = [find('e'), { primitive: 'goTo', params: { x: 1, y: 64, z: 2, range: `$e.${field}` } }];
    assert.equal(ok(draft(body)).ok, true, field);
  }
  // Coordinate params and count-typed slots take them too.
  assert.equal(ok(draft([find('e'), { primitive: 'blockAt', params: { x: '$e.x', y: '$e.y', z: '$e.z' } }])).ok, true);
  assert.equal(ok(draft([find('e'), { primitive: 'craft', params: { itemName: 'stick', count: '$e.x' } }])).ok, true);
});

test('P2 A2 field refs still require visibility and number slots stay typed', () => {
  const e = findEntity('e');
  const bad = [
    draft([{ primitive: 'goTo', params: { x: '$e.x', y: 1, z: 2 } }, e]),          // forward id
    draft([{ primitive: 'goTo', params: { x: '$e.x', y: 1, z: 2 } }]),            // never bound
    draft([e, { primitive: 'attack', params: { entityName: '$e.x' } }]),          // number field in a string slot
    draft([e, { primitive: 'goTo', params: { x: '$e.position', y: 1, z: 2 } }]),  // non-whitelisted field
    draft([e, { if: { hasItem: 'dirt', atLeast: '$e.x' }, then: [drop()] }]),     // conditions stay param-only
    draft([e, { repeat: '$e.x', body: [drop()] }]),                               // repeat stays param-only
  ];
  for (const value of bad) assert.equal(ok(value).ok, false, JSON.stringify(value.body));
});

test('P2 A2 interpret resolves coordinate fields to numbers', async () => {
  const bound = { x: 1, y: 64, z: 2, entityName: 'zombie', uuid: OWNER };
  const { calls, run } = stubbed({ findEntity: () => bound });
  await run([
    findEntity('e'),
    { primitive: 'goTo', params: { x: '$e.x', y: '$e.y', z: '$e.z', range: 3 } },
  ]);
  assert.deepEqual(calls[1], { primitive: 'goTo', params: { x: 1, y: 64, z: 2, range: 3 } });
});

test('P2 A2 coordinate fields fail target_not_found on coordinate-less results', async () => {
  for (const [label, body, impls] of [
    ['no coordinates', [findEntity('e'), { primitive: 'goTo', params: { x: '$e.x', y: 1, z: 2 } }],
      { findEntity: () => ({ entityName: 'zombie' }) }],
    ['null result', [findEntity('e'), { primitive: 'goTo', params: { x: '$e.x', y: 1, z: 2 } }],
      { findEntity: () => null }],
    ['scalar binding', [{ primitive: 'countItem', params: { itemName: 'dirt' }, id: 'n' },
      { primitive: 'goTo', params: { x: '$n.x', y: 1, z: 2 } }], { countItem: () => 7 }],
  ]) {
    const { calls, run } = stubbed(impls);
    await assert.rejects(run(body), error => error.code === 'target_not_found', label);
    assert.equal(calls.length, body.length - 1, `${label}: the referencing step never dispatched`);
  }
});

// --- A3 `minecraft:` prefix ---------------------------------------------------

test('P2 A3 minecraft: prefix validates wherever item/block/effect names are legal', () => {
  const good = [
    draft([{ primitive: 'findBlock', params: { blockName: 'minecraft:stone' }, id: 'b' },
      { primitive: 'dig', params: {}, at: 'b' }]),
    draft([{ primitive: 'place', params: { itemName: 'minecraft:dirt' }, at: '$self.front' }]),
    draft([findEntity('e'), { primitive: 'attack', params: { entityName: 'minecraft:zombie' } }]),
    draft([{ primitive: 'countItem', params: { itemName: 'minecraft:stick' } }]),
    draft([{ primitive: 'eat', params: { itemName: 'minecraft:bread' } }]),
    draft([{ if: { hasItem: 'minecraft:dirt', atLeast: 1 }, then: [drop()] }]),
    draft([{ if: { hasEffect: 'minecraft:speed' }, then: [drop()] }]),
    draft([{ obtain: { item: 'minecraft:oak_log', count: 2 } }]),
    draft([{ primitive: 'findBlock', params: { blockName: '$block' } }],
      { block: { type: 'block', default: 'minecraft:grass_block' } }),
  ];
  for (const value of good) assert.deepEqual(ok(value), { ok: true, errors: [] }, JSON.stringify(value.body));
  // Call args accept the alias too.
  const child = { name: 'child', params: { item: { type: 'item', required: true } }, body: [drop()] };
  const call = draft([{ call: 'child', args: { item: 'minecraft:stick' } }]);
  assert.equal(validateDraft(call, { registry, skills: [child] }).ok, true);
  // Unknown names stay unknown — the alias never widens the catalog.
  for (const value of [
    draft([{ primitive: 'findBlock', params: { blockName: 'minecraft:made_up' } }]),
    draft([{ if: { hasEffect: 'minecraft:made_up' }, then: [drop()] }]),
    draft([{ obtain: { item: 'minecraft:made_up', count: 1 } }]),
  ]) assert.equal(ok(value).ok, false, JSON.stringify(value.body));
});

test('P2 A3 validateArgs outputs bare names for prefixed values and defaults', () => {
  assert.deepEqual(validateArgs({ item: { type: 'item', required: true } }, { item: 'minecraft:dirt' }),
    { ok: true, args: { item: 'dirt' } });
  assert.deepEqual(validateArgs({ block: { type: 'block', default: 'minecraft:torch' } }, {}),
    { ok: true, args: { block: 'torch' } });
  assert.equal(validateArgs({ item: { type: 'item', required: true } }, { item: 'minecraft:made_up' }).ok, false);
  assert.equal(validateArgs({ n: { type: 'count' } }, { n: 'minecraft:1' }).ok, false);
});

test('P2 A3 resolveStep strips the namespace on the way to the registry but never inside say text', () => {
  assert.equal(resolveStep({ primitive: 'countItem', params: { itemName: 'minecraft:dirt' } }, new Map()).params.itemName, 'dirt');
  assert.equal(resolveStep({ primitive: 'findEntity', params: { entityName: 'minecraft:zombie' } }, new Map()).params.entityName, 'zombie');
  assert.equal(resolveStep({ primitive: 'say', params: { text: '挖 minecraft:stone 呢' } }, new Map()).params.text,
    '挖 minecraft:stone 呢');
  // The registry's catalog check accepts the resolved name unchanged.
  const resolved = resolveStep({ primitive: 'findBlock', params: { blockName: 'minecraft:stone' } }, new Map());
  assert.equal(resolved.params.blockName, 'stone');
  assert.doesNotThrow(() => registry.validate(resolved.primitive, resolved.params));
});

test('P2 A3 interpret dispatches prefixed params as bare names end-to-end', async () => {
  const { calls, run } = stubbed({ findBlock: () => ({ x: 1, y: 2, z: 3 }) });
  await run([
    { primitive: 'findBlock', params: { blockName: 'minecraft:stone' }, id: 'b' },
    { primitive: 'dig', params: {}, at: '$b' },
  ]);
  assert.equal(calls[0].params.blockName, 'stone');
  assert.deepEqual(calls[1].params, { x: 1, y: 2, z: 3 });
  // hasItem and obtain normalize on the same layer.
  const second = stubbed({ countItem: () => 3 });
  await second.run([{ if: { hasItem: 'minecraft:dirt', atLeast: 1 }, then: [drop()], else: [{ fail: 'missing_item' }] }]);
  assert.equal(second.calls[0].params.itemName, 'dirt');
  let asked;
  await interpret({
    program: { body: [{ obtain: { item: 'minecraft:oak_log', count: 2 } }], params: {}, args: {} },
    isActive: () => true, trace: [], runPrimitive: stubbed().runPrimitive,
    obtain: async args => { asked = args; },
  });
  assert.equal(asked.item, 'oak_log');
});

test('P2 A3 stored skills keep canonical bare names — prefixes normalize on save', t => {
  const root = fileURLToPath(new URL('../../.tmp/', import.meta.url));
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'p2-'));
  const library = createSkillLibrary({ dataDir: directory, registry });
  t.after(() => {
    library.close();
    assert.equal(removePathRobust(directory), true);
    assert.equal(existsSync(directory), false);
  });
  library.learn(draft([
    { primitive: 'findBlock', params: { blockName: 'minecraft:stone' }, id: 'b' },
    { primitive: 'say', params: { text: '是 minecraft:stone 哦' } },
    { obtain: { item: 'minecraft:oak_log', count: 1 } },
  ], { tool: { type: 'item', default: 'minecraft:torch' } }), { teacherUuid: OWNER, context: 'test', route: 'innate' });
  const stored = library.get('test_skill');
  assert.equal(stored.body[0].params.blockName, 'stone');
  assert.equal(stored.body[1].params.text, '是 minecraft:stone 哦', 'say.text is free text — kept verbatim');
  assert.equal(stored.body[2].obtain.item, 'oak_log');
  assert.equal(stored.params.tool.default, 'torch');
});

// --- A4 say text interpolation -------------------------------------------------

test('P2 A4 say text interpolates $id, $id.field and $owner at resolution', () => {
  const prior = new Map([['b', { x: 3, y: 62, z: -8 }], ['e', { x: 1, y: 64, z: 2, entityName: 'zombie', uuid: 'u-1' }],
    ['n', 7]]);
  prior.blockNames = new Map([['b', 'coal_ore']]);
  const say = (text, options = {}) => resolveStep({ primitive: 'say', params: { text } }, prior, options).params.text;
  assert.equal(say('找到了 $b'), '找到了 coal_ore', 'a bound block result speaks its name');
  assert.equal(say('在 $b.x 这里'), '在 3 这里');
  assert.equal(say('$e.entityName 在 $e.x,$e.z'), 'zombie 在 1,2');
  assert.equal(say('背包里有 $n.count 个'), '背包里有 7 个');
  assert.equal(say('$n 个'), '7 个', 'a scalar binding stringifies');
  assert.equal(say('你好 $owner', { bot: ownerBot, ownerUuid: OWNER }), '你好 TestOwner');
  assert.equal(say('价格是 $5 不用管'), '价格是 $5 不用管', 'no ref-shaped token — literal $ stays text');
});

test('P2 A4 unresolvable say tokens fail target_not_found rather than chatting raw', () => {
  const prior = new Map([['b', { x: 3, y: 62, z: -8 }], ['n', 7]]);
  const say = text => resolveStep({ primitive: 'say', params: { text } }, prior,
    { bot: ownerBot, ownerUuid: OWNER });
  for (const text of ['找不到 $gone', '坏的 $b.unknownField', '$n.x', '看不见 $owner.field']) {
    assert.throws(() => say(text), error => error.code === 'target_not_found', text);
  }
  // $owner with no owner in scope fails the same way rather than guessing a name.
  assert.throws(() => resolveStep({ primitive: 'say', params: { text: '玩家 $owner 不在' } }, prior, {}),
    error => error.code === 'target_not_found');
});

test('P2 A4 whole-string field refs coerce to strings; interpolation runs through interpret', async () => {
  const { calls, run } = stubbed({ countItem: () => 7, findBlock: () => ({ x: 4, y: 63, z: -2 }) },
    { bot: ownerBot, ownerUuid: OWNER });
  await run([
    { primitive: 'countItem', params: { itemName: 'dirt' }, id: 'n' },
    { primitive: 'findBlock', params: { blockName: 'coal_ore' }, id: 'b' },
    { primitive: 'say', params: { text: '$n.count' } },
    { primitive: 'say', params: { text: '挖到 $n.count 个，是 $b' } },
    { primitive: 'say', params: { text: '你好 $owner' } },
  ]);
  assert.equal(calls[2].params.text, '7', 'a whole-string number ref still produces string text');
  assert.equal(calls[3].params.text, '挖到 7 个，是 coal_ore');
  assert.equal(calls[4].params.text, '你好 TestOwner');
});

test('P2 A4 interpolation failures surface as target_not_found through interpret', async () => {
  for (const [label, text] of [
    ['unbound id', '找不到 $gone'], ['missing field', '坐标 $e.y'], ['bad field on scalar', '$n.blockName'],
  ]) {
    const { calls, run } = stubbed(
      { findEntity: () => ({ entityName: 'zombie' }), countItem: () => 7 },
      { bot: ownerBot, ownerUuid: OWNER });
    const body = [findEntity('e'), { primitive: 'countItem', params: { itemName: 'dirt' }, id: 'n' },
      { primitive: 'say', params: { text } }];
    await assert.rejects(run(body), error => error.code === 'target_not_found', label);
    assert.equal(calls.length, 2, `${label}: the say step never dispatched`);
  }
});

test('P2 A4 bare $id stays illegal outside string contexts', async () => {
  const { calls, run } = stubbed({ findEntity: () => ({ x: 1, y: 2, z: 3, entityName: 'zombie', uuid: 'u-1' }) });
  await run([findEntity('e'), { primitive: 'goToEntity', params: { uuid: '$e' } }]);
  // No interpolation into non-text params: the raw ref reaches validation as-is.
  assert.equal(calls[1].params.uuid, '$e');
});

test('P2 A4 validateDraft checks say tokens against visible ids, fields and declared params', () => {
  const good = [
    draft([find('b'), { primitive: 'say', params: { text: '找到了 $b.blockName' } }]),
    draft([find('b'), { primitive: 'say', params: { text: '$owner 挖好了' } }]),
    draft([find('b'), { primitive: 'say', params: { text: '$b' } }]),
    draft([find('b'), { primitive: 'say', params: { text: '在 $b.x,$b.y,$b.z' } }]),
    draft([{ primitive: 'say', params: { text: '挖了 $count 个' } }], { count: { type: 'count', default: 1 } }),
    draft([{ primitive: 'say', params: { text: '$item' } }], { item: { type: 'item', default: 'dirt' } }),
    draft([{ primitive: 'say', params: { text: '价格 $5 也好' } }]),
  ];
  for (const value of good) assert.equal(ok(value).ok, true, JSON.stringify(value.body));
  const bad = [
    draft([{ primitive: 'say', params: { text: '找了 $gone' } }]),                    // unbound
    draft([find('b'), { primitive: 'say', params: { text: '$b.unknownField' } }]),     // non-whitelisted field
    draft([find('b'), { primitive: 'say', params: { text: '$b.position' } }]),
    draft([{ primitive: 'say', params: { text: '$gone.x' } }]),
    draft([{ primitive: 'say', params: { text: '$count' } }]),                         // never declared
  ];
  for (const value of bad) assert.equal(ok(value).ok, false, JSON.stringify(value.body));
});

test('P2 A4 substitute keeps step refs and inlines declared params inside strings', () => {
  assert.deepEqual(substitute({ a: '$p', b: '$e.uuid', c: 3, d: 'plain' }, { p: 5 }),
    { a: 5, b: '$e.uuid', c: 3, d: 'plain' });
  assert.deepEqual(
    substitute({ text: '挖了 $count 个', keep: '$e', mixed: 'x $p.y', tail: '$e.' }, { count: 2 }),
    { text: '挖了 2 个', keep: '$e', mixed: 'x $p.y', tail: '$e.' });
});

// --- A5 normalizeDraft rules ----------------------------------------------------

test('P2 A5 normalizeDraft drops at_dollar_id and minecraft_prefix; shape rules stay', () => {
  const { draft: out, repairs } = normalizeDraft(draft([
    { findBlock: { blockName: 'minecraft:stone' }, id: 'b' },
    { primitive: 'dig', params: {}, at: '$b' },
    { primitive: 'collectDrops' },
    { if: { found: 'b' }, then: [drop()], else: [] },
  ]), { registry });
  assert.deepEqual(repairs.sort(), ['empty_else', 'missing_params', 'shorthand_primitive']);
  assert.equal(out.body[0].primitive, 'findBlock');
  assert.equal(out.body[0].params.blockName, 'minecraft:stone', 'legal alias is kept');
  assert.equal(out.body[1].at, '$b', 'legal at:"$id" is kept');
  assert.deepEqual(validateDraft(out, { registry }), { ok: true, errors: [] });
});

// --- P2 round-2: holdout-driven conformance (camelCase ids, branch-union
// visibility, lifted params, empty-then) ---------------------------------------

test('P2 R2 ids accept camelCase everywhere — step ids, refs, offsets, skill names', () => {
  const good = [
    // `atChest`, `plankCount`, `charcoalCount` — the holdout's actual spellings.
    draft([{ primitive: 'goTo', params: { x: 1, y: 64, z: 2 }, id: 'atChest' }, drop()]),
    draft([find('plankCount'), { primitive: 'dig', params: {}, at: '$plankCount' }]),
    draft([find('dirtSpot'), { primitive: 'dig', params: {}, at: 'dirtSpot.below'.replace('dirtSpot', '$dirtSpot') }]),
    draft([find('oreVein'), { primitive: 'say', params: { text: '是 $oreVein.blockName' } }]),
    draft([find('e2'), { primitive: 'goTo', params: { x: '$e2.x', y: '$e2.y', z: '$e2.z' } }]),
  ];
  for (const value of good) assert.equal(ok(value).ok, true, JSON.stringify(value.body));
  assert.equal(ok(draft([drop()], {}, 'craftOakPlanks')).ok, true, 'camelCase skill name');
  // First char still lowercase; pure-uppercase and leading-digit ids stay invalid.
  for (const id of ['Chest', '9lives', 'Has-dash']) {
    assert.equal(ok(draft([{ primitive: 'goTo', params: { x: 1, y: 2, z: 3 }, id }])).ok, false, id);
  }
});

test('P2 R2 camelCase ids resolve at runtime — at, field refs and say text', () => {
  const prior = new Map([['chestSpot', { x: 8, y: 1, z: 10 }], ['plankCount', 4]]);
  assert.deepEqual(resolveStep({ primitive: 'dig', params: {}, at: '$chestSpot' }, prior).params,
    { x: 8, y: 1, z: 10 });
  assert.equal(resolveStep({ primitive: 'say', params: { text: '有 $plankCount.count 个' } }, prior).params.text,
    '有 4 个');
});

test('P2 R2 ids bound inside if/repeat bodies stay visible to later siblings', () => {
  // The holdout shape: `c` bound inside else, referenced by a later say.
  const value = draft([
    { if: { foodBelow: 10 }, then: [drop()], else: [
      { repeat: 2, body: [find('s'), { primitive: 'countItem', params: { itemName: 'cobblestone' }, id: 'c' }] }] },
    { primitive: 'say', params: { text: '现在有 $c.count 个' } },
  ]);
  assert.equal(ok(value).ok, true, JSON.stringify(value.body));
  // Same for a repeat body's bindings.
  assert.equal(ok(draft([
    { repeat: 3, body: [find('dirt')] }, { primitive: 'dig', params: {}, at: '$dirt' }])).ok, true);
  // Sibling isolation is unchanged: a `then` step still cannot see `else` bindings.
  assert.equal(ok(draft([
    { if: { found: 'x' }, then: [{ primitive: 'say', params: { text: '$elseId' } }], else: [find('elseId')] },
  ], {}, 'x')).ok, false);
  // And a branch id still cannot satisfy a forward reference inside its own condition.
  assert.equal(ok(draft([find('x'), { if: { found: 'x' }, then: [drop()], else: [
    { primitive: 'say', params: { text: '有了 $lateId' } }, find('lateId')] }])).ok, false);
});

test('P2 R2 a ref to an id bound only in an un-run branch fails target_not_found', async () => {
  const { calls, run } = stubbed({ countItem: () => 7 });
  // foodBelow is false → else runs → `c` never binds → the say step errors.
  await assert.rejects(run([
    { if: { foodBelow: 10 }, then: [{ primitive: 'countItem', params: { itemName: 'dirt' }, id: 'c' }],
      else: [drop()] },
    { primitive: 'say', params: { text: '$c.count' } },
  ]), error => error.code === 'target_not_found');
  assert.equal(calls.length, 2, 'collectDrops ran; the say never dispatched');
});

test('P2 R2 normalizeDraft lifts stray node-level fields into params', () => {
  const { draft: out, repairs } = normalizeDraft(draft([
    { primitive: 'say', text: '搞定了' },
    { primitive: 'findBlock', blockName: 'stone', id: 'ore' },
  ]), { registry });
  assert.deepEqual(repairs, ['missing_params', 'lift_params', 'missing_params', 'lift_params']);
  assert.deepEqual(out.body[0], { primitive: 'say', params: { text: '搞定了' } });
  assert.deepEqual(out.body[1], { primitive: 'findBlock', params: { blockName: 'stone' }, id: 'ore' });
  assert.equal(validateDraft(out, { registry }).ok, true);
  // Existing params win on collision; stray fields merge underneath.
  const { draft: merged } = normalizeDraft(draft([
    { primitive: 'say', params: { text: '原样' }, extra: 9 }]), { registry });
  assert.deepEqual(merged.body[0], { primitive: 'say', params: { extra: 9, text: '原样' } });
  // Lifted x/y/z still get stripped by at_xyz when `at` is present.
  const { draft: lifted, repairs: r3 } = normalizeDraft(draft([
    find('b'), { primitive: 'dig', x: 1, y: 2, at: '$b' }]), { registry });
  assert.deepEqual(r3, ['missing_params', 'lift_params', 'at_xyz']);
  assert.deepEqual(lifted.body[1], { primitive: 'dig', params: {}, at: '$b' });
});

test('P2 R4 bare `at:"$self"` targets the block she stands in', () => {
  assert.equal(ok(draft([{ primitive: 'findBlock', params: { blockName: 'chest' }, id: 'c', at: '$self' }])).ok, true);
  assert.equal(ok(draft([{ primitive: 'dig', params: {}, at: '$self' }])).ok, true);
  const bot = { entity: { position: { x: 1.6, y: 64.2, z: -3.9 }, yaw: 0 } };
  assert.deepEqual(resolveStep({ primitive: 'dig', params: {}, at: '$self' }, new Map(), { bot }).params,
    { x: 1, y: 64, z: -4 }, 'the block she stands in — below subtracts one more');
  assert.deepEqual(resolveStep({ primitive: 'dig', params: {}, at: '$self.below' }, new Map(), { bot }).params,
    { x: 1, y: 63, z: -4 });
});

test('P2 R3 bare `item`/`block`/`entity` param names alias to the `*Name` fields', () => {
  // The holdout's dominant residual: {"item":"apple"} where schemas want itemName.
  for (const [primitive, params] of [
    ['withdraw', { item: 'apple', count: 2 }],
    ['deposit', { item: 'oak_log', count: 3 }],
    ['eat', { item: 'apple' }],
    ['give', { item: 'coal', count: 1 }],
    ['countItem', { item: 'dirt' }],
    ['craft', { item: 'stick' }],
    ['findBlock', { block: 'chest' }],
    ['findEntity', { entity: 'zombie' }],
    ['smelt', { item: 'raw_iron', fuel: 'coal', count: 2 }],
  ]) {
    assert.deepEqual(ok(draft([{ primitive, params }])), { ok: true, errors: [] }, primitive);
  }
  assert.equal(ok(draft([{ primitive: 'place', params: { item: 'dirt' }, at: '$self.front' }])).ok, true);
  // The canonical field wins when both are present; the bare one still fails.
  assert.equal(ok(draft([{ primitive: 'eat', params: { item: 'bread', itemName: 'apple' } }])).ok, false);
  // No widening: a field with no `*Name` sibling stays unknown.
  assert.equal(ok(draft([{ primitive: 'eat', params: { snack: 'apple' } }])).ok, false);
  // Refs survive the rename — `$id.field` values under an aliased key resolve normally.
  assert.equal(ok(draft([find('b'), { primitive: 'countItem', params: { item: '$b.blockName' } }])).ok, true);
});

test('P2 R2 normalizeDraft rewrites empty then as not+else or drops the no-op', () => {
  const { draft: swapped, repairs } = normalizeDraft(draft([
    { if: { hasItem: 'coal', atLeast: 1 }, then: [], else: [{ primitive: 'say', params: { text: '没煤' } }] },
  ]), { registry });
  assert.ok(repairs.includes('empty_then'));
  assert.deepEqual(swapped.body[0], { if: { not: { hasItem: 'coal', atLeast: 1 } },
    then: [{ primitive: 'say', params: { text: '没煤' } }] });
  assert.equal(validateDraft(swapped, { registry }).ok, true);
  // Empty then with no else — the whole node is a no-op and drops out.
  const { draft: dropped } = normalizeDraft(draft([
    { if: { hasItem: 'coal', atLeast: 1 }, then: [] }, drop()]), { registry });
  assert.equal(dropped.body.length, 1);
  assert.equal(dropped.body[0].primitive, 'collectDrops');
});

// --- P3: deferAmbit draft probes + parameterless `call` ----------------------
// P0r2 exposed a latent bug: `at` probes merge the {0,0,0} sentinel and
// `$id.x` params resolve to the {x:1,y:1,z:1} example — both are judged
// against the real bot position by the §3 ambit check, so any draft with a
// bound position fails validation whenever she is >32 blocks from the world
// origin. format.js now asks the registry to defer ambit for those probes;
// run()/query() still enforce it on resolved coordinates.

const farBot = {
  entity: { position: { x: 200, y: 64, z: 200 }, yaw: 0 },
  entities: {},
  players: { TestOwner: { uuid: OWNER, username: 'TestOwner' } },
};
const farRegistry = createPrimitiveRegistry({ bot: farBot, mcData, ownerUuid: OWNER });
const farOk = value => validateDraft(value, { registry: farRegistry });

test('P3 deferAmbit: bound-position drafts validate far from world origin', () => {
  // at:"id" — the {0,0,0} probe must not be treated as a real target.
  assert.equal(farOk(draft([find('ore'), { primitive: 'dig', params: {}, at: 'ore' }])).ok, true);
  assert.equal(farOk(draft([find('ore'), { primitive: 'dig', params: {}, at: '$ore' }])).ok, true);
  // $id.x/y/z params — placeholders are not real coordinates either.
  assert.equal(farOk(draft([
    find('s'),
    { primitive: 'dig', params: { x: '$s.x', y: '$s.y', z: '$s.z' } },
  ])).ok, true);
  // findEntity search center from refs defers the same way.
  assert.equal(farOk(draft([
    find('s'),
    { primitive: 'findEntity', params: { entityName: 'zombie', x: '$s.x', y: '$s.y', z: '$s.z' } },
  ])).ok, true);
});

test('P3 deferAmbit: literal coordinates still obey the ambit', () => {
  // Literals near her pass; literals beyond 32 blocks still reject — the
  // deferral only covers runtime-resolved positions, never written numbers.
  assert.equal(farOk(draft([{ primitive: 'place', params: { itemName: 'torch', x: 205, y: 64, z: 205 } }])).ok, true);
  const far = farOk(draft([{ primitive: 'place', params: { itemName: 'torch', x: 300, y: 64, z: 300 } }]));
  assert.equal(far.ok, false);
  assert.ok(far.errors.some(e => e.includes('ambit')));
  // And validate() without the option has no sentinel magic: a bare {0,0,0}
  // is a real coordinate and is judged like one (run/query never defer).
  assert.throws(() => farRegistry.validate('place', { itemName: 'torch', x: 0, y: 0, z: 0 }), /ambit/);
  assert.doesNotThrow(() => farRegistry.validate('place', { itemName: 'torch', x: 0, y: 0, z: 0 }, { deferAmbit: true }));
});

test('P3 call: args may be omitted on parameterless skills', () => {
  const skill = {
    name: 'hop', description: 'pick up drops', params: {},
    body: [{ primitive: 'collectDrops', params: {} }],
  };
  const needful = {
    name: 'fetch_it', description: 'fetch an item', params: { item: { type: 'item', required: true } },
    body: [{ primitive: 'collectDrops', params: {} }],
  };
  const skills = [skill, needful];
  const check = body => validateDraft(draft(body), { registry, skills });
  assert.equal(check([{ call: 'hop' }]).ok, true);
  assert.equal(check([{ call: 'hop', args: {} }]).ok, true);
  // Omitted args on a required-param callee still fail arg validation.
  const missing = check([{ call: 'fetch_it' }]);
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some(e => e.includes('invalid call args')));
  // A non-object args value is still an args shape error.
  const wrong = check([{ call: 'hop', args: 'yes' }]);
  assert.equal(wrong.ok, false);
  assert.ok(wrong.errors.some(e => e.includes('call args must be an object')));
});
