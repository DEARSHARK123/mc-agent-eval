import { existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { createBridge } from './bridge.js';
import { createRpcClient } from './rpcClient.js';

export const companionRoot = fileURLToPath(new URL('../../', import.meta.url));
export const restrictedArgs = ['--mode', 'rpc', '--no-session', '--no-builtin-tools', '--no-extensions',
  '--no-skills', '--no-context-files', '--no-prompt-templates', '--no-themes'];
export function createPiManager({ piBin = 'pi', piHome = 'pi-home', model = 'openrouter/thinkingmachines/inkling:free',
  tools = [], eventlog, dailyLimit = 1000, clock = Date.now, spawn, command, args,
  hasAuth = existsSync, schedule = setTimeout, unschedule = clearTimeout, readyTimeoutMs = 20000 } = {}) {
  piHome = resolve(companionRoot, piHome);
  const bridge = createBridge({ tools });
  const events = new EventEmitter();
  let rpc, ready = false, closed = false, started = false, retries = 0, retryTimer, readyTimer, disabledDay, exhaustedDay;
  const day = () => { const d = new Date(clock()); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const log = (kind, payload, traceId) => { if (!closed) eventlog?.append(kind, payload, traceId); };
  bridge.events.on('report', report => {
    clearTimeout(readyTimer);
    ready = report.kind === 'ready';
    if (!ready) { disabledDay = day(); log('agent.fallback', { reason: 'tools_mismatch' }); }
    events.emit('report', report);
  });
  function crash(client) {
    if (client !== rpc || closed) return;
    ready = false; clearTimeout(readyTimer); events.emit('exit');
    if (retries >= 3) { disabledDay = day(); log('agent.fallback', { reason: 'pi_crashed' }); return; }
    retryTimer = schedule(() => { retryTimer = null; if (!closed) launch(); }, [2000, 5000, 15000][retries++]);
  }
  function launch() {
    if (closed) return;
    ready = false;
    const tmp = join(companionRoot, '.tmp', 'pi-tmp');
    const cwd = join(companionRoot, '.tmp', 'pi-cwd');
    mkdirSync(tmp, { recursive: true }); mkdirSync(cwd, { recursive: true });
    const env = { ...process.env, PI_CODING_AGENT_DIR: piHome, TEMP: tmp, TMP: tmp, TMPDIR: tmp,
      PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', COMPANION_BRIDGE_URL: bridge.url, COMPANION_BRIDGE_TOKEN: bridge.token };
    for (const name of Object.keys(env)) if (/(?:API_KEY|ACCESS_TOKEN)$/u.test(name)) delete env[name];
    rpc = createRpcClient({ command: command ?? 'cmd.exe', args: args ?? ['/d', '/c', piBin, ...restrictedArgs,
      '-e', join(companionRoot, 'pi-extension', 'companion-bridge.mjs'), '--model', model], env, cwd, spawn,
      diagnostics: record => log('agent.diagnostic', record) });
    const client = rpc;
    client.events.on('event', record => { if (!closed && client === rpc) events.emit('event', record); });
    client.events.once('exit', () => crash(client));
    readyTimer = setTimeout(() => { if (!ready && !closed && client === rpc) void client.close(); }, readyTimeoutMs);
  }
  function available() {
    if (closed || !hasAuth(join(piHome, 'auth.json')) || !ready || !rpc?.alive || disabledDay === day()) return false;
    const since = day();
    const calls = eventlog?.query?.({ kind: 'agent.call', since, limit: Number.MAX_SAFE_INTEGER }) ?? [];
    if (calls.length < dailyLimit) return true;
    if (exhaustedDay !== since && !(eventlog?.query?.({ kind: 'agent.quota_exhausted', since, limit: 1 }) ?? []).length) {
      exhaustedDay = since; log('agent.quota_exhausted', {});
    }
    return false;
  }
  return { bridge, events, model, log, available,
    get hasCredentials() { return !closed && hasAuth(join(piHome, 'auth.json')); },
    get enabled() { return !closed && ready && rpc?.alive === true && disabledDay !== day() && hasAuth(join(piHome, 'auth.json')); }, get rpc() { return rpc; },
    async start() {
      if (started || closed || !hasAuth(join(piHome, 'auth.json'))) return;
      started = true; await bridge.start(); if (!closed) launch(); else await bridge.close();
    },
    command(type, data) { return rpc?.command(type, data) ?? Promise.reject(new Error('pi unavailable')); },
    async close() {
      if (closed) return;
      closed = true; ready = false; clearTimeout(readyTimer); unschedule(retryTimer); events.emit('exit');
      await Promise.all([rpc?.close(), bridge.close()]);
    } };
}
