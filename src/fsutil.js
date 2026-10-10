import { lstatSync, readdirSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

function removeRemainingEntry(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const name of readdirSync(path)) removeRemainingEntry(join(path, name));
    rmdirSync(path);
  } else {
    unlinkSync(path);
  }
}

export function removePathRobust(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    // Some Windows runtimes report success without removing the entry.
    removeRemainingEntry(path);
    return true;
  } catch {
    return false;
  }
}

export const removeDirRobust = removePathRobust;
