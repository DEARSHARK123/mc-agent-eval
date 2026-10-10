import { spawn } from 'node:child_process';
import companionBridge from '../../pi-extension/companion-bridge.mjs';

if (process.argv.includes('--fake-pi')) {
const emit = record => process.stdout.write(`${JSON.stringify(record)}\r\n`);
let buffer = '', callbacks = {}, tools = new Map(), waiting, controller, messages = [], configured = false, autoRetry = true;
const pi = { on: (kind, fn) => { callbacks[kind] = fn; }, registerTool: tool => tools.set(tool.name, tool),
  getActiveTools: () => [...tools.keys(), ...(process.env.FAKE_EXTRA_TOOL ? ['bash'] : [])] };
companionBridge(pi);
await callbacks.session_start();
const respond = (command, data) => emit({ type: 'response', id: command.id, command: command.type, success: true, data });
const next = () => { emit({ type: 'fake_next', context: { messages } }); return new Promise(resolve => { waiting = resolve; }); };
async function run() {
  controller = new AbortController();
  await callbacks.before_agent_start();
  emit({ type: 'agent_start' });
  for (;;) {
    const message = await next();
    if (controller.signal.aborted || !message) break;
    emit({ type: 'message_start', message: { role: 'assistant' } });
    emit({ type: 'message_end', message }); messages.push(message);
    if (message.stopReason === 'error') break;
    const calls = message.content?.filter(c => c.type === 'toolCall') ?? [];
    if (!calls.length) break;
    for (const call of calls) {
      if (controller.signal.aborted) break;
      emit({ type: 'tool_execution_start', toolName: call.name, toolCallId: call.id });
      try {
        const result = await tools.get(call.name).execute(call.id, call.arguments, controller.signal);
        messages.push({ role: 'toolResult', toolName: call.name, ...result });
        emit({ type: 'tool_execution_end', toolName: call.name, result });
      } catch { if (!controller.signal.aborted) emit({ type: 'fake_error' }); }
    }
    if (controller.signal.aborted) break;
  }
  emit({ type: 'agent_end', messages }); emit({ type: 'agent_settled' });
}
async function handle(c) {
  emit({ type: 'fake_command', command: c.type, ...(c.type === 'set_auto_retry' ? { enabled: c.enabled } : {}) });
  if (c.type === 'test_reply') { waiting?.(c.message); waiting = null; return respond(c); }
  if (c.type === 'test_config') { configured = true; return respond(c); }
  if (c.type === 'new_session') { messages = []; autoRetry = true; await callbacks.session_start(); return respond(c, { cancelled: false }); }
  if (c.type === 'set_auto_retry') { autoRetry = c.enabled; return respond(c); }
  if (c.type === 'prompt') {
    if (autoRetry && configured) return emit({ type: 'response', id: c.id, command: c.type, success: false });
    respond(c, { disposition: 'started' }); if (configured) void run(); return;
  }
  if (c.type === 'abort') { controller?.abort(); waiting?.(null); waiting = null; emit({ type: 'fake_abort' }); return respond(c); }
  if (c.type === 'stall') return;
  if (c.type === 'exit') return process.exit(3);
  if (c.type === 'orphan') {
    const child = spawn(process.execPath, [new URL('fake-orphan.mjs', import.meta.url).pathname.slice(1), '--orphan'], { windowsHide: true, stdio: 'ignore' });
    return respond(c, { pid: child.pid });
  }
  if (c.type === 'echo') return setTimeout(() => respond(c, { text: c.text }), c.delay ?? 0);
  respond(c);
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    void handle(JSON.parse(line));
  }
});
}
