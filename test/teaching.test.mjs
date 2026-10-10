import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, unlinkSync, rmdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveItem, resolveGoalItem, mcData } from '../src/teaching/lexicon.js';
import { itemNames } from '../src/teaching/itemNames.js';
import { parseUtterance } from '../src/teaching/parser.js';
import { createBrain } from '../src/brain/llm.js';
import { factLine, describeWhen, buildPersona } from '../src/persona.js';
import { createRelationship } from '../src/relationship.js';
import { createMouth } from '../src/mouth.js';
import { createOwnerChatHandler } from '../src/teaching/handler.js';
import { createSkillLibrary } from '../src/skills/library.js';
import { createPrimitiveRegistry } from '../src/primitives/registry.js';
import { createDialogue } from '../src/dialogue.js';

const tempRoot = process.env.COMPANION_TEST_TMP ?? fileURLToPath(new URL('../../.tmp/', import.meta.url));
const OWNER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RAW = '四个木板就能合成工作台';
const secret = 'fake-t5-private-key';
const allowedItems = ['crafting_table', 'oak_planks', 'oak_log', 'stick', 'chest', 'torch'];
const validTeaching = { item: 'crafting_table', ingredients: [{ item: 'oak_planks', count: 4 }] };
const response = content => ({ ok: true, status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
  body: new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
    controller.close();
  } }),
});
const brainWith = (fetch, options = {}) => createBrain({ baseUrl: 'https://example.invalid/v1/',
  apiKey: secret, model: 'test-model', fetch, ...options });

function fixture(t, { brain = createBrain(), registry = createPrimitiveRegistry({}) } = {}) {
  mkdirSync(tempRoot, { recursive: true });
  const directory = mkdtempSync(join(tempRoot, 't5-test-'));
  const libraries = [];
  const calls = [];
  const speech = [];
  const logs = [];
  let timestamp = new Date(2026, 8, 30, 12).getTime();
  let outcome = { status: 'completed' };
  const clock = { now: () => timestamp };
  const arbiter = { submit(intent) { calls.push(intent); return { done: Promise.resolve(outcome) }; } };
  const mouth = { say(text, traceId) { speech.push({ text, traceId }); } };
  const eventlog = { append(kind, payload, traceId) { logs.push({ kind, payload, traceId, ts: timestamp }); },
    query: () => logs };
  const relationship = createRelationship({ eventlog, brain, ownerUuid: OWNER });
  relationship.setOwnerName('TestOwner');
  function open() {
    const library = createSkillLibrary({ dataDir: directory, registry, clock });
    libraries.push(library);
    return library;
  }
  function handler(library, overrides = {}) {
    return createOwnerChatHandler({ library, arbiter, mouth, brain, eventlog,
      ownerUuid: OWNER, relationship, clock, random: () => 0, ...overrides });
  }
  t.after(() => {
    try { for (const library of libraries) library.close(); } finally {
      assert.equal(dirname(directory), resolve(tempRoot));
      for (const file of readdirSync(directory)) unlinkSync(join(directory, file));
      rmdirSync(directory);
      assert.equal(existsSync(directory), false, 'T5 must leave no temporary files');
    }
  });
  return { open, handler, calls, speech, logs, relationship, setTime: value => { timestamp = value; },
    setOutcome: value => { outcome = value; } };
}

test('teaching lexicon: Chinese, English, and real mcData names resolve', () => {
  const groups = [
    ['oak_planks', '木板', '橡木木板', 'planks'], ['oak_log', '原木', '木头', 'log'],
    ['crafting_table', '工作台', 'crafting table'], ['stick', '木棍', '棍子', 'stick'],
    ['chest', '箱子', 'chest'], ['torch', '火把', 'torch'],
  ];
  for (const [name, ...aliases] of groups) for (const text of [name, ...aliases]) {
    assert.equal(resolveItem(text), name);
  }
  for (const name of Object.keys(mcData.itemsByName)) assert.equal(resolveItem(name), name);
  assert.equal(resolveItem('  CRAFTING   TABLE  '), 'crafting_table');
  for (const value of ['imaginary_item', '龙蛋糕', '__proto__', '', null]) assert.equal(resolveItem(value), null);
});

const teachingExamples = [
  [RAW, 'crafting_table', 'oak_planks', 4],
  ['4个木板可以做工作台', 'crafting_table', 'oak_planks', 4],
  ['用四块木板合成一个工作台', 'crafting_table', 'oak_planks', 4],
  ['一个原木能做四个木板', 'oak_planks', 'oak_log', 1],
  ['两个木板合成四根木棍', 'stick', 'oak_planks', 2],
  ['4 planks make a crafting table', 'crafting_table', 'oak_planks', 4],
  ['craft a crafting table from 4 planks', 'crafting_table', 'oak_planks', 4],
  ['两张木板做成四根木棍', 'stick', 'oak_planks', 2],
  ['一块原木变成四个木板', 'oak_planks', 'oak_log', 1],
];
for (const [raw, item, ingredient, count] of teachingExamples) {
  test(`teaching parser: ${raw}`, () => {
    assert.deepEqual(parseUtterance(raw), { kind: 'teach_craft', item,
      ingredients: [{ item: ingredient, count }], raw });
  });
}

test('teaching parser: one through ten, 两, all classifiers, punctuation and multiple ingredients', () => {
  for (const [index, number] of Array.from('一二三四五六七八九十').entries()) {
    for (const unit of ['块', '个', '根', '张']) {
      assert.equal(parseUtterance(`${number}${unit}木板合成工作台`).ingredients[0].count, index + 1);
    }
  }
  assert.equal(parseUtterance('两块木板合成木棍').ingredients[0].count, 2);
  assert.deepEqual(parseUtterance('几块木板合成工作台').ingredients, [{ item: 'oak_planks', count: null }]);
  assert.deepEqual(parseUtterance('  4 planks make a crafting table!  '), {
    kind: 'teach_craft', ...validTeaching, raw: '  4 planks make a crafting table!  ',
  });
  assert.deepEqual(parseUtterance('一个木棍和一个原木合成火把').ingredients,
    [{ item: 'stick', count: 1 }, { item: 'oak_log', count: 1 }]);
});

for (const raw of ['做个工作台', '帮我合成一个工作台', '造工作台', 'make a crafting table']) {
  test(`teaching parser command: ${raw}`, () => {
    assert.deepEqual(parseUtterance(raw), { kind: 'command_craft', item: 'crafting_table',
      count: 1, giveToOwner: false, raw });
  });
}

test('teaching parser: skills questions and ordinary chat', () => {
  for (const raw of ['你会什么', '你会做什么', 'what can you do']) {
    assert.deepEqual(parseUtterance(raw), { kind: 'ask_skills', raw });
  }
  for (const raw of ['主人回来了', '今天天气不错', 'hello', '', '我想你了']) {
    assert.deepEqual(parseUtterance(raw), { kind: 'chat', raw });
  }
});

test('teaching parser: unresolved outputs retain the unknown word and null item', () => {
  for (const raw of ['四个木板合成星星', '做个星星', 'make a star']) {
    const parsed = parseUtterance(raw);
    assert.equal(parsed.item, null);
    assert.equal(parsed.unknownText, raw === 'make a star' ? 'star' : '星星');
    assert.equal(parsed.raw, raw);
  }
  assert.equal(parseUtterance('四个星星合成工作台').unknownText, '星星');
  assert.equal(parseUtterance('四个星星合成工作台').item, null);
});

test('teaching persona: fallback reports facts and stays silent for social events', () => {
  const vars = { item: 'crafting_table', itemName: '工作台', taughtWhen: '昨天',
    taughtBy: { playerName: 'TestOwner' }, reason: '被打断' };
  assert.equal(factLine({ kind: 'learned', ...vars }), '工作台：已学会。');
  assert.equal(factLine({ kind: 'dont_know', ...vars }), '工作台：还不会。');
  assert.equal(factLine({ kind: 'remembered', ...vars }), '工作台：已做好（昨天 TestOwner 教的）。');
  assert.equal(factLine({ kind: 'try_failed', ...vars }), '工作台：没做成，原因：被打断。');
  assert.equal(factLine({ kind: 'skills_list', skills: [{ itemName: '工作台' }, { itemName: '木棍' }] }), '会：工作台、木棍。');
  assert.equal(factLine({ kind: 'unknown_word', unknownWord: '星星' }), '不认识：星星。');
  for (const kind of ['owner_joined', 'owner_left', 'chat']) assert.equal(factLine({ kind }), null);
  assert.match(buildPersona(), /所有行为.*只限于游戏内/u);
  assert.match(buildPersona(), /不做任何情感操控/u);
});

test('teaching persona: describeWhen handles every time category and calendar boundaries', () => {
  const now = new Date(2026, 8, 30, 12).getTime();
  assert.equal(describeWhen(now, now), '刚才');
  assert.equal(describeWhen(now + 1_000, now), '刚才');
  assert.equal(describeWhen(now - 5 * 60_000, now), '5 分钟前');
  assert.equal(describeWhen(now - 3_600_000, now), '今天早些时候');
  assert.equal(describeWhen(now - 86_400_000, now), '昨天');
  assert.equal(describeWhen(now - 3 * 86_400_000, now), '3 天前');
  assert.equal(describeWhen(new Date(2026, 8, 29, 23).getTime(), now), '昨天');
});

test('teaching mouth: concurrent speech queues at minimum intervals, truncates, and records traces', async () => {
  let now = 0;
  const sends = [];
  const events = [];
  const mouth = createMouth({ bot: { chat(text) { sends.push({ text, ts: now }); } },
    eventlog: { append(kind, payload, traceId) { events.push({ kind, payload, traceId }); } },
    clock: { now: () => now, setTimeout(fn, ms) { now += ms; queueMicrotask(fn); } },
    maxLength: 4,
  });
  assert.deepEqual(await Promise.all([mouth.say('玩家你好呀', 'one'), mouth.say('second', 'two'), mouth.say('third', 'three')]),
    ['玩家你好', 'seco', 'thir']);
  assert.deepEqual(sends, [{ text: '玩家你好', ts: 0 }, { text: 'seco', ts: 800 }, { text: 'thir', ts: 1600 }]);
  assert.deepEqual(events, sends.map(({ text }, i) => ({ kind: 'speech', payload: { text }, traceId: ['one', 'two', 'three'][i] })));
  now = 5000;
  await mouth.say('later', 'four');
  assert.equal(sends.at(-1).ts, 5000);
});

test('teaching mouth: a failed send does not poison later queued speech', async () => {
  let first = true;
  const events = [];
  const mouth = createMouth({ minIntervalMs: 0, bot: { chat() {
    if (first) { first = false; throw new Error('offline'); }
  } }, eventlog: { append: (...args) => events.push(args) } });
  await assert.rejects(mouth.say('first'), /offline/u);
  assert.equal(await mouth.say('next'), 'next');
  assert.equal(events.length, 1);
});

test('teaching brain: any missing setting disables all methods without calling fetch', async () => {
  for (const field of ['baseUrl', 'apiKey', 'model']) {
    const brain = brainWith(() => assert.fail('Disabled brain must not fetch'), { [field]: '' });
    assert.equal(brain.enabled, false);
    assert.equal(await brain.parseTeaching(RAW, { allowedItems }), null);
    assert.equal(await brain.speak({ situation: { kind: 'chat', ownerMessage: 'hello' } }), null);
  }
});

test('teaching brain: OpenAI request uses Bearer and validates Chinese aliases against allowed mcData', async () => {
  const requests = [];
  const brain = brainWith(async (url, options) => {
    requests.push({ url, options });
    return response(JSON.stringify({ item: '工作台', ingredients: [{ item: '木板', count: 4 }] }));
  });
  assert.equal(brain.enabled, true);
  assert.deepEqual(await brain.parseTeaching(RAW, { allowedItems }), validTeaching);
  const { url, options } = requests[0];
  assert.equal(url, 'https://example.invalid/v1/chat/completions');
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, `Bearer ${secret}`);
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'test-model');
  assert.equal(body.stream, false);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.deepEqual(JSON.parse(body.messages[1].content), { text: RAW, allowedItems });
});

test('teaching brain: invalid JSON, unknown or disallowed items, and invalid counts are rejected', async () => {
  const invalid = [null, [], {}, { ...validTeaching, item: 'illegal_item' },
    { ...validTeaching, item: 'diamond' }, { ...validTeaching, ingredients: [] },
    { ...validTeaching, ingredients: [null] },
    { ...validTeaching, ingredients: [{ item: 'illegal_item', count: 4 }] },
    ...[0, -1, 1.5, '4'].map(count => ({ ...validTeaching, ingredients: [{ item: 'oak_planks', count }] }))];
  for (const value of invalid) {
    assert.equal(await brainWith(async () => response(JSON.stringify(value))).parseTeaching(RAW, { allowedItems }), null);
  }
  assert.equal(await brainWith(async () => response('not JSON')).parseTeaching(RAW, { allowedItems }), null);
});

test('teaching brain: speak passes memory as user data and keeps one sentence and at most 40 characters', async () => {
  let body;
  const brain = brainWith(async (_, options) => {
    body = JSON.parse(options.body);
    return response('玩家你好。第二句不能出现。');
  });
  assert.equal(await brain.speak({ situation: { kind: 'chat', ownerMessage: '你好' }, persona: buildPersona(), memory: ['教过工作台'] }), '玩家你好。');
  assert.ok(body.messages[0].content.includes(buildPersona()));
  assert.equal(body.messages[0].content.includes('教过工作台'), false);
  assert.deepEqual(JSON.parse(body.messages[1].content).memory, ['教过工作台']);
  assert.equal(body.stream, true);
  assert.equal(Array.from(await brainWith(async () => response('啊'.repeat(90))).speak()).length, 40);
  assert.equal(await brainWith(async () => response('')).speak(), null);
  assert.equal(await brainWith(async () => response('完成！下一句。')).speak(), '完成！');
});

test('teaching brain: HTTP, fetch, and response JSON errors return null without leaking the key', async t => {
  const output = [];
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) t.mock.method(console, method, (...args) => output.push(args));
  for (const fetch of [
    async () => ({ ok: false, status: 500 }),
    async () => { throw new Error(`remote error ${secret}`); },
    async () => ({ ok: true, json: async () => { throw new Error(secret); } }),
    async () => response(secret),
  ]) {
    const brain = brainWith(fetch);
    assert.equal(await brain.parseTeaching(RAW, { allowedItems }), null);
    assert.equal(await brain.speak(), null);
  }
  assert.equal(JSON.stringify(output).includes(secret), false);
});

test('teaching brain: timeout covers stalled fetch and response body, even when abort is ignored', async () => {
  for (const stallBody of [false, true]) {
    let signal;
    const brain = brainWith(async (_, options) => {
      signal = options.signal;
      if (stallBody) return { ok: true, json: () => new Promise(() => {}), body: new ReadableStream() };
      return new Promise(() => {});
    }, { speakTimeoutMs: 10, parseTimeoutMs: 10 });
    assert.equal(await brain.parseTeaching(RAW, { allowedItems }), null);
    assert.equal(signal.aborted, true);
    assert.equal(await brain.speak(), null);
    assert.equal(signal.aborted, true);
  }
});

test('teaching handler M0: unknown -> trial -> learn -> close/reopen -> remembered, without LLM', async t => {
  const f = fixture(t);
  const library = f.open();
  const handler = f.handler(library);
  assert.equal((await handler.handle('做个工作台', 'before')).kind, 'dont_know');
  assert.equal(f.calls.length, 0);
  assert.equal((await handler.handle(RAW, 'learn')).kind, 'learned');
  assert.deepEqual(f.calls, [{ source: 'owner', label: 'craft_crafting_table',
    steps: [{ primitive: 'craft', params: { itemName: 'crafting_table', count: 1, useTable: false } }], traceId: 'learn' }]);
  const learned = library.get('craft_crafting_table');
  assert.equal(learned.provenance[0].teacher_uuid, OWNER);
  assert.equal(learned.provenance[0].context, RAW);
  assert.equal(learned.provenance[0].taught_at, new Date(2026, 8, 30, 12).getTime());
  assert.equal(f.logs.find(event => event.kind === 'teaching.learned').traceId, 'learn');
  library.close();
  const reopened = f.open();
  f.setTime(learned.provenance[0].taught_at + 86_400_000);
  const remembered = await f.handler(reopened).handle('做个工作台', 'remember');
  assert.equal(remembered.kind, 'remembered');
  assert.equal(remembered.text, '工作台：已做好（昨天 TestOwner 教的）。');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].label, 'craft_crafting_table');
  assert.equal(f.calls[1].source, 'owner');
  assert.equal(f.calls[1].traceId, 'remember');
  assert.equal(reopened.get('craft_crafting_table').successes, 1);
});

test('teaching handler: learning waits for the actual trial outcome', async t => {
  const f = fixture(t);
  const library = f.open();
  let finish;
  const handler = f.handler(library, { arbiter: { submit() {
    return { done: new Promise(resolve => { finish = resolve; }) };
  } } });
  const pending = handler.handle(RAW, 'pending');
  assert.equal(library.has('craft_crafting_table'), false);
  assert.equal(f.speech.length, 0);
  finish({ status: 'completed' });
  assert.equal((await pending).kind, 'learned');
  assert.equal(library.has('craft_crafting_table'), true);
});

test('teaching handler: missing materials never enter the library and record failure', async t => {
  const f = fixture(t);
  const library = f.open();
  f.setOutcome({ status: 'failed', error: { message: 'No available recipe (missing ingredients or crafting table)' } });
  const result = await f.handler(library).handle(RAW, 'missing');
  assert.equal(result.kind, 'missing_item');
  assert.match(result.text, /oak_planks/u);
  assert.equal(f.calls.length, 1);
  assert.equal(library.has('craft_crafting_table'), false);
  assert.equal(f.logs[0].kind, 'teaching.failed');
  assert.equal(f.logs[0].traceId, 'missing');
});

test('teaching handler: missing_ingredients code maps kinds without relying on the message', async t => {
  const f = fixture(t);
  const library = f.open();
  const handler = f.handler(library);
  f.setOutcome({ status: 'failed', error: { code: 'missing_ingredients', message: 'server said no' } });
  assert.equal((await handler.handle(RAW, 'coded-missing')).kind, 'missing_item');
});

test('teaching handler: reteaching appends provenance and uses the previous teaching time', async t => {
  const f = fixture(t);
  const library = f.open();
  const handler = f.handler(library);
  await handler.handle(RAW, 'first');
  const first = library.get('craft_crafting_table').provenance[0];
  f.setTime(first.taught_at + 5 * 60_000);
  const raw = '4个木板可以做工作台';
  const result = await handler.handle(raw, 'second');
  assert.equal(result.kind, 'relearned');
  assert.equal(result.text, '工作台：已重新学会（5 分钟前 TestOwner 教过）。');
  const provenance = library.get('craft_crafting_table').provenance;
  assert.equal(provenance.length, 2);
  assert.deepEqual(provenance[0], first);
  assert.equal(provenance[1].teacher_uuid, OWNER);
  assert.equal(provenance[1].context, raw);
  assert.equal(f.calls.length, 2);
  assert.equal((await handler.handle('做个工作台', 'again')).kind, 'remembered');
  assert.equal(f.speech.at(-1).text, '工作台：已做好（刚才 TestOwner 教的）。');
});

test('teaching handler: workbench need follows mcData recipes, not taught ingredient count', async t => {
  const f = fixture(t);
  const handler = f.handler(f.open());
  for (const [text, expected] of [[RAW, false], ['一个原木能做四个木板', false],
    ['两个木板合成四根木棍', false], ['八个木板合成箱子', true], ['一个木棍和一个原木合成火把', false]]) {
    assert.equal((await handler.handle(text, 'table')).kind, 'learned');
    assert.equal(f.calls.at(-1).steps[0].params.useTable, expected);
    assert.equal(f.calls.at(-1).steps[0].params.count, 1);
  }
});

test('teaching handler: invalid drafts and quantities never submit or learn', async t => {
  const f = fixture(t, { registry: { has: () => false } });
  const library = f.open();
  assert.equal((await f.handler(library).handle(RAW, 'invalid')).kind, 'try_failed');
  assert.equal(f.calls.length, 0);
  assert.equal(library.list().length, 0);
  const normal = fixture(t);
  const normalLibrary = normal.open();
  assert.equal((await normal.handler(normalLibrary).handle('0个木板合成工作台', 'zero')).kind, 'try_failed');
  assert.equal((await normal.handler(normalLibrary).handle('几块木板合成工作台', 'uncertain')).kind, 'try_failed');
  assert.equal(normal.calls.length, 0);
});

for (const status of ['failed', 'preempted', 'cancelled', 'rejected']) {
  test(`teaching handler: ${status} trial does not learn or replace prior skill`, async t => {
    const f = fixture(t);
    const library = f.open();
    const handler = f.handler(library);
    await handler.handle(RAW, 'initial');
    const before = library.get('craft_crafting_table');
    f.setOutcome({ status, error: { message: 'interrupted' } });
    assert.equal((await handler.handle(RAW, 'retry')).kind, 'try_failed');
    assert.deepEqual(library.get('craft_crafting_table'), before);
    assert.equal((await handler.handle('做个工作台', 'command')).kind, 'try_failed');
  });
}

test('teaching handler: learned command missing materials uses missing_item', async t => {
  const f = fixture(t);
  const handler = f.handler(f.open());
  await handler.handle(RAW, 'initial');
  f.setOutcome({ status: 'failed', error: { code: 'missing_item', item: 'oak_planks' } });
  const result = await handler.handle('做个工作台', 'command');
  assert.equal(result.kind, 'missing_item');
  assert.match(result.text, /oak_planks/u);
});

test('teaching handler: enabled brain fallback is validated then tried before learning', async t => {
  let requests = 0;
  const f = fixture(t, { brain: brainWith(async () => {
    requests++;
    return response(JSON.stringify(validTeaching));
  }) });
  const library = f.open();
  assert.equal((await f.handler(library).handle('Put four oak boards together for a workbench', 'brain')).kind, 'learned');
  assert.equal(requests, 2);
  assert.equal(f.calls.length, 1);
  assert.equal(library.get('craft_crafting_table').provenance[0].context, 'Put four oak boards together for a workbench');
});

test('teaching handler: illegal brain output is refused even from an injected untrusted brain', async t => {
  for (const brain of [brainWith(async (_, options) => response(JSON.parse(options.body).stream ? '' : JSON.stringify({ ...validTeaching, item: 'illegal_item' }))),
    { enabled: true, parseTeaching: async () => ({ ...validTeaching, item: 'illegal_item' }), speak: async () => null }]) {
    const f = fixture(t, { brain });
    const library = f.open();
    await f.handler(library).handle('四个木板合成星星', 'illegal');
    assert.equal(library.list().length, 0);
    assert.equal(f.calls.length, 0);
    assert.equal(f.speech[0].text, '不认识：星星。');
    assert.equal(JSON.stringify(f.logs).includes(secret), false);
  }
});

test('teaching handler: facts speak without an intent and chat stays silent without a brain', async t => {
  const f = fixture(t);
  const library = f.open();
  const handler = f.handler(library);
  assert.equal((await handler.handle('你会什么', 'skills')).kind, 'skills_list');
  assert.equal((await handler.handle('做个星星', 'unknown')).kind, 'unknown_word');
  assert.equal(f.speech.at(-1).text, '不认识：星星。');
  assert.deepEqual(await handler.handle('今天天气不错', 'chat'), { kind: 'chat', text: null });
  assert.equal(f.speech.length, 2);
  assert.equal(f.calls.length, 0);
  await handler.handle(RAW, 'learn');
  assert.equal((await handler.handle('你会做什么', 'list')).text, '会：工作台。');
  const brain = { enabled: true, parseTeaching: async () => null, speak: async ({ persona, memory, situation }) => {
    assert.equal(persona, buildPersona({ playerName: 'TestOwner', nickname: 'TestOwner' }));
    assert.equal(memory.skills.length, 1);
    assert.equal(situation.ownerMessage, 'hello');
    return 'TestOwner，我在。';
  } };
  assert.equal((await f.handler(library, { brain }).handle('hello', 'reply')).text, 'TestOwner，我在。');
});

test('teaching handler: every crafting branch provides complete situations and compact owner memory', async t => {
  const situations = [];
  const memories = [];
  let output = '模型现场生成。';
  const lines = ['模型现场生成。', '记录首次学习结果。', '更新已有教学来源。',
    '当前制作已经完成。', '这次操作没有成功。', '背包缺少所需材料。'];
  const f = fixture(t, { brain: { enabled: true, parseTeaching: async () => null,
    speak: async ({ situation, memory }) => {
      situations.push(situation);
      memories.push(memory);
      return output === null ? null : lines[situations.length - 1];
    } } });
  const library = f.open();
  const handler = f.handler(library);
  for (let i = 0; i < 120; i++) {
    f.logs.push({ kind: 'chat', ts: i, payload: { from_owner: true, message: 'private bulky payload'.repeat(100) } });
    f.logs.push({ kind: 'playerJoined', ts: i, payload: { uuid: 'stranger' } });
  }
  assert.deepEqual(await handler.handle('做个工作台', 'unknown'), { kind: 'dont_know', text: output });
  assert.equal(memories[0].events.length, 10);
  assert.deepEqual(memories[0].events.map(event => event.ts), Array.from({ length: 10 }, (_, i) => i + 110));
  assert.deepEqual(Object.keys(memories[0].events[0]), ['kind', 'ts']);
  assert.equal(JSON.stringify(memories[0]).includes('private bulky payload'), false);
  await handler.handle(RAW, 'learn');
  await handler.handle(RAW, 'relearn');
  await handler.handle('做个工作台', 'remember');
  f.setOutcome({ status: 'failed', error: { message: 'interrupted' } });
  await handler.handle(RAW, 'failed');
  f.setOutcome({ status: 'failed', error: { code: 'missing_item', item: 'oak_planks', message: '材料不足' } });
  await handler.handle(RAW, 'missing');
  assert.deepEqual(situations.map(value => value.kind), ['dont_know', 'learned', 'relearned', 'remembered', 'try_failed', 'missing_item']);
  for (const situation of situations) {
    for (const name of ['kind', 'item', 'itemName', 'reason', 'taughtBy', 'taughtWhen', 'previousTeachings', 'skills', 'ownerMessage']) {
      assert.ok(Object.hasOwn(situation, name), `${situation.kind} needs ${name}`);
    }
    assert.deepEqual(situation.owner, { playerName: 'TestOwner', nickname: 'TestOwner' });
    if (situation.kind === 'dont_know') {
      assert.equal(situation.taughtBy, null);
      assert.equal(situation.taughtWhen, null);
    } else assert.deepEqual(situation.taughtBy, { playerName: 'TestOwner' });
    assert.ok(Array.isArray(situation.skills));
    assert.ok(situation.ownerMessage);
  }
  assert.equal(situations[1].item, 'crafting_table');
  assert.equal(situations[1].itemName, '工作台');
  assert.equal(situations[1].previousTeachings, 0);
  assert.equal(situations[2].previousTeachings, 1);
  assert.equal(situations[2].taughtWhen, '刚才');
  assert.equal(situations[3].previousTeachings, 2);
  assert.equal(situations[4].reason, 'interrupted');
  assert.equal(situations[4].previousTeachings, 2);
  assert.equal(situations[4].taughtWhen, '刚才');
  assert.equal(situations[5].item, 'oak_planks');
  assert.equal(situations[5].itemName, '木板');
  assert.equal(situations[5].reason, '材料不足');
  assert.deepEqual(memories[3].skills[0].provenance, [
    { taughtAt: new Date(2026, 8, 30, 12).getTime(), route: 'taught', taughtBy: 'owner' },
    { taughtAt: new Date(2026, 8, 30, 12).getTime(), route: 'taught', taughtBy: 'owner' },
  ]);
  assert.equal(JSON.stringify(memories.map(({ skills, events }) => ({ skills, events }))).includes(RAW), false);
  assert.ok(memories.some(memory => memory.dialogue.some(line => line.speaker === 'owner' && line.text === RAW)));
  output = null;
  const result = await handler.handle('做个工作台', 'fallback');
  assert.match(result.text, /^缺少材料：/u);
  assert.equal(f.logs.at(-1).payload.usedBrain, false);
});

test('teaching handler: social narration is silent with disabled, failing, or empty brain', async t => {
  for (const brain of [createBrain(), { enabled: true, parseTeaching: async () => null, speak: async () => null },
    { enabled: true, parseTeaching: async () => null, speak: async () => { throw new Error('offline'); } }]) {
    const f = fixture(t, { brain });
    const handler = f.handler(f.open());
    assert.deepEqual(await handler.handle('hello', 'chat'), { kind: 'chat', text: null });
    for (const kind of ['owner_joined', 'owner_left']) {
      assert.deepEqual(await handler.narrate({ kind }, kind), { kind, text: null });
    }
    assert.equal(f.speech.length, 0);
    assert.deepEqual(f.logs.map(event => event.payload), [
      { kind: 'chat', usedBrain: false }, { kind: 'owner_joined', usedBrain: false }, { kind: 'owner_left', usedBrain: false },
    ]);
  }
});

test('teaching handler: addresses use the relationship nickname and only real provenance reaches speech', async t => {
  const situations = [];
  const f = fixture(t, { brain: { enabled: true, parseTeaching: async () => null,
    nickname: async () => '阿测', speak: async ({ situation, persona }) => {
      situations.push(situation);
      assert.equal(persona, buildPersona(situation.owner));
      return null;
    } } });
  const handler = f.handler(f.open());
  f.setOutcome({ status: 'failed', error: { code: 'missing_item', item: 'oak_planks' } });
  await handler.handle(RAW, 'unlearned-failure');
  assert.equal(situations[0].taughtBy, null);
  assert.equal(situations[0].taughtWhen, null);
  assert.equal(situations[0].owner.nickname, 'TestOwner');
  await f.relationship.ensureNickname();
  for (const message of ['做个工作台', '做个星星', 'hello', '你会什么']) await handler.handle(message, 'no-source');
  for (const kind of ['owner_joined', 'owner_left']) await handler.narrate({ kind }, kind);
  for (const situation of situations.slice(1)) {
    assert.equal(situation.taughtBy, null);
    assert.equal(situation.taughtWhen, null);
    assert.deepEqual(situation.owner, { playerName: 'TestOwner', nickname: '阿测' });
  }
  f.setOutcome({ status: 'completed' });
  await handler.handle(RAW, 'learned');
  await handler.handle('做个工作台', 'remembered');
  assert.deepEqual(situations.at(-1).taughtBy, { playerName: 'TestOwner' });
  assert.equal(situations.at(-1).taughtWhen, '刚才');
  assert.equal(f.speech.at(-1).text, '工作台：已做好（刚才 TestOwner 教的）。');
});

test('teaching handler: a generated forbidden address falls back to facts', async t => {
  const f = fixture(t, { brain: { enabled: true, parseTeaching: async () => null,
    speak: async () => '主人教过这个。' } });
  assert.equal((await f.handler(f.open()).handle('做个工作台', 'unknown')).text, '工作台：还不会。');
});

test('the goal vocabulary resolves exactly to real items', () => {
  for (const [name, item] of itemNames) {
    assert.ok(Object.hasOwn(mcData.itemsByName, item), `${item} must be a real item`);
    assert.equal(resolveGoalItem(name), item, name);
  }
  assert.equal(resolveGoalItem('木板'), 'oak_planks');
  assert.equal(resolveGoalItem('石镐'), 'stone_pickaxe');
  for (const word of ['星星', '龙蛋糕', 'not_a_thing', '']) assert.equal(resolveGoalItem(word), null);
  for (const [name, item] of [['木板', 'oak_planks'], ['原木', 'oak_log'], ['工作台', 'crafting_table'],
    ['木棍', 'stick'], ['箱子', 'chest'], ['火把', 'torch'], ['草方块', 'grass_block'], ['泥土', 'dirt'],
    ['石头', 'stone'], ['圆石', 'cobblestone'], ['沙子', 'sand'], ['沙砾', 'gravel'], ['树叶', 'oak_leaves']]) {
    assert.equal(resolveItem(name), item);
  }
});

test('goal commands carry clamped counts and giveToOwner', () => {
  for (const [raw, expected] of [
    ['给我 8 个木棍', { kind: 'command_goal', item: 'stick', count: 8, giveToOwner: true }],
    ['做 100 个木板', { kind: 'command_craft', item: 'oak_planks', count: 64, capped: true, giveToOwner: false }],
    ['来几个木板', { kind: 'command_goal', item: 'oak_planks', count: 3, giveToOwner: true }],
    ['弄一些圆石', { kind: 'command_goal', item: 'cobblestone', count: 3, giveToOwner: false }],
    ['拿给我两把石镐', { kind: 'command_goal', item: 'stone_pickaxe', count: 2, giveToOwner: true }],
    ['递给我一根木棍', { kind: 'command_goal', item: 'stick', count: 1, giveToOwner: true }],
    ['做一把石镐', { kind: 'command_craft', item: 'stone_pickaxe', count: 1, giveToOwner: false }],
  ]) {
    const parsed = parseUtterance(raw);
    for (const [key, value] of Object.entries(expected)) assert.equal(parsed[key], value, `${raw} ${key}`);
  }
});

test('goal commands do not steal existing routes', () => {
  for (const [raw, kind] of [['挖 5 个泥土', 'unknown_action'], ['跟着我', 'follow'], ['停', 'stop'],
    ['四个木板就能合成工作台', 'teach_craft'], ['你会什么', 'ask_skills'], ['给我挖5个泥土', 'command_action']]) {
    const parsed = parseUtterance(raw);
    assert.equal(parsed.kind, kind, raw);
    assert.notEqual(parsed.kind, 'command_goal', raw);
  }
});

test('say once, restart, and the learned skill runs without the planner', async t => {
  const f = fixture(t);
  const library = f.open();
  const situations = [];
  const goals = {
    feasibility: () => ({ ok: true, plan: { steps: [{ type: 'craft' }], summary: 'plan' } }),
    obtain: args => ({ done: Promise.resolve({ status: 'succeeded',
      have: { [args.item]: args.count }, plan: { stepCount: 4 } }) }),
  };
  const handler = f.handler(library, { goals, learningAutonomy: 2, brain: { enabled: true,
    parseTeaching: async () => null, speak: async ({ situation }) => { situations.push(situation); return null; } } });
  const first = await handler.handle('做一把石镐', 'learn-goal');
  assert.equal(first.kind, 'goal_done');
  assert.equal(situations.at(-1).origin, 'self_learned');
  assert.equal(situations.at(-1).newly_learned, true);
  assert.equal(situations.at(-1).taughtBy, null);
  assert.equal(situations.at(-1).taughtWhen, null);
  const learned = library.get('make_stone_pickaxe');
  assert.equal(learned.provenance.at(-1).route, 'self');
  assert.equal(learned.provenance.at(-1).trace_id, 'learn-goal');
  assert.equal(learned.body[0].obtain.item, 'stone_pickaxe');
  assert.ok(f.logs.some(event => event.kind === 'skills.self_learned'
    && event.payload.name === 'make_stone_pickaxe' && event.payload.item === 'stone_pickaxe'));
  assert.equal(f.speech.at(-1).text.includes('自己学会'), true);
  const reopened = f.open();
  const second = await f.handler(reopened, {
    goals: { feasibility: () => { throw new Error('the planner must not run for a learned skill'); } },
    learningAutonomy: 2,
    brain: { enabled: true, parseTeaching: async () => null,
      speak: async ({ situation }) => { situations.push(situation); return null; } },
  }).handle('做一把石镐', 'reuse-skill');
  assert.equal(second.kind, 'goal_done');
  assert.equal(f.calls.at(-1).label, 'make_stone_pickaxe');
  assert.equal(f.calls.at(-1).source, 'owner');
  assert.equal(f.calls.at(-1).program.body[0].obtain.item, 'stone_pickaxe');
  assert.equal(f.calls.at(-1).program.args.count, 1);
  assert.equal(situations.at(-1).origin, 'self_learned');
  assert.equal(situations.at(-1).newly_learned, false);
  assert.equal(situations.at(-1).taughtBy, null);
});

test('self-learning only lands after a verified success', async t => {
  for (const [label, result, expected] of [
    ['failed', { status: 'failed', reason: 'craft_failed' }, false],
    ['cancelled', { status: 'cancelled' }, false],
    ['preempted', { status: 'preempted' }, false],
    ['liar', { status: 'succeeded', have: { stone_pickaxe: 0 }, plan: { stepCount: 1 } }, false],
    ['verified', { status: 'succeeded', have: { stone_pickaxe: 2 }, plan: { stepCount: 1 } }, true],
    ['short delivery', { status: 'succeeded', have: { stick: 8 }, given: 4, plan: { stepCount: 1 } }, false],
    ['full delivery', { status: 'succeeded', have: { stick: 0 }, given: 8, plan: { stepCount: 1 } }, true],
  ]) {
    const f = fixture(t);
    const library = f.open();
    const message = label.endsWith('delivery') ? '给我 8 个木棍' : '做一把石镐';
    const item = label.endsWith('delivery') ? 'stick' : 'stone_pickaxe';
    const goals = { feasibility: () => ({ ok: true, plan: { steps: [{}], summary: 'plan' } }),
      obtain: () => ({ done: Promise.resolve(result) }) };
    const said = await f.handler(library, { goals, learningAutonomy: 2 }).handle(message, label);
    assert.equal(library.has(`make_${item}`), expected, label);
    assert.equal(said.kind, expected ? 'goal_done' : 'goal_failed', label);
    assert.equal(f.logs.some(event => event.kind === 'skills.self_learned'), expected, label);
    assert.equal(f.calls.length, 0, label);
  }
});

test('infeasible goals stay put without a task or a skill', async t => {
  for (const [raw, item, reason] of [
    ['做一个下界合金锭', 'netherite_ingot', 'needs_nether_or_end'],
    ['做个下界合金锭', 'netherite_ingot', 'needs_nether_or_end'],
  ]) {
    const f = fixture(t);
    const library = f.open();
    const goals = { feasibility: () => ({ ok: false, reason }),
      obtain: () => { throw new Error('infeasible goal must not execute'); } };
    const said = await f.handler(library, { goals, learningAutonomy: 2 }).handle(raw, 'unable');
    assert.equal(said.kind, 'goal_unable', raw);
    assert.equal(said.text.includes(reason), true, said.text);
    assert.equal(f.calls.length, 0, raw);
    assert.equal(library.has(`make_${item}`), false, raw);
    assert.equal(f.logs.some(event => event.kind === 'skills.self_learned'), false, raw);
  }
  const f = fixture(t);
  const handler = f.handler(f.open(), { goals: { feasibility: () => ({ ok: true, plan: { steps: [], summary: 's' } }) },
    learningAutonomy: 2 });
  assert.equal((await handler.handle('做个星星', 'unknown')).kind, 'unknown_word');
});

test('autonomy below two keeps goal commands on the ask path', async t => {
  for (const level of [0, 1]) {
    const f = fixture(t);
    const library = f.open();
    const goals = { feasibility: () => { throw new Error('must not plan'); },
      obtain: () => { throw new Error('must not execute'); } };
    const said = await f.handler(library, { goals, learningAutonomy: level }).handle('做一把石镐', 'level');
    assert.equal(said.kind, 'dont_know');
    assert.equal(f.calls.length, 0);
    assert.equal(library.has('make_stone_pickaxe'), false);
  }
  const f = fixture(t);
  const library = f.open();
  library.learnSelf({ item: 'stone_pickaxe', count: 1, traceId: 'seed', plan: { stepCount: 1, summary: 's' } });
  const said = await f.handler(library, { learningAutonomy: 0 }).handle('做一把石镐', 'known');
  assert.equal(said.kind, 'goal_done');
  assert.equal(f.calls.at(-1).label, 'make_stone_pickaxe');
});

test('a known make_ skill hands items to the owner when asked', async t => {
  const f = fixture(t);
  const library = f.open();
  library.learnSelf({ item: 'stick', count: 8, traceId: 'seed', plan: { stepCount: 2, summary: 's' } });
  const said = await f.handler(library, { learningAutonomy: 2 }).handle('给我 8 个木棍', 'deliver');
  assert.equal(said.kind, 'goal_done');
  assert.deepEqual(f.calls.map(call => call.label), ['make_stick', 'give']);
  assert.equal(f.calls[0].program.args.count, 8);
  assert.deepEqual(f.calls[1].steps, [{ primitive: 'give', params: { itemName: 'stick', count: 8 } }]);
});

test('self-learned skills cannot be claimed as taught', async t => {
  const situations = [];
  const f = fixture(t, { brain: { enabled: true, parseTeaching: async () => null,
    speak: async ({ situation }) => { situations.push(situation); return '你教过我做make_stone_pickaxe的。'; } } });
  const library = f.open();
  library.learnSelf({ item: 'stone_pickaxe', count: 1, traceId: 'seed', plan: { stepCount: 2, summary: 's' } });
  const said = await f.handler(library, { learningAutonomy: 2 }).handle('做一把石镐', 'guard');
  assert.equal(said.kind, 'goal_done');
  assert.equal(situations.at(-1).origin, 'self_learned');
  assert.equal(Object.keys(situations.at(-1)).some(key => key.startsWith('teacher_')), false);
  assert.equal(said.text.includes('你教过'), false);
  assert.equal(said.text.includes('自己学会'), true);
});

test('taught skills may still be described as taught', async t => {
  const f = fixture(t, { brain: { enabled: true, parseTeaching: async () => null,
    speak: async () => '你教过我craft_crafting_table的。' } });
  const library = f.open();
  await f.handler(library).handle(RAW, 'teach');
  const said = await f.handler(library).handle('做个工作台', 'claim');
  assert.equal(said.text, '你教过我craft_crafting_table的。');
});

// --- T18b: container commands ---------------------------------------------------

test('parser: store phrasings become command_store with an optional count', () => {
  for (const [raw, item, count] of [
    ['把圆石放进箱子', 'cobblestone', null],
    ['把圆石放进箱子里', 'cobblestone', null],
    ['把五个圆石放进箱子', 'cobblestone', 5],
    ['把10个圆石放到箱子', 'cobblestone', 10],
    ['把两个圆石存进箱子', 'cobblestone', 2],
    ['把3个圆石存到箱子里', 'cobblestone', 3],
    ['把圆石存起来', 'cobblestone', null],
    ['把8根木棍存起来', 'stick', 8],
    ['把铁镐放进箱子', 'iron_pickaxe', null],
  ]) {
    const parsed = parseUtterance(raw);
    assert.equal(parsed.kind, 'command_store', raw);
    assert.equal(parsed.item, item, raw);
    assert.equal(parsed.count, count, raw);
  }
});

test('parser: fetch phrasings become command_fetch with a default count', () => {
  for (const [raw, count, capped] of [
    ['从箱子拿圆石', 1, undefined],
    ['从箱子里拿圆石', 1, undefined],
    ['从箱子里拿2个圆石', 2, undefined],
    ['从箱子取五个圆石给我', 5, undefined],
    ['从箱子里拿几个圆石', 3, undefined],
    ['从箱子里拿70个圆石', 64, true],
  ]) {
    const parsed = parseUtterance(raw);
    assert.equal(parsed.kind, 'command_fetch', raw);
    assert.equal(parsed.item, 'cobblestone', raw);
    assert.equal(parsed.count, count, raw);
    assert.equal(parsed.capped, capped, raw);
  }
});

test('parser: unknown items still produce command kinds headed for unknown_word', () => {
  const stored = parseUtterance('把星星放进箱子');
  assert.equal(stored.kind, 'command_store');
  assert.equal(stored.item, null);
  assert.equal(stored.unknownText, '星星');
  const fetched = parseUtterance('从箱子里拿星星');
  assert.equal(fetched.kind, 'command_fetch');
  assert.equal(fetched.item, null);
  assert.equal(fetched.unknownText, '星星');
});

test('parser: store and fetch do not steal existing routes', () => {
  for (const [raw, kind] of [['挖 5 个泥土', 'unknown_action'], ['跟着我', 'follow'], ['停', 'stop'],
    ['四个木板就能合成工作台', 'teach_craft'], ['把五个木板就能合成工作台', 'teach_craft'],
    ['你会什么', 'ask_skills'], ['给我挖5个泥土', 'command_action'], ['做一把石镐', 'command_craft'],
    ['给我 8 个木棍', 'command_goal'], ['弄一些圆石', 'command_goal']]) {
    const parsed = parseUtterance(raw);
    assert.equal(parsed.kind, kind, raw);
    assert.ok(!['command_store', 'command_fetch'].includes(parsed.kind), raw);
  }
  for (const raw of ['放圆石', '存起来', '把圆石放前面']) {
    assert.ok(!['command_store', 'command_fetch'].includes(parseUtterance(raw).kind), raw);
  }
});

test('store submits an owner deposit task and says stored facts', async t => {
  const f = fixture(t);
  const situations = [];
  const handler = f.handler(f.open(), { learningAutonomy: 0, brain: { enabled: true,
    parseTeaching: async () => null,
    speak: async ({ situation }) => { situations.push(situation); return null; } } });
  f.setOutcome({ status: 'completed', results: [{ ok: true, result: { moved: 16 } }] });
  const said = await handler.handle('把圆石放进箱子', 'store');
  assert.equal(said.kind, 'stored');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].source, 'owner');
  assert.equal(f.calls[0].label, 'store cobblestone');
  assert.deepEqual(f.calls[0].steps, [{ primitive: 'deposit', params: { itemName: 'cobblestone' } }]);
  const situation = situations.at(-1);
  assert.equal(situation.item, 'cobblestone');
  assert.equal(situation.itemName, '圆石');
  assert.equal(situation.moved, 16);
});

test('a counted store passes count and a fetch submits withdraw', async t => {
  const f = fixture(t);
  const handler = f.handler(f.open(), { learningAutonomy: 1 });
  f.setOutcome({ status: 'completed', results: [{ ok: true, result: { moved: 5 } }] });
  assert.equal((await handler.handle('把五个圆石放进箱子', 'store5')).kind, 'stored');
  assert.deepEqual(f.calls[0].steps, [{ primitive: 'deposit', params: { itemName: 'cobblestone', count: 5 } }]);
  f.setOutcome({ status: 'completed', results: [{ ok: true, result: { moved: 2 } }] });
  assert.equal((await handler.handle('从箱子里拿 2 个圆石', 'fetch2')).kind, 'fetched');
  assert.equal(f.calls[1].label, 'fetch cobblestone');
  assert.deepEqual(f.calls[1].steps, [{ primitive: 'withdraw', params: { itemName: 'cobblestone', count: 2 } }]);
});

test('store and fetch failures say the primitive reason code', async t => {
  const f = fixture(t);
  const handler = f.handler(f.open(), { learningAutonomy: 0 });
  f.setOutcome({ status: 'failed', results: [{ ok: false, error: { code: 'no_container' } }] });
  const stored = await handler.handle('把圆石放进箱子', 'store-fail');
  assert.equal(stored.kind, 'store_failed');
  assert.equal(stored.text.includes('no_container'), true, stored.text);
  const fetched = await handler.handle('从箱子拿圆石', 'fetch-fail');
  assert.equal(fetched.kind, 'fetch_failed');
  assert.equal(fetched.text.includes('no_container'), true, fetched.text);
});

test('store and fetch of unknown items stay unknown words', async t => {
  const f = fixture(t);
  const handler = f.handler(f.open(), { learningAutonomy: 0 });
  assert.equal((await handler.handle('把星星放进箱子', 'store-unknown')).kind, 'unknown_word');
  assert.equal((await handler.handle('从箱子拿星星', 'fetch-unknown')).kind, 'unknown_word');
  assert.equal(f.calls.length, 0);
});

test('self-learning an iron pickaxe stores make_iron_pickaxe', async t => {
  const f = fixture(t);
  const library = f.open();
  const goals = { feasibility: () => ({ ok: true, plan: { steps: [{}], summary: 'plan' } }),
    obtain: () => ({ done: Promise.resolve({ status: 'succeeded',
      have: { iron_pickaxe: 1 }, plan: { stepCount: 9 } }) }) };
  const said = await f.handler(library, { goals, learningAutonomy: 2 }).handle('做一把铁镐', 'iron');
  assert.equal(said.kind, 'goal_done');
  assert.equal(library.has('make_iron_pickaxe'), true);
  assert.equal(library.get('make_iron_pickaxe').provenance.at(-1).route, 'self');
  assert.equal(library.get('make_iron_pickaxe').body[0].obtain.item, 'iron_pickaxe');
});

test('an exhausted budget stops the planner goal path without moving', async t => {
  const f = fixture(t);
  const library = f.open();
  const spends = [];
  const goals = { feasibility: () => ({ ok: true, plan: { steps: [{}], summary: 'plan' } }),
    obtain: () => { throw new Error('budget-exhausted goal must not execute'); } };
  const budget = { limit: 0, remaining: () => 0, reserve: 1,
    spend: args => { spends.push(args); return false; } };
  const said = await f.handler(library, { goals, learningAutonomy: 2, budget }).handle('做一把石镐', 'broke');
  assert.equal(said.kind, 'goal_unable');
  assert.equal(said.text.includes('自己摸索的次数用完'), true, said.text);
  assert.deepEqual(spends, [{ kind: 'goal', item: 'stone_pickaxe' }]);
  assert.equal(f.calls.length, 0, 'no arbiter task was submitted');
  assert.equal(library.has('make_stone_pickaxe'), false);
  assert.equal(f.logs.some(event => event.kind === 'budget.learning_spent'), false);
});

test('a learned make_ skill ignores the budget entirely', async t => {
  const f = fixture(t);
  const library = f.open();
  library.learnSelf({ item: 'stone_pickaxe', count: 1, traceId: 'seed', plan: { stepCount: 1, summary: 's' } });
  const budget = { limit: 0, remaining: () => 0, reserve: 1,
    spend: () => { throw new Error('learned skills must not spend'); } };
  const said = await f.handler(library, { learningAutonomy: 2, budget }).handle('做一把石镐', 'known');
  assert.equal(said.kind, 'goal_done');
  assert.equal(f.calls.at(-1).label, 'make_stone_pickaxe');
  assert.equal(f.logs.some(event => event.kind === 'budget.learning_spent'), false);
});

test('failed feasibility never touches the budget', async t => {
  const f = fixture(t);
  const goals = { feasibility: () => ({ ok: false, reason: 'needs_nether_or_end' }),
    obtain: () => { throw new Error('infeasible goal must not execute'); } };
  const budget = { limit: 30, remaining: () => 30, reserve: 8,
    spend: () => { throw new Error('infeasible goals must not spend'); } };
  const said = await f.handler(f.open(), { goals, learningAutonomy: 2, budget })
    .handle('做一个下界合金锭', 'unable');
  assert.equal(said.kind, 'goal_unable');
  assert.equal(f.calls.length, 0);
});

test('a propose_goal yes walks the goal path, spends once and self-learns', async t => {
  const f = fixture(t);
  const library = f.open();
  const spends = [];
  const obtained = [];
  const goals = { feasibility: () => ({ ok: true, plan: { steps: [{}], summary: 'plan' } }),
    obtain: args => { obtained.push(args); return { done: Promise.resolve({ status: 'succeeded',
      have: { [args.item]: args.count }, plan: { stepCount: 3 } }) }; } };
  const budget = { limit: 30, remaining: () => 30, reserve: 8,
    spend: args => { spends.push(args); return true; } };
  const dialogue = createDialogue({ clock: { now: () => 0 } });
  const handler = f.handler(library, { goals, learningAutonomy: 2, budget, dialogue });
  dialogue.setQuestion({ type: 'propose_goal', action: '木镐', args: { item: 'wooden_pickaxe', count: 1 } });
  const said = await handler.handle('好', 'approve');
  assert.equal(said.kind, 'goal_done');
  assert.deepEqual(obtained.map(args => [args.item, args.count]), [['wooden_pickaxe', 1]]);
  assert.deepEqual(spends, [{ kind: 'goal', item: 'wooden_pickaxe' }]);
  assert.equal(library.has('make_wooden_pickaxe'), true);
  assert.equal(dialogue.getQuestion(), null);
});

test('a propose_goal no cancels without a task or a spend', async t => {
  const f = fixture(t);
  const goals = { feasibility: () => { throw new Error('must not plan'); },
    obtain: () => { throw new Error('must not execute'); } };
  const budget = { limit: 30, remaining: () => 30, reserve: 8,
    spend: () => { throw new Error('a refusal must not spend'); } };
  const dialogue = createDialogue({ clock: { now: () => 0 } });
  const handler = f.handler(f.open(), { goals, learningAutonomy: 2, budget, dialogue });
  dialogue.setQuestion({ type: 'propose_goal', action: '木镐', args: { item: 'wooden_pickaxe', count: 1 } });
  const said = await handler.handle('不用', 'decline');
  assert.equal(said.kind, 'cancelled');
  assert.equal(f.calls.length, 0);
  assert.equal(dialogue.getQuestion(), null);
});

test('parser: hut aliases, repeat phrasing, unknown blueprints and crafting stay distinct', () => {
  for (const raw of ['给我们搭个小屋', '搭个房子', '帮我盖一座小房子', '再搭个房子', '请造一间木屋吧', '建个屋子', '去搭一个小木屋吗']) {
    const parsed = parseUtterance(raw);
    assert.equal(parsed.kind, 'command_build', raw);
    assert.equal(parsed.blueprint, 'hut', raw);
  }
  const castle = parseUtterance('搭个城堡');
  assert.equal(castle.kind, 'command_build');
  assert.equal(castle.blueprint, null);
  assert.equal(castle.unknownText, '城堡');
  for (const [raw, item] of [['造一把木镐', 'wooden_pickaxe'], ['造个工作台', 'crafting_table'], ['做一把石镐', 'stone_pickaxe']]) {
    const parsed = parseUtterance(raw);
    assert.equal(parsed.kind, 'command_craft', raw);
    assert.equal(parsed.item, item, raw);
  }
});

test('factLine describes build_done and build_failed from facts only', () => {
  assert.equal(factLine({ kind: 'build_done', itemName: '小屋', placed: 55 }), '小屋：搭好了（55 块）。');
  assert.equal(factLine({ kind: 'build_failed', itemName: '小屋', reason: 'blocked' }), '小屋：没搭成，原因：blocked。');
  assert.match(factLine({ kind: 'build_failed', itemName: '小屋', reason: 'learning_budget_exhausted' }), /今天自己摸索的次数用完了/u);
  assert.match(factLine({ kind: 'build_failed', itemName: '城堡', reason: 'unknown_blueprint' }), /没有这个蓝图/u);
});

function buildHandler(t, { info, budget, result = { status: 'succeeded', placed: 55, frame: true }, builder } = {}) {
  const f = fixture(t);
  const situations = [];
  const calls = { inspect: [], build: [], spend: [] };
  const fake = builder === undefined ? {
    inspect: args => { calls.inspect.push(args); return info ?? { ok: true, need: 55, have: 55, material: 'oak_planks' }; },
    build: args => { calls.build.push(args); return { done: Promise.resolve(result) }; },
  } : builder;
  const spendBudget = budget === undefined ? { spend: (entry, traceId) => { calls.spend.push([entry, traceId]); return true; } } : budget;
  const handler = f.handler(f.open(), { learningAutonomy: 0, builder: fake, budget: spendBudget,
    brain: { enabled: true, parseTeaching: async () => null, speak: async ({ situation }) => { situations.push(situation); return null; } } });
  return { handler, situations, calls };
}

test('build with enough planks never spends the learning budget', async t => {
  const { handler, situations, calls } = buildHandler(t);
  const said = await handler.handle('给我们搭个小屋', 'b1');
  assert.equal(said.kind, 'build_done');
  assert.equal(calls.spend.length, 0);
  assert.deepEqual(calls.build, [{ blueprint: 'hut', traceId: 'b1' }]);
  assert.equal(situations.at(-1).itemName, '小屋');
  assert.equal(situations.at(-1).placed, 55);
  assert.equal(situations.at(-1).frame, true);
});

test('build that needs materials spends exactly one learning unit and a spent-out budget submits nothing', async t => {
  const short = { ok: true, need: 55, have: 10, material: 'oak_planks' };
  const spending = buildHandler(t, { info: short });
  assert.equal((await spending.handler.handle('搭个小屋', 'b2')).kind, 'build_done');
  assert.deepEqual(spending.calls.spend, [[{ kind: 'build', item: 'oak_planks' }, 'b2']]);
  assert.equal(spending.calls.build.length, 1);

  const exhausted = buildHandler(t, { info: short, budget: { spend: () => false } });
  const said = await exhausted.handler.handle('搭个小屋', 'b3');
  assert.equal(said.kind, 'build_failed');
  assert.equal(exhausted.calls.build.length, 0);
  assert.equal(exhausted.situations.at(-1).reason, 'learning_budget_exhausted');
});

test('build failures say the reason: unknown blueprint, no builder, no site and failed builds', async t => {
  const unknown = buildHandler(t);
  assert.equal((await unknown.handler.handle('搭个城堡', 'b4')).kind, 'build_failed');
  assert.equal(unknown.situations.at(-1).reason, 'unknown_blueprint');
  assert.equal(unknown.situations.at(-1).itemName, '城堡');
  assert.equal(unknown.calls.inspect.length, 0);

  const none = buildHandler(t, { builder: null });
  assert.equal((await none.handler.handle('搭个小屋', 'b5')).kind, 'build_failed');
  assert.equal(none.situations.at(-1).reason, 'unavailable');

  const noSite = buildHandler(t, { info: { ok: false, reason: 'no_site' } });
  assert.equal((await noSite.handler.handle('搭个小屋', 'b6')).kind, 'build_failed');
  assert.equal(noSite.situations.at(-1).reason, 'no_site');
  assert.equal(noSite.calls.build.length, 0);

  const failed = buildHandler(t, { result: { status: 'failed', reason: 'blocked', placed: 50 } });
  assert.equal((await failed.handler.handle('搭个小屋', 'b7')).kind, 'build_failed');
  assert.equal(failed.situations.at(-1).reason, 'blocked');
});

// T25 · toolset parsing, execution, self-learned program, protect_here
test('parser: toolset clauses pick the last matching clause and all three tiers', () => {
  for (const [raw, tier] of [
    ['做一套木制工具', 'wooden'], ['做套石头工具', 'stone'], ['来一套铁制工具', 'iron'],
    ['弄一套木质的工具', 'wooden'], ['造一套石质工具', 'stone'], ['做一套铁的工具', 'iron'],
    ['去弄点木头，做一套木制工具', 'wooden'], ['挖点石头，然后做一套石头工具', 'stone'],
    ['做一套木制工具。先做一套铁制工具', 'iron'],
  ]) assert.deepEqual(parseUtterance(raw), { kind: 'command_toolset', tier, raw });
});

test('parser: whole-sentence toolset upgrades', () => {
  for (const [raw, tier] of [
    ['换石头的', 'stone'], ['换成铁的', 'iron'], ['换一套木制工具', 'wooden'],
    ['那升级到石质的', 'stone'], ['那就换成铁工具吧', 'iron'], ['升级成木头', 'wooden'],
  ]) assert.deepEqual(parseUtterance(raw), { kind: 'command_toolset', tier, raw });
});

test('parser: toolset matching does not disturb craft, store or build commands', () => {
  assert.equal(parseUtterance('做一把石镐').kind, 'command_craft');
  assert.equal(parseUtterance('把圆石放进箱子').kind, 'command_store');
  assert.equal(parseUtterance('给我们搭个小屋').kind, 'command_build');
  assert.equal(parseUtterance('保护这里').kind, 'protect_here');
  for (const raw of ['这是我的家', '这是我的房子', '别动这附近', '别动这里']) {
    assert.equal(parseUtterance(raw).kind, 'protect_here', raw);
  }
  assert.notEqual(parseUtterance('保护她').kind, 'protect_here');
});

function toolsetFixture(t, { obtainResults = {}, feasibility = { ok: true, plan: { steps: [{}], summary: 'p' } }, spend = () => true } = {}) {
  const f = fixture(t);
  const library = f.open();
  const obtained = [];
  const situations = [];
  const goals = {
    feasibility: () => feasibility,
    obtain: args => { obtained.push(args); const entry = obtainResults[args.item];
      const result = Array.isArray(entry) ? (entry.shift() ?? { status: 'failed', reason: 'goal_failed' }) : entry;
      return { done: Promise.resolve(result ?? { status: 'succeeded', have: { [args.item]: 1 }, plan: { stepCount: 1 } }) }; },
  };
  const budget = { spend: (entry, traceId) => { situations.push(['spend', entry]); return spend(entry, traceId); } };
  const handler = f.handler(library, { goals, budget, learningAutonomy: 2,
    brain: { enabled: true, parseTeaching: async () => null,
      speak: async ({ situation }) => { situations.push(situation); return null; } } });
  return { f, library, handler, obtained, situations };
}

test('toolset runs three obtains, equips the pickaxe, spends once and self-learns', async t => {
  const { f, library, handler, obtained, situations } = toolsetFixture(t);
  const said = await handler.handle('换石头的', 'tools-1');
  assert.equal(said.kind, 'goal_done');
  assert.deepEqual(obtained.map(o => o.item), ['stone_pickaxe', 'stone_axe', 'stone_sword']);
  assert.deepEqual(obtained.map(o => o.count), [1, 1, 1]);
  assert.equal(situations.filter(s => s[0] === 'spend').length, 1);
  assert.deepEqual(situations.find(s => s[0] === 'spend')[1], { kind: 'goal', item: 'make_stone_tools' });
  const equip = f.calls.find(c => c.label === 'equip stone_pickaxe');
  assert.ok(equip);
  assert.deepEqual(equip.steps, [{ primitive: 'equip', params: { itemName: 'stone_pickaxe', slot: 'hand' } }]);
  const skill = library.get('make_stone_tools');
  assert.ok(skill);
  assert.equal(skill.provenance.at(-1).route, 'self');
  assert.deepEqual(skill.body, [
    { obtain: { item: 'stone_pickaxe', count: 1 } },
    { obtain: { item: 'stone_axe', count: 1 } },
    { obtain: { item: 'stone_sword', count: 1 } },
    { primitive: 'equip', params: { itemName: 'stone_pickaxe', slot: 'hand' } },
  ]);
  assert.equal(situations.at(-1).origin, 'self_learned');
  assert.equal(situations.at(-1).newly_learned, true);
  assert.equal(situations.at(-1).itemName, '一套石质工具');
});

test('toolset a failed tool says goal_failed with that tool and stores nothing', async t => {
  const { f, library, handler } = toolsetFixture(t, {
    obtainResults: { stone_axe: { status: 'failed', reason: 'craft_failed' } } });
  const said = await handler.handle('换石头的', 'tools-2');
  assert.equal(said.kind, 'goal_failed');
  assert.equal(library.has('make_stone_tools'), false);
  assert.equal(f.calls.filter(c => c.label === 'equip stone_pickaxe').length, 0);
});

test('toolset infeasible or broke says goal_unable and spends nothing', async t => {
  const noFeasible = toolsetFixture(t, { feasibility: { ok: false, reason: 'needs_iron' } });
  const said = await noFeasible.handler.handle('做一套铁制工具', 'tools-3');
  assert.equal(said.kind, 'goal_unable');
  assert.equal(noFeasible.situations.filter(s => s[0] === 'spend').length, 0);
  assert.equal(noFeasible.obtained.length, 0);
  const broke = toolsetFixture(t, { spend: () => false });
  const brokeSaid = await broke.handler.handle('做一套铁制工具', 'tools-4');
  assert.equal(brokeSaid.kind, 'goal_unable');
  assert.equal(broke.situations.at(-1).reason, 'learning_budget_exhausted');
  assert.equal(broke.obtained.length, 0);
});

test('toolset a learned skill runs through runSkill and never touches goals or budget', async t => {
  const f = fixture(t);
  const library = f.open();
  library.learnSelfProgram({ name: 'make_stone_tools', description: '一套石质工具', traceId: 'seed',
    context: { goal: { tools: [] } },
    body: [{ obtain: { item: 'stone_pickaxe', count: 1 } },
      { primitive: 'equip', params: { itemName: 'stone_pickaxe', slot: 'hand' } }] });
  const said = await f.handler(library, { learningAutonomy: 2,
    goals: { feasibility: () => { throw new Error('must not plan'); },
      obtain: () => { throw new Error('must not obtain'); } },
    budget: { spend: () => { throw new Error('must not spend'); } },
  }).handle('换石头的', 'reuse');
  assert.equal(said.kind, 'goal_done');
  assert.equal(f.calls.at(-1).label, 'make_stone_tools');
  assert.equal(f.calls.at(-1).source, 'owner');
  assert.equal(f.calls.at(-1).program.body.length, 2);
});

test('toolset honours the autonomy gate like goalCommand', async t => {
  for (const level of [0, 1]) {
    const f = fixture(t);
    const library = f.open();
    const said = await f.handler(library, { learningAutonomy: level,
      goals: { feasibility: () => { throw new Error('must not plan'); } } }).handle('换石头的', 'lvl');
    assert.equal(said.kind, 'dont_know');
    assert.equal(library.has('make_stone_tools'), false);
  }
});

test('protect_here centres a radius-12 zone on the owner and says protected', async t => {
  const f = fixture(t);
  const zones = [];
  const ownerEntity = { position: { x: 10.5, y: 64.2, z: -3.7 } };
  const bot = { players: { TestOwner: { uuid: OWNER, entity: ownerEntity } } };
  const protection = { add: (zone, traceId) => (zones.push(zone), { ...zone }) };
  const said = await f.handler(f.open(), { bot, protection }).handle('这是我的家', 'prot');
  assert.equal(said.kind, 'protected');
  assert.deepEqual(zones, [{ x: 10, y: 64, z: -4, radius: 12, reason: 'owner' }]);
});

test('protect_here failures: unknown owner position and full zone list', async t => {
  const f = fixture(t);
  const bot = { players: {} };
  const said = await f.handler(f.open(), { bot, protection: { add: () => ({}) } }).handle('保护这里', 'p1');
  assert.equal(said.kind, 'protect_failed');
  assert.equal(said.text, factLine({ kind: 'protect_failed', reason: 'owner_not_found' }));
  const full = await f.handler(f.open(), { bot: { players: { TestOwner: { uuid: OWNER, entity: { position: { x: 0, y: 64, z: 0 } } } } },
    protection: { add: () => null } }).handle('保护这里', 'p2');
  assert.equal(full.kind, 'protect_failed');
  assert.equal(factLine({ kind: 'protected', radius: 12 }), '这附近（半径 12 格）不会再动。');
  assert.equal(factLine({ kind: 'protect_failed', reason: 'zone_limit' }), '记下的保护区已经满了。');
});

test('factLine nightfall carries the bed fact only when it is none', () => {
  assert.equal(factLine({ kind: 'proactive_remark', reason: 'nightfall', bed: 'none' }), '天黑了，附近没有床。');
  assert.equal(factLine({ kind: 'proactive_remark', reason: 'nightfall', bed: 'nearby' }), '天黑了。');
  assert.equal(factLine({ kind: 'proactive_remark', reason: 'nightfall', bed: 'inventory' }), '天黑了。');
});

test('toolset never retries a cancelled or preempted obtain', async t => {
  // Reflex preemption resumes inside obtain itself; a surfaced 'preempted' means
  // the owner took over, and 'cancelled' means the owner said stop.
  for (const status of ['cancelled', 'preempted']) {
    const { library, handler, obtained } = toolsetFixture(t, {
      obtainResults: { stone_axe: [{ status }] } });
    const said = await handler.handle('换石头的', `tools-${status}`);
    assert.equal(said.kind, 'goal_failed');
    assert.equal(obtained.filter(o => o.item === 'stone_axe').length, 1, `${status} must not be retried`);
    assert.equal(library.has('make_stone_tools'), false);
  }
});

test('toolset retries a craft_failed obtain once and still self-learns', async t => {
  const { library, handler, obtained } = toolsetFixture(t, {
    obtainResults: { stone_axe: [{ status: 'failed', reason: 'craft_failed' },
      { status: 'succeeded', have: { stone_axe: 1 }, plan: { stepCount: 1 } }] } });
  const said = await handler.handle('换石头的', 'tools-cf');
  assert.equal(said.kind, 'goal_done');
  assert.equal(obtained.filter(o => o.item === 'stone_axe').length, 2);
  assert.ok(library.has('make_stone_tools'));
});

test('toolset a repeated transient obtain failure is a real failure', async t => {
  const { library, handler, obtained } = toolsetFixture(t, {
    obtainResults: { stone_axe: [{ status: 'failed', reason: 'busy' }, { status: 'failed', reason: 'busy' }] } });
  const said = await handler.handle('换石头的', 'tools-r2');
  assert.equal(said.kind, 'goal_failed');
  assert.equal(obtained.filter(o => o.item === 'stone_axe').length, 2);
  assert.equal(library.has('make_stone_tools'), false);
});
