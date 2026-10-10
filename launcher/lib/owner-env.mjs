import { readFileSync } from 'node:fs';
import { atomicWrite } from './settings.mjs';

export function replaceOwnerUuid(text, uuid) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const line = `OWNER_UUID=${uuid}`;
  if (/^OWNER_UUID=.*$/m.test(text)) return text.replace(/^OWNER_UUID=[^\r\n]*/gm, original => line + (/[ \t]+#.*$/.exec(original)?.[0] ?? ''));
  return text + (text && !text.endsWith('\n') ? newline : '') + line + newline;
}

export function writeOwnerUuid(file, uuid) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw new Error('无法更新 OWNER_UUID'); }
  try { atomicWrite(file, replaceOwnerUuid(text, uuid)); } catch { throw new Error('无法更新 OWNER_UUID'); }
}
