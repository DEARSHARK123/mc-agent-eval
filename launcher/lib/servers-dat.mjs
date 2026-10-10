import { createRequire } from 'node:module';
import { existsSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, validField } from './settings.mjs';

export const nbt = createRequire(import.meta.url)('prismarine-nbt');

export function serverListPath(mcDir, mcVersion) {
  if (!mcDir || !validField('mcVersion', mcVersion)) throw new Error('Minecraft 目录或版本无效');
  const versionDir = join(mcDir, 'versions', mcVersion);
  return join(existsSync(versionDir) ? versionDir : mcDir, 'servers.dat');
}

export function addLocalServer(file) {
  const existing = existsSync(file);
  const root = existing ? nbt.parseUncompressed(readFileSync(file)) : nbt.comp({ servers: nbt.list({ type: 'compound', value: [] }) });
  if (root.type !== 'compound') throw new Error('服务器列表格式无效');
  if (!root.value.servers) root.value.servers = nbt.list({ type: 'compound', value: [] });
  const servers = root.value.servers;
  if (servers.type !== 'list' || !['compound', 'end'].includes(servers.value.type)) throw new Error('服务器列表格式无效');
  if (servers.value.value.some(entry => ['127.0.0.1', '127.0.0.1:25565'].includes(entry.ip?.value))) return false;
  servers.value.type = 'compound';
  servers.value.value.unshift({ name: nbt.string('Companion 测试服'), ip: nbt.string('127.0.0.1') });
  const output = nbt.writeUncompressed(root);
  if (existing) copyFileSync(file, `${file}.launcher-bak`);
  atomicWrite(file, output);
  return true;
}
