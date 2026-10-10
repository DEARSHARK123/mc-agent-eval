import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const overrides = new Map([
  ['level-name', 'world'],
  ['level-type', 'minecraft\\:flat'],
  ['generate-structures', 'false'],
  ['difficulty', 'peaceful'],
  ['spawn-monsters', 'false'],
  ['spawn-animals', 'false'],
  ['spawn-npcs', 'false'],
  ['online-mode', 'false'],
  ['server-ip', '127.0.0.1'],
  ['enforce-secure-profile', 'false'],
  ['view-distance', '4'],
  ['simulation-distance', '4'],
]);

export function prepareE2eServer(testServer, runDir, extraOverrides = {}) {
  const source = readFileSync(join(testServer, 'server.properties'), 'utf8');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const effective = new Map([...overrides, ...Object.entries(extraOverrides)]);
  const missing = new Set(effective.keys());
  let properties = source.split(/\r?\n/).map(line => {
    const key = line.match(/^[ \t]*([^#! \t=]+)[ \t]*=/)?.[1];
    if (!effective.has(key)) return line;
    missing.delete(key);
    return `${key}=${effective.get(key)}`;
  }).join(newline);
  if (missing.size) {
    if (properties && !properties.endsWith('\n')) properties += newline;
    properties += [...missing].map(key => `${key}=${effective.get(key)}`).join(newline) + newline;
  }
  const config = join(runDir, 'server.properties');
  const plugins = join(runDir, 'plugins');
  mkdirSync(plugins, { recursive: true });
  writeFileSync(config, properties, 'utf8');
  return { config, plugins };
}
