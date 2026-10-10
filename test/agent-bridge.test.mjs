import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { createRpcClient } from '../src/brain/rpcClient.js';
import { createBridge } from '../src/brain/bridge.js';
import { createPiManager, companionRoot, restrictedArgs } from '../src/brain/manager.js';
import { createGameTools } from '../src/brain/tools.js';
import { startCompanion } from '../src/main.js';
import { loadConfig } from '../src/config.js';
import { removePathRobust } from '../src/fsutil.js';
import companionBridge from '../pi-extension/companion-bridge.mjs';
import { setup, closeFixtures } from './fixtures/agent-fixture.mjs';
import { createGameAgent } from '../src/brain/agent.js';
import { piSmoke } from '../scripts/pi-smoke.mjs';
afterEach(closeFixtures);
function fakeChild(pid = 123) {
  const child = new EventEmitter();
  Object.assign(child, { pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { queueMicrotask(() => child.emit('exit', 0)); return true; } });
  return child;
}
function request(bridge, path, { token = bridge.token, host = new URL(bridge.url).host, body, method = body === undefined ? 'GET' : 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${bridge.url}${path}`, { method, headers: { Host: host,
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }), 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
}

test('isolated environment cwd flags auth existence and secret-free argv', async t => {
  const calls = [];
  const child = fakeChild();
  const pi = createPiManager({ hasAuth: path => { assert.equal(path, join(companionRoot, 'pi-home', 'auth.json')); return true; },
    spawn: (command, args, options) => { calls.push({ command, args, options }); return command === 'taskkill' ? fakeChild(456) : child; } });
  t.after(() => { child.emit('exit'); return pi.close(); });
  assert.equal(pi.enabled, false); assert.equal(pi.available(), false); await pi.start();
  const { command, args, options } = calls[0];
  assert.equal(command, 'cmd.exe'); assert.deepEqual(args.slice(0, 3), ['/d', '/c', 'pi']);
  for (const flag of restrictedArgs) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf('-e') + 1], join(companionRoot, 'pi-extension', 'companion-bridge.mjs'));
  assert.equal(args[args.indexOf('--model') + 1], 'openrouter/thinkingmachines/inkling:free');
  assert.equal(options.env.PI_CODING_AGENT_DIR, join(companionRoot, 'pi-home'));
  for (const name of ['TEMP', 'TMP', 'TMPDIR']) assert.equal(options.env[name], join(companionRoot, '.tmp', 'pi-tmp'));
  assert.equal(options.env.PI_OFFLINE, '1'); assert.equal(options.cwd, join(companionRoot, '.tmp', 'pi-cwd'));
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  assert.equal(options.env.COMPANION_BRIDGE_URL, pi.bridge.url); assert.equal(options.env.COMPANION_BRIDGE_TOKEN, pi.bridge.token);
  assert.ok(!JSON.stringify(args).includes(pi.bridge.token)); assert.ok(!JSON.stringify(args).includes(pi.bridge.url));
  const config = loadConfig({ OWNER_UUID: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', PI_HOME: '.tmp/custom-home', PI_BIN: 'custom.cmd' });
  assert.equal(config.piHome, join(companionRoot, '.tmp', 'custom-home')); assert.equal(config.piBin, 'custom.cmd');
});

test('LF framing preserves unicode CRLF correlates IDs and rejects on exit', async () => {
  const diagnostics = [];
  const child = fakeChild(); const rpc = createRpcClient({ spawn: () => child, platform: 'linux', diagnostics: record => diagnostics.push(record) });
  child.stderr.write('secret-key'.repeat(200));
  assert.deepEqual(diagnostics, [{ kind: 'pi.stderr', bytes: 1024 }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret-key/u);
  const commands = [];
  child.stdin.on('data', data => commands.push(JSON.parse(String(data))));
  const a = rpc.command('echo'), b = rpc.command('echo');
  child.stdout.write(JSON.stringify({ type: 'response', id: commands[1].id, success: true, data: '二\u2028三\u2029四' }) + '\r\n');
  const wire = Buffer.from(JSON.stringify({ type: 'response', id: commands[0].id, success: true, data: '中文' }) + '\n');
  for (const byte of wire) child.stdout.write(Buffer.from([byte]));
  assert.equal(await a, '中文'); assert.equal(await b, '二\u2028三\u2029四');
  const event = new Promise(resolve => rpc.events.once('event', resolve)); child.stdout.write('{"type":"agent_settled"}\n');
  assert.equal((await event).type, 'agent_settled');
  const pending = assert.rejects(rpc.command('stall'), /exited/u); child.emit('exit'); await pending;
  await rpc.close(); await rpc.close();
});

test('close is idempotent and taskkill kills the entire fake process tree', async () => {
  const child = fakeChild(); const descendant = { alive: true }; const calls = [];
  const rpc = createRpcClient({ platform: 'win32', spawn(command, args, options) {
    calls.push({ command, args, options });
    if (command !== 'taskkill') return child;
    const killer = fakeChild(); queueMicrotask(() => { descendant.alive = false; child.emit('exit'); killer.emit('exit', 0); }); return killer;
  } });
  const first = rpc.close(); assert.equal(first, rpc.close()); await first;
  assert.equal(descendant.alive, false); assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, ['/pid', '123', '/T', '/F']); assert.equal(calls[1].options.shell, false);
});

test('bridge rejects token host idle tool oversized JSON unknown routes', async t => {
  const bridge = createBridge(); await bridge.start(); t.after(() => bridge.close());
  assert.equal(bridge.server.address().address, '127.0.0.1');
  for (const path of ['/manifest', '/run', '/tool', '/report', '/unknown']) {
    for (const options of [{ token: null }, { token: 'wrong' }, { host: 'evil.example' }])
      assert.ok([401, 403].includes((await request(bridge, path, options)).status));
  }
  assert.equal((await request(bridge, '/tool', { body: { name: 'inventory', args: {} } })).status, 409);
  assert.equal((await request(bridge, '/run')).status, 409);
  assert.equal((await request(bridge, '/tool', { body: 'x'.repeat(65537) })).status, 413);
  assert.equal((await request(bridge, '/tool', { body: '{' })).status, 400);
  assert.equal((await request(bridge, '/unknown')).status, 404);
});

test('disconnected extension request aborts tool signal', async t => {
  let started, aborted;
  const signalReceived = new Promise(r => { started = r; });
  const signalAborted = new Promise(r => { aborted = r; });
  const tool = { name: 'test', parameters: {}, async execute(_id, _args, signal) {
    started(signal); await new Promise(r => signal.addEventListener('abort', () => { aborted(); r(); }, { once: true }));
    return { content: [], details: {} };
  } };
  const bridge = createBridge({ tools: [tool] }); await bridge.start(); t.after(() => bridge.close());
  bridge.setRun({ tools: [tool], systemPrompt: 'private' });
  const req = http.request(`${bridge.url}/tool`, { method: 'POST', headers: { Authorization: `Bearer ${bridge.token}` } });
  req.on('error', () => {}); req.end(JSON.stringify({ name: 'test', args: {}, toolCallId: 'id' }));
  const signal = await signalReceived; req.destroy(); await signalAborted; assert.equal(signal.aborted, true);
});

test('manifest exact conditional tools extension rejects extra bash and agent falls back', async t => {
  const s = setup(); await s.ready;
  assert.deepEqual((await request(s.pi.bridge, '/manifest')).body.map(t => t.name).sort(), createGameTools(s.dependencies).map(t => t.name).sort());
  for (const changes of [{ learningAutonomy: 1 }, { jev: null }]) {
    const tools = createGameTools({ ...s.dependencies, ...changes });
    assert.equal(tools.some(t => t.name === 'start_intent'), false);
    assert.equal(tools.some(t => t.name === 'obtain'), changes.learningAutonomy !== 1);
  }
  const registrations = [], callbacks = {};
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const reports = [];
  globalThis.fetch = async (url, opts) => ({ ok: true, json: async () => {
    if (url.endsWith('/manifest')) return s.pi.bridge.manifest();
    reports.push(JSON.parse(opts.body)); return {};
  } });
  companionBridge({ on: (name, fn) => { callbacks[name] = fn; }, registerTool: tool => registrations.push(tool),
    getActiveTools: () => [...registrations.map(t => t.name), 'bash'] });
  await callbacks.session_start();
  assert.deepEqual(registrations.map(t => t.name), s.pi.bridge.manifest().map(t => t.name));
  assert.equal(reports[0].kind, 'tools_mismatch');
  await request(s.pi.bridge, '/report', { body: reports[0] });
  assert.deepEqual(await s.agent.run({ message: '你好', owner: {} }), { fallback: true });
  assert.ok(s.logs.some(e => e.kind === 'agent.fallback' && e.payload.reason === 'tools_mismatch'));
});

test('extension factory stays idle session registers schemas forwards abort errors and prompt', async t => {
  const oldFetch = globalThis.fetch; t.after(() => { globalThis.fetch = oldFetch; });
  const calls = [], callbacks = {}, registrations = [];
  const manifest = [{ name: 'inventory', description: 'game', parameters: { type: 'object', properties: {} } }];
  const result = { content: [{ type: 'text', text: '四块泥土' }], details: { dirt: 4 } };
  let stalled = false, rejected = false, suppliedSignal;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith('/tool')) {
      suppliedSignal = opts.signal;
      if (stalled) return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      if (rejected) return { ok: false };
    }
    return { ok: true, json: async () => url.endsWith('/manifest') ? manifest : url.endsWith('/run') ? { systemPrompt: 'Companion private system' } : result };
  };
  companionBridge({ on: (kind, fn) => { callbacks[kind] = fn; }, registerTool: tool => registrations.push(tool), getActiveTools: () => ['inventory'] });
  assert.equal(calls.length, 0); await callbacks.session_start();
  assert.ok(calls[0].url.endsWith('/manifest')); assert.equal(JSON.parse(calls[1].opts.body).kind, 'ready');
  assert.equal(registrations[0].parameters.type, 'object');
  assert.deepEqual(await registrations[0].execute('id-1', { value: 1 }), result);
  assert.deepEqual(JSON.parse(calls.at(-1).opts.body), { name: 'inventory', args: { value: 1 }, toolCallId: 'id-1' });
  assert.deepEqual(await callbacks.before_agent_start(), { systemPrompt: 'Companion private system' });
  stalled = true; const controller = new AbortController();
  const rejectedCall = assert.rejects(registrations[0].execute('id', {}, controller.signal), /aborted/u);
  controller.abort(); await rejectedCall; assert.equal(suppliedSignal.aborted, true);
  stalled = false; rejected = true; await assert.rejects(registrations[0].execute('id', {}), /rejected/u);
  const source = readFileSync(new URL('../pi-extension/companion-bridge.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:|child_process|readFile|writeFile/u);
  assert.deepEqual([...source.matchAll(/from '([^']+)'/gu)].map(m => m[1]), ['@earendil-works/pi-ai']);
});

test('absent auth preserves fallback without spawning pi', async t => {
  let spawns = 0;
  const pi = createPiManager({ hasAuth: () => false, spawn: () => { spawns++; throw new Error('must not spawn'); } });
  t.after(() => pi.close()); await pi.start(); assert.equal(pi.enabled, false); assert.equal(pi.available(), false); assert.equal(spawns, 0);
  const s = setup([], { pi: { apiKey: '' } }); await s.handler.handle('你好'); assert.equal(s.gemini, 1); assert.equal(s.faux.state.callCount, 0);
});

test('crash restarts at 2s 5s 15s then disables and emits no logs after close', async t => {
  const children = [], scheduled = [], logs = [];
  const pi = createPiManager({ hasAuth: () => true, eventlog: { append: (kind, payload) => logs.push({ kind, payload }) },
    schedule: (fn, delay) => { scheduled.push({ fn, delay }); return scheduled.length; }, unschedule: () => {},
    spawn: () => { const child = fakeChild(children.length + 100); children.push(child); return child; } });
  t.after(() => pi.close()); await pi.start();
  for (let i = 0; i < 3; i++) { children[i].emit('exit'); assert.equal(pi.available(), false); scheduled[i].fn(); }
  children[3].emit('exit'); assert.deepEqual(scheduled.map(s => s.delay), [2000, 5000, 15000]);
  assert.equal(children.length, 4); assert.equal(pi.available(), false);
  assert.deepEqual(logs.at(-1), { kind: 'agent.fallback', payload: { reason: 'pi_crashed' } });
  await pi.close(); const count = logs.length;
  pi.bridge.events.emit('report', { kind: 'tools_mismatch', tools: ['bash'] }); children[3].emit('exit');
  assert.equal(logs.length, count);
});

test('main closes real fake subprocess and bridge and ignores late events', async t => {
  mkdirSync(join(companionRoot, '.tmp'), { recursive: true });
  const temp = mkdtempSync(join(companionRoot, '.tmp', 't14d-main-'));
  t.after(() => assert.equal(removePathRobust(temp), true));
  const bot = new EventEmitter();
  Object.assign(bot, { username: 'Companion', entity: { position: { x: 0, y: 64, z: 0 } }, players: {}, entities: {},
    loadPlugin() {}, quit() {}, inventory: { items: () => [] } });
  let child, bridgeUrl;
  const app = startCompanion({ config: loadConfig({ OWNER_UUID: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', COMPANION_DATA_DIR: temp }),
    signals: new EventEmitter(), createBot: () => bot, pathfinderPlugin() {},
    piManagerFactory: options => createPiManager({ ...options, hasAuth: () => true, command: process.execPath,
      args: [fileURLToPath(new URL('fixtures/fake-pi.mjs', import.meta.url)), '--fake-pi'],
      spawn(command, args, opts) { if (command !== 'taskkill') { bridgeUrl = opts.env.COMPANION_BRIDGE_URL; child = spawn(command, args, opts); return child; } return spawn(command, args, opts); } }) });
  t.after(() => app.close()); bot.emit('spawn'); await app.ready;
  const deadline = Date.now() + 5000;
  while (!child && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert.ok(child); await app.close(); assert.ok(child.exitCode !== null || child.signalCode !== null);
  await assert.rejects(fetch(`${bridgeUrl}/manifest`));
  bot.emit('chat', 'Alex', 'late'); child.stdout.emit('data', '{"type":"agent_settled"}\n');
  assert.deepEqual(app.eventlog.query(), []);
});

test('log metadata excludes bridge token keys prompt and raw errors', async () => {
  const s = setup([{ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'secret-key raw-provider-body private-prompt HTTP 429', usage: { input: 12, output: 3 } }]);
  await s.ready;
  await s.agent.run({ message: 'private-prompt', owner: { nickname: 'private-owner' } });
  const logs = s.logs.filter(e => ['agent.call', 'agent.fallback'].includes(e.kind));
  assert.equal(logs.length, 2); assert.ok(!JSON.stringify(logs).includes(s.pi.bridge.token));
  assert.doesNotMatch(JSON.stringify(logs), /secret-key|raw-provider-body|private-prompt|private-owner/u);
  assert.equal(logs[0].payload.input_tokens, 12); assert.equal(logs[0].payload.output_tokens, 3);
});

test('RPC real fake child exit rejects outstanding commands and sessions disable retries', async () => {
  const s = setup(); await s.ready;
  await s.agent.run({ message: '你好', owner: {} }); await s.agent.run({ message: '再聊一句', owner: {} });
  assert.equal(s.commands.filter(c => c.command === 'new_session').length, 2);
  assert.deepEqual(s.commands.filter(c => c.command === 'set_auto_retry').map(c => c.enabled), [false, false]);
  const pending = assert.rejects(s.pi.command('stall'), /exited/u);
  await assert.rejects(s.pi.command('exit'), /exited/u); await pending;
});

test('agent_end waits for agent_settled and replaces per-run prompt with persona context', async () => {
  const s = setup(); await s.ready;
  const events = new EventEmitter(); let current, commands = [], ended;
  const endedPromise = new Promise(resolve => { ended = resolve; });
  const pi = { enabled: true, available: () => true, model: 'fake', events, log: s.pi.log,
    bridge: { events: new EventEmitter(), setRun(value) { current = value; } },
    async command(type) {
      commands.push(type);
      if (type === 'new_session') return { cancelled: false };
      if (type === 'prompt') {
        assert.match(current.systemPrompt, /只能通过工具做事/u);
        assert.match(current.systemPrompt, /recent-private/u);
        assert.match(current.systemPrompt, /recovery/u);
        assert.deepEqual(current.tools.map(t => t.name), createGameTools(s.dependencies).map(t => t.name));
        events.emit('event', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '已观察。' }], stopReason: 'stop' } });
        events.emit('event', { type: 'agent_end' }); ended(); return { disposition: 'started' };
      }
    } };
  const agent = createGameAgent({ pi, ...s.dependencies });
  let done = false;
  const running = agent.run({ message: '你好', owner: { nickname: 'Alex' }, recent: [{ text: 'recent-private' }],
    recovery: { status: 'failed', reason: 'escalated', steps: 1 }, mode: 'recover' }).then(value => { done = true; return value; });
  await endedPromise; await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
  events.emit('event', { type: 'agent_settled' }); assert.deepEqual(await running, { text: '已观察。' });
  assert.equal(current, null); assert.deepEqual(commands, ['new_session', 'set_auto_retry', 'prompt']);
});

test('pi smoke reports readiness inventory text duration and closes without credentials', async () => {
  const lines = []; let closed = false;
  await piSmoke({ log: line => lines.push(line), managerFactory({ tools }) {
    const events = new EventEmitter();
    return { hasCredentials: true, rpc: { child: { exitCode: 0 } }, events,
      bridge: { token: 'fake-secret-token', setRun() {} },
      async start() { events.emit('report', { kind: 'ready', tools: ['inventory'] }); },
      async command(type) {
        if (type === 'prompt') {
          await tools[0].execute();
          events.emit('event', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '四块泥土。' }], stopReason: 'stop' } });
          events.emit('event', { type: 'agent_settled' });
        }
      }, async close() { closed = true; } };
  } });
  const report = JSON.parse(lines[0]);
  assert.equal(report.ready, true); assert.deepEqual(report.tools, ['inventory']); assert.equal(report.inventoryCalled, true);
  assert.equal(report.text, '四块泥土。'); assert.ok(report.elapsedMs >= 0); assert.equal(closed, true);
  assert.equal(lines[1], 'closed=true'); assert.doesNotMatch(lines.join(''), /fake-secret-token/u);
});
