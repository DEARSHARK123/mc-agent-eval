import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireRunLock, removeDirRobust, sweepStaleRunDirs } from '../scripts/e2e-cleanup.mjs';

const tmpRoot = fileURLToPath(new URL('../../.tmp/', import.meta.url));

function fixture(t) {
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, 't10-test-'));
  t.after(() => {
    assert.equal(removeDirRobust(dir), true);
    assert.equal(existsSync(dir), false);
  });
  return dir;
}

test('sweep removes only dead matching run directories', t => {
  const dir = fixture(t);
  for (const name of ['e2e-1-111', 'e2e-2-222', 'keepme', 'e2e-bad']) {
    mkdirSync(join(dir, name));
  }
  writeFileSync(join(dir, 'e2e-3-333'), 'matching file must remain');
  writeFileSync(join(dir, 'e2e-1-111', 'server.log'), 'stale log');
  const checked = [];
  assert.deepEqual(sweepStaleRunDirs(dir, { isAlive: pid => {
    checked.push(pid);
    return pid === 222;
  } }), ['e2e-1-111']);
  assert.deepEqual(checked.sort((a, b) => a - b), [111, 222]);
  assert.deepEqual(readdirSync(dir).sort(), ['e2e-2-222', 'e2e-3-333', 'e2e-bad', 'keepme']);
});

test('removeDirRobust deletes a populated directory', t => {
  const dir = fixture(t);
  const target = join(dir, 'nested');
  mkdirSync(target);
  writeFileSync(join(target, 'server.log'), 'log');
  assert.equal(removeDirRobust(target), true);
  assert.equal(existsSync(target), false);
});

test('removeDirRobust succeeds when the directory does not exist', t => {
  assert.equal(removeDirRobust(join(fixture(t), 'missing')), true);
});

test('removeDirRobust returns false instead of throwing on failure', () => {
  assert.equal(removeDirRobust(null), false);
});

test('run lock records this PID and release removes it idempotently', t => {
  const lock = join(fixture(t), 'e2e.lock');
  const release = acquireRunLock(lock);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  release();
  assert.equal(existsSync(lock), false);
  release();
});

test('run lock rejects another acquisition while its PID is alive', t => {
  const lock = join(fixture(t), 'e2e.lock');
  const release = acquireRunLock(lock);
  assert.throws(() => acquireRunLock(lock), error => {
    assert.equal(error.message, `另一轮 e2e 正在运行 (pid ${process.pid})，e2e 必须串行`);
    return true;
  });
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  release();
});

test('run lock takes over a dead PID lock', t => {
  const lock = join(fixture(t), 'e2e.lock');
  writeFileSync(lock, '999999');
  const checked = [];
  const release = acquireRunLock(lock, { isAlive: pid => { checked.push(pid); return false; } });
  assert.deepEqual(checked, [999999]);
  assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  release();
  assert.equal(existsSync(lock), false);
});

test('release preserves a lock replaced by another PID', t => {
  const lock = join(fixture(t), 'e2e.lock');
  const release = acquireRunLock(lock);
  const otherPid = String(process.pid + 1);
  writeFileSync(lock, otherPid);
  release();
  assert.equal(readFileSync(lock, 'utf8'), otherPid);
});

test('acquisition preserves an empty lock that may still be initializing', t => {
  const lock = join(fixture(t), 'e2e.lock');
  writeFileSync(lock, '');
  assert.throws(() => acquireRunLock(lock), /invalid PID/);
  assert.equal(readFileSync(lock, 'utf8'), '');
});

test('default liveness treats ESRCH as dead and EPERM as alive', t => {
  const dir = fixture(t);
  mkdirSync(join(dir, 'e2e-1-111'));
  mkdirSync(join(dir, 'e2e-2-222'));
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(signal, 0);
    throw Object.assign(new Error('process probe'), { code: pid === 111 ? 'ESRCH' : 'EPERM' });
  });
  assert.deepEqual(sweepStaleRunDirs(dir), ['e2e-1-111']);
  assert.equal(existsSync(join(dir, 'e2e-2-222')), true);
});
