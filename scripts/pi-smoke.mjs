// Run directly: node scripts/pi-smoke.mjs. No environment files are loaded.
import { createPiManager } from '../src/brain/manager.js';

export async function piSmoke({ log = console.log, managerFactory = createPiManager } = {}) {
  let inventoryCalled = false;
  const tool = { name: 'inventory', description: '查看游戏背包', parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() { inventoryCalled = true; return { content: [{ type: 'text', text: '{"dirt":4}' }], details: { dirt: 4 } }; } };
  const pi = managerFactory({ piBin: process.env.PI_BIN || 'pi', piHome: process.env.PI_HOME || 'pi-home',
    model: process.env.AGENT_MODEL || 'openrouter/thinkingmachines/inkling:free', tools: [tool] });
  const started = Date.now();
  let ready = false, tools = [], text = null, timer;
  try {
    if (!pi.hasCredentials) { log('ready=false (auth.json missing)'); return; }
    const report = new Promise((resolve, reject) => {
      pi.events.on('report', value => { tools = value.tools; ready = value.kind === 'ready'; ready ? resolve() : reject(new Error('tools_mismatch')); });
      pi.events.once('exit', () => reject(new Error('pi exited')));
    });
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('smoke timeout')), 30000); });
    await Promise.race([(async () => { await pi.start(); await report; })(), timeout]);
    await pi.command('new_session');
    await pi.command('set_auto_retry', { enabled: false });
    pi.bridge.setRun({ tools: [tool], systemPrompt: '你是游戏伙伴。只用游戏工具观察背包，用简短中文描述已经观察到的事实。' });
    const settled = new Promise((resolve, reject) => {
      pi.events.on('event', event => {
        if (event.type === 'message_end' && event.message?.role === 'assistant') {
          if (event.message.stopReason === 'error') { reject(new Error('model request failed')); return; }
          text = event.message.content.filter(c => c.type === 'text').map(c => c.text).join('') || null;
        }
        if (event.type === 'agent_settled') resolve();
      });
    });
    await pi.command('prompt', { message: '看看背包里有什么，用一句中文告诉我' });
    await Promise.race([settled, timeout]);
    // Do not let an unexpected model echo leak the bridge secret.
    log(JSON.stringify({ ready, tools, inventoryCalled,
      text: text?.replaceAll(pi.bridge.token, '[redacted]'), elapsedMs: Date.now() - started }));
  } finally {
    clearTimeout(timer); pi.bridge.setRun(null); await pi.close();
    const exited = !pi.rpc || pi.rpc.child.exitCode !== null || pi.rpc.child.signalCode !== null;
    log(`closed=${exited}`);
    if (!exited) throw new Error('pi process remains');
  }
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  piSmoke().catch(() => { console.error('pi smoke failed (details redacted)'); process.exitCode = 1; });
}
