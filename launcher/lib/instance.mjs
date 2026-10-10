import { existsSync, readFileSync, unlinkSync, openSync, closeSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { isAlive } from './processes.mjs';

export function canConnect(port) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = result => { socket.destroy(); resolve(result); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

export async function existingInstance(file, { alive = isAlive, connect = canConnect } = {}) {
  if (!existsSync(file)) return null;
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  if (!Number.isInteger(data.port) || data.port < 1 || data.port > 65535 ||
      typeof data.token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(data.token) || !alive(data.pid)) return null;
  return await connect(data.port) ? data : null;
}

export function instanceUrl(data) { return `http://127.0.0.1:${data.port}/#t=${data.token}`; }

export function removeStaleInstance(file, alive = isAlive) {
  if (!existsSync(file)) return;
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { /* Recover a damaged record. */ }
  if (data && alive(data.pid)) throw new Error('另一个启动器仍在运行，请稍后重试');
  unlinkSync(file);
}

export function claimInstance(file, data) {
  const fd = openSync(file, 'wx');
  try { writeFileSync(fd, JSON.stringify(data), 'utf8'); } finally { closeSync(fd); }
}

export function removeInstance(file, pid = process.pid) {
  try {
    if (JSON.parse(readFileSync(file, 'utf8')).pid === pid) unlinkSync(file);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
