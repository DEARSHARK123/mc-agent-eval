import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, unlinkSync, rmdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createSkillLibrary, InvalidSkillError, UnknownSkillError } from '../src/skills/library.js';
import { runSkill } from '../src/skills/runner.js';
import { INNATE_SKILLS, seedInnateSkills } from '../src/skills/seed.js';
import { createPrimitiveRegistry } from '../src/primitives/registry.js';
import { createArbiter } from '../src/arbiter.js';

const tempRoot = process.env.COMPANION_TEST_TMP ?? fileURLToPath(new URL('../../.tmp/', import.meta.url));
const DAY_MS = 86_400_000;
const teacher = { teacherUuid: 'teacher-one', context: 'Please greet me.', route: 'innate' };
const say = text => ({ primitive: 'say', params: { text } });
const draft = (name = 'greet_me', body = [say('hello')]) => ({ name, description: 'A greeting.', body });

function fixture(t, registry = createPrimitiveRegistry({})) {
  mkdirSync(tempRoot, { recursive: true });
  const directory = mkdtempSync(join(tempRoot, 't4-test-'));
  const libraries = [];
  let timestamp = 1_000;
  t.after(() => {
    try {
      for (const library of libraries) library.close();
    } finally {
      assert.equal(dirname(directory), resolve(tempRoot));
      for (const file of readdirSync(directory)) unlinkSync(join(directory, file));
      rmdirSync(directory);
      assert.equal(existsSync(directory), false, 'SQLite fixture must leave no temporary files');
    }
  });
  function open() {
    const library = createSkillLibrary({ dataDir: directory, registry, clock: { now: () => timestamp } });
    libraries.push(library);
    return library;
  }
  return { directory, open, setTime: value => { timestamp = value; } };
}

const invalidDrafts = [
  ['invalid names', ['A_bad', 'a', '_greet', 'bad-name', 'a'.repeat(42), 'aa\n', null].map(name => draft(name))],
  ['empty or missing steps', [draft('empty', []), { name: 'missing' }]],
  ['more than 64 nodes', [draft('too_many', Array.from({ length: 65 }, () => say('hi')))]],
  ['unknown primitive', [draft('unknown', [{ primitive: 'fly', params: {} }])]],
  ['unknown skill', [draft('unknown', [{ call: 'not_learned', args: {} }])]],
  ['malformed steps', [draft('invalid', [null]), draft('invalid', [{}]),
    draft('invalid', [{ primitive: 'say', skill: 'other', params: {} }]),
    draft('invalid', [{ skill: 'other', params: {} }])]],
  ['invalid params or timeout', [draft('invalid', [{ primitive: 'say' }]),
    draft('invalid', [{ primitive: 'say', params: [] }]),
    draft('invalid', [{ primitive: 'say', params: { text: undefined } }]),
    ...[0, -1, Infinity, 2_147_483_648, '10'].map(timeoutMs =>
      draft('invalid', [{ ...say('hi'), timeoutMs }]))]],
];

for (const [label, drafts] of invalidDrafts) {
  test(`skills: validateDraft rejects ${label} without writing`, t => {
    const f = fixture(t);
    const library = f.open();
    const db = new DatabaseSync(join(f.directory, 'skills.sqlite'));
    try {
      for (const value of drafts) {
        const result = library.validateDraft(value);
        assert.equal(result.ok, false);
        assert.ok(result.errors.length > 0);
        assert.throws(() => library.learn(value, teacher), error =>
          error instanceof InvalidSkillError && assert.deepEqual(error.errors, result.errors) === undefined);
      }
      assert.deepEqual(library.list(), []);
      assert.equal(db.prepare('SELECT count(*) AS count FROM skill_provenance').get().count, 0);
    } finally {
      db.close();
    }
  });
}

test('skills: valid draft boundaries validate without writing', t => {
  const library = fixture(t).open();
  for (const name of ['ab', 'a1_', 'a'.repeat(41)]) {
    assert.deepEqual(library.validateDraft(draft(name, Array.from({ length: 32 }, () => say('hi')))),
      { ok: true, errors: [] });
  }
  assert.equal(library.has('ab'), false);
  assert.deepEqual(library.list(), []);
});

test('skills: new learning records initial values and provenance', t => {
  const library = fixture(t).open();
  const result = library.learn(draft(), teacher);
  assert.equal(result.isNew, true);
  assert.deepEqual(result.previousTeachings, []);
  assert.deepEqual(result.skill, {
    ...draft(), steps: draft().body, params: {}, format: 2, proficiency: 0.3, uses: 0, successes: 0, version: 1,
    created_at: 1_000, updated_at: 1_000, last_used_at: null,
    provenance: [{ teacher_uuid: teacher.teacherUuid, taught_at: 1_000, version: 1, context: teacher.context,
      route: 'innate', parent_skill: null, trace_id: null }],
  });
  assert.equal(library.has('greet_me'), true);
  assert.equal(library.get('unlearned'), null);
  library.learn(draft('aa'), teacher);
  assert.deepEqual(library.list().map(skill => skill.name), ['aa', 'greet_me']);
});

test('skills: reteaching replaces steps and appends all prior teachings', t => {
  const f = fixture(t);
  const library = f.open();
  const first = library.learn(draft(), teacher).skill;
  library.recordOutcome('greet_me', true);
  f.setTime(2_000);
  const next = library.learn(draft('greet_me', [say('welcome')]), { teacherUuid: 'teacher-two', context: 'A new greeting.', route: 'innate' });
  assert.equal(next.isNew, false);
  assert.equal(next.skill.version, 2);
  assert.deepEqual(next.previousTeachings, first.provenance);
  assert.deepEqual(next.skill.steps, [say('welcome')]);
  assert.equal(next.skill.provenance.length, 2);
  assert.equal(next.skill.provenance[1].teacher_uuid, 'teacher-two');
  assert.equal(next.skill.provenance[1].taught_at, 2_000);
  assert.equal(next.skill.proficiency, 0.475);
  assert.equal(next.skill.uses, 1);
  assert.equal(next.skill.successes, 1);
  assert.equal(next.skill.created_at, 1_000);
  assert.equal(next.skill.updated_at, 2_000);
  const third = library.learn(draft(), teacher);
  assert.equal(third.skill.version, 3);
  assert.deepEqual(third.previousTeachings, next.skill.provenance);
  assert.equal(third.skill.provenance.length, 3);
});

test('skills: reteaching raises low proficiency back to 0.3', t => {
  const library = fixture(t).open();
  library.learn(draft(), teacher);
  library.recordOutcome('greet_me', false);
  assert.equal(library.get('greet_me').proficiency, 0.24);
  assert.equal(library.learn(draft(), teacher).skill.proficiency, 0.3);
});

test('skills: skills, outcomes and provenance survive close and reopen', t => {
  const f = fixture(t);
  const library = f.open();
  library.learn(draft(), teacher);
  f.setTime(2_000);
  library.recordOutcome('greet_me', true);
  library.learn(draft('greet_me', [say('again')]), { teacherUuid: 'teacher-two', context: 'Again.', route: 'innate' });
  const before = library.get('greet_me');
  library.close();
  library.close();
  const reopened = f.open();
  assert.deepEqual(reopened.get('greet_me'), before);
  assert.deepEqual(reopened.get('greet_me').body, before.body);
  assert.deepEqual(reopened.learn(draft(), teacher).previousTeachings, before.provenance);
});

test('skills: calls preserve nested order, repeated references, params and timeout', async t => {
  const library = fixture(t).open();
  const first = { ...say('first'), timeoutMs: 500 };
  library.learn(draft('base_skill', [first]), teacher);
  library.learn(draft('nested_skill', [{ call: 'base_skill', args: {} }, say('second')]), teacher);
  library.learn(draft('top_skill', [{ call: 'nested_skill', args: {} }, { call: 'base_skill', args: {} }]), teacher);
  const calls = [];
  const arbiter = createArbiter({ eventlog: { append() {} }, registry: { has: () => true,
    run(primitive, params, options) { calls.push({ primitive, params, timeoutMs: options.timeoutMs }); return { ok: true }; } } });
  assert.equal((await runSkill({ library, arbiter, name: 'top_skill' })).ok, true);
  assert.deepEqual(calls.map(({ primitive, params, timeoutMs }) => ({ primitive, params,
    ...(timeoutMs === undefined ? {} : { timeoutMs }) })), [first, say('second'), first]);
  library.get('base_skill').body[0].params.text = 'mutated';
  assert.deepEqual(library.get('base_skill').body, [first]);
});

test('skills: direct and indirect cycles reject updates without changing skills or provenance', t => {
  const library = fixture(t).open();
  library.learn(draft('base_skill'), teacher);
  library.learn(draft('child_skill', [{ call: 'base_skill', args: {} }]), teacher);
  const before = library.list();
  for (const target of ['base_skill', 'child_skill']) {
    const value = draft('base_skill', [{ call: target, args: {} }]);
    assert.match(library.validateDraft(value).errors.join(' '), /cycle/);
    assert.throws(() => library.learn(value, teacher), InvalidSkillError);
    assert.deepEqual(library.list(), before);
  }
});

test('skills: four levels allowed, fifth level and child updates exceeding depth rejected', t => {
  const library = fixture(t).open();
  library.learn(draft('level_one'), teacher);
  let previous = 'level_one';
  for (const name of ['level_two', 'level_three', 'level_four']) {
    library.learn(draft(name, [{ call: previous, args: {} }]), teacher);
    previous = name;
  }
  assert.equal(library.get('level_four').body[0].call, 'level_three');
  library.learn(draft('other_leaf'), teacher);
  const before = library.list();
  for (const value of [draft('level_five', [{ call: 'level_four', args: {} }]),
    draft('level_one', [{ call: 'other_leaf', args: {} }])]) {
    assert.match(library.validateDraft(value).errors.join(' '), /depth.*4/);
    assert.throws(() => library.learn(value, teacher), InvalidSkillError);
    assert.deepEqual(library.list(), before);
  }
});

test('skills: outcomes update proficiency, counters and timestamps', t => {
  const f = fixture(t);
  const library = f.open();
  library.learn(draft(), teacher);
  f.setTime(2_000);
  library.recordOutcome('greet_me', true);
  assert.equal(library.get('greet_me').proficiency, 0.475);
  f.setTime(3_000);
  library.recordOutcome('greet_me', false);
  const skill = library.get('greet_me');
  assert.equal(skill.proficiency, 0.38);
  assert.equal(skill.uses, 2);
  assert.equal(skill.successes, 1);
  assert.equal(skill.last_used_at, 3_000);
  assert.equal(skill.updated_at, 3_000);
  assert.equal(skill.provenance.length, 1);
  assert.throws(() => library.recordOutcome('unknown', true), UnknownSkillError);
});

test('skills: decay starts after seven days, has a floor, and never writes', t => {
  const f = fixture(t);
  const library = f.open();
  library.learn(draft(), teacher);
  f.setTime(1_000 + 8 * DAY_MS);
  assert.equal(library.effectiveProficiency('greet_me'), 0.3 * 0.97);
  library.recordOutcome('greet_me', true);
  const stored = library.get('greet_me');
  for (const days of [0, 6, 7]) {
    f.setTime(stored.last_used_at + days * DAY_MS);
    assert.equal(library.effectiveProficiency('greet_me'), 0.475);
  }
  for (const days of [8, 10, 1_000]) {
    f.setTime(stored.last_used_at + days * DAY_MS);
    assert.equal(library.effectiveProficiency('greet_me'), Math.max(0.05, 0.475 * 0.97 ** (days - 7)));
    assert.deepEqual(library.get('greet_me'), stored);
  }
  assert.throws(() => library.effectiveProficiency('unknown'), UnknownSkillError);
});

test('skills: runner does not submit unknown skills', async t => {
  const library = fixture(t).open();
  assert.deepEqual(await runSkill({ library, name: 'unknown', arbiter: {
    submit() { assert.fail('Unknown skill must not submit an intent'); },
  } }), { ok: false, reason: 'unknown_skill' });
});

for (const status of ['completed', 'failed', 'preempted', 'cancelled', 'rejected']) {
  test(`skills: runner submits one program intent and handles ${status}`, async t => {
    const library = fixture(t).open();
    library.learn(draft('base_skill'), teacher);
    library.learn(draft('greet_me', [{ call: 'base_skill', args: {} }, say('again')]), teacher);
    const before = library.get('greet_me');
    const calls = [];
    let finish;
    const outcome = { status, completedSteps: status === 'completed' ? 2 : 0 };
    const arbiter = { submit(intent) {
      calls.push(intent);
      return { done: new Promise(resolve => { finish = resolve; }) };
    } };
    const running = runSkill({ library, arbiter, name: 'greet_me', traceId: 'trace-t4' });
    assert.deepEqual(calls, [{ source: 'plan', label: 'greet_me',
      program: { body: before.body, params: {}, args: {} }, library, traceId: 'trace-t4' }]);
    assert.deepEqual(library.get('greet_me'), before, 'Must wait for done before recording outcome');
    finish(outcome);
    assert.deepEqual(await running, { ok: status === 'completed', outcome });
    const after = library.get('greet_me');
    if (status === 'completed' || status === 'failed') {
      assert.equal(after.uses, 1);
      assert.equal(after.successes, status === 'completed' ? 1 : 0);
      assert.equal(after.proficiency, status === 'completed' ? 0.475 : 0.24);
      assert.equal(library.get('base_skill').uses, 0);
    } else {
      assert.deepEqual(after, before);
    }
  });
}

test('skills: runner integrates with the real arbiter and primitive registry offline', async t => {
  const chats = [];
  const logs = [];
  const eventlog = { append: (kind, payload, traceId) => logs.push({ kind, payload, traceId }) };
  const registry = createPrimitiveRegistry({ bot: { chat: text => chats.push(text) }, eventlog });
  const library = fixture(t, registry).open();
  const arbiter = createArbiter({ registry, eventlog });
  library.learn(draft('base_skill'), teacher);
  library.learn(draft('greet_me', [{ call: 'base_skill', args: {} }, say('again')]), teacher);
  const result = await runSkill({ library, arbiter, name: 'greet_me', source: 'owner', traceId: 'trace-integration' });
  assert.equal(result.ok, true);
  assert.equal(result.outcome.status, 'completed');
  assert.equal(result.outcome.completedSteps, 2);
  assert.deepEqual(chats, ['hello', 'again']);
  const accepted = logs.filter(log => log.kind === 'arbiter.accept');
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].payload.source, 'owner');
  assert.equal(accepted[0].payload.label, 'greet_me');
  assert.ok(logs.every(log => log.traceId === 'trace-integration'));
  assert.equal(library.get('greet_me').successes, 1);
});

test('skills: innate seeds use the whitelist, exclude crafting and digging, and only write once', t => {
  const library = fixture(t).open();
  assert.ok(INNATE_SKILLS.length > 0);
  for (const innate of INNATE_SKILLS) {
    assert.equal(library.validateDraft(innate).ok, true);
    assert.ok(innate.body.every(step => !['craft', 'dig'].includes(step.primitive) && !step.call));
  }
  seedInnateSkills(library);
  const before = library.list();
  assert.equal(before.length, INNATE_SKILLS.length);
  assert.ok(before.every(skill => skill.version === 1 && skill.provenance.length === 1 &&
    skill.provenance[0].teacher_uuid === 'innate'));
  seedInnateSkills(library);
  assert.deepEqual(library.list(), before);
  const changed = library.learn(draft(INNATE_SKILLS[0].name), teacher).skill;
  seedInnateSkills(library);
  assert.deepEqual(library.get(changed.name), changed);
});

test('obtain nodes and the quantity type validate; bad shapes are rejected', t => {
  const library = fixture(t).open();
  const good = { name: 'make_stone', description: 'Obtain stone',
    params: { count: { type: 'quantity', default: 1 } },
    body: [{ obtain: { item: 'stone', count: '$count' } }] };
  assert.deepEqual(library.validateDraft(good), { ok: true, errors: [] });
  assert.equal(library.validateDraft({ ...good, body: [{ obtain: { item: 'stone', count: 40 } }] }).ok, true);
  assert.equal(library.validateDraft({ ...good, name: 'fetch_thing',
    params: { target: { type: 'item', required: true }, count: { type: 'quantity', default: 1 } },
    body: [{ obtain: { item: '$target', count: '$count' } }] }).ok, true);
  assert.equal(library.validateDraft({ ...good, name: 'fetch_count',
    params: { count: { type: 'count', default: 1 } },
    body: [{ obtain: { item: 'stone', count: '$count' } }] }).ok, true);
  const bad = [
    ['unknown node field', { ...good, name: 'bad_one', body: [{ obtain: { item: 'stone', count: 1 }, extra: true }] }],
    ['unknown inner field', { ...good, name: 'bad_two', body: [{ obtain: { item: 'stone', count: 1, at: '$self' } }] }],
    ['count zero', { ...good, name: 'bad_three', body: [{ obtain: { item: 'stone', count: 0 } }] }],
    ['count sixty five', { ...good, name: 'bad_four', body: [{ obtain: { item: 'stone', count: 65 } }] }],
    ['unknown item', { ...good, name: 'bad_five', body: [{ obtain: { item: 'unobtainium', count: 1 } }] }],
    ['undeclared ref', { ...good, name: 'bad_six', body: [{ obtain: { item: 'stone', count: '$nope' } }] }],
    ['wrong ref type', { ...good, name: 'bad_seven', params: { n: { type: 'number', default: 1 } },
      body: [{ obtain: { item: 'stone', count: '$n' } }] }],
    ['missing count', { ...good, name: 'bad_eight', body: [{ obtain: { item: 'stone' } }] }],
    ['quantity default out of range', { ...good, name: 'bad_nine', params: { count: { type: 'quantity', default: 65 } } }],
  ];
  for (const [label, value] of bad) assert.equal(library.validateDraft(value).ok, false, label);
});

test('A1+A3 learnSelf writes make_<item> with self provenance and survives reopen', t => {
  const f = fixture(t);
  const library = f.open();
  const { skill, isNew } = library.learnSelf({ item: 'stone_pickaxe', count: 2, traceId: 'trace-one',
    plan: { stepCount: 4, summary: 'plan' }, nowMs: 5_000 });
  assert.equal(isNew, true);
  assert.equal(skill.name, 'make_stone_pickaxe');
  assert.equal(skill.description, 'Obtain stone_pickaxe');
  assert.deepEqual(skill.body, [{ obtain: { item: 'stone_pickaxe', count: '$count' } }]);
  assert.deepEqual(skill.params, { count: { type: 'quantity', default: 1 } });
  assert.equal(skill.version, 1);
  assert.equal(skill.proficiency, 0.3);
  assert.deepEqual(skill.provenance, [{ teacher_uuid: 'self', taught_at: 5_000, version: 1,
    context: JSON.stringify({ goal: { item: 'stone_pickaxe', count: 2 }, plan: { stepCount: 4, summary: 'plan' } }),
    route: 'self', parent_skill: null, trace_id: 'trace-one' }]);
  f.setTime(6_000);
  const again = library.learnSelf({ item: 'stone_pickaxe', count: 1, traceId: 'trace-two',
    plan: { stepCount: 3, summary: 'plan' } });
  assert.equal(again.isNew, false);
  assert.equal(again.skill.version, 1);
  assert.equal(again.skill.provenance.length, 2);
  assert.equal(again.skill.provenance[1].trace_id, 'trace-two');
  assert.deepEqual(again.skill.body, skill.body);
  assert.equal(again.skill.description, skill.description);
  assert.throws(() => library.learnSelf({ item: 'stone', count: 1, traceId: '' }), InvalidSkillError);
  assert.throws(() => library.learnSelf({ item: 'stone', count: 1 }), InvalidSkillError);
  assert.throws(() => library.learn(draft(), { teacherUuid: 'x', context: 'c', route: 'self' }), InvalidSkillError);
  library.close();
  const restored = f.open().get('make_stone_pickaxe');
  assert.equal(restored.provenance.length, 2);
  assert.equal(restored.body[0].obtain.item, 'stone_pickaxe');
  assert.equal(restored.provenance[0].route, 'self');
});

test('learnSelf on an existing skill only appends provenance', t => {
  const f = fixture(t);
  const library = f.open();
  library.learn({ name: 'make_bowl', description: 'Taught bowl craft.',
    body: [{ fail: 'cannot' }] }, { teacherUuid: 'teacher-one', context: 'taught' });
  const before = library.get('make_bowl');
  const { skill, isNew } = library.learnSelf({ item: 'bowl', count: 1, traceId: 'trace-nine',
    plan: { stepCount: 1, summary: 's' } });
  assert.equal(isNew, false);
  assert.deepEqual(skill.body, before.body);
  assert.equal(skill.version, before.version);
  assert.equal(skill.description, before.description);
  assert.equal(skill.provenance.length, 2);
  assert.equal(skill.provenance[0].route, 'taught');
  assert.equal(skill.provenance[1].route, 'self');
  assert.equal(skill.provenance[1].version, before.version);
});

test('a copied pre-T13 library opens losslessly and accepts self skills', { skip: 'needs a local legacy skills database (data/skills.sqlite) that is not committed' }, t => {
  const f = fixture(t);
  const source = fileURLToPath(new URL('../data/skills.sqlite', import.meta.url));
  const before = new DatabaseSync(source, { readOnly: true });
  const expectedSkills = before.prepare('SELECT * FROM skills').all();
  const expectedProvenance = before.prepare('SELECT * FROM skill_provenance').all();
  before.close();
  copyFileSync(source, join(f.directory, 'skills.sqlite'));
  const library = f.open();
  assert.deepEqual(library.list().map(s => s.name).sort(), expectedSkills.map(s => s.name).sort());
  for (const row of expectedSkills) {
    const skill = library.get(row.name);
    assert.equal(skill.name, row.name);
    const body = JSON.parse(row.steps).map(node => node.skill === undefined ? node : { call: node.skill, args: {} });
    assert.deepEqual(skill.body, body);
    assert.deepEqual(skill.params, {});
    const provenance = expectedProvenance.filter(e => e.skill_name === row.name);
    assert.equal(skill.provenance.length, provenance.length);
    for (const [index, entry] of skill.provenance.entries()) {
      assert.equal(entry.teacher_uuid, provenance[index].teacher_uuid);
      assert.equal(entry.taught_at, provenance[index].taught_at);
      assert.equal(entry.context, provenance[index].context);
      assert.equal(entry.route, entry.teacher_uuid === 'innate' ? 'innate' : 'taught');
    }
  }
  library.learnSelf({ item: 'bowl', count: 1, traceId: 'trace-old', plan: { stepCount: 1, summary: 's' } });
  const learned = library.get('make_bowl');
  assert.equal(learned.provenance.at(-1).route, 'self');
  assert.equal(library.list().length, expectedSkills.length + 1);
});
