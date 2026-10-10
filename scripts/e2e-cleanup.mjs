import { closeSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeDirRobust } from '../src/fsutil.js';
export { removeDirRobust } from '../src/fsutil.js';

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

export function sweepStaleRunDirs(tmpRoot, { isAlive = isProcessAlive } = {}) {
  const deleted = [];
  for (const entry of readdirSync(tmpRoot, { withFileTypes: true })) {
    const match = /^e2e-\d+-(\d+)$/.exec(entry.name);
    if (!entry.isDirectory() || !match || isAlive(Number(match[1]))) continue;
    const dir = join(tmpRoot, entry.name);
    if (removeDirRobust(dir)) deleted.push(entry.name);
    else console.warn(`E2E cleanup warning: could not remove ${dir}`);
  }
  return deleted;
}

export function acquireRunLock(lockPath, { isAlive = isProcessAlive } = {}) {
  const ownPid = String(process.pid);
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = openSync(lockPath, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(lockPath, 'utf8').trim());
      // An empty lock may belong to a process still writing its PID.
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error(`E2E lock has an invalid PID: ${lockPath}; e2e must run serially`);
      }
      if (isAlive(pid)) {
        throw new Error(`另一轮 e2e 正在运行 (pid ${pid})，e2e 必须串行`);
      }
      if (attempt === 1) throw new Error(`E2E lock changed during acquisition: ${lockPath}`);
      unlinkSync(lockPath);
      continue;
    }
    try {
      writeFileSync(fd, ownPid, 'utf8');
    } finally {
      closeSync(fd);
    }
    return function release() {
      try {
        if (readFileSync(lockPath, 'utf8').trim() === ownPid) unlinkSync(lockPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    };
  }
}
