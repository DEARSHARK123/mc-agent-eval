import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDraft } from '../src/skills/repair.js';
import { validateDraft } from '../src/skills/format.js';
import { createPrimitiveRegistry } from '../src/primitives/registry.js';
import { mcData, resolveItem, resolveNamesInText } from '../src/teaching/lexicon.js';
import { createBrain } from '../src/brain/llm.js';
import { createSkillLibrary } from '../src/skills/library.js';
import { createOwnerChatHandler } from '../src/teaching/handler.js';
import { createDialogue } from '../src/dialogue.js';

// T29 A: draft normalization, one repair retry, P1 grammar prompt alignment,
// clearer attack+at error, countItem via registry.query, slimmer speak payload.
const OWNER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const registry = createPrimitiveRegistry({ mcData, ownerUuid: OWNER });
const primitives = registry.list().map(name => registry.describe(name));
const tempRoot = process.env.COMPANION_TEST_TMP ?? fileURLToPath(new URL('../../.tmp/', import.meta.url));
const drop = () => ({ primitive: 'collectDrops', params: {} });
const draft = (body, extra = {}) => ({ name: 'test_skill', description: '测试', ...extra, body });

const response = content => ({ ok: true, status: 200,
  json: async () => ({ choices: [{ message: { content } }] }) });
function queuedBrain(queue, { requests = [], events = [], fallback = { kind: 'chat' } } = {}) {
  return createBrain({ baseUrl: 'https://example.invalid/v1', apiKey: 'fake-t29-key', model: 'parse-model',
    fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return response(JSON.stringify(queue.length ? queue.shift() : fallback));
    },
    eventlog: { append: (kind, payload) => events.push({ kind, payload }) } });
}

// --- normalizeDraft rules ----------------------------------------------------

test('P2 normalizeDraft: minecraft: prefixes are legal and pass validation unstripped', () => {
  const input = {
    name: 'multi_fix', description: '混合修复',
    params: { tool: { type: 'item', default: 'minecraft:torch' } },
    body: [
      { primitive: 'findBlock', params: { blockName: 'minecraft:stone' }, id: 'b' },
      { obtain: { item: 'minecraft:oak_log', count: 2 } },
      { if: { hasItem: 'minecraft:dirt', atLeast: 1 }, then: [drop()] },
      { if: { hasEffect: 'minecraft:speed' }, then: [drop()] },
      { call: 'child', args: { item: 'minecraft:stick' } },
    ],
  };
  const snapshot = structuredClone(input);
  const { draft: out, repairs } = normalizeDraft(input, { registry });
  // P2 A3: the prefix is a legal alias now, so normalizeDraft leaves catalog
  // fields alone — no repair noise for a valid draft.
  assert.deepEqual(repairs, []);
  assert.equal(out.params.tool.default, 'minecraft:torch');
  assert.equal(out.body[0].params.blockName, 'minecraft:stone');
  assert.equal(out.body[1].obtain.item, 'minecraft:oak_log');
  assert.equal(out.body[2].if.hasItem, 'minecraft:dirt');
  assert.equal(out.body[3].if.hasEffect, 'minecraft:speed');
  assert.equal(out.body[4].args.item, 'minecraft:stick');
  assert.deepEqual(input, snapshot, 'input must not be mutated');
  const child = { name: 'child', params: { item: { type: 'item', required: true } }, body: [drop()] };
  assert.deepEqual(validateDraft(input, { registry, skills: [child] }), { ok: true, errors: [] });
  assert.equal(resolveItem('minecraft:stone'), 'stone');
  assert.equal(resolveItem('minecraft:木板'), 'oak_planks');
});

test('normalizeDraft: at strips x/y/z from params, missing params defaults to {}', () => {
  const { draft: out, repairs } = normalizeDraft(draft([
    { primitive: 'goTo', params: { x: 1, y: 64, z: 2, range: 3 }, at: '$self.below' },
    { primitive: 'collectDrops' },
    { primitive: 'dig', params: { x: 5 } }, // no at: x/y/z untouched
  ]), { registry });
  assert.deepEqual(out.body[0].params, { range: 3 });
  assert.deepEqual(out.body[1].params, {});
  assert.deepEqual(out.body[2].params, { x: 5 });
  assert.deepEqual(repairs, ['at_xyz', 'missing_params']);
});

test('normalizeDraft: empty else removed; P2 rewrites an empty then as not+else', () => {
  const { draft: out, repairs } = normalizeDraft(draft([
    { if: { found: 'b' }, then: [drop()], else: [] },
    { if: { found: 'b' }, then: [], else: [drop()] },
  ]), { registry });
  assert.equal(Object.hasOwn(out.body[0], 'else'), false);
  assert.deepEqual(out.body[1], { if: { not: { found: 'b' } }, then: [drop()] });
  assert.deepEqual(repairs, ['empty_else', 'empty_then']);
});

test('P2 normalizeDraft: at:"$id" is legal and untouched like the other $ forms', () => {
  const { draft: out, repairs } = normalizeDraft(draft([
    { primitive: 'goTo', params: {}, at: '$ore', id: 'g' },     // legal P2 A1 form, kept as-is
    { primitive: 'goTo', params: {}, at: '$owner' },           // keep
    { primitive: 'goTo', params: {}, at: '$self.below' },      // keep
    { primitive: 'goTo', params: {}, at: '$ore.above' },       // keep (dotted $id.below|above is legal P1)
    { primitive: 'goTo', params: {}, at: 'ore' },              // already bare
  ]), { registry });
  assert.equal(out.body[0].at, '$ore');
  assert.equal(out.body[1].at, '$owner');
  assert.equal(out.body[2].at, '$self.below');
  assert.equal(out.body[3].at, '$ore.above');
  assert.equal(out.body[4].at, 'ore');
  assert.deepEqual(repairs, []);
});

test('normalizeDraft: {primitive-name: params} shorthand rewrites via registry whitelist', () => {
  const { draft: out, repairs } = normalizeDraft(draft([
    { dig: { x: 1, y: 64, z: 2 }, id: 'b', timeoutMs: 5000 },
    { fly: {} },                      // not a registered primitive: untouched
    { say: { text: 'hi' } },          // whitelisted even though taught rules ban it
    { primitive: 'dig', params: {} }, // canonical shape: untouched
  ]), { registry });
  assert.deepEqual(out.body[0], { primitive: 'dig', params: { x: 1, y: 64, z: 2 }, id: 'b', timeoutMs: 5000 });
  assert.deepEqual(out.body[1], { fly: {} });
  assert.deepEqual(out.body[2], { primitive: 'say', params: { text: 'hi' } });
  assert.deepEqual(out.body[3], { primitive: 'dig', params: {} });
  assert.deepEqual(repairs, ['shorthand_primitive', 'shorthand_primitive']);
  // Without a registry the shorthand cannot be recognized.
  const plain = normalizeDraft(draft([{ dig: { x: 1 } }]));
  assert.deepEqual(plain.draft.body[0], { dig: { x: 1 } });
  assert.deepEqual(plain.repairs, []);
});

test('normalizeDraft: clean drafts return an equal copy with no repairs; non-objects pass through', () => {
  const input = draft([{ primitive: 'findBlock', params: { blockName: '$block' }, id: 't' },
    { primitive: 'dig', params: {}, at: 't' }], { params: { block: { type: 'block', default: 'dirt' } } });
  const { draft: out, repairs } = normalizeDraft(input, { registry });
  assert.deepEqual(out, input);
  assert.deepEqual(repairs, []);
  for (const value of [null, 'x', 5, [{ primitive: 'dig' }]]) {
    assert.deepEqual(normalizeDraft(value, { registry }), { draft: value, repairs: [] });
  }
});

test('P2 normalizeDraft: repaired drafts pass validateDraft where the raw draft failed', () => {
  const raw = draft([
    { findBlock: { blockName: 'minecraft:stone' }, id: 'b' },
    { primitive: 'dig', params: { x: 0 }, at: 'b' },
  ]);
  assert.equal(validateDraft(raw, { registry }).ok, false);
  const { draft: fixed, repairs } = normalizeDraft(raw, { registry });
  // P2 A3: the minecraft: prefix needs no repair — shorthand and at_xyz still do.
  assert.equal(fixed.body[0].params.blockName, 'minecraft:stone');
  assert.deepEqual(validateDraft(fixed, { registry }), { ok: true, errors: [] });
  assert.deepEqual(repairs.sort(), ['at_xyz', 'shorthand_primitive']);
});

// --- parseIntent: prompt grammar, names slice, repair retry -------------------

test('parseIntent: system prompt documents the P1 grammar and payload carries a name slice', async () => {
  const requests = [];
  const brain = queuedBrain([{ kind: 'chat' }], { requests });
  assert.deepEqual(await brain.parseIntent('教你怎么挖泥土和烤土豆', { primitives }), { kind: 'chat' });
  const system = requests[0].body.messages[0].content;
  for (const fragment of ['$id.field', 'uuid', 'entityName', 'blockName', '$id.below', '$id.above',
    'healthBelow', 'foodBelow', 'hasEffect', 'obtain', 'free:true',
    // P3 C: camelCase names, reusable inner-branch ids, and the call-reuse preference.
    'a-zA-Z0-9_', '分支和循环内部绑定的 id 之后可用', 'target_not_found 落空',
    '优先 call skills 列表中语义匹配的已有技能']) {
    assert.ok(system.includes(fragment), `prompt must document ${fragment}`);
  }
  const user = JSON.parse(requests[0].body.messages[1].content);
  for (const name of ['dirt', 'baked_potato', 'oak_log', 'stone', 'zombie', 'crafting_table']) {
    assert.ok(user.names.includes(name), `names slice must include ${name}`);
  }
  assert.ok(user.names.length <= 200, 'name slice stays modest');
});

test('parseIntent: normalized teach draft validates without a retry and reports repairs', async () => {
  const requests = [];
  const events = [];
  const skill = { name: 'find_and_dig', description: '找矿挖掉',
    body: [{ findBlock: { blockName: 'minecraft:stone' }, id: 'b' },
      { primitive: 'dig', params: { x: 1 }, at: 'b' }] };
  const brain = queuedBrain([{ kind: 'teach', skill }], { requests, events });
  const result = await brain.parseIntent('教你找石头挖掉', { primitives });
  assert.equal(result.kind, 'teach');
  assert.equal(result.skill.body[0].primitive, 'findBlock');
  // P2 A3: the legal alias is kept as authored; storage canonicalizes it.
  assert.equal(result.skill.body[0].params.blockName, 'minecraft:stone');
  assert.deepEqual(result.skill.body[1].params, {});
  assert.deepEqual(result.repairs.sort(), ['at_xyz', 'shorthand_primitive']);
  assert.equal(requests.length, 1);
  assert.equal(events.at(-1).payload.purpose, 'parse');
});

test('parseIntent: one repair retry carries draft+errors and succeeds; never loops', async () => {
  const requests = [];
  const events = [];
  const broken = { name: 'dig_it', description: '挖它', body: [{ primitive: 'nosuch', params: {} }] };
  const fixed = { name: 'dig_it', description: '挖它', body: [drop()] };
  const brain = queuedBrain([{ kind: 'teach', skill: broken }, { kind: 'teach', skill: fixed }], { requests, events });
  const result = await brain.parseIntent('教学', { primitives });
  assert.equal(result.kind, 'teach');
  assert.deepEqual(result.skill, fixed);
  assert.equal(requests.length, 2);
  const retryUser = JSON.parse(requests[1].body.messages[1].content);
  assert.deepEqual(retryUser.draft, broken);
  assert.ok(Array.isArray(retryUser.errors) && retryUser.errors.length > 0);
  assert.equal(retryUser.message, '教学');
  assert.deepEqual(events.map(event => event.payload.purpose), ['parse', 'teach_repair']);
});

test('parseIntent: a failed retry degrades to chat after exactly one extra request', async () => {
  const requests = [];
  const broken = { name: 'dig_it', description: '挖它', body: [{ primitive: 'nosuch', params: {} }] };
  const brain = queuedBrain([{ kind: 'teach', skill: broken }, { kind: 'teach', skill: broken }], { requests });
  assert.deepEqual(await brain.parseIntent('教学', { primitives }), { kind: 'chat' });
  assert.equal(requests.length, 2);
});

test('parseIntent: retry answers that are not teach also degrade to chat', async () => {
  const requests = [];
  const broken = { name: 'dig_it', description: '挖它', body: [{ primitive: 'nosuch', params: {} }] };
  for (const second of [{ kind: 'chat' }, 'not json', { kind: 'teach' }]) {
    requests.length = 0;
    const brain = queuedBrain([{ kind: 'teach', skill: broken }, second], { requests });
    assert.deepEqual(await brain.parseIntent('教学', { primitives }), { kind: 'chat' });
    assert.equal(requests.length, 2);
  }
});

// --- format.js: clearer at error ----------------------------------------------

test('validateDraft: at on a primitive without x/y/z names the rule, not unknown field x', () => {
  const bad = validateDraft(draft([
    { primitive: 'attack', params: { entityName: 'zombie' }, at: '$owner' }]), { registry, taught: true });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.includes("attack does not take 'at'"), bad.errors.join('; '));
  const query = validateDraft(draft([
    { primitive: 'findEntity', params: { entityName: 'zombie' }, id: 'e' },
    { primitive: 'attack', params: { entityName: '$e.entityName' }, at: 'e' }]), { registry });
  assert.equal(query.ok, false);
  assert.ok(query.errors.includes("attack does not take 'at'"));
  // Coordinate-bearing primitives still take at normally.
  assert.deepEqual(validateDraft(draft([
    { primitive: 'blockAt', params: {}, at: '$self.below' }]), { registry }), { ok: true, errors: [] });
});

// --- handler: skills.repaired log, countItem via query, speak without body -----

function fixture(t, { brain, registry: testRegistry = registry } = {}) {
  mkdirSync(tempRoot, { recursive: true });
  const directory = mkdtempSync(join(tempRoot, 't29-'));
  const libraries = [];
  const calls = [];
  const logs = [];
  const speech = [];
  let outcome = { status: 'completed' };
  const arbiter = { submit(intent) { calls.push(intent); return { done: Promise.resolve(outcome) }; } };
  const eventlog = { append: (kind, payload, traceId) => logs.push({ kind, payload, traceId }), query: () => logs };
  const mouth = { say(text) { speech.push(text); return text; } };
  function open() {
    const library = createSkillLibrary({ dataDir: directory, registry: testRegistry, clock: { now: () => 0 } });
    libraries.push(library);
    return library;
  }
  function handler(library, overrides = {}) {
    return createOwnerChatHandler({ library, arbiter, mouth, brain, eventlog,
      ownerUuid: OWNER, registry: testRegistry, clock: { now: () => 0 },
      relationship: { ownerName: () => 'TestOwner', nickname: () => 'T' }, ...overrides });
  }
  t.after(() => {
    for (const library of libraries) library.close();
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  });
  return { open, handler, calls, logs, speech, setOutcome: value => { outcome = value; } };
}

test('handler: unknownActionStep path normalizes, logs skills.repaired and learns', async t => {
  const freeform = '就是低头把脚下那块挖掉，然后把掉下来的东西捡起来';
  const repairable = { name: 'dig_below', description: '挖脚下的方块',
    body: [{ primitive: 'dig', params: { x: 1, y: 64, z: 2 }, at: '$self.below' }, { primitive: 'collectDrops' }] };
  const inputs = [];
  const f = fixture(t, { brain: { enabled: true,
    parseIntent: async (message, options) => { inputs.push({ message, ...options }); return { kind: 'teach', skill: repairable }; },
    parseTeaching: async () => assert.fail('teach_action must not fall back to craft parsing'),
    speak: async () => null } });
  const library = f.open();
  const handler = f.handler(library);
  assert.equal((await handler.handle('挖脚下的方块')).kind, 'dont_know');
  assert.equal((await handler.handle(freeform)).kind, 'learned');
  const repaired = f.logs.find(event => event.kind === 'skills.repaired');
  assert.ok(repaired, 'skills.repaired event logged');
  assert.deepEqual(repaired.payload.rules.sort(), ['at_xyz', 'missing_params']);
  assert.deepEqual(f.calls[0].program.body[0].params, {});
  assert.deepEqual(f.calls[0].program.body[1].params, {});
  assert.ok(library.has('dig_below'));
});

test('handler: parseIntent sees skill bodies while speak payloads drop them', async t => {
  const skill = { name: 'dig_dirt', description: '挖泥土', params: {},
    body: [{ primitive: 'dig', params: { x: 1, y: 64, z: 2 } }], provenance: [] };
  const inputs = [];
  const situations = [];
  const f = fixture(t, { brain: { enabled: true,
    parseIntent: async (message, options) => { inputs.push(options); return { kind: 'chat' }; },
    parseTeaching: async () => null,
    speak: async ({ situation, memory }) => { situations.push({ situation, memory }); return null; } } });
  const library = f.open();
  const handler = f.handler(library, { library: { ...library, list: () => [skill] } });
  await handler.handle('你好呀', 'chat');
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0].skills[0].body, skill.body, 'parseIntent keeps DSL bodies for call composition');
  assert.ok(situations.length >= 1);
  for (const entry of situations) {
    assert.equal(Object.hasOwn(entry.situation.skills[0], 'body'), false, 'speak situation drops bodies');
    assert.equal(Object.hasOwn(entry.memory.skills[0], 'body'), false, 'speak memory drops bodies');
    assert.equal(entry.situation.skills[0].name, 'dig_dirt');
  }
});

test('handler: selfTry counts inventory through registry.query, not run', async t => {
  const queries = [];
  const f = fixture(t);
  const library = f.open();
  const stubRegistry = {
    has: () => false,
    list: () => [],
    query(name, params) { queries.push({ name, params }); return 7; },
    run(name) { assert.equal(name === 'countItem', false, 'countItem must not go through run'); return { ok: true }; },
  };
  const handler = f.handler(library, {
    registry: stubRegistry, learningAutonomy: 2, bot: {},
    jev: { ask: async () => ({ ok: true, answers: {} }) },
  });
  const result = await handler.handle('挖泥土', 'selftry');
  assert.equal(result.kind, 'self_try');
  assert.ok(queries.length >= 2, 'counted before and after the intent');
  assert.ok(queries.every(call => call.name === 'countItem' && call.params.itemName === 'dirt'));
});

// --- lexicon name slice helper --------------------------------------------------

test('lexicon: resolveNamesInText finds aliases, ids and entities', () => {
  assert.deepEqual(resolveNamesInText(null), []);
  const found = resolveNamesInText('去挖石头和泥土，小心 zombie，做个工作台');
  for (const name of ['stone', 'dirt', 'zombie', 'crafting_table']) assert.ok(found.includes(name), name);
  for (const name of found) {
    assert.ok(Object.hasOwn(mcData.itemsByName, name) || Object.hasOwn(mcData.blocksByName, name)
      || Object.hasOwn(mcData.entitiesByName, name), `${name} must be a real 1.20.4 id`);
  }
});
