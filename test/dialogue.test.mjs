import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDialogue, parseShortReply, seedRecentSpeech } from '../src/dialogue.js';
import { createSpeaker } from '../src/teaching/speech.js';
import { createOwnerChatHandler } from '../src/teaching/handler.js';
import { parseUtterance } from '../src/teaching/parser.js';
import { mcData } from '../src/teaching/lexicon.js';
import { createSkillLibrary, validateDraft } from '../src/skills/library.js';
import { createPrimitiveRegistry } from '../src/primitives/registry.js';
import { createArbiter } from '../src/arbiter.js';
import { Vec3, goals } from '../src/primitives/helpers.js';

const OWNER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const tick = () => new Promise(resolve => setImmediate(resolve));
const dirtDraft = { name: 'dig_dirt', description: '挖泥土',
  body: [{ primitive: 'dig', params: {}, at: '$self.below' }] };

function fixture(t, { enabled = true, intent = null, speak, arbiter, registry,
  clock = { now: () => 1000 }, transformSpeech = text => text } = {}) {
  const root = fileURLToPath(new URL('../../.tmp/', import.meta.url));
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 't12-dialogue-'));
  registry ??= createPrimitiveRegistry({ mcData, ownerUuid: OWNER });
  const library = createSkillLibrary({ dataDir: directory, registry, clock });
  t.after(() => {
    try { library.close(); } finally {
      for (const file of readdirSync(directory)) unlinkSync(join(directory, file));
      rmdirSync(directory);
      assert.equal(existsSync(directory), false, 'T12 leaves no temporary database');
    }
  });
  const calls = [];
  const speeches = [];
  const speakCalls = [];
  const intentCalls = [];
  const logs = [];
  const outcomes = [];
  const eventlog = { append: (kind, payload, traceId) => logs.push({ kind, payload, traceId }),
    query: () => logs };
  arbiter ??= { submit(task) {
    calls.push(task);
    return { accepted: true, done: Promise.resolve(outcomes.shift() ?? { status: 'completed' }) };
  } };
  const brain = { enabled,
    async parseIntent(message, memory) {
      intentCalls.push({ message, memory });
      return typeof intent === 'function' ? intent(message, memory) : intent;
    },
    parseTeaching: async () => null,
    async speak(input) {
      speakCalls.push(structuredClone(input));
      return speak ? speak(input, speakCalls.length) : `回声${speakCalls.length}。`;
    },
  };
  const dialogue = createDialogue({ clock });
  const handler = createOwnerChatHandler({ library, arbiter, brain, registry, dialogue, clock,
    ownerUuid: OWNER, eventlog,
    relationship: { ownerName: () => 'TestOwner', nickname: () => '小鲨鱼' },
    mouth: { say(text, traceId) {
      const final = transformSpeech(text);
      speeches.push({ text: final, traceId });
      return final;
    } },
  });
  const learn = () => library.learn(dirtDraft, { teacherUuid: OWNER, context: '挖泥土就是挖脚下' });
  return { handler, library, dialogue, brain, learn, calls, speeches, speakCalls, intentCalls, outcomes };
}

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, ms) {
      const id = ++nextId;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    pending: () => timers.size,
    async advance(ms) {
      const end = now + ms;
      await tick();
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
        await tick();
      }
      now = end;
      await tick();
    },
  };
}

function followFixture() {
  const clock = fakeClock();
  const owner = { uuid: OWNER.toUpperCase(), isValid: true, position: new Vec3(10, 64, 0) };
  const stranger = { uuid: 'stranger', position: new Vec3(1, 64, 0) };
  const pathCalls = [];
  const bot = { entities: { 1: stranger, 2: owner }, players: {},
    pathfinder: {
      setGoal: (goal, dynamic) => pathCalls.push({ name: 'setGoal', goal, dynamic }),
      stop: () => pathCalls.push({ name: 'stop' }),
    } };
  const eventlog = { append() {} };
  const registry = createPrimitiveRegistry({ bot, ownerUuid: OWNER, clock, eventlog, mcData });
  const arbiter = createArbiter({ registry, eventlog, clock });
  return { clock, owner, bot, pathCalls, registry, arbiter };
}

for (const enabled of [true, false]) {
  test(`A${enabled ? '1' : '2'} replay: unknown, affirmative, teaching, counted command and bare affirmative (brain ${enabled ? 'on' : 'off'})`, async t => {
    const f = fixture(t, { enabled });
    assert.equal((await f.handler.handle('能挖几个泥土吗？', 'unknown')).kind, 'dont_know');
    assert.equal(f.dialogue.openQuestion.type, 'teach_request');
    assert.equal(f.dialogue.openQuestion.skillName, 'dig_dirt');
    assert.equal(f.calls.length, 0);
    const spoken = f.speeches.length;
    assert.deepEqual(await f.handler.handle('对', 'wait'), { kind: 'teach_wait', text: null });
    assert.equal(f.speeches.length, spoken);
    assert.equal(f.dialogue.openQuestion.type, 'teach_request');
    assert.equal((await f.handler.handle('挖泥土就是挖脚下', 'teach')).kind, 'learned');
    assert.equal(f.library.has('dig_dirt'), true);
    assert.equal(f.dialogue.openQuestion, null);
    assert.equal(f.calls.length, 1, 'one teaching trial');
    const before = f.speakCalls.length;
    assert.equal((await f.handler.handle('能挖几个泥土吗？', 'command')).kind, 'remembered');
    assert.equal(f.calls.length, 2, 'one counted program after learning');
    assert.equal(f.calls[1].program.body[0].repeat, 3);
    assert.ok(f.calls.slice(1).every(task => task.label === 'dig_dirt' && task.source === 'owner'));
    assert.equal(f.library.get('dig_dirt').uses, 1);
    assert.equal(f.dialogue.openQuestion, null);
    assert.ok(f.speakCalls.slice(before).every(call => call.situation.kind === 'remembered'));
    assert.equal((await f.handler.handle('对', 'chat')).kind, 'chat');
    assert.equal(f.calls.length, 2);
    if (!enabled) assert.equal(f.speakCalls.length, 0);
  });
}

test('confirm: confidence 0.4 asks, affirmative executes stored count, cancellation clears without execution', async t => {
  const f = fixture(t, { intent: { kind: 'command', skill: 'dig_dirt', action: '挖泥土',
    confidence: 0.4, args: { count: 2 } } });
  f.learn();
  assert.equal((await f.handler.handle('处理一下那边', 'confirm')).kind, 'confirm');
  assert.deepEqual(f.dialogue.openQuestion, { type: 'confirm', action: '挖泥土',
    skillName: 'dig_dirt', args: { count: 2 }, at: 1000 });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.handler.handle('对', 'yes')).kind, 'remembered');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].program.body[0].repeat, 2);
  assert.equal(f.dialogue.openQuestion, null);
  assert.equal((await f.handler.handle('处理一下那边', 'confirm-again')).kind, 'confirm');
  assert.equal((await f.handler.handle('算了', 'cancel')).kind, 'cancelled');
  assert.equal(f.dialogue.openQuestion, null);
  assert.equal(f.calls.length, 1);
  assert.equal(f.speakCalls.at(-1).situation.kind, 'cancelled');
});

test('cancellation and confirmation replies work with the brain disabled', async t => {
  const f = fixture(t, { enabled: false });
  f.learn();
  f.dialogue.setQuestion({ type: 'confirm', skillName: 'dig_dirt', action: '挖泥土', args: { count: 1 } });
  assert.equal((await f.handler.handle('对', 'yes')).kind, 'remembered');
  assert.equal(f.calls.length, 1);
  await f.handler.handle('挖石头', 'unknown');
  assert.equal(f.dialogue.openQuestion.type, 'teach_request');
  assert.equal((await f.handler.handle('算了', 'cancel')).kind, 'cancelled');
  assert.equal(f.dialogue.openQuestion, null);
  assert.equal(f.calls.length, 1);
  assert.equal(f.speakCalls.length, 0);
});

test('dialogue: retains 16 records, copies recent records and expires questions at 120 seconds', () => {
  let now = 0;
  const dialogue = createDialogue({ clock: { now: () => now } });
  for (let i = 0; i < 20; i++) dialogue.record(i % 2 ? 'companion' : 'owner', `line-${i}`, 'chat');
  assert.equal(dialogue.recent(100).length, 16);
  assert.equal(dialogue.recent(100)[0].text, 'line-4');
  assert.deepEqual(dialogue.recent(1)[0], { speaker: 'companion', text: 'line-19', ts: 0, kind: 'chat' });
  dialogue.recent(1)[0].text = 'mutation';
  assert.equal(dialogue.recent(1)[0].text, 'line-19');
  assert.deepEqual(dialogue.recentLines(), Array.from({ length: 8 }, (_, i) => `line-${5 + 2 * i}`));
  dialogue.recentLines().pop();
  assert.equal(dialogue.recentLines().length, 8);
  dialogue.setQuestion({ type: 'confirm', skillName: 'dig_dirt' });
  now = 119_999;
  assert.equal(dialogue.openQuestion.type, 'confirm');
  now = 120_000;
  assert.equal(dialogue.openQuestion, null);
});

test('dialogue: short replies accept punctuation, case and particles', () => {
  for (const text of ['对', '是', '是的', '嗯', '好', '好的', '可以', '行', '去吧', '做吧',
    '去吧呀！', '做吧吧。', 'ok', 'OK！', '对呀。']) {
    assert.equal(parseShortReply(text), 'yes', text);
  }
  for (const text of ['不', '不用', '不要', '算了', '别了', '不用啊！']) {
    assert.equal(parseShortReply(text), 'no', text);
  }
  assert.equal(parseShortReply('挖脚下'), null);
});

test('dialogue: final mouth text and owner messages reach speak and parseIntent memory', async t => {
  const f = fixture(t, { transformSpeech: text => `${text}已说出` });
  await f.handler.handle('第一条闲聊', 'first');
  assert.deepEqual(f.dialogue.recent(2).map(line => [line.speaker, line.text, line.kind]), [
    ['owner', '第一条闲聊', 'owner_message'], ['companion', f.speeches[0].text, 'chat'],
  ]);
  await f.handler.handle('第二条闲聊', 'second');
  for (const memory of [f.intentCalls.at(-1).memory, f.speakCalls.at(-1).memory]) {
    assert.ok(memory.dialogue.some(line => line.text === f.speeches[0].text));
    assert.equal(memory.dialogue.at(-1).text, '第二条闲聊');
    assert.ok(memory.dialogue.length <= 8);
  }
  assert.deepEqual(f.speakCalls.at(-1).memory.recentLines, [f.speeches[0].text]);
});

test('follow then stop: real arbiter runs follow and clears the pathfinder goal; idle stop', async t => {
  const g = followFixture();
  t.after(() => g.arbiter.cancel('owner'));
  const f = fixture(t, g);
  assert.equal((await f.handler.handle('跟着我', 'follow')).kind, 'following');
  await tick();
  assert.equal(g.arbiter.isBusy(), true);
  assert.deepEqual(g.arbiter.current(), { epoch: 1, source: 'owner', label: 'follow', traceId: 'follow' });
  const goal = g.pathCalls.find(call => call.goal);
  assert.ok(goal.goal instanceof goals.GoalFollow);
  assert.equal(goal.goal.entity, g.owner);
  assert.equal(goal.dynamic, true);
  assert.equal(goal.goal.rangeSq, 4, 'default follow distance is two blocks');
  assert.equal((await f.handler.handle('停', 'stop')).kind, 'stopped');
  await tick();
  assert.equal(g.arbiter.isBusy(), false);
  assert.equal(f.speakCalls.at(-1).situation.taskName, 'follow');
  assert.ok(g.pathCalls.some(call => call.name === 'stop'));
  assert.ok(g.pathCalls.some(call => call.name === 'setGoal' && call.goal === null));
  assert.equal(g.clock.pending(), 0);
  assert.equal((await f.handler.handle('停', 'idle')).kind, 'idle');
});

test('follow primitive: owner absent for 30 fake seconds returns owner_lost and clears goals', async () => {
  const g = followFixture();
  g.bot.entities = { 1: g.bot.entities[1] };
  const operation = g.registry.run('follow');
  let ended = false;
  void operation.then(() => { ended = true; });
  await g.clock.advance(29_999);
  assert.equal(ended, false);
  await g.clock.advance(1);
  const result = await operation;
  assert.equal(result.ok, true);
  assert.deepEqual(result.result, { reason: 'owner_lost' });
  assert.ok(g.pathCalls.some(call => call.name === 'stop'));
  assert.ok(g.pathCalls.some(call => call.name === 'setGoal' && call.goal === null));
  assert.equal(g.clock.pending(), 0);
});

test('follow primitive: UUID player lookup, cancellation clears goals and timers', async t => {
  const g = followFixture();
  g.bot.entities = {};
  g.bot.players = { MisleadingName: { uuid: OWNER.toUpperCase(), entity: g.owner },
    TestOwner: { uuid: 'stranger', entity: { position: new Vec3(1, 0, 0) } } };
  const controller = new AbortController();
  t.after(() => controller.abort());
  const operation = g.registry.run('follow', { range: 3 }, { signal: controller.signal });
  await tick();
  const followed = g.pathCalls.find(call => call.name === 'setGoal' && call.goal);
  assert.equal(followed.goal.entity, g.owner);
  assert.equal(followed.goal.rangeSq, 9);
  controller.abort();
  assert.equal((await operation).cancelled, true);
  await tick();
  assert.ok(g.pathCalls.some(call => call.name === 'stop'));
  assert.ok(g.pathCalls.some(call => call.name === 'setGoal' && call.goal === null));
  assert.equal(g.clock.pending(), 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('quantity parsing: Arabic, Chinese, two, vague and capped counts', () => {
  for (const [text, count, capped] of [
    ['挖5个泥土', 5, false], ['挖五块泥土', 5, false], ['挖两个泥土', 2, false],
    ['挖点泥土', 3, false], ['挖100个泥土', 16, true], ['挖泥土', 1, false],
    ['挖一些泥土', 3, false], ['挖六十四块泥土', 16, true],
  ]) {
    const parsed = parseUtterance(text);
    assert.equal(parsed.kind, 'command_action', text);
    assert.equal(parsed.skill, 'dig_dirt', text);
    assert.equal(parsed.args.count, count, text);
    assert.equal(parsed.args.capped === true, capped, text);
  }
});

test('counted execution stops on third failure with done 2 and requested 3', async t => {
  const f = fixture(t);
  f.learn();
  f.outcomes.push({ status: 'failed', error: { code: 'cannot_dig', message: 'blocked' },
    trace: [{ node: 'repeat', depth: 0, count: 3, completed: 2 }] });
  assert.equal((await f.handler.handle('挖几个泥土', 'failed')).kind, 'try_failed');
  assert.equal(f.calls.length, 1);
  const situation = f.speakCalls.at(-1).situation;
  assert.equal(situation.done, 2);
  assert.equal(situation.requested, 3);
  assert.equal(situation.reason.code, 'cannot_dig');
  assert.equal(f.library.get('dig_dirt').successes, 0);
});

test('capped execution submits one 16-round program and reports capped', async t => {
  const f = fixture(t);
  f.learn();
  assert.equal((await f.handler.handle('挖100个泥土', 'capped')).kind, 'remembered');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].program.body[0].repeat, 16);
  assert.equal(f.speakCalls.at(-1).situation.done, 16);
  assert.equal(f.speakCalls.at(-1).situation.capped, true);
});

test('ability query: known reports teacher, unknown opens teaching window; neither executes', async t => {
  const f = fixture(t);
  assert.equal(parseUtterance('你会挖泥土吗').kind, 'ask_ability');
  assert.equal(parseUtterance('会不会挖泥土').kind, 'ask_ability');
  assert.equal((await f.handler.handle('你会挖泥土吗', 'unknown')).kind, 'dont_know');
  assert.equal(f.dialogue.openQuestion.type, 'teach_request');
  assert.equal(f.calls.length, 0);
  f.learn();
  assert.equal((await f.handler.handle('你会挖泥土吗', 'known')).kind, 'ask_ability');
  const situation = f.speakCalls.at(-1).situation;
  assert.deepEqual(situation.taughtBy, { playerName: 'TestOwner' });
  assert.equal(situation.taughtWhen, '刚才');
  assert.equal(f.calls.length, 0);
});

test('duplicate generation retries once with avoid and accepts a repeated second answer', async t => {
  const repeated = '小鲨鱼，泥土操作已经完成了。';
  const f = fixture(t, { speak: () => repeated });
  f.dialogue.record('companion', repeated, 'remembered');
  const result = await f.handler.narrate({ kind: 'remembered', action: '挖泥土', itemName: '泥土' }, 'duplicate');
  assert.equal(f.speakCalls.length, 2);
  assert.equal(f.speakCalls[0].situation.avoid, undefined);
  assert.ok(f.speakCalls[1].situation.avoid.some(fragment => fragment.length >= 6));
  assert.ok(f.speakCalls[1].situation.avoid.every(fragment => !fragment.includes('小鲨鱼') && !fragment.includes('泥土')));
  assert.deepEqual(f.speakCalls[0].memory.recentLines, [repeated]);
  assert.equal(result.text, repeated);
  assert.equal(f.speeches.length, 1);
});

test('nonduplicate generation calls the brain only once', async t => {
  const f = fixture(t, { speak: () => '刚才的动作已结束。' });
  f.dialogue.record('companion', '背包里还有很多材料。', 'chat');
  assert.equal((await f.handler.narrate({ kind: 'chat' }, 'unique')).text, '刚才的动作已结束。');
  assert.equal(f.speakCalls.length, 1);
});

test('duplicate checking and recentLines retain the last eight spoken lines across owner turns', async t => {
  const oldLine = '这次操作已经完成了。';
  const f = fixture(t, { speak: () => oldLine });
  for (let i = 0; i < 8; i++) {
    f.dialogue.record('owner', `消息${i}`, 'owner_message');
    f.dialogue.record('companion', i === 0 ? oldLine : `答复${i}。`, 'chat');
  }
  for (let i = 0; i < 16; i++) f.dialogue.record('owner', `连续消息${i}`, 'owner_message');
  assert.ok(f.dialogue.recent(16).every(line => line.speaker === 'owner'));
  await f.handler.narrate({ kind: 'chat' }, 'old-duplicate');
  assert.equal(f.speakCalls[0].memory.recentLines.length, 8);
  assert.equal(f.speakCalls[0].memory.recentLines[0], oldLine);
  assert.equal(f.speakCalls.length, 2);
  assert.ok(f.speakCalls[1].situation.avoid.length > 0);
});

test('capabilities contain learned skills and builtin follow/stop on each speech', async t => {
  const f = fixture(t);
  f.learn();
  await f.handler.handle('你好', 'chat');
  await f.handler.handle('挖泥土', 'command');
  for (const { situation } of f.speakCalls) {
    assert.deepEqual(situation.capabilities.find(capability => capability.name === 'dig_dirt'),
      { name: 'dig_dirt', description: '挖泥土' });
    for (const name of ['follow', 'stop']) {
      const capability = situation.capabilities.find(capability => capability.name === name);
      assert.equal(capability.builtin, true);
      assert.ok(capability.description);
    }
  }
});

for (const confidence of [0.9, 0.4]) {
  test(`unknown model command goes to dont_know, never chat or confirm (confidence ${confidence})`, async t => {
    const f = fixture(t, { intent: { kind: 'command', skill: 'fly_high', action: '飞上天', confidence } });
    assert.equal((await f.handler.handle('带我看看云层', 'unknown')).kind, 'dont_know');
    assert.equal(f.calls.length, 0);
    assert.equal(f.dialogue.openQuestion.type, 'teach_request');
    assert.equal(f.dialogue.openQuestion.skillName, 'fly_high');
    assert.deepEqual(f.speakCalls.map(call => call.situation.kind), ['dont_know']);
  });
}

test('taught draft rejects follow while builtin registry allows it', () => {
  const registry = createPrimitiveRegistry({ ownerUuid: OWNER, mcData });
  const draft = { name: 'follow_owner', description: '跟随', body: [{ primitive: 'follow', params: {} }] };
  assert.equal(registry.has('follow'), true);
  assert.ok(registry.list().includes('follow'));
  assert.equal(registry.describe('follow').defaultTimeoutMs, 600_000);
  assert.equal(validateDraft(draft, { registry }).ok, true);
  const validation = validateDraft(draft, { registry, taught: true });
  assert.equal(validation.ok, false);
  assert.ok(validation.errors.some(error => /taught skills cannot use follow/u.test(error)));
});

test('arbiter cancel(source): mismatch returns false without cancelling active task', async () => {
  let signal;
  let finish;
  const operation = new Promise(resolve => { finish = resolve; });
  const arbiter = createArbiter({ eventlog: { append() {} },
    registry: { has: () => true, run(_name, _params, options) { signal = options.signal; return operation; } } });
  const submitted = arbiter.submit({ source: 'plan', label: 'plan task', steps: [{ primitive: 'goTo', params: {} }] });
  const current = arbiter.current();
  assert.equal(arbiter.cancel('owner'), false);
  assert.deepEqual(arbiter.current(), current);
  assert.equal(signal.aborted, false);
  assert.equal(arbiter.cancel('plan'), true);
  assert.equal(signal.aborted, true);
  assert.equal((await submitted.done).status, 'cancelled');
  assert.equal(arbiter.cancel('plan'), false);
  finish({ ok: true });
  await tick();
});

test('seedRecentSpeech replays the last eight speech texts in order', () => {
  const logs = Array.from({ length: 11 }, (_, index) => ({ kind: 'speech', ts: index, payload: { text: `line${index}` } }));
  logs.push({ kind: 'speech', ts: 11, payload: {} });
  const appended = [];
  const eventlog = { query: () => logs, append: (...args) => appended.push(args) };
  const dialogue = createDialogue({ clock: { now: () => 0 } });
  const lines = seedRecentSpeech(dialogue, eventlog);
  assert.deepEqual(lines, Array.from({ length: 7 }, (_, index) => `line${index + 4}`));
  assert.deepEqual(dialogue.recentLines(), lines);
  assert.equal(dialogue.recent().length, 0, 'seeding must not add records');
  assert.equal(appended.length, 0, 'seeding must not emit events');
});

test('empty history seeds nothing and seeding is capped at eight', () => {
  const empty = createDialogue({ clock: { now: () => 0 } });
  assert.deepEqual(seedRecentSpeech(empty, { query: () => [] }), []);
  assert.deepEqual(empty.recentLines(), []);
  const dialogue = createDialogue({ clock: { now: () => 0 } });
  dialogue.seedLines(['a', 'b', 'c']);
  dialogue.seedLines(Array.from({ length: 9 }, (_, index) => `s${index}`));
  assert.deepEqual(dialogue.recentLines(), Array.from({ length: 8 }, (_, index) => `s${index + 1}`));
});

test('a seeded line matching generated speech triggers one regeneration', async () => {
  const dialogue = createDialogue({ clock: { now: () => 0 } });
  dialogue.seedLines(['今天也是晴朗的好日子']);
  const prompts = [];
  const { say } = createSpeaker({ dialogue,
    brain: { enabled: true,
      speak: async input => { prompts.push(input); return prompts.length === 1 ? '今天也是晴朗的好日子呢' : '完全不同的回答。'; } },
    mouth: { say: async text => text },
    eventlog: { append() {}, query: () => [] },
    relationship: { ownerName: () => 'TestOwner', nickname: () => 'TestOwner' },
    ownerUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    skillsMemory: () => [], capabilities: () => [] });
  const result = await say({ kind: 'chat', ownerMessage: 'hi' }, 'seeded');
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].situation.avoid.length > 0);
  assert.equal(result.text, '完全不同的回答。');
});
