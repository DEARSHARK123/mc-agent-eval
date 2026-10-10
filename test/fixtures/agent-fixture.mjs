import { fileURLToPath } from 'node:url';
import { createPiManager } from '../../src/brain/manager.js';
import { createGameAgent } from '../../src/brain/agent.js';
import { createGameTools } from '../../src/brain/tools.js';
import { createOwnerChatHandler } from '../../src/teaching/handler.js';

const live = new Set();
export async function closeFixtures() { await Promise.all([...live].map(pi => pi.close())); live.clear(); }
export function setup(responses = [{ role: 'assistant', content: [{ type: 'text', text: '今天这里很安静。' }], stopReason: 'stop' }], options = {}) {
  const logs = [];
  const eventlog = { append(kind, payload) { logs.push({ kind, payload, ts: Date.now() }); },
    query({ kind, since = 0, limit = Number.MAX_SAFE_INTEGER } = {}) {
      return logs.filter(e => (!kind || e.kind === kind) && e.ts >= since).slice(0, limit);
    } };
  const dependencies = { library: { list: () => [], get: () => null, has: () => false },
    arbiter: { current: () => null, cancel: () => true },
    registry: { list: () => ['dig'], describe: name => ({ name }), run: async () => ({ ok: true, result: 4 }) },
    bot: { username: 'Companion', entity: { position: { x: 0, y: 64, z: 0 } }, entities: {},
      inventory: { items: () => [{ name: 'dirt', count: 4 }] } }, ownerUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    learningAutonomy: 2, jev: { ask: async () => ({ ok: false }) },
    goals: { obtain: () => ({ done: Promise.resolve({ status: 'succeeded' }) }) },
    eventlog, ...options.dependencies };
  const pi = createPiManager({ eventlog, tools: createGameTools(dependencies), hasAuth: () => options.pi?.apiKey !== '',
    command: process.execPath, args: [fileURLToPath(new URL('fake-pi.mjs', import.meta.url)), '--fake-pi'], ...options.pi });
  live.add(pi);
  const commands = [];
  const faux = { state: { callCount: 0 } };
  pi.events.on('event', event => {
    if (event.type === 'fake_command') commands.push(event);
    if (event.type !== 'fake_next') return;
    const index = faux.state.callCount++;
    if (options.stall) return;
    const response = responses[index];
    const message = typeof response === 'function' ? response(event.context) : response;
    void pi.command('test_reply', { message: message ?? { role: 'assistant', content: [], stopReason: 'stop' } }).catch(() => {});
  });
  const ready = (async () => {
    if (!pi.hasCredentials) return;
    const reported = new Promise(resolve => pi.events.once('report', resolve));
    await pi.start(); await reported; await pi.command('test_config');
  })();
  const actual = createGameAgent({ pi, ...dependencies, ...options.agent });
  const agent = { get enabled() { return options.pi?.apiKey !== ''; }, available: actual.available, cancel: actual.cancel,
    async run(input) { await ready; return actual.run(input); } };
  const lines = []; let gemini = 0;
  const brain = { enabled: true, speak: async () => { gemini++; return '这是备用回复。'; } };
  const handler = createOwnerChatHandler({ ...dependencies, agent, brain,
    mouth: { say: async text => { lines.push(text); return text; } },
    relationship: { ownerName: () => 'Alex', nickname: () => '阿星' }, ...options.handler });
  return { logs, eventlog, faux, pi, agent, dependencies, handler, lines, ready, commands, get gemini() { return gemini; } };
}
