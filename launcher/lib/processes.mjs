import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { offlineUuid } from '../../scripts/owner-uuid.mjs';
import { validPlayerName, validateExecutable } from './settings.mjs';
import { writeOwnerUuid } from './owner-env.mjs';
import { addLocalServer, serverListPath } from './servers-dat.mjs';
import { skinCommand } from './skin.mjs';
import { ensureCompanionOp } from './ops.mjs';

export function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export function portOccupied(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', error => error.code === 'EADDRINUSE' ? resolve(true) : reject(error));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
  });
}

export async function preflight(repo, settings, { alive = isAlive, occupied = portOccupied } = {}) {
  const lock = join(repo, '.tmp', 'e2e.lock');
  if (existsSync(lock) && alive(Number(readFileSync(lock, 'utf8').trim()))) throw new Error('e2e 正在运行');
  if (await occupied(25565)) throw new Error('已有服务器在运行，请先关掉');
  if (!validPlayerName(settings.playerName)) throw new Error('玩家名必须是 3–16 位字母、数字或下划线');
}

function safeLog(text) {
  return text.replace(/((?:OWNER_UUID|BRAIN_API_KEY|BRAIN_BASE_URL|BRAIN_MODEL|[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY))\s*[=:]\s*)[^\s,}]+/gi, '$1[隐藏]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [隐藏]');
}

export class LogBuffer extends EventEmitter {
  constructor() { super(); this.lines = []; this.seq = 0; }
  push(text) {
    const line = { seq: ++this.seq, text: safeLog(text), time: new Date().toISOString() };
    this.lines.push(line);
    if (this.lines.length > 500) this.lines.shift();
    this.emit('line', line);
  }
  after(seq = 0) { return this.lines.filter(line => line.seq > seq); }
  attach(stream) {
    if (!stream) return;
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) this.push(line);
      if (pending.length > 65536) { this.push(pending.slice(0, 65536)); pending = ''; }
    });
    stream.on('end', () => { if (pending) this.push(pending); });
  }
}

function waitForLine(log, child, match, after, timeout, signal) {
  return new Promise((resolve, reject) => {
    const finish = error => {
      clearTimeout(timer);
      log.off('line', line);
      child.off('exit', exit);
      child.off('error', failed);
      signal.removeEventListener('abort', abort);
      error ? reject(error) : resolve();
    };
    const line = entry => { if (entry.seq > after && entry.text.includes(match)) finish(); };
    const exit = () => finish(new Error(`进程已退出，未等到 ${match}`));
    const failed = () => finish(new Error('进程启动失败，请检查可执行文件'));
    const abort = () => finish(new Error('已停止'));
    const timer = setTimeout(() => finish(new Error(`等待 ${match} 超时`)), timeout);
    log.on('line', line);
    child.once('exit', exit);
    child.once('error', failed);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else if (child.exitCode != null || child.signalCode != null) exit();
    else if (log.after(after).some(entry => entry.text.includes(match))) finish();
  });
}

function exited(child, timeout) {
  if (!child || child.exitCode != null || child.signalCode != null || child.launchFailed) return Promise.resolve(true);
  return new Promise(resolve => {
    const done = result => { clearTimeout(timer); child.off('exit', onExit); resolve(result); };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), timeout);
    child.once('exit', onExit);
  });
}

export class LauncherProcesses {
  constructor(repo, store, dependencies = {}) {
    this.repo = repo;
    this.companion = join(repo, 'companion');
    this.store = store;
    this.deps = { spawn, preflight, validateExecutable, writeOwnerUuid, addLocalServer, ensureCompanionOp, ...dependencies };
    this.logs = { server: new LogBuffer(), bot: new LogBuffer(), demo: new LogBuffer() };
    this.components = Object.fromEntries(['server', 'bot', 'game', 'demo'].map(key => [key, { status: 'stopped', text: '未启动' }]));
    this.step = null;
    this.stepStatus = 'idle';
    this.lastError = null;
    this.busy = false;
    this.server = null;
    this.bot = null;
    this.demoChild = null;
    this.timeouts = { server: 180000, bot: 60000, stop: 20000, kill: 5000, demo: 30000, ...dependencies.timeouts };
  }
  state() {
    return { settings: this.store.snapshot(), components: structuredClone(this.components),
      step: this.step, stepStatus: this.stepStatus, lastError: this.lastError, busy: this.busy || !!this.stoppingAll,
      active: this.busy || !!this.stoppingAll || !!this.server || !!this.bot || !!this.demoChild };
  }
  component(key, status, text) { this.components[key] = { status, text }; }
  setStep(step) { this.step = step; this.stepStatus = 'running'; }
  command(text) {
    if (!this.server?.stdin?.writable) throw new Error('服务器未运行');
    this.server.stdin.write(text + '\n');
  }
  launch(key, file, args, options) {
    const child = this.deps.spawn(file, args, { ...options, shell: false });
    this[key] = child;
    this.logs[key].attach(child.stdout);
    this.logs[key].attach(child.stderr);
    child.stdin?.on('error', () => {});
    child.once('error', () => {
      child.launchFailed = true;
      this.component(key, 'error', '进程启动失败');
      if (this[key] === child) this[key] = null;
    });
    child.once('exit', code => {
      if (this[key] !== child) return;
      this[key] = null;
      this.component(key, code === 0 || this.stopping ? 'stopped' : 'error', this.stopping ? '已停止' : `进程已退出 (${code ?? '终止'})`);
      if (key === 'server' && this.bot) this.bot.kill();
    });
    return child;
  }
  start() {
    if (this.busy || this.stoppingAll || this.server || this.bot || this.demoChild) throw new Error('启动流程或服务器已在运行');
    return this.run(async signal => {
      const settings = { ...this.store.values };
      this.setStep('preflight');
      await this.deps.preflight(this.repo, settings);
      const java = this.deps.validateExecutable(settings.javaExe, { allowJava: true });
      const pcl = settings.openPcl ? this.deps.validateExecutable(settings.pclExe) : null;
      if (signal.aborted) throw new Error('已停止');
      this.store.save();
      this.deps.writeOwnerUuid(join(this.companion, '.env'), offlineUuid(settings.playerName));
      if (settings.allowCommands) this.deps.ensureCompanionOp(this.repo);
      this.setStep('server');
      this.component('server', 'starting', '等待服务器就绪');
      const after = this.logs.server.seq;
      const child = this.launch('server', java, ['-Xms512M', `-Xmx${settings.serverMemoryMB}M`, '-jar', 'server.jar', 'nogui'],
        { cwd: join(this.repo, 'test-server'), windowsHide: true, stdio: 'pipe' });
      await waitForLine(this.logs.server, child, 'Done (', after, this.timeouts.server, signal);
      this.component('server', 'running', '127.0.0.1:25565');
      this.setStep('permissions');
      this.command(`op ${settings.playerName}`);
      this.setStep('bot');
      await this.startCompanion(settings, signal);
      this.setStep('skin');
      if (settings.applySkin) {
        const command = skinCommand(settings.skinUrl, settings.skinVariant);
        if (command) this.command(command);
        else this.logs.server.push('已跳过皮肤：URL 必须为 HTTPS 且不含引号或空白');
      }
      this.setStep('server-list');
      if (settings.addServerEntry) this.deps.addLocalServer(serverListPath(settings.mcDir, settings.mcVersion));
      this.setStep('pcl');
      if (settings.openPcl) {
        this.component('game', 'starting', '正在打开 PCL');
        await new Promise((resolve, reject) => {
          const game = this.deps.spawn(pcl, [], { shell: false, detached: true, stdio: 'ignore', windowsHide: true });
          game.once('error', () => reject(new Error('PCL 启动失败')));
          game.once('spawn', () => { game.unref(); resolve(); });
        });
        this.component('game', 'running', 'PCL 已打开');
      } else this.component('game', 'stopped', '未打开 PCL');
      this.store.update({ lastStartedAt: new Date().toISOString() }, { internal: true });
      this.stepStatus = 'complete';
    });
  }
  async startCompanion(settings, signal) {
    if (!this.server) throw new Error('服务器未运行');
    this.component('bot', 'starting', '等待 Companion 上线');
    const after = this.logs.server.seq;
    const env = { ...process.env };
    // Always set COMMANDS explicitly: --env-file-if-exists does not override an
    // already-set variable, so '0' keeps a stale .env value from leaking in.
    env.COMMANDS = settings.allowCommands ? '1' : '0';
    if (!settings.brainEnabled) Object.assign(env, { BRAIN_BASE_URL: '', BRAIN_API_KEY: '', BRAIN_MODEL: '' });
    const child = this.launch('bot', process.execPath, ['--env-file-if-exists=.env', 'src/main.js'],
      { cwd: this.companion, windowsHide: true, stdio: 'pipe', env });
    await waitForLine(this.logs.server, child, 'Companion joined the game', after, this.timeouts.bot, signal);
    this.component('bot', 'running', settings.brainEnabled ? '已上线 · 大脑开启' : '已上线 · 大脑关闭');
  }
  // The v1 scenario owns its own server inside the child process; refuse while
  // anything else is running. The child exits via a `stop` line on stdin.
  demo() {
    if (this.busy || this.stoppingAll || this.server || this.bot || this.demoChild) {
      throw new Error('启动流程、服务器或演示已在运行');
    }
    const lock = join(this.repo, '.tmp', 'e2e.lock');
    if (existsSync(lock) && isAlive(Number(readFileSync(lock, 'utf8').trim()))) throw new Error('e2e 正在运行');
    const child = this.deps.spawn(process.execPath, ['scripts/e2e.mjs'], {
      cwd: this.companion, windowsHide: true, shell: false, stdio: 'pipe',
      env: { ...process.env, E2E_SCENARIO: 'v1', E2E_V1: '1', E2E_STDIN_STOP: '1' },
    });
    this.demoChild = child;
    this.logs.demo.attach(child.stdout);
    this.logs.demo.attach(child.stderr);
    child.stdin?.on('error', () => {});
    this.component('demo', 'running', '演示进行中（约 30–40 分钟）');
    const onLine = entry => {
      if (entry.text.includes('E2E V1 FAIL')) this.component('demo', 'error', '演示失败');
      else if (entry.text.includes('E2E V1 PASS')) this.component('demo', 'passed', '演示通过');
    };
    this.logs.demo.on('line', onLine);
    child.once('error', () => {
      child.launchFailed = true;
      if (this.demoChild === child) this.demoChild = null;
      this.component('demo', 'error', '进程启动失败');
    });
    child.once('exit', code => {
      if (this.demoChild === child) this.demoChild = null;
      this.logs.demo.off('line', onLine);
      if (this.components.demo.status === 'running') {
        this.component('demo', code === 0 ? 'passed' : 'error',
          code === 0 ? '演示通过' : `演示退出 (${code ?? '终止'})`);
      }
    });
    return child;
  }
  run(action, { restart = false } = {}) {
    this.busy = true;
    this.lastError = null;
    this.abort = new AbortController();
    this.operation = (async () => {
      try { await action(this.abort.signal); }
      catch (error) {
        if (!this.abort.signal.aborted) {
          this.lastError = error.message;
          this.stepStatus = 'error';
          const key = this.step === 'bot' ? 'bot' : this.step === 'pcl' ? 'game' : 'server';
          this.component(key, 'error', error.message);
        }
        if (restart && !this.abort.signal.aborted) {
          const bot = this.bot;
          if (bot) { bot.kill(); await exited(bot, this.timeouts.kill); }
        } else await this.cleanup();
      } finally { this.busy = false; }
    })();
    return this.operation;
  }
  async cleanup() {
    this.stopping = true;
    let failure;
    try {
      const bot = this.bot;
      if (bot) {
        bot.kill();
        if (!await exited(bot, this.timeouts.kill)) {
          failure = new Error('Companion 未能退出');
          this.component('bot', 'error', failure.message);
        }
      }
      const server = this.server;
      if (server) {
        try { this.command('stop'); } catch { server.kill(); }
        if (!await exited(server, this.timeouts.stop)) {
          server.kill();
          if (!await exited(server, this.timeouts.kill)) {
            failure ??= new Error('服务器未能退出');
            this.component('server', 'error', '服务器未能退出');
          }
        }
      }
      for (const key of ['server', 'bot']) if (this.components[key].status !== 'error') this.component(key, 'stopped', '已停止');
      if (failure) throw failure;
    } finally { this.stopping = false; }
  }
  stop() {
    if (this.stopOperation) return this.stopOperation;
    this.stoppingAll = true;
    this.stopOperation = (async () => {
      try {
        const demo = this.demoChild;
        if (demo) {
          // Windows kill does not run the e2e signal handlers, so the child must
          // be asked over stdin to clean up its own server first.
          try { demo.stdin?.write('stop\n'); } catch {}
          if (!await exited(demo, this.timeouts.demo)) {
            try { demo.kill(); } catch {}
            await exited(demo, this.timeouts.kill);
          }
        }
        this.abort?.abort();
        await this.operation;
        await this.cleanup();
        this.step = null;
        this.stepStatus = 'idle';
      } finally { this.stoppingAll = false; this.stopOperation = null; }
    })();
    return this.stopOperation;
  }
  restartCompanion() {
    if (this.busy || this.stoppingAll || !this.server || this.components.server.status !== 'running') throw new Error('请先等待服务器启动完成');
    return this.run(async signal => {
      this.setStep('bot');
      const old = this.bot;
      if (old) { old.kill(); if (!await exited(old, this.timeouts.kill)) throw new Error('Companion 未能退出'); }
      if (signal.aborted) throw new Error('已停止');
      await this.startCompanion({ ...this.store.values }, signal);
      this.stepStatus = 'complete';
    }, { restart: true });
  }
  givePlanks() {
    if (this.busy || this.stoppingAll || this.components.bot.status !== 'running') throw new Error('Companion 尚未上线');
    this.command('give Companion oak_planks 4');
  }
}
