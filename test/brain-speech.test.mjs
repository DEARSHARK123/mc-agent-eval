import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createPiManager as createPi } from '../src/brain/manager.js';
import { setup, closeFixtures } from './fixtures/agent-fixture.mjs';
afterEach(closeFixtures);
import { createGameTools, lookAround } from '../src/brain/tools.js';
import { createOwnerChatHandler } from '../src/teaching/handler.js';
import { createDialogue } from '../src/dialogue.js';
import { loadConfig } from '../src/config.js';
import { mcData } from '../src/teaching/lexicon.js';
import { createJev } from '../src/decision/jev.js';
import { createArbiter } from '../src/arbiter.js';

const ownerUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

test('missing auth ignores ambient credentials and src uses no model libraries', async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'ambient-secret';
  try {
    assert.equal(createPi({ hasAuth: () => false }).enabled, false);
    assert.equal(loadConfig({ OWNER_UUID: ownerUuid }).openrouterApiKey, '');
    const scan = dir => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) scan(path);
        else {
          const source = readFileSync(path, 'utf8');
          assert.doesNotMatch(source, /pi-coding-agent|pi-agent-core|@earendil-works\/pi-ai|HTTP-Referer|X-Title|homedir|\.pi[\\/]/u, path);
          if (!path.endsWith('/voice/fish.js')) assert.doesNotMatch(source, /openrouter\.ai/u, path);
        }
      }
    };
    scan(fileURLToPath(new URL('../src', import.meta.url)));
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});

test('exact game tool whitelist and conditional intent registration', () => {
  const s = setup();
  assert.deepEqual(createGameTools(s.dependencies).map(t => t.name).sort(), ['inventory', 'list_skills', 'look_around', 'obtain', 'run_skill', 'start_intent', 'stop']);
  assert.deepEqual(createGameTools({ ...s.dependencies, learningAutonomy: 1 }).map(t => t.name).sort(), ['inventory', 'list_skills', 'look_around', 'run_skill', 'stop']);
  assert.deepEqual(createGameTools({ ...s.dependencies, jev: null }).map(t => t.name).sort(), ['inventory', 'list_skills', 'look_around', 'obtain', 'run_skill', 'stop']);
});

test('chat speaks through mouth and rejects owner-title and repeated text', async () => {
  const s = setup([fauxAssistantMessage('今天这里很安静。'), fauxAssistantMessage('主人我在这里。'), fauxAssistantMessage('今天这里很安静。')]);
  await s.handler.handle('你好'); await s.handler.handle('今天天气如何'); await s.handler.handle('再聊一句');
  assert.deepEqual(s.lines, ['今天这里很安静。']);
  assert.equal(s.gemini, 0);
});

test('inventory then intent returns executor result to model and mouth', async () => {
  let executions = 0;
  const s = setup([fauxAssistantMessage(fauxToolCall('inventory', {})),
    context => {
      assert.match(JSON.stringify(context), /dirt/u);
      return fauxAssistantMessage(fauxToolCall('start_intent', { block: 'dirt', count: 3 }));
    }, context => {
      assert.match(JSON.stringify(context), /succeeded/u);
      return fauxAssistantMessage('泥土已拿到。');
    }], { dependencies: { submitIntentFn: ({ intent }) => {
      executions++; assert.equal(intent.success.atLeast, 7);
      return { done: Promise.resolve({ status: 'succeeded', steps: 3, actions: [] }) };
    } } });
  await s.handler.handle('你好');
  assert.equal(executions, 1); assert.deepEqual(s.lines, ['泥土已拿到。']);
});

test('tool-round fuse stops endless calls without speech', async () => {
  const s = setup(Array.from({ length: 20 }, () => fauxAssistantMessage(fauxToolCall('look_around', {}))), { agent: { maxToolRounds: 3 } });
  await s.handler.handle('你好');
  assert.equal(s.faux.state.callCount, 3); assert.deepEqual(s.lines, []);
});

test('timeout aborts a stalled stream without invented speech', async () => {
  const s = setup([], { stall: true, agent: { timeoutMs: 20 } });
  await s.ready;
  let aborted = false;
  s.pi.events.on('event', e => { if (e.type === 'fake_abort') aborted = true; });
  await s.handler.handle('你好');
  await s.pi.command('echo');
  assert.equal(aborted, true); assert.deepEqual(s.lines, []);
  assert.equal(s.gemini, 1);
  assert.ok(s.logs.some(e => e.kind === 'agent.fallback'));
});

test('third execution rejected and cancelled tool ends the agent', async () => {
  let executions = 0;
  const responses = Array.from({ length: 3 }, () => fauxAssistantMessage(fauxToolCall('start_intent', { block: 'dirt', count: 1 })));
  responses.push(context => { assert.match(JSON.stringify(context), /execution_limit/u); return fauxAssistantMessage('已完成两次尝试。'); });
  const s = setup(responses, { dependencies: { submitIntentFn: () => { executions++; return { done: Promise.resolve({ status: 'succeeded' }) }; } } });
  await s.handler.handle('你好'); assert.equal(executions, 2);
  const c = setup([fauxAssistantMessage(fauxToolCall('start_intent', { block: 'dirt', count: 1 })), fauxAssistantMessage('不应发出')],
    { dependencies: { submitIntentFn: () => ({ done: Promise.resolve({ status: 'cancelled' }) }) } });
  await c.handler.handle('你好'); assert.equal(c.faux.state.callCount, 1); assert.deepEqual(c.lines, []);
});

test('HTTP failures request once and fall back to Gemini', async () => {
  for (const status of [429, 503]) {
    const s = setup([fauxAssistantMessage([], { stopReason: 'error', errorMessage: `HTTP ${status}` })]);
    await s.handler.handle('你好'); assert.equal(s.faux.state.callCount, 1);
    assert.equal(s.gemini, 1); assert.ok(s.logs.some(e => e.kind === 'agent.fallback'));
  }
});

test('local daily quota uses event history and reports exhaustion once', async () => {
  const s = setup(undefined, { pi: { dailyLimit: 1 } });
  await s.handler.handle('你好'); await s.handler.handle('天气如何'); await s.handler.handle('聊聊');
  assert.equal(s.faux.state.callCount, 1); assert.equal(s.gemini, 3);
  assert.equal(s.logs.filter(e => e.kind === 'agent.quota_exhausted').length, 1);
  assert.equal(s.pi.available(), false);
  assert.equal(s.logs.filter(e => e.kind === 'agent.quota_exhausted').length, 1);
});

test('teaching stop short replies and learned commands keep rule routing', async () => {
  const s = setup(); const dialogue = createDialogue();
  const skill = { name: 'dig_dirt', description: '挖泥土', params: {}, body: [], provenance: [] };
  const h = createOwnerChatHandler({ ...s.dependencies, agent: s.agent, dialogue,
    library: { ...s.dependencies.library, has: name => name === skill.name, get: () => skill, recordOutcome() {} },
    arbiter: { cancel: () => true, current: () => null, submit: () => ({ done: Promise.resolve({ status: 'completed' }) }) },
    mouth: { say: async text => text }, brain: { enabled: false } });
  await h.handle('挖泥土'); await h.handle('停');
  dialogue.setQuestion({ type: 'teach_request', action: '测试', skillName: 'test' });
  await h.handle('对'); await h.handle('算了');
  await h.handle('做工作台就是用4个橡木木板合成工作台');
  assert.equal(s.faux.state.callCount, 0);
  const unknown = setup(); await unknown.handler.handle('跳个舞'); assert.equal(unknown.faux.state.callCount, 1);
  const noKey = setup([], { pi: { apiKey: '' } });
  await noKey.handler.handle('你好'); await noKey.handler.handle('跳个舞');
  assert.equal(noKey.faux.state.callCount, 0); assert.ok(noKey.gemini >= 1);
});

test('escalated intent recovers once even when recovery intent fails', async () => {
  let fetches = 0; let recoveries = 0;
  const s = setup([fauxAssistantMessage(fauxToolCall('start_intent', { block: 'dirt', count: 1 })), fauxAssistantMessage('这次没找到。')],
    { dependencies: { submitIntentFn: () => { recoveries++; return { done: Promise.resolve({ status: 'failed', reason: 'escalated' }) }; } } });
  const jev = createJev({ apiKey: 'fake', fetch: async () => { fetches++; return { ok: true, status: 200,
    json: async () => ({ answers: { next_action: { type: 'choice', choice: 'escalate', confidence: 0.99 }, danger: { type: 'score', score: 0 } } }) }; } });
  const arbiter = createArbiter({ registry: s.dependencies.registry, eventlog: s.eventlog });
  const h = createOwnerChatHandler({ ...s.dependencies, jev, arbiter, agent: s.agent,
    mouth: { say: async text => s.lines.push(text) }, brain: { enabled: false } });
  await h.handle('挖3个泥土');
  assert.equal(fetches, 1); assert.equal(recoveries, 1);
  assert.equal(s.logs.filter(e => e.kind === 'agent.call' && e.payload.mode === 'recover').length, 2);
  assert.deepEqual(s.lines, ['这次没找到。']);
});

test('unlearned argument override rejects without executing', async () => {
  let executions = 0;
  const s = setup([], { dependencies: { library: { list: () => [], get: () => ({ params: { block: { type: 'block', default: 'dirt', values: ['dirt'] } }, body: [] }) },
    arbiter: { submit: () => { executions++; }, cancel: () => false } } });
  const tool = createGameTools(s.dependencies).find(t => t.name === 'run_skill');
  const result = await tool.execute('id', { name: 'dig_dirt', args: { block: 'stone' } });
  assert.equal(result.details.error, 'not_learned'); assert.equal(executions, 0);
});

test('call events redact credentials prompts and raw provider errors', async () => {
  const s = setup([fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'configured-secret prompt-private HTTP 429' })]);
  await s.agent.run({ message: 'prompt-private', owner: { nickname: 'private-name' } });
  const calls = s.logs.filter(e => e.kind === 'agent.call'); assert.equal(calls.length, 1);
  assert.doesNotMatch(JSON.stringify(calls), /configured-secret|prompt-private|private-name/u);
  assert.equal(calls[0].payload.error_code, 'http_429');
});

test('config defaults and look-around UUID range and block limits', () => {
  const config = loadConfig({ OWNER_UUID: ownerUuid });
  assert.equal(config.agentModel, 'openrouter/thinkingmachines/inkling:free');
  assert.equal(config.agentTimeoutMs, 20000); assert.equal(config.agentMaxToolRounds, 6); assert.equal(config.openrouterDailyLimit, 1000);
  const bot = { entity: { position: { x: 0, y: 0, z: 0 } }, entities: {
    owner: { uuid: ownerUuid, position: { x: 3, y: 0, z: 4 } },
    impostor: { username: 'Alex', position: { x: 1, y: 0, z: 0 } },
    near: { name: 'zombie', position: { x: 16, y: 0, z: 0 } }, far: { name: 'zombie', position: { x: 17, y: 0, z: 0 } } },
    findBlocks: () => Array.from({ length: 12 }, (_, x) => ({ x, y: 0, z: 0 })), blockAt: p => ({ name: `block_${p.x}` }) };
  const result = lookAround(bot, ownerUuid);
  assert.equal(result.owner.distance, 5); assert.equal(result.hostiles.length, 1); assert.equal(Object.keys(result.blocks).length, 10);
});

test('abort covers stalled stream creation and owner cancellation stays silent', async () => {
  const stalled = setup([], { stall: true, agent: { timeoutMs: 20 } });
  await stalled.handler.handle('你好'); assert.deepEqual(stalled.lines, []); assert.equal(stalled.gemini, 1);
  const s = setup([], { stall: true });
  await s.ready;
  const started = new Promise(resolve => s.pi.events.on('event', e => { if (e.type === 'fake_next') resolve(); }));
  let aborted = false;
  s.pi.events.on('event', e => { if (e.type === 'fake_abort') aborted = true; });
  const running = s.handler.handle('你好');
  await started;
  await s.handler.handle('停'); await running;
  await s.pi.command('echo');
  assert.equal(aborted, true);
  assert.equal(s.faux.state.callCount, 1);
  assert.equal(s.lines.includes('这是备用回复。'), true);
  assert.equal(s.gemini, 1);
});

test('tools validate inputs, preserve skill quantities and cancel arbiter execution', async () => {
  let submitted = 0; let program; let finish;
  const skill = { name: 'dig_dirt', params: { block: { type: 'block', default: 'dirt' } }, body: [] };
  const s = setup([], { dependencies: { library: { get: () => skill, list: () => [skill], recordOutcome() {} },
    arbiter: { submit: input => { submitted++; program = input.program; return { done: new Promise(resolve => { finish = resolve; }) }; },
      cancel: () => { finish?.({ status: 'cancelled' }); return true; } } } });
  const tools = createGameTools(s.dependencies); const run = tools.find(t => t.name === 'run_skill');
  assert.equal((await run.execute('a', { name: skill.name, args: { count: 17 } })).details.error, 'invalid_args');
  assert.equal(submitted, 0);
  const controller = new AbortController();
  const running = run.execute('b', { name: skill.name, args: { count: 3 } }, controller.signal);
  assert.equal(program.body[0].repeat, 3); controller.abort();
  assert.equal((await running).details.status, 'cancelled');
  const intent = createGameTools(s.dependencies).find(t => t.name === 'start_intent');
  assert.equal((await intent.execute('c', { block: 'unknown', count: 1 })).details.error, 'invalid_intent');
  assert.equal((await intent.execute('d', { block: 'dirt', count: 17 })).details.error, 'invalid_intent');
  assert.equal(submitted, 1);
});

test('cancellation blocks subsequent execution in the same tool batch', async () => {
  let count = 0;
  const s = setup([fauxAssistantMessage([fauxToolCall('start_intent', { block: 'dirt', count: 1 }),
    fauxToolCall('start_intent', { block: 'dirt', count: 1 })])], { dependencies: { submitIntentFn: () => {
      count++; return { done: Promise.resolve({ status: 'cancelled' }) };
    } } });
  await s.handler.handle('你好'); assert.equal(count, 1); assert.deepEqual(s.lines, []);
});
