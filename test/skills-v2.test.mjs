import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createSkillLibrary, InvalidSkillError } from '../src/skills/library.js';
import { validateDraft, validateArgs, allowsArgOverride } from '../src/skills/format.js';
import { runSkill } from '../src/skills/runner.js';
import { seedInnateSkills } from '../src/skills/seed.js';
import { createArbiter } from '../src/arbiter.js';
import { createPrimitiveRegistry } from '../src/primitives/registry.js';
import { resolveStep } from '../src/skills/bindings.js';
import { createOwnerChatHandler } from '../src/teaching/handler.js';
import { parseUtterance } from '../src/teaching/parser.js';
import { mcData } from '../src/teaching/lexicon.js';
import { createBrain } from '../src/brain/llm.js';
import { removePathRobust } from '../src/fsutil.js';

const OWNER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const teacher = { teacherUuid: OWNER, context: 'T13 test' };
const drop = () => ({ primitive: 'collectDrops', params: {} });
const find = (id = 'target') => ({ primitive: 'findBlock', params: { blockName: 'dirt' }, id });
const draft = (body, params = {}, name = 'test_skill') => ({ name, description: 'test', params, body });
const tick = () => new Promise(resolve => setImmediate(resolve));
const root = fileURLToPath(new URL('../../.tmp/', import.meta.url));
const schema = createPrimitiveRegistry({ mcData, ownerUuid: OWNER });

function directory(t, libraries = []) {
  mkdirSync(root, { recursive: true });
  const path = mkdtempSync(join(root, 't13-'));
  t.after(() => {
    for (const library of libraries) library.close();
    assert.equal(removePathRobust(path), true);
    assert.equal(existsSync(path), false);
  });
  return path;
}

function fixture(t, run = () => ({ ok: true })) {
  const libraries = [];
  const path = directory(t, libraries);
  const logs = [];
  const calls = [];
  const situations = [];
  const eventlog = { append(kind, payload, traceId) { logs.push({ kind, payload, traceId }); }, query: () => logs };
  const registry = { has: name => schema.has(name), validate: (name, params) => schema.validate(name, params),
    run(name, params, options) {
      calls.push({ name, params, options });
      return run(name, params, options, calls.length);
    } };
  const open = () => {
    const library = createSkillLibrary({ dataDir: path, registry, eventlog });
    libraries.push(library);
    return library;
  };
  const library = open();
  const arbiter = createArbiter({ registry, eventlog,
    resolver: (step, bindings) => resolveStep(step, bindings, {
      bot: { entity: { position: { x: 0, y: 64, z: 0 }, yaw: 0 } }, ownerUuid: OWNER,
    }) });
  const handler = current => createOwnerChatHandler({ library: current, registry: schema, arbiter, eventlog, ownerUuid: OWNER,
    brain: { enabled: true, parseIntent: async () => null, parseTeaching: async () => null,
      speak: async ({ situation }) => { situations.push(situation); return null; } },
    mouth: { say: text => text } });
  return { path, library, open, arbiter, handler, calls, logs, situations };
}

test('legal primitive, call, repeat, if and fail nodes validate', t => {
  const f = fixture(t);
  f.library.learn(draft([drop()], {}, 'child_skill'), teacher);
  const values = [
    draft([drop()]), draft([{ call: 'child_skill', args: {} }]),
    draft([{ repeat: 16, body: [drop()] }]), draft([{ fail: 'missing_item' }]),
    draft([find(), { if: { found: 'target' }, then: [drop()], else: [{ fail: 'target_not_found' }] }]),
    draft([{ if: { not: { all: [{ hasItem: 'stone', atLeast: 1 }, { any: [{ hasItem: 'dirt', atLeast: 2304 }] }] } }, then: [drop()] }]),
    draft([{ primitive: 'findBlock', params: { blockName: '$block' } }, { repeat: '$count', body: [drop()] }],
      { block: { type: 'block', default: 'dirt' }, count: { type: 'count', default: 2 } }),
    draft([{ primitive: 'goTo', params: { x: '$x', y: 64, z: 0 } }], { x: { type: 'number', default: -64 } }),
    draft([{ primitive: 'countItem', params: { itemName: '$item' } }], { item: { type: 'item', default: 'stick' } }),
  ];
  for (const value of values) assert.deepEqual(f.library.validateDraft(value, { taught: true }), { ok: true, errors: [] });
  assert.equal(f.library.validateDraft(draft(Array.from({ length: 64 }, drop))).ok, true);
  assert.equal(f.library.validateDraft(draft(Array.from({ length: 24 }, drop)), { taught: true }).ok, true);
});

const invalid = [
  ['primitive fields', draft([{ ...drop(), unknown: true }])],
  ['primitive schema', draft([{ primitive: 'dig', params: { x: 'bad', y: 0, z: 0 } }])],
  ['call fields', draft([{ call: 'child_skill', args: {}, body: [] }])],
  ['unknown call', draft([{ call: 'absent_skill', args: {} }])],
  ['repeat zero', draft([{ repeat: 0, body: [drop()] }])],
  ['repeat type', draft([{ repeat: '$number', body: [drop()] }], { number: { type: 'number' } })],
  ['if fields', draft([{ if: { hasItem: 'dirt', atLeast: 1 }, then: [drop()], unknown: 1 }])],
  ['condition fields', draft([{ if: { hasItem: 'dirt', atLeast: 1, found: 'target' }, then: [drop()] }])],
  ['condition depth 4', draft([{ if: { not: { not: { not: { not: { hasItem: 'dirt', atLeast: 1 } } } } }, then: [drop()] }])],
  ['fail code', draft([{ fail: 'arbitrary' }])],
  ['mixed shapes', draft([{ ...drop(), fail: 'cannot' }])],
  ['undeclared primitive ref', draft([{ primitive: 'findBlock', params: { blockName: '$missing' } }])],
  ['undeclared call ref', draft([{ call: 'child_skill', args: { block: '$missing' } }])],
  ['undeclared condition ref', draft([{ if: { hasItem: '$missing', atLeast: 1 }, then: [drop()] }])],
  ['undeclared repeat ref', draft([{ repeat: '$missing', body: [drop()] }])],
  ['wrong ref type', draft([{ primitive: 'findBlock', params: { blockName: '$count' } }], { count: { type: 'count' } })],
  ['invalid defaults', draft([drop()], { count: { type: 'count', default: 17 } })],
  ['invalid block default', draft([drop()], { block: { type: 'block', default: 'made_up_block' } })],
  ['invalid item default', draft([drop()], { item: { type: 'item', default: 'made_up_item' } })],
  ['number Infinity', draft([drop()], { number: { type: 'number', default: Infinity } })],
  ['five params', draft([drop()], Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(key => [key, { type: 'count' }])))],
  ['unknown root fields', { ...draft([drop()]), code: 'x' }],
  ['65 nodes', draft(Array.from({ length: 65 }, drop))],
  ['depth 5', draft([{ repeat: 1, body: [{ repeat: 1, body: [{ repeat: 1, body: [{ repeat: 1, body: [drop()] }] }] }] }])],
  ['forward at', draft([{ primitive: 'dig', params: {}, at: 'target' }, find()])],
  ['forward found', draft([{ if: { found: 'target' }, then: [drop()] }, find()])],
  // P2 round-2: sub-body ids stay visible afterwards, so 'inner at/found' are
  // legal now — an un-run branch still fails honestly with target_not_found.
  ['duplicate id', draft([find(), find()])],
  ['self binding', draft([{ primitive: 'dig', params: {}, id: 'target', at: 'target' }])],
];
for (const [label, value] of invalid) test(`rejects ${label} without writing`, t => {
  const f = fixture(t);
  f.library.learn(draft([drop()], {}, 'child_skill'), teacher);
  const before = f.library.list();
  assert.equal(f.library.validateDraft(value).ok, false);
  assert.throws(() => f.library.learn(value, teacher), InvalidSkillError);
  assert.deepEqual(f.library.list(), before);
});

test('taught say/follow, 25 nodes, call cycles and mixed call nesting reject without writing', t => {
  const f = fixture(t);
  for (const name of ['say', 'follow']) {
    const value = draft([{ primitive: name, params: name === 'say' ? { text: 'test' } : {} }]);
    assert.equal(f.library.validateDraft(value, { taught: true }).ok, false);
    assert.throws(() => f.library.learn(value, teacher), InvalidSkillError);
  }
  assert.equal(f.library.validateDraft(draft(Array.from({ length: 25 }, drop)), { taught: true }).ok, false);
  assert.throws(() => f.library.learn(draft(Array.from({ length: 25 }, drop)), teacher), InvalidSkillError);
  f.library.learn(draft([drop()], {}, 'base_skill'), teacher);
  f.library.learn(draft([{ call: 'base_skill', args: {} }], {}, 'child_skill'), teacher);
  const before = f.library.list();
  for (const value of [draft([{ call: 'base_skill', args: {} }], {}, 'base_skill'),
    draft([{ call: 'child_skill', args: {} }], {}, 'base_skill'),
    draft([{ repeat: 1, body: [{ if: { hasItem: 'dirt', atLeast: 1 }, then: [{ call: 'child_skill', args: {} }] }] }])]) {
    assert.equal(f.library.validateDraft(value).ok, false);
    assert.throws(() => f.library.learn(value, teacher), InvalidSkillError);
  }
  assert.deepEqual(f.library.list(), before);
  assert.equal(f.library.validateDraft(draft([find(), { repeat: 2, body: [find(), { primitive: 'dig', params: {}, at: 'target' }] }])).ok, true);
});

test('call args reject missing required, incorrect types and unknown fields without writes', t => {
  const f = fixture(t);
  f.library.learn(draft([{ primitive: 'findBlock', params: { blockName: '$block' } }],
    { block: { type: 'block', required: true } }, 'child_skill'), teacher);
  const before = f.library.list();
  for (const args of [{}, { block: 1 }, { block: 'made_up' }, { block: 'dirt', unknown: 2 }]) {
    const value = draft([{ call: 'child_skill', args }]);
    assert.equal(f.library.validateDraft(value).ok, false);
    assert.throws(() => f.library.learn(value, teacher), InvalidSkillError);
  }
  assert.deepEqual(f.library.list(), before);
});

test('repeat literals and $count execute exact counts with ordered results and trace', async t => {
  const f = fixture(t, (_name, _params, _options, n) => ({ ok: true, result: n }));
  for (const [repeat, args, count] of [[5, {}, 5], ['$count', { count: 3 }, 3]]) {
    const program = draft([{ repeat, body: [drop()] }], typeof repeat === 'string' ? { count: { type: 'count', required: true } } : {});
    f.library.learn(program, teacher);
    const before = f.calls.length;
    const { outcome } = await runSkill({ ...f, name: program.name, args });
    assert.equal(outcome.status, 'completed');
    assert.equal(f.calls.length - before, count);
    assert.equal(outcome.completedSteps, count);
    assert.deepEqual(outcome.results.map(result => result.result), Array.from({ length: count }, (_, i) => before + i + 1));
    assert.deepEqual(outcome.trace, [{ node: 'repeat', depth: 0, count, completed: count }]);
  }
});

for (const result of [{ x: 1, y: 2, z: 3 }, null]) test(`if found selects ${result ? 'then' : 'else'}`, async t => {
  const f = fixture(t, name => ({ ok: true, result: name === 'findBlock' ? result : 0 }));
  f.library.learn(draft([find(), { if: { found: 'target' }, then: [drop()], else: [{ fail: 'target_not_found' }] }]), teacher);
  const { outcome } = await runSkill({ ...f, name: 'test_skill' });
  assert.equal(outcome.status, result ? 'completed' : 'failed');
  assert.equal(outcome.trace[0].branch, result ? 'then' : 'else');
  assert.equal(outcome.completedSteps, result ? 2 : 1);
  if (!result) assert.equal(outcome.error.code, 'target_not_found');
});

test('hasItem uses countItem, substitutes params and short-circuits not/all/any', async t => {
  const f = fixture(t, name => ({ ok: true, result: name === 'countItem' ? 4 : null }));
  f.library.learn(draft([{ if: { all: [{ hasItem: '$item', atLeast: '$count' },
    { any: [{ not: { hasItem: 'dirt', atLeast: 5 } }, { hasItem: 'stone', atLeast: 1 }] }] }, then: [drop()], else: [{ fail: 'missing_item' }] }],
  { item: { type: 'item', required: true }, count: { type: 'count', required: true } }), teacher);
  const { outcome } = await runSkill({ ...f, name: 'test_skill', args: { item: 'stick', count: 4 } });
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(f.calls.map(call => call.name), ['countItem', 'countItem', 'collectDrops']);
  assert.deepEqual(f.calls[0].params, { itemName: 'stick' });
  assert.equal(outcome.completedSteps, 3);
  assert.equal(outcome.results.length, 3);
});

test('call substitutes args in isolated callee scopes and uses the current library version', async t => {
  let f;
  f = fixture(t, (name, params) => {
    if (name === 'collectDrops') f.library.learn(draft([{ primitive: 'findBlock', params: { blockName: '$block', maxDistance: 9 }, id: 'target' }],
      { block: { type: 'block', required: true } }, 'child_skill'), teacher);
    return { ok: true, result: name === 'findBlock' ? { x: 1, y: 2, z: 3 } : null };
  });
  f.library.learn(draft([{ primitive: 'findBlock', params: { blockName: '$block' }, id: 'target' }],
    { block: { type: 'block', required: true } }, 'child_skill'), teacher);
  f.library.learn(draft([find(), drop(), { call: 'child_skill', args: { block: '$block' } },
    { primitive: 'dig', params: {}, at: 'target' }], { block: { type: 'block', default: 'sand' } }), teacher);
  const { outcome } = await runSkill({ ...f, name: 'test_skill' });
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(f.calls[2].params, { blockName: 'sand', maxDistance: 9 });
  assert.equal(outcome.trace[0].version, 2);
  assert.equal(outcome.trace[0].completed, true);
  assert.deepEqual(f.calls[3].params, { x: 1, y: 2, z: 3 });
});

test('fail ends execution with code and primitive 257 fails budget_exceeded', async t => {
  const f = fixture(t);
  f.library.learn(draft([drop(), { fail: 'cannot' }, drop()]), teacher);
  let result = await runSkill({ ...f, name: 'test_skill' });
  assert.equal(result.outcome.error.code, 'cannot');
  assert.equal(result.outcome.results.length, 1);
  f.library.learn(draft([{ repeat: 16, body: [{ repeat: 16, body: [drop()] }] }, drop()]), teacher);
  const before = f.calls.length;
  result = await runSkill({ ...f, name: 'test_skill' });
  assert.equal(result.outcome.status, 'failed');
  assert.equal(result.outcome.error.code, 'budget_exceeded');
  assert.equal(result.outcome.completedSteps, 256);
  assert.equal(result.outcome.results.length, 256);
  assert.equal(f.calls.length - before, 256);
  assert.ok(result.outcome.trace.length <= 64);
});

test('loop bindings reset each round and do not overwrite outer ids', async t => {
  let finds = 0;
  const f = fixture(t, name => ({ ok: true,
    result: name === 'findBlock' ? ++finds === 3 ? null : { x: finds === 1 ? 99 : 1, y: 64, z: 0 } : null }));
  f.library.learn(draft([find(), { repeat: 2, body: [find(),
    { if: { found: 'target' }, then: [{ primitive: 'dig', params: {}, at: 'target' }], else: [drop()] }] },
  { primitive: 'dig', params: {}, at: 'target' }]), teacher);
  const { outcome } = await runSkill({ ...f, name: 'test_skill' });
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(f.calls.filter(call => call.name === 'dig').map(call => call.params.x), [1, 99]);
  assert.equal(outcome.trace[0].completed, 2);
  assert.deepEqual(outcome.trace.filter(entry => entry.node === 'if').map(entry => entry.branch), ['then', 'else']);
  assert.equal(outcome.completedSteps, 6);
});

test('trace is capped at 64 while repeat completion remains accurate', async t => {
  const f = fixture(t);
  f.library.learn(draft([{ repeat: 16, body: [{ repeat: 16, body: [
    { if: { hasItem: 'dirt', atLeast: 1 }, then: [{ fail: 'cannot' }], else: [drop()] },
  ] }] }]), teacher);
  const { outcome } = await runSkill({ ...f, name: 'test_skill' });
  assert.equal(outcome.error.code, 'budget_exceeded');
  assert.equal(outcome.trace.length, 64);
  assert.equal(outcome.trace[0].completed, 8);
  assert.equal(outcome.completedSteps, 256);
});

for (const action of ['preempted', 'cancelled']) test(`third-round ${action} stops primitives and snapshots outcome`, async t => {
  let release;
  let started;
  const third = new Promise(resolve => { started = resolve; });
  let count = 0;
  const f = fixture(t, name => {
    if (name === 'collectDrops' && ++count === 3) {
      started();
      return new Promise(resolve => { release = resolve; });
    }
    return { ok: true, result: count };
  });
  f.library.learn(draft([{ repeat: 5, body: [drop()] }]), teacher);
  const running = runSkill({ ...f, name: 'test_skill', source: 'owner' });
  await third;
  let replacement;
  if (action === 'preempted') replacement = f.arbiter.submit({ source: 'reflex', label: 'reflex', steps: [{ primitive: 'countItem', params: { itemName: 'dirt' } }] });
  else assert.equal(f.arbiter.cancel('owner'), true);
  const { outcome } = await running;
  assert.equal(outcome.status, action);
  assert.equal(outcome.completedSteps, 2);
  assert.equal(outcome.results.length, 2);
  assert.deepEqual(outcome.trace, [{ node: 'repeat', depth: 0, count: 5, completed: 2 }]);
  const snapshot = structuredClone(outcome);
  release({ ok: true, result: 'late' });
  await replacement?.done;
  await tick();
  assert.equal(count, 3);
  assert.deepEqual(outcome, snapshot);
  assert.equal(f.calls[2].options.signal.aborted, true);
  assert.equal(f.logs.filter(log => log.kind === 'arbiter.stale').length, 1);
});

test('cancelling hasItem interrupts countItem and starts no branch primitives', async t => {
  let started;
  let release;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture(t, () => { started(); return new Promise(resolve => { release = resolve; }); });
  f.library.learn(draft([{ if: { hasItem: 'dirt', atLeast: 1 }, then: [drop()], else: [{ fail: 'missing_item' }] }]), teacher);
  const running = runSkill({ ...f, name: 'test_skill', source: 'owner' });
  await ready;
  assert.equal(f.calls[0].name, 'countItem');
  assert.equal(f.arbiter.cancel('owner'), true);
  const { outcome } = await running;
  assert.equal(outcome.status, 'cancelled');
  assert.equal(outcome.completedSteps, 0);
  assert.deepEqual(outcome.results, []);
  assert.deepEqual(outcome.trace, []);
  assert.equal(f.calls[0].options.signal.aborted, true);
  release({ ok: true, result: 5 });
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.logs.filter(log => log.kind === 'arbiter.stale').length, 1);
});

test('SQLite migrates calls, bindings, all provenance and other data exactly once', async t => {
  const libraries = [];
  const path = directory(t, libraries);
  const db = new DatabaseSync(join(path, 'skills.sqlite'));
  db.exec(`CREATE TABLE skills (
    name TEXT PRIMARY KEY, description TEXT NOT NULL, steps TEXT NOT NULL CHECK(json_valid(steps)),
    proficiency REAL NOT NULL, uses INTEGER NOT NULL, successes INTEGER NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER, version INTEGER NOT NULL
  ); CREATE TABLE skill_provenance (
    id INTEGER PRIMARY KEY, skill_name TEXT NOT NULL, version INTEGER NOT NULL,
    teacher_uuid TEXT NOT NULL, taught_at INTEGER NOT NULL, context TEXT NOT NULL
  ); CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('keep me');`);
  const insert = db.prepare('INSERT INTO skills VALUES (?, ?, ?, 0.5, 2, 1, 10, 20, 15, 2)');
  insert.run('child_skill', 'child', JSON.stringify([find(), { primitive: 'dig', params: {}, at: 'target' }]));
  insert.run('parent_skill', 'parent', JSON.stringify([{ skill: 'child_skill' }, drop()]));
  insert.run('pick_up_nearby', 'seed', JSON.stringify([drop()]));
  const source = db.prepare('INSERT INTO skill_provenance VALUES (?, ?, ?, ?, ?, ?)');
  source.run(1, 'parent_skill', 1, OWNER, 10, 'first');
  source.run(2, 'parent_skill', 2, 'another-uuid', 20, 'second');
  source.run(3, 'pick_up_nearby', 1, 'innate', 10, 'Innate skill.');
  const priorRows = db.prepare('SELECT * FROM skills ORDER BY name').all();
  db.close();
  const logs = [];
  const eventlog = { append: (kind, payload) => logs.push({ kind, payload }) };
  const library = createSkillLibrary({ dataDir: path, registry: schema, eventlog });
  libraries.push(library);
  const before = library.list();
  for (const row of priorRows) {
    const migrated = before.find(skill => skill.name === row.name);
    for (const [key, value] of Object.entries(row)) if (key !== 'steps') assert.equal(migrated[key], value);
  }
  assert.deepEqual(library.get('parent_skill').body, [{ call: 'child_skill', args: {} }, drop()]);
  assert.deepEqual(library.get('parent_skill').provenance.map(source => [source.teacher_uuid, source.version, source.taught_at, source.context, source.route]),
    [[OWNER, 1, 10, 'first', 'taught'], ['another-uuid', 2, 20, 'second', 'taught']]);
  assert.equal(library.get('pick_up_nearby').provenance[0].route, 'innate');
  const calls = [];
  const arbiter = createArbiter({ eventlog, resolver: resolveStep,
    registry: { has: () => true, validate: schema.validate, run(name, params) {
      calls.push({ name, params }); return { ok: true, result: { x: 4, y: 5, z: 6 } };
    } } });
  assert.equal((await runSkill({ library, arbiter, name: 'parent_skill' })).ok, true);
  assert.deepEqual(calls, [{ name: 'findBlock', params: { blockName: 'dirt' } },
    { name: 'dig', params: { x: 4, y: 5, z: 6 } }, { name: 'collectDrops', params: {} }]);
  library.close();
  const reopened = createSkillLibrary({ dataDir: path, registry: schema, eventlog });
  libraries.push(reopened);
  assert.deepEqual(reopened.get('child_skill'), before.find(skill => skill.name === 'child_skill'));
  assert.deepEqual(logs.filter(log => log.kind === 'skills.migrated'), [{ kind: 'skills.migrated', payload: { count: 3 } }]);
  const check = new DatabaseSync(join(path, 'skills.sqlite'));
  try {
    assert.equal(check.prepare('SELECT value FROM unrelated').get().value, 'keep me');
    for (const row of priorRows) {
      const migrated = check.prepare('SELECT * FROM skills WHERE name = ?').get(row.name);
      for (const key of ['description', 'created_at', 'version']) assert.equal(migrated[key], row[key]);
      assert.equal(migrated.format, 2);
      assert.equal(migrated.params, '{}');
    }
    assert.equal(check.prepare('SELECT count(*) AS n FROM skill_provenance').get().n, 3);
  } finally { check.close(); }
});

test('provenance accepts taught/innate and rejects future routes without writes', t => {
  const f = fixture(t);
  f.library.learn(draft([drop()]), { ...teacher, parentSkill: 'parent_skill', traceId: 'trace-one' });
  assert.deepEqual(f.library.get('test_skill').provenance[0], {
    teacher_uuid: OWNER, taught_at: f.library.get('test_skill').created_at, version: 1,
    context: 'T13 test', route: 'taught', parent_skill: 'parent_skill', trace_id: 'trace-one',
  });
  seedInnateSkills(f.library);
  assert.equal(f.library.get('pick_up_nearby').provenance[0].route, 'innate');
  const before = f.library.list();
  for (const route of ['adapted', 'self', 'blueprint', 'other']) assert.throws(() => f.library.learn(draft([drop()]), { ...teacher, route }), InvalidSkillError);
  assert.deepEqual(f.library.list(), before);
});

test('runSkill rejects missing and wrong args without submitting and applies defaults', async t => {
  const f = fixture(t);
  f.library.learn(draft([{ repeat: '$count', body: [{ primitive: 'findBlock', params: { blockName: '$block' } }] }],
    { block: { type: 'block', required: true }, count: { type: 'count', default: 2 } }), teacher);
  const arbiter = { submit() { assert.fail('invalid args must not submit'); } };
  for (const args of [{}, { block: 3 }, { block: 'invented' }, { block: 'dirt', count: 17 }, { block: 'dirt', extra: 1 }]) {
    assert.deepEqual(await runSkill({ library: f.library, arbiter, name: 'test_skill', args }), { ok: false, reason: 'invalid_args' });
  }
  const result = await runSkill({ ...f, name: 'test_skill', args: { block: 'dirt' } });
  assert.equal(result.ok, true);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].params, { blockName: 'dirt' });
  assert.equal(validateArgs({ n: { type: 'number' } }, { n: 321 }).ok, false);
});

test('substituted values must still pass the primitive schema before execution', async t => {
  const f = fixture(t);
  f.library.learn(draft([{ primitive: 'findBlock', params: { blockName: '$item' } }],
    { item: { type: 'item', required: true } }), teacher);
  const { outcome } = await runSkill({ ...f, name: 'test_skill', args: { item: 'stick' } });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error.message, /unknown Minecraft name/u);
  assert.equal(outcome.completedSteps, 0);
  assert.equal(f.calls.length, 0);
});

for (const [text, failAt, count, expectedDone] of [['挖5个泥土', 0, 5, 5], ['挖5个泥土', 3, 3, 2], ['挖100个泥土', 0, 16, 16]]) {
  test(`handler ${text} failAt ${failAt}: one task and done ${expectedDone}`, async t => {
    const f = fixture(t, (_name, _params, _options, n) => n === failAt ? { ok: false, error: { code: 'cannot', message: 'blocked' } } : { ok: true });
    f.library.learn(draft([drop()], {}, 'dig_dirt'), teacher);
    const result = await f.handler(f.library).handle(text, 'quantity');
    assert.equal(result.kind, failAt ? 'try_failed' : 'remembered');
    assert.equal(f.logs.filter(log => log.kind === 'arbiter.accept').length, 1);
    assert.equal(f.calls.length, count);
    assert.equal(f.situations.at(-1).done, expectedDone);
    assert.equal(f.situations.at(-1).requested, Math.min(16, Number(text.match(/\d+/u)[0])));
    assert.equal(f.situations.at(-1).capped === true, text.includes('100'));
  });
}

test('handler passes declared count as args and stop cancels the entire counted task', async t => {
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture(t, (_name, _params, _options, n) => {
    if (n === 3) { started(); return new Promise(resolve => { release = resolve; }); }
    return { ok: true };
  });
  f.library.learn(draft([{ repeat: '$count', body: [drop()] }], { count: { type: 'count', default: 1 } }, 'dig_dirt'), teacher);
  const handler = f.handler(f.library);
  const command = handler.handle('挖5个泥土', 'command');
  await ready;
  assert.equal((await handler.handle('停', 'stop')).kind, 'stopped');
  assert.equal((await command).kind, 'try_failed');
  assert.equal(f.logs.filter(log => log.kind === 'arbiter.accept').length, 1);
  assert.equal(f.situations.at(-1).done, 2);
  assert.equal(f.calls[2].options.signal.aborted, true);
  release({ ok: true });
  await tick();
  assert.equal(f.calls.length, 3);
});

test('quantity wrapper can execute a known skill at the maximum combined depth', async t => {
  const f = fixture(t);
  f.library.learn(draft([{ repeat: 1, body: [{ repeat: 1, body: [{ repeat: 1, body: [drop()] }] }] }], {}, 'dig_dirt'), teacher);
  assert.equal((await f.handler(f.library).handle('挖5个泥土')).kind, 'remembered');
  assert.equal(f.calls.length, 5);
  assert.equal(f.situations.at(-1).done, 5);
  assert.equal(f.logs.filter(log => log.kind === 'arbiter.accept').length, 1);
});

test('rule teaching persists block defaults, executes grass and keeps sand unknown', async t => {
  const f = fixture(t, name => ({ ok: true, result: name === 'findBlock' ? { x: 1, y: 2, z: 3 } : null }));
  const handler = f.handler(f.library);
  assert.equal((await handler.handle('挖草方块就是找到它，走过去，挖掉，捡起来')).kind, 'learned');
  const skill = f.library.get('dig_grass_block');
  assert.deepEqual(skill.params, { block: { type: 'block', default: 'grass_block' } });
  assert.equal(skill.body[0].params.blockName, '$block');
  assert.equal((await handler.handle('挖草方块')).kind, 'remembered');
  assert.equal(f.calls[4].params.blockName, 'grass_block');
  const before = f.calls.length;
  assert.equal((await handler.handle('挖沙子')).kind, 'dont_know');
  assert.equal(f.calls.length, before);
  assert.deepEqual(parseUtterance('挖脚下就是挖脚下').draft.params, {});
});

test('parseIntent validates v2, rejects object overrides and accepts count', async () => {
  const skill = draft([{ repeat: '$count', body: [{ primitive: 'findBlock', params: { blockName: '$block' } }] }],
    { block: { type: 'block', default: 'grass_block' }, count: { type: 'count', default: 1 } }, 'dig_grass_block');
  const primitives = schema.list().map(name => schema.describe(name));
  let value;
  const requests = [];
  const brain = createBrain({ baseUrl: 'https://example.invalid', apiKey: 'fake', model: 'fake',
    fetch: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(value) } }] }) };
    } });
  value = { kind: 'teach', skill };
  assert.deepEqual(await brain.parseIntent('教学', { primitives }), value);
  for (const body of [[{ repeat: 0, body: [drop()] }], [{ primitive: 'follow', params: {} }], [{ fail: 'invalid' }]]) {
    value = { kind: 'teach', skill: { ...skill, body } };
    assert.deepEqual(await brain.parseIntent('教学', { primitives }), { kind: 'chat' });
  }
  value = { kind: 'command', skill: skill.name, action: '挖沙子', args: { block: 'sand' } };
  assert.deepEqual(await brain.parseIntent('挖沙子', { skills: [skill], primitives }), { kind: 'unknown_action', action: '挖沙子' });
  value = { kind: 'command', skill: skill.name, args: { count: 5, block: 'grass_block' } };
  assert.deepEqual(await brain.parseIntent('挖5个草方块', { skills: [skill], primitives }), value);
  value = { kind: 'command', skill: skill.name, args: { count: '5' } };
  assert.deepEqual((await brain.parseIntent('挖草方块', { skills: [skill], primitives })).args, {});
  value = { kind: 'command', skill: skill.name, args: { block: 'made_up_block', count: 2, unknown: 3 } };
  assert.deepEqual((await brain.parseIntent('挖草方块', { skills: [skill], primitives })).args, { count: 2 });
  assert.equal(allowsArgOverride(skill, { block: 'sand' }), false);
  const prompt = requests[0].messages[0].content;
  for (const word of ['v2', '24', '64', '256', 'repeat', 'call', '$参数名', '不生成台词']) assert.ok(prompt.includes(word));
});

test('handler rejects model block overrides and opens a teaching window', async t => {
  const f = fixture(t);
  f.library.learn(draft([drop()], { block: { type: 'block', default: 'grass_block' } }, 'dig_grass_block'), teacher);
  const handler = createOwnerChatHandler({ library: f.library, arbiter: f.arbiter, eventlog: { append() {} }, ownerUuid: OWNER,
    mouth: { say: text => text }, brain: { enabled: true, speak: async () => null,
      parseIntent: async () => ({ kind: 'command', skill: 'dig_grass_block', action: '挖沙子', args: { block: 'sand' } }) } });
  assert.equal((await handler.handle('去处理那些沙子')).kind, 'dont_know');
  assert.equal(f.calls.length, 0);
});

test('legacy steps tasks retain sequential results, failures and cancellation', async t => {
  const f = fixture(t, (_name, _params, _options, n) => n === 2 ? { ok: false, error: { code: 'cannot' } } : { ok: true, result: n });
  const submitted = f.arbiter.submit({ source: 'owner', label: 'legacy', steps: [drop(), drop(), drop()] });
  const outcome = await submitted.done;
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.completedSteps, 1);
  assert.equal(outcome.results.length, 2);
  assert.equal(f.calls.length, 2);
  assert.equal(outcome.error.code, 'cannot');
});

test('e2e script keeps offline craft, grass, restart, follow and stop regression', async t => {
  const e2e = fileURLToPath(new URL('../scripts/e2e.mjs', import.meta.url));
  const source = readFileSync(e2e, 'utf8');
  assert.match(source, /E2E_SCENARIO/u);
  assert.match(source, /LEARNING_AUTONOMY/u);
  let followSignal;
  const f = fixture(t, (name, _params, options) => {
    if (name === 'follow') { followSignal = options.signal; return new Promise(() => {}); }
    return { ok: true, result: name === 'findBlock' ? { x: 1, y: 2, z: 3 } : null };
  });
  const handler = f.handler(f.library);
  assert.equal((await handler.handle('四个木板就能合成工作台')).kind, 'learned');
  assert.equal((await handler.handle('挖草方块就是找到它，走过去，挖掉，捡起来')).kind, 'learned');
  f.library.close();
  const reopened = f.open();
  const next = f.handler(reopened);
  assert.equal((await next.handle('做工作台')).kind, 'remembered');
  assert.equal((await next.handle('挖草方块')).kind, 'remembered');
  assert.equal((await next.handle('跟着我')).kind, 'following');
  assert.equal((await next.handle('停')).kind, 'stopped');
  assert.equal(followSignal.aborted, true);
  assert.equal(f.arbiter.isBusy(), false);
});
