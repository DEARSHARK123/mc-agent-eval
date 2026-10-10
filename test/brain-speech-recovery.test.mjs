import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createArbiter } from '../src/arbiter.js';
import { createOwnerChatHandler } from '../src/teaching/handler.js';
import { parseUtterance } from '../src/teaching/parser.js';
import { isStopCommand, dispatchOwnerChat } from '../src/teaching/stop.js';
import { createGameAgent } from '../src/brain/agent.js';
import { setup, closeFixtures } from './fixtures/agent-fixture.mjs';
afterEach(closeFixtures);

function fixture(agent) {
  const situations = [], events = [];
  const eventlog = { append: (kind, payload, traceId) => events.push({ kind, payload, traceId }), query: () => [] };
  const arbiter = createArbiter({ eventlog, registry: { has: () => true,
    run: () => new Promise(() => {}) } });
  const handler = createOwnerChatHandler({ arbiter, agent, eventlog,
    library: { list: () => [] }, ownerUuid: 'owner', mouth: { say: text => text },
    brain: { enabled: true, speak: async ({ situation }) => {
      situations.push(situation); return null;
    } } });
  return { arbiter, handler, situations, events, actionQueue: Promise.resolve() };
}

test('follow stop preserves cancelled task label and stopped situation', async () => {
  const runtime = fixture();
  await runtime.handler.handle('跟着我', 'follow-trace');
  assert.equal(runtime.arbiter.current().label, 'follow');
  const taskDone = new Promise(resolve => runtime.arbiter.on('done', resolve));
  const result = await dispatchOwnerChat(runtime, { message: '停', traceId: 'stop-trace' });
  assert.equal((await taskDone).status, 'cancelled');
  assert.equal(runtime.arbiter.current(), null);
  assert.equal(result.kind, 'stopped');
  assert.equal(runtime.situations.at(-1).action, 'follow');
  assert.equal(runtime.events.at(-1).traceId, 'stop-trace');
});

test('suspended agent cancels and acknowledges without waiting for agent completion', async () => {
  let active = false, cancelled = false;
  const agent = { enabled: true, run: () => {
    active = true; return new Promise(() => {});
  }, cancel: () => { cancelled = active; active = false; return cancelled; } };
  const runtime = fixture(agent);
  void dispatchOwnerChat(runtime, { message: '今天怎么样', traceId: 'chat-trace' }, agent);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(active, true);
  let queueSettled = false;
  void runtime.actionQueue.then(() => { queueSettled = true; });
  let timer;
  try {
    const result = await Promise.race([
      dispatchOwnerChat(runtime, { message: '别动了', traceId: 'stop-trace' }, agent),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('stop waited for agent')), 500); }),
    ]);
    assert.equal(cancelled, true);
    assert.equal(queueSettled, false);
    assert.equal(result.kind, 'stopped');
    assert.equal(runtime.situations.at(-1).action, '刚才的事');
  } finally { clearTimeout(timer); }
});

test('idle stop reports no task and does not reuse a previous trace', async () => {
  const runtime = fixture({ cancel: () => false });
  const result = await dispatchOwnerChat(runtime, { message: '停', traceId: 'idle-trace' });
  assert.equal(result.kind, 'idle');
  assert.match(result.text, /没有正在执行的任务/u);
  const unrelated = await runtime.handler.handle('停', 'other-trace', {
    traceId: 'old-trace', label: 'follow', taskCancelled: true, agentCancelled: false,
  });
  assert.equal(unrelated.kind, 'idle');
});

test('shared stop recognition covers all aliases and rejects parking questions', async () => {
  for (const message of ['停', '停止', '停下', '别跟了', '不用跟了', '别动', '别动了', '站住', '等等']) {
    for (const decorated of [message, `  ${message}。！？!,，  `]) {
      assert.equal(isStopCommand(decorated), true, decorated);
      assert.equal(parseUtterance(decorated).kind, 'stop');
      const runtime = fixture();
      runtime.arbiter.submit({ source: 'owner', label: 'follow', steps: [{ primitive: 'follow' }] });
      assert.equal((await dispatchOwnerChat(runtime, { message: decorated, traceId: decorated })).kind, 'stopped');
      assert.equal(runtime.arbiter.current(), null);
    }
  }
  for (const message of ['停车场在哪', '停下来以后去哪', '别动了我的东西', '', null, undefined])
    assert.equal(isStopCommand(message), false);
});

test('real agent cancel reports idle accurately without API calls', () => {
  const agent = createGameAgent({ pi: { enabled: false } });
  assert.equal(agent.cancel(), false);
});

test('real agent cancellation returns true and aborts fake RPC immediately', async () => {
  const runtime = fixture();
  const s = setup([], { stall: true, dependencies: { arbiter: runtime.arbiter } });
  await s.ready;
  const agent = s.agent;
  let aborted = false;
  s.pi.events.on('event', e => { if (e.type === 'fake_abort') aborted = true; });
  const started = new Promise(resolve => s.pi.events.on('event', e => { if (e.type === 'fake_next') resolve(); }));
  const running = agent.run({ message: '你好', owner: {} });
  await started;
  assert.equal((await dispatchOwnerChat(runtime, { message: '停下', traceId: 'real-stop' }, agent)).kind, 'stopped');
  assert.equal((await running).cancelled, true);
  await s.pi.command('echo'); assert.equal(aborted, true);
  assert.equal(agent.cancel(), false);
});

test('direct stop with omitted traceId still cancels owner work', async () => {
  const runtime = fixture();
  await runtime.handler.handle('跟着我');
  assert.equal((await runtime.handler.handle('停')).kind, 'stopped');
  assert.equal(runtime.situations.at(-1).action, 'follow');
});
