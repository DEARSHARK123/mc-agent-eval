import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { removePathRobust } from '../fsutil.js';

export function pcmToWav(pcm, sampleRate, volume = 80) {
  if (!Buffer.isBuffer(pcm) || pcm.length % 2 || pcm.length > 0xffffffff - 36 ||
      !Number.isSafeInteger(sampleRate) || sampleRate < 1 || sampleRate > 0x7fffffff ||
      !Number.isFinite(volume) || volume < 0 || volume > 100) throw new Error('Invalid WAV input');
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length, 40);
  for (let i = 0; i < pcm.length; i += 2) {
    wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * volume / 100))), 44 + i);
  }
  return wav;
}

export function isSafeVoicePath(path, voiceDir) {
  return typeof path === 'string' && /^[\p{L}\p{N} _:.\\/-]+$/u.test(path) &&
    resolve(path) === path && dirname(path) === resolve(voiceDir) &&
    /^[0-9a-f-]{36}\.wav$/u.test(path.slice(dirname(path).length + 1));
}

export function createPlayer({ repoRoot, spawn = nodeSpawn, eventlog, volume = 80,
  platform = process.platform } = {}) {
  const voiceDir = resolve(repoRoot, '.tmp', 'voice');
  const log = (kind, payload, traceId) => eventlog?.append(kind, payload, traceId);
  const queue = [];
  const files = new Set();
  let active = null;
  let child = null;
  let closed = false;
  let disabled = false;
  let startupFailures = 0;
  let unsupportedLogged = false;
  let closePromise;
  try {
    const tmpDir = dirname(voiceDir);
    mkdirSync(tmpDir, { recursive: true });
    if (realpathSync(tmpDir) !== join(realpathSync(resolve(repoRoot)), '.tmp')) throw new Error('unsafe temporary directory');
    // Remove stale audio before creating a fresh, non-symlink playback directory.
    if (!removePathRobust(voiceDir)) throw new Error('cleanup failed');
    mkdirSync(voiceDir);
  } catch {
    disabled = true;
    log('voice.disabled', { reason: 'temporary_directory' });
  }

  function cleanup(path) {
    if (removePathRobust(path)) files.delete(path);
    else log('voice.error', { reason: 'cleanup' });
  }

  function finish(task, result) {
    if (!task || task.settled) return;
    task.settled = true;
    cleanup(task.path);
    task.resolve(result);
  }

  function failedStart() {
    if (++startupFailures >= 3) {
      disabled = true;
      log('voice.disabled', { reason: 'player_start' });
      for (const task of queue.splice(0)) finish(task, 'failed');
    }
  }

  function startChild() {
    let proc;
    try {
      proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', fileURLToPath(new URL('./player.ps1', import.meta.url))],
      { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      failedStart();
      return null;
    }
    let resolveExit;
    const record = { proc, stopping: false, ended: false, hasPlayed: false,
      exited: new Promise(resolve => { resolveExit = resolve; }) };
    child = record;
    const end = () => {
      if (record.ended) return;
      record.ended = true;
      if (child === record) {
        child = null;
        if (!record.stopping && !record.hasPlayed) failedStart();
        finish(active, record.stopping ? 'interrupted' : 'failed');
        active = null;
      }
      resolveExit();
      pump();
    };
    proc.once('exit', end);
    proc.once('error', end);
    proc.stdin.on('error', () => {
      if (!record.ended) { proc.kill(); end(); }
    });
    let output = '';
    const decoder = new StringDecoder('utf8');
    proc.stdout.on('data', data => {
      output += decoder.write(data);
      let newline;
      while ((newline = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, newline).replace(/\r$/u, '');
        output = output.slice(newline + 1);
        if (child !== record || record.stopping || !active) continue;
        if (line !== `done ${active.path}` && line !== `failed ${active.path}`) continue;
        const played = line.startsWith('done ');
        if (played) { startupFailures = 0; record.hasPlayed = true; }
        finish(active, played ? 'played' : 'failed');
        active = null;
        pump();
      }
      if (output.length > 8192) { proc.kill(); end(); }
    });
    // Drain stderr without persisting script output or paths.
    proc.stderr?.on('data', () => {});
    return record;
  }

  function pump() {
    if (closed || disabled || active || child?.stopping || !queue.length) return;
    active = queue.shift();
    const record = child ?? startChild();
    if (!record) {
      finish(active, 'failed');
      active = null;
      pump();
      return;
    }
    if (!isSafeVoicePath(active.path, voiceDir)) {
      finish(active, 'failed');
      active = null;
      pump();
      return;
    }
    try {
      record.proc.stdin.write(`${active.path}\n`);
    } catch {
      record.proc.kill();
    }
  }

  function interrupt() {
    for (const task of queue.splice(0)) finish(task, 'interrupted');
    if (!child) { finish(active, 'interrupted'); active = null; return Promise.resolve(); }
    const record = child;
    if (!record.stopping) {
      record.stopping = true;
      record.proc.kill();
    }
    return record.exited;
  }

  return {
    play(pcm, sampleRate, { traceId } = {}) {
      if (platform !== 'win32') {
        if (!unsupportedLogged) { unsupportedLogged = true; log('voice.unsupported', { platform }, traceId); }
        return Promise.resolve('failed');
      }
      if (closed || disabled) return Promise.resolve('failed');
      const path = join(voiceDir, `${randomUUID()}.wav`);
      if (!isSafeVoicePath(path, voiceDir)) return Promise.resolve('failed');
      try {
        if (realpathSync(voiceDir) !== voiceDir) throw new Error('unsafe temporary directory');
        files.add(path);
        writeFileSync(path, pcmToWav(pcm, sampleRate, volume), { flag: 'wx' });
      } catch {
        cleanup(path);
        return Promise.resolve('failed');
      }
      return new Promise(resolve => {
        queue.push({ path, traceId, resolve, settled: false });
        if (queue.length > 3) {
          const dropped = queue.shift();
          log('voice.dropped', { reason: 'queue_full' }, dropped.traceId);
          finish(dropped, 'interrupted');
        }
        pump();
      });
    },
    interrupt,
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = interrupt().then(() => {
        for (const path of files) cleanup(path);
        if (!disabled && !removePathRobust(voiceDir)) log('voice.error', { reason: 'cleanup' });
      });
      return closePromise;
    },
  };
}
