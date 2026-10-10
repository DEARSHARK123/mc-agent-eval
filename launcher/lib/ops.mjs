import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { offlineUuid } from '../../scripts/owner-uuid.mjs';
import { atomicWrite } from './settings.mjs';

// Merges Companion into ops.json at level 2 (never higher), preserving every other
// entry. Existing Companion entries above level 2 are downgraded. A corrupt file
// fails with a clear error and is never overwritten.
export function ensureCompanionOp(repo, { botName = 'Companion', write = atomicWrite } = {}) {
  const file = join(repo, 'test-server', 'ops.json');
  let entries = [];
  if (existsSync(file)) {
    let parsed;
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
    catch { throw new Error('ops.json 内容不是有效的 JSON，请手动修复后再启动'); }
    if (!Array.isArray(parsed)) {
      throw new Error('ops.json 内容不是有效的 JSON，请手动修复后再启动');
    }
    entries = parsed;
  }
  const uuid = offlineUuid(botName);
  const mine = entries.find(entry => entry && typeof entry === 'object'
    && (entry.uuid === uuid || entry.name === botName));
  if (mine) {
    mine.uuid = uuid;
    mine.name = botName;
    mine.level = 2;
    mine.bypassesPlayerLimit = mine.bypassesPlayerLimit === true;
  } else {
    entries.push({ uuid, name: botName, level: 2, bypassesPlayerLimit: false });
  }
  write(file, `${JSON.stringify(entries, null, 2)}\n`);
}
