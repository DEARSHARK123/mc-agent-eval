import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { removeDirRobust } from '../scripts/e2e-cleanup.mjs';
import { offlineUuid } from '../scripts/owner-uuid.mjs';
import { SettingsStore, defaults, detectSettings, playerFromLog, validPlayerName, validateExecutable } from '../launcher/lib/settings.mjs';
import { replaceOwnerUuid, writeOwnerUuid } from '../launcher/lib/owner-env.mjs';
import { nbt, addLocalServer, serverListPath } from '../launcher/lib/servers-dat.mjs';
import { skinCommand } from '../launcher/lib/skin.mjs';
import { LauncherProcesses, LogBuffer, preflight, portOccupied } from '../launcher/lib/processes.mjs';
import { ensureCompanionOp } from '../launcher/lib/ops.mjs';
import { createLauncherHttp, listenAvailable } from '../launcher/lib/http.mjs';
import { existingInstance, instanceUrl, claimInstance, removeInstance, removeStaleInstance } from '../launcher/lib/instance.mjs';
import { startLauncher } from '../launcher/server.mjs';

const tmpRoot = fileURLToPath(new URL('../../.tmp/', import.meta.url));
function fixture(t) {
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, 't11-test-'));
  t.after(() => { assert.equal(removeDirRobust(dir), true); assert.equal(existsSync(dir), false); });
  return dir;
}
function put(file, data) { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, data); }
function storeAt(dir, detected = {}) { return new SettingsStore(join(dir, 'settings.json'), dir, () => detected); }

test('settings fill missing and invalid fields with correct sources', t => {
  const dir = fixture(t);
  put(join(dir, 'settings.json'), JSON.stringify({ playerName: 123, pclExe: 'saved.exe', serverMemoryMB: 900,
    brainEnabled: 'true', mcVersion: '../escape', skinVariant: 'invalid', lastStartedAt: false, unknown: true }));
  const store = storeAt(dir, { playerName: 'Detected', javaExe: 'detected.exe' });
  assert.equal(store.values.playerName, 'Detected');
  assert.equal(store.sources.playerName, 'detected');
  assert.equal(store.sources.javaExe, 'detected');
  assert.equal(store.values.pclExe, 'saved.exe');
  assert.equal(store.sources.pclExe, 'saved');
  for (const key of ['serverMemoryMB', 'brainEnabled', 'mcVersion', 'skinVariant', 'lastStartedAt']) {
    assert.equal(store.values[key], defaults[key]);
    assert.equal(store.sources[key], 'default');
  }
  assert.equal(Object.hasOwn(store.values, 'unknown'), false);
});

test('settings absent or broken JSON uses defaults, save reload is identical and atomic', t => {
  const dir = fixture(t);
  const store = storeAt(dir);
  assert.deepEqual(store.values, defaults);
  store.update({ playerName: 'Owner_1', serverMemoryMB: 4096, brainEnabled: false });
  assert.deepEqual(storeAt(dir).values, store.values);
  assert.ok(Object.values(storeAt(dir).sources).every(source => source === 'saved'));
  assert.deepEqual(readdirSync(dir), ['settings.json']);
  put(join(dir, 'settings.json'), '{broken');
  assert.deepEqual(storeAt(dir).values, defaults);
  put(join(dir, 'settings.json'), 'null');
  assert.deepEqual(storeAt(dir).values, defaults);
});

test('partial settings reject invalid or unknown values without changing saved state', t => {
  const store = storeAt(fixture(t));
  for (const patch of [{ arbitraryCommand: 'bad' }, { serverMemoryMB: 4097 }, { serverMemoryMB: 1023 },
    { serverMemoryMB: 1536.5 }, { openPcl: 'yes' }, { lastStartedAt: null }, { mcVersion: '../../bad' }, null, []]) {
    assert.throws(() => store.update(patch));
    assert.deepEqual(store.values, defaults);
  }
  store.update({ serverMemoryMB: 1024 });
  assert.equal(store.values.serverMemoryMB, 1024);
});

test('detect prefers version log, parses java.exe and derives Minecraft directory', t => {
  const dir = fixture(t);
  const pcl = join(dir, 'PCL', 'launcher.exe');
  put(pcl, 'fake');
  const mcDir = join(dir, 'PCL', '.minecraft');
  put(join(mcDir, 'versions', '1.20.4', 'logs', 'latest.log'), '[info] Setting user: First\nSetting user: DEARSHARK14010\n');
  put(join(mcDir, 'logs', 'latest.log'), 'Setting user: Fallback');
  put(join(dir, 'test-server', 'run.bat'), '"D:\\Java\\bin\\java.exe" -jar server.jar');
  const detected = detectSettings(dir, {}, { pclCandidate: pcl });
  assert.equal(detected.playerName, 'DEARSHARK14010');
  assert.equal(detected.javaExe, 'D:\\Java\\bin\\java.exe');
  assert.equal(detected.pclExe, pcl);
  assert.equal(detected.mcDir, mcDir);
  put(join(mcDir, 'versions', '1.20.4', 'logs', 'latest.log'), 'No match');
  assert.equal(detectSettings(dir, {}, { pclCandidate: pcl }).playerName, 'Fallback');
  put(join(dir, 'test-server', 'run.bat'), 'java -jar server.jar');
  assert.equal(detectSettings(dir, {}, { pclCandidate: join(dir, 'absent.exe') }).javaExe, undefined);
});

test('redetect overrides only player/PCL/java and persists results', t => {
  const store = storeAt(fixture(t), { playerName: 'NewOwner', pclExe: 'new.exe' });
  store.update({ playerName: 'OldOwner', pclExe: 'old.exe', javaExe: 'old-java.exe', brainEnabled: false });
  const result = store.redetect();
  assert.equal(result.values.playerName, 'NewOwner');
  assert.equal(result.sources.playerName, 'detected');
  assert.equal(result.values.javaExe, 'java');
  assert.equal(result.sources.javaExe, 'default');
  assert.equal(result.values.brainEnabled, false);
  assert.equal(storeAt(join(store.file, '..')).values.playerName, 'NewOwner');
});

test('player detection takes last match and player validation checks boundaries', () => {
  assert.equal(playerFromLog('Setting user: First\r\n[12] Setting user: Last_123'), 'Last_123');
  assert.equal(playerFromLog('unrelated log'), '');
  for (const name of ['abc', 'A'.repeat(16), 'abc_123']) assert.equal(validPlayerName(name), true);
  for (const name of ['', 'ab', 'A'.repeat(17), 'a b', 'abc\nstop', '中文名', 'a-b', null]) assert.equal(validPlayerName(name), false);
});

test('executable validation rejects commands/directories and resolves java fallback', t => {
  const dir = fixture(t);
  const exe = join(dir, 'java.exe');
  put(exe, 'fake executable');
  assert.equal(validateExecutable(exe), exe);
  assert.equal(validateExecutable('java', { allowJava: true, env: { PATH: dir } }), exe);
  for (const path of [join(dir, 'missing.exe'), join(dir, 'run.cmd'), 'java', dir, exe + ' & bad']) {
    assert.throws(() => validateExecutable(path));
  }
});

test('OWNER_UUID replacement preserves comments, other lines and CRLF', () => {
  const text = '# comment\r\nKEY=keep\r\nOWNER_UUID=old\r\n# OWNER_UUID=comment\r\nTAIL=keep';
  assert.equal(replaceOwnerUuid(text, 'new'), '# comment\r\nKEY=keep\r\nOWNER_UUID=new\r\n# OWNER_UUID=comment\r\nTAIL=keep');
  assert.equal(replaceOwnerUuid('KEY=keep\r\n', 'new'), 'KEY=keep\r\nOWNER_UUID=new\r\n');
  assert.equal(replaceOwnerUuid('KEY=keep', 'new'), 'KEY=keep\nOWNER_UUID=new\n');
  assert.equal(replaceOwnerUuid('OWNER_UUID=old', 'new'), 'OWNER_UUID=new');
  assert.equal(replaceOwnerUuid('OWNER_UUID=old  # keep\r\n', 'new'), 'OWNER_UUID=new  # keep\r\n');
});

test('OWNER_UUID writer creates absent fake file and updates only its line', t => {
  const file = join(fixture(t), 'fake-env.txt');
  writeOwnerUuid(file, 'first');
  assert.equal(readFileSync(file, 'utf8'), 'OWNER_UUID=first\n');
  put(file, '# keep\r\nOTHER=value\r\nOWNER_UUID=old\r\n');
  writeOwnerUuid(file, 'second');
  assert.equal(readFileSync(file, 'utf8'), '# keep\r\nOTHER=value\r\nOWNER_UUID=second\r\n');
});

test('servers.dat new file can be parsed and chooses version directory or fallback', t => {
  const dir = fixture(t);
  assert.equal(serverListPath(dir, '1.20.4'), join(dir, 'servers.dat'));
  mkdirSync(join(dir, 'versions', '1.20.4'), { recursive: true });
  const file = serverListPath(dir, '1.20.4');
  assert.equal(file, join(dir, 'versions', '1.20.4', 'servers.dat'));
  assert.equal(addLocalServer(file), true);
  assert.deepEqual(nbt.simplify(nbt.parseUncompressed(readFileSync(file))).servers, [{ name: 'Companion 测试服', ip: '127.0.0.1' }]);
  assert.equal(existsSync(file + '.launcher-bak'), false);
});

test('servers.dat inserts first, preserves other tags and creates exact backup', t => {
  const file = join(fixture(t), 'servers.dat');
  const original = nbt.writeUncompressed(nbt.comp({ custom: nbt.string('keep'), servers: nbt.list({ type: 'compound', value: [
    { name: nbt.string('Other'), ip: nbt.string('example.org'), icon: nbt.string('keep') },
  ] }) }));
  put(file, original);
  assert.equal(addLocalServer(file), true);
  assert.deepEqual(readFileSync(file + '.launcher-bak'), original);
  const parsed = nbt.simplify(nbt.parseUncompressed(readFileSync(file)));
  assert.equal(parsed.custom, 'keep');
  assert.equal(parsed.servers[0].ip, '127.0.0.1');
  assert.deepEqual(parsed.servers[1], { name: 'Other', ip: 'example.org', icon: 'keep' });
});

for (const ip of ['127.0.0.1', '127.0.0.1:25565']) test(`servers.dat does not duplicate ${ip} or rewrite existing file`, t => {
  const file = join(fixture(t), 'servers.dat');
  const original = nbt.writeUncompressed(nbt.comp({ servers: nbt.list({ type: 'compound', value: [{ name: nbt.string('Keep'), ip: nbt.string(ip) }] }) }));
  put(file, original);
  assert.equal(addLocalServer(file), false);
  assert.deepEqual(readFileSync(file), original);
  assert.equal(existsSync(file + '.launcher-bak'), false);
});

test('skin command permits only HTTPS URL without quotes or whitespace', () => {
  assert.equal(skinCommand(defaults.skinUrl, 'classic'), null); // no skin configured by default
  assert.equal(skinCommand('https://example.org/skin.png', 'slim'), 'skin set "https://example.org/skin.png" Companion slim');
  for (const url of ['http://example.org/a', 'https://example.org/"a', "https://example.org/'a", 'https://example.org/a b', 'https://example.org/a\nstop', 'bad', null]) assert.equal(skinCommand(url), null);
  assert.equal(skinCommand(defaults.skinUrl, 'classic\nstop'), null);
});

test('preflight rejects alive e2e lock before checking port', async t => {
  const dir = fixture(t);
  put(join(dir, '.tmp', 'e2e.lock'), '123');
  await assert.rejects(preflight(dir, { playerName: 'Owner' }, { alive: pid => pid === 123,
    occupied: () => assert.fail('must not check port') }), /e2e 正在运行/);
  await assert.rejects(preflight(dir, { playerName: 'Owner' }, { alive: () => false, occupied: async () => true }), /已有服务器/);
  await assert.rejects(preflight(dir, { playerName: 'bad\nstop' }, { alive: () => false, occupied: async () => false }), /玩家名/);
  await preflight(dir, { playerName: 'Owner' }, { alive: () => false, occupied: async () => false });
});

async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
function request(port, path, { token = 'test-token', host = `127.0.0.1:${port}`, method = 'GET', body, contentType = 'application/json' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    if (token != null) headers['X-Launcher-Token'] = token;
    if (body !== undefined) headers['Content-Type'] = contentType;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => {
      let data = '';
      res.setEncoding('utf8'); res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('real HTTP enforces token/Host/JSON/body limits and routes fixed actions', async t => {
  const dir = fixture(t), store = storeAt(dir), calls = [];
  const manager = { logs: { server: new LogBuffer(), bot: new LogBuffer() },
    state: () => ({ settings: store.snapshot() }), start: async () => calls.push('start'), stop: async () => calls.push('stop'),
    restartCompanion: async () => calls.push('restart'), givePlanks: () => calls.push('planks') };
  manager.logs.server.push('first'); manager.logs.server.push('second');
  const uiFile = join(dir, 'ui.html'), skinFile = join(dir, 'skin.png');
  put(uiFile, '<html>fixture</html>'); put(skinFile, Buffer.from([1, 2, 3]));
  const server = createLauncherHttp({ token: 'test-token', store, manager, uiFile, skinFile, quit: () => calls.push('quit') });
  const port = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const token of [null, '', 'wrong', 'test-tokex']) assert.equal((await request(port, '/api/state', { token })).status, 401);
  assert.equal((await request(port, '/api/state', { host: 'evil.example:' + port })).status, 403);
  assert.equal((await request(port, '/api/state')).status, 200);
  assert.equal((await request(port, '/api/state', { host: 'localhost:' + port })).status, 200);
  assert.equal((await request(port, '/api/start', { method: 'POST', body: '{}', contentType: 'text/plain' })).status, 415);
  assert.equal((await request(port, '/api/start', { method: 'POST', body: '{bad' })).status, 400);
  assert.equal((await request(port, '/api/start', { method: 'POST', body: JSON.stringify({ text: 'x'.repeat(65536) }) })).status, 413);
  assert.equal((await request(port, '/api/settings', { method: 'POST', body: '{"playerName":"SavedOwner"}' })).status, 200);
  assert.equal(store.values.playerName, 'SavedOwner');
  for (const action of ['detect', 'start', 'restart-companion', 'give-planks', 'stop', 'quit']) {
    const result = await request(port, '/api/' + action, { method: 'POST', body: '{}' });
    assert.equal(result.status, ['start', 'restart-companion'].includes(action) ? 202 : 200);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['start', 'restart', 'planks', 'stop', 'stop', 'quit']);
  const logs = await request(port, '/api/logs?source=server&after=1');
  assert.deepEqual(JSON.parse(logs.data).lines.map(line => line.text), ['second']);
  for (const path of ['/api/logs?source=unknown', '/api/logs?source=server&after=NaN', '/api/logs?source=__proto__']) assert.equal((await request(port, path)).status, 400);
  assert.equal((await request(port, '/skin.png', { token: null })).status, 200);
  assert.equal((await request(port, '/', { token: null })).status, 200);
  assert.equal((await request(port, '/api/command', { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await request(port, '/../settings.json')).status, 404);
});

test('port selection skips occupied port and listens only on IPv4 loopback', async t => {
  const first = http.createServer();
  const port = await listen(first);
  const next = http.createServer();
  t.after(() => new Promise(resolve => first.close(resolve)));
  t.after(() => new Promise(resolve => next.close(resolve)));
  assert.equal(await portOccupied(port), true);
  assert.ok(await listenAvailable(next, port) > port);
  assert.equal(next.address().address, '127.0.0.1');
});

test('single-instance validates PID, port, token and only removes owned record', async t => {
  const file = join(fixture(t), '.instance.json');
  const data = { pid: 123, port: 37615, token: 'a'.repeat(32) };
  assert.equal(await existingInstance(file), null);
  claimInstance(file, data);
  assert.throws(() => claimInstance(file, data), { code: 'EEXIST' });
  assert.deepEqual(await existingInstance(file, { alive: () => true, connect: async () => true }), data);
  assert.equal(instanceUrl(data), `http://127.0.0.1:37615/#t=${data.token}`);
  assert.equal(await existingInstance(file, { alive: () => false, connect: async () => true }), null);
  assert.equal(await existingInstance(file, { alive: () => true, connect: async () => false }), null);
  assert.throws(() => removeStaleInstance(file, () => true), /仍在运行/);
  assert.equal(existsSync(file), true);
  removeInstance(file, 456); assert.equal(existsSync(file), true);
  removeInstance(file, 123); assert.equal(existsSync(file), false);
  put(file, 'null');
  assert.equal(await existingInstance(file), null);
  removeStaleInstance(file);
  assert.equal(existsSync(file), false);
});

test('launcher entry reopens the same instance and shutdown removes record/listeners', async t => {
  const dir = fixture(t), urls = [];
  mkdirSync(join(dir, 'companion', 'launcher'), { recursive: true });
  const before = process.listenerCount('SIGINT');
  const launcher = await startLauncher({ repo: dir, browser: url => urls.push(url) });
  t.after(() => launcher.shutdown());
  const token = new URLSearchParams(new URL(urls[0]).hash.slice(1)).get('t');
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal((await request(launcher.port, '/api/state', { token })).status, 200);
  assert.equal(await startLauncher({ repo: dir, browser: url => urls.push(url) }), null);
  assert.equal(urls[0], urls[1]);
  await launcher.shutdown();
  assert.equal(existsSync(join(dir, 'companion', 'launcher', '.instance.json')), false);
  assert.equal(launcher.server.listening, false);
  assert.equal(process.listenerCount('SIGINT'), before);
});

test('logs buffer caps 500 lines, assigns monotonic sequences and redacts secrets', () => {
  const log = new LogBuffer();
  for (let i = 0; i < 510; i++) log.push('line ' + i);
  assert.equal(log.lines.length, 500);
  assert.equal(log.lines[0].seq, 11);
  log.push('BRAIN_API_KEY=secret OWNER_UUID=private Bearer token');
  assert.equal(log.after(510)[0].text, 'BRAIN_API_KEY=[隐藏] OWNER_UUID=[隐藏] Bearer [隐藏]');
});

function processFixture(t, options = {}) {
  const dir = fixture(t), store = storeAt(dir), events = [], children = [];
  store.update({ playerName: 'Owner_123', javaExe: 'java.exe', pclExe: 'pcl.exe', mcDir: join(dir, 'minecraft'), brainEnabled: false });
  const manager = new LauncherProcesses(dir, store, {
    preflight: async () => events.push('preflight'), validateExecutable: file => file,
    writeOwnerUuid: (file, uuid) => events.push(['owner', uuid]), addLocalServer: file => events.push(['list', file]),
    timeouts: { server: 40, bot: 40, stop: 15, kill: 15 },
    spawn: (file, args, spawnOptions) => {
      const key = file === 'java.exe' ? 'server' : file === 'pcl.exe' ? 'game' : 'bot';
      const child = new EventEmitter();
      child.key = key; child.exitCode = null; child.signalCode = null;
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.finish = () => { child.exitCode = 0; child.emit('exit', 0); child.stdout.end(); child.stderr.end(); };
      child.kill = () => { events.push(['kill', key]); child.finish(); return true; };
      child.unref = () => events.push('unref');
      child.stdin = new Writable({ write(chunk, encoding, callback) {
        const command = chunk.toString().trim(); events.push(['command', command]);
        if (command === 'stop' && !options.ignoreStop) child.finish(); callback();
      } });
      children.push({ child, file, args, options: spawnOptions }); events.push(['spawn', key]);
      setImmediate(() => {
        child.emit('spawn');
        if (key === 'server' && !options.noDone) { child.stdout.write('Starting\r\nDone (0.5s)!\r\n'); }
        if (key === 'bot' && !options.noJoin) manager.server?.stdout.write('Companion joined the game\n');
      });
      return child;
    }, ...options.deps,
  });
  t.after(() => manager.stop());
  return { manager, store, events, children, dir };
}

test('fixed startup sequence, arguments, disabled brain, skin, NBT path and detached PCL', async t => {
  const { manager, store, events, children, dir } = processFixture(t);
  await manager.start();
  assert.equal(manager.lastError, null);
  assert.equal(manager.stepStatus, 'complete');
  assert.ok(store.values.lastStartedAt);
  assert.deepEqual(events, ['preflight', ['owner', offlineUuid('Owner_123')], ['spawn', 'server'],
    ['command', 'op Owner_123'], ['spawn', 'bot'],
    ['list', join(dir, 'minecraft', 'servers.dat')], ['spawn', 'game'], 'unref']);
  assert.deepEqual(children[0].args, ['-Xms512M', '-Xmx1536M', '-jar', 'server.jar', 'nogui']);
  assert.equal(children[0].options.cwd, join(dir, 'test-server'));
  assert.equal(children[0].options.shell, false);
  assert.equal(children[0].options.windowsHide, true);
  assert.deepEqual(children[1].args, ['--env-file-if-exists=.env', 'src/main.js']);
  for (const key of ['BRAIN_BASE_URL', 'BRAIN_API_KEY', 'BRAIN_MODEL']) assert.equal(children[1].options.env[key], '');
  assert.equal(children[2].options.detached, true);
  assert.equal(children[2].options.stdio, 'ignore');
  manager.givePlanks();
  assert.deepEqual(events.at(-1), ['command', 'give Companion oak_planks 4']);
  await manager.stop();
  assert.deepEqual(events.slice(-2), [['kill', 'bot'], ['command', 'stop']]);
  assert.equal(manager.server, null); assert.equal(manager.bot, null);
  assert.equal(manager.components.game.status, 'running');
});

test('restart only replaces Companion, keeps server and ignores previous join lines', async t => {
  const options = { noJoin: false }, { manager, events, children } = processFixture(t, options);
  await manager.start();
  const old = manager.bot, server = manager.server;
  await manager.restartCompanion();
  assert.notEqual(manager.bot, old); assert.equal(manager.server, server);
  assert.deepEqual(events.slice(-2), [['kill', 'bot'], ['spawn', 'bot']]);
  assert.equal(children.filter(child => child.child.key === 'server').length, 1);
  options.noJoin = true;
  await manager.restartCompanion();
  assert.match(manager.lastError, /超时/);
  assert.equal(manager.server, server);
  assert.equal(manager.bot, null);
});

test('startup timeout cleans managed children and does not launch Companion/PCL', async t => {
  const { manager, children } = processFixture(t, { noDone: true });
  await manager.start();
  assert.match(manager.lastError, /超时/);
  assert.equal(manager.step, 'server'); assert.equal(manager.stepStatus, 'error');
  assert.equal(manager.server, null);
  assert.equal(children.length, 1);
});

test('stop cancels pending startup and force kills server after grace period', async t => {
  const { manager, events } = processFixture(t, { noDone: true, ignoreStop: true });
  const starting = manager.start();
  assert.throws(() => manager.start(), /运行/);
  await new Promise(resolve => setImmediate(resolve));
  const stopping = manager.stop();
  assert.equal(manager.stop(), stopping);
  assert.throws(() => manager.start(), /运行/);
  await stopping; await starting;
  assert.equal(manager.server, null); assert.equal(manager.busy, false);
  assert.deepEqual(events.slice(-2), [['command', 'stop'], ['kill', 'server']]);
  assert.equal(manager.lastError, null);
});

test('preflight failure starts no processes and unsafe skin is skipped', async t => {
  const failed = processFixture(t, { deps: { preflight: async () => { throw new Error('e2e 正在运行'); } } });
  await failed.manager.start(); assert.equal(failed.children.length, 0); assert.equal(failed.manager.lastError, 'e2e 正在运行');
  const ok = processFixture(t);
  ok.store.update({ skinUrl: 'http://example.org/a', addServerEntry: false, openPcl: false });
  await ok.manager.start();
  assert.equal(ok.manager.lastError, null);
  assert.equal(ok.children.length, 2);
  assert.equal(ok.events.some(event => Array.isArray(event) && event[0] === 'command' && event[1].startsWith('skin')), false);
  assert.ok(ok.manager.logs.server.lines.some(line => line.text.includes('已跳过皮肤')));
});

test('ops.json merge: creates level 2, preserves others, downgrades higher levels', t => {
  const dir = fixture(t);
  const file = join(dir, 'test-server', 'ops.json');
  ensureCompanionOp(dir);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')),
    [{ uuid: offlineUuid('Companion'), name: 'Companion', level: 2, bypassesPlayerLimit: false }]);
  assert.deepEqual(readdirSync(join(dir, 'test-server')).filter(name => name.endsWith('.tmp')), []);

  const other = { uuid: '11111111-2222-3333-4444-555555555555', name: 'Someone', level: 4, bypassesPlayerLimit: true };
  put(file, JSON.stringify([other, { uuid: 'deadbeef-0000-0000-0000-000000000000', name: 'Companion', level: 4, bypassesPlayerLimit: false }]));
  ensureCompanionOp(dir);
  const merged = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], other, 'unrelated op entries must be preserved verbatim');
  assert.deepEqual(merged[1], { uuid: offlineUuid('Companion'), name: 'Companion', level: 2, bypassesPlayerLimit: false });

  put(file, '{broken json');
  assert.throws(() => ensureCompanionOp(dir), /ops\.json.*JSON/u);
  assert.equal(readFileSync(file, 'utf8'), '{broken json', 'a corrupt ops.json must never be overwritten');
});

test('ops.json write failure leaves the original file untouched', t => {
  const dir = fixture(t);
  const file = join(dir, 'test-server', 'ops.json');
  put(file, '[]');
  assert.throws(() => ensureCompanionOp(dir, { write: () => { throw new Error('disk full'); } }), /disk full/u);
  assert.equal(readFileSync(file, 'utf8'), '[]');
});

test('launcher writes ops and sets COMMANDS only when allowCommands', async t => {
  const seen = [];
  const { manager, store, children, dir } = processFixture(t, {
    deps: { ensureCompanionOp: repo => { seen.push(manager.server === null); ensureCompanionOp(repo); } } });
  store.update({ allowCommands: true });
  await manager.start();
  assert.equal(manager.lastError, null);
  assert.deepEqual(seen, [true], 'ops.json must be written before the server spawns');
  const bot = children.find(child => child.child.key === 'bot');
  assert.equal(bot.options.env.COMMANDS, '1');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'test-server', 'ops.json'), 'utf8')),
    [{ uuid: offlineUuid('Companion'), name: 'Companion', level: 2, bypassesPlayerLimit: false }]);
  await manager.stop();

  const off = processFixture(t, { deps: { ensureCompanionOp: () => seen.push('unexpected') } });
  await off.manager.start();
  assert.equal(off.manager.lastError, null);
  assert.deepEqual(seen, [true], 'ops.json must not be touched when allowCommands is off');
  const offCompanion = off.children.find(child => child.child.key === 'bot');
  assert.equal(offCompanion.options.env.COMMANDS, '0');
  assert.equal(existsSync(join(off.dir, 'test-server', 'ops.json')), false);
  await off.manager.stop();

  const broken = processFixture(t);
  put(join(broken.dir, 'test-server', 'ops.json'), '{broken');
  broken.store.update({ allowCommands: true });
  await broken.manager.start();
  assert.match(broken.manager.lastError ?? '', /ops\.json.*JSON/u);
  assert.equal(broken.children.length, 0, 'a corrupt ops.json must stop the launch');
  assert.equal(readFileSync(join(broken.dir, 'test-server', 'ops.json'), 'utf8'), '{broken');
});

test('demo() refuses while anything is running, then spawns the v1 e2e with stdin stop env', async t => {
  const { manager, children, events } = processFixture(t);
  await manager.start();
  assert.throws(() => manager.demo(), /运行/);
  await manager.stop();
  const child = manager.demo();
  assert.throws(() => manager.demo(), /演示/);
  assert.throws(() => manager.start(), /运行/);
  const spawned = children.at(-1);
  assert.equal(spawned.file, process.execPath);
  assert.deepEqual(spawned.args, ['scripts/e2e.mjs']);
  assert.equal(spawned.options.cwd, manager.companion);
  assert.equal(spawned.options.env.E2E_SCENARIO, 'v1');
  assert.equal(spawned.options.env.E2E_V1, '1');
  assert.equal(spawned.options.env.E2E_STDIN_STOP, '1');
  assert.equal(manager.components.demo.status, 'running');
  assert.equal(manager.state().active, true);
  child.stdout.write('E2E V1 S1 PASS\n');
  assert.equal(manager.components.demo.status, 'running');
  child.stdout.write('E2E V1 PASS\n');
  assert.equal(manager.components.demo.status, 'passed');
  child.finish();
  assert.equal(manager.demoChild, null);
});

test('demo failure states: FAIL line and nonzero exit turn the component error', async t => {
  const { manager, children } = processFixture(t);
  const child = manager.demo();
  child.stdout.write('E2E V1 FAIL: S3: timed out\n');
  assert.equal(manager.components.demo.status, 'error');
  child.finish();
  const again = manager.demo();
  const other = children.at(-1).child;
  other.emit('exit', 1);
  assert.equal(manager.components.demo.status, 'error');
  assert.match(manager.components.demo.text, /退出/);
  assert.equal(again, other);
});

test('stop writes stop to the demo stdin first and only kills when it does not exit', async t => {
  const graceful = processFixture(t);
  graceful.manager.demo();
  await graceful.manager.stop();
  assert.deepEqual(graceful.events.filter(e => e[0] === 'command' || e[0] === 'kill'),
    [['command', 'stop']], 'stdin stop let the child exit on its own');
  const stubborn = processFixture(t, { ignoreStop: true, deps: { timeouts: { demo: 15, kill: 15 } } });
  stubborn.manager.demo();
  await stubborn.manager.stop();
  assert.deepEqual(stubborn.events.filter(e => e[0] === 'command' || e[0] === 'kill'),
    [['command', 'stop'], ['kill', 'bot']], 'stdin stop first, kill after the wait window');
});

test('demo refuses while an e2e lock is held and /api/demo is authenticated like the rest', async t => {
  const { manager, dir } = processFixture(t);
  put(join(dir, '.tmp', 'e2e.lock'), String(process.pid));
  assert.throws(() => manager.demo(), /e2e 正在运行/);
  const store = storeAt(dir);
  const calls = [];
  const fake = { logs: { server: new LogBuffer(), bot: new LogBuffer(), demo: new LogBuffer() },
    state: () => ({}), demo: () => calls.push('demo'), start: async () => {}, stop: async () => {},
    restartCompanion: async () => {}, givePlanks: () => {} };
  const server = createLauncherHttp({ token: 'test-token', store, manager: fake,
    uiFile: join(dir, 'ui.html'), skinFile: join(dir, 'skin.png'), quit: () => {} });
  put(join(dir, 'ui.html'), '<html></html>'); put(join(dir, 'skin.png'), Buffer.from([1]));
  const port = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal((await request(port, '/api/demo', { method: 'POST', body: '{}', token: null })).status, 401);
  assert.equal((await request(port, '/api/demo', { method: 'POST', body: '{}' })).status, 202);
  assert.deepEqual(calls, ['demo']);
  fake.logs.demo.push('E2E V1 S1 PASS');
  const demoLogs = await request(port, '/api/logs?source=demo');
  assert.deepEqual(JSON.parse(demoLogs.data).lines.map(line => line.text), ['E2E V1 S1 PASS']);
});
