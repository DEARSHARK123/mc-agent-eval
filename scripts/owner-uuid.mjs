import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function offlineUuid(name) {
  if (typeof name !== 'string' || !name) throw new Error('Player name is required');
  const digest = createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  digest[6] = (digest[6] & 0x0f) | 0x30;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const name = process.argv[2];
  if (!name || process.argv.length !== 3) {
    console.error('Usage: node scripts/owner-uuid.mjs <player-name>');
    process.exitCode = 1;
  } else {
    console.log(offlineUuid(name));
  }
}
