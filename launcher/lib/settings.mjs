import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export const DEFAULT_PCL = '';
export const defaults = Object.freeze({
  playerName: '', pclExe: '', mcDir: '', mcVersion: '1.20.4', javaExe: 'java',
  serverMemoryMB: 1536, brainEnabled: true, applySkin: true,
  skinUrl: '',
  skinVariant: 'classic', addServerEntry: true, openPcl: true, allowCommands: false, lastStartedAt: null,
});

export function validPlayerName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(name);
}

export function playerFromLog(text) {
  const matches = [...text.matchAll(/Setting user:\s*([A-Za-z0-9_]+)\b/g)];
  return matches.at(-1)?.[1] ?? '';
}

function readOptional(file) {
  try { return readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

export function detectSettings(repo, current = {}, { pclCandidate = DEFAULT_PCL } = {}) {
  const pclExe = existsSync(pclCandidate) ? pclCandidate : '';
  const mcDir = current.mcDir || ((current.pclExe || pclExe) ? join(dirname(current.pclExe || pclExe), '.minecraft') : '');
  let playerName = '';
  if (mcDir) {
    for (const file of [join(mcDir, 'versions', '1.20.4', 'logs', 'latest.log'), join(mcDir, 'logs', 'latest.log')]) {
      playerName = playerFromLog(readOptional(file));
      if (playerName) break;
    }
  }
  const javaExe = /"([^"\r\n]*[\\/]java\.exe)"/i.exec(readOptional(join(repo, 'test-server', 'run.bat')))?.[1] ?? '';
  return { ...(pclExe ? { pclExe } : {}), ...(mcDir ? { mcDir } : {}),
    ...(playerName ? { playerName } : {}), ...(javaExe ? { javaExe } : {}) };
}

export function validField(key, value) {
  if (!Object.hasOwn(defaults, key)) return false;
  if (key === 'lastStartedAt') return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
  if (key === 'serverMemoryMB') return Number.isInteger(value) && value >= 1024 && value <= 4096;
  if (key === 'skinVariant') return ['classic', 'slim'].includes(value);
  if (key === 'mcVersion') return typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value) && !value.includes('..');
  return typeof value === typeof defaults[key];
}

export function atomicWrite(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, data);
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export class SettingsStore {
  constructor(file, repo, detect = detectSettings) {
    this.file = file;
    this.repo = repo;
    this.detect = detect;
    let saved = {};
    try { saved = JSON.parse(readOptional(file) || '{}'); } catch { /* Invalid JSON falls back to detection. */ }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
    const clean = Object.fromEntries(Object.entries(saved).filter(([key, value]) => validField(key, value)));
    const detected = detect(repo, clean);
    this.values = {};
    this.sources = {};
    for (const key of Object.keys(defaults)) {
      this.values[key] = Object.hasOwn(clean, key) ? clean[key] : (detected[key] ?? defaults[key]);
      this.sources[key] = Object.hasOwn(clean, key) ? 'saved' : Object.hasOwn(detected, key) ? 'detected' : 'default';
    }
  }
  snapshot() { return { values: { ...this.values }, sources: { ...this.sources } }; }
  save() { atomicWrite(this.file, JSON.stringify(this.values, null, 2) + '\n'); }
  update(patch, { internal = false } = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置必须是对象');
    for (const [key, value] of Object.entries(patch)) {
      if (!validField(key, value) || (!internal && key === 'lastStartedAt')) throw new Error(`无效设置：${key}`);
    }
    const before = { ...this.values };
    Object.assign(this.values, patch);
    try { this.save(); } catch (error) { this.values = before; throw error; }
    for (const key of Object.keys(patch)) this.sources[key] = 'saved';
    return this.snapshot();
  }
  redetect() {
    const detected = this.detect(this.repo, this.values);
    for (const key of ['playerName', 'pclExe', 'javaExe']) {
      this.values[key] = detected[key] ?? defaults[key];
      this.sources[key] = Object.hasOwn(detected, key) ? 'detected' : 'default';
    }
    this.save();
    return this.snapshot();
  }
}

export function validateExecutable(file, { allowJava = false, env = process.env } = {}) {
  let resolved = file;
  if (allowJava && file === 'java') {
    resolved = (env.PATH || env.Path || '').split(';').map(dir => join(dir, 'java.exe')).find(candidate => existsSync(candidate));
  }
  if (typeof resolved !== 'string' || !/\.exe$/i.test(resolved) || !existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error('启动路径必须是存在的 .exe 文件');
  }
  return resolve(resolved);
}
