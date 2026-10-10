import { spawn as nativeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export function createRpcClient({ command = 'cmd.exe', args = [], env, cwd, spawn = nativeSpawn,
  platform = process.platform, diagnostics } = {}) {
  const events = new EventEmitter();
  const child = spawn(command, args, { env, cwd, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let sequence = 0, buffer = '', dead = false, closing;
  function finish() {
    if (dead) return;
    dead = true;
    for (const entry of pending.values()) entry.reject(new Error('pi exited'));
    pending.clear();
    events.emit('exit');
  }
  child.on('error', finish);
  child.on('exit', finish);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/u, '');
      buffer = buffer.slice(end + 1);
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type === 'response' && record.id) {
        const entry = pending.get(record.id);
        if (!entry) continue;
        pending.delete(record.id);
        if (record.success) entry.resolve(record.data);
        else entry.reject(new Error('pi command failed'));
      } else if (!record.id) events.emit('event', record);
    }
  });
  // Never forward raw stderr: it can contain provider bodies or credentials.
  child.stderr.on('data', chunk => diagnostics?.({ kind: 'pi.stderr', bytes: Math.min(chunk.length, 1024) }));
  return { child, events, get alive() { return !dead; },
    command(type, data = {}) {
      if (dead || closing) return Promise.reject(new Error('pi unavailable'));
      const id = `companion-${++sequence}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ ...data, type, id })}\n`, error => {
          if (error) { pending.delete(id); reject(new Error('pi write failed')); }
        });
      });
    },
    close() {
      if (closing) return closing;
      if (dead) { closing = Promise.resolve(); return closing; }
      const exited = dead ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve));
      finish();
      if (platform === 'win32' && child.pid) {
        closing = new Promise(resolve => {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
          killer.once('error', () => { child.kill('SIGKILL'); resolve(); });
          killer.once('exit', code => { if (code !== 0) child.kill('SIGKILL'); resolve(); });
        }).then(() => exited);
      } else { child.kill('SIGKILL'); closing = exited; }
      return closing;
    } };
}
