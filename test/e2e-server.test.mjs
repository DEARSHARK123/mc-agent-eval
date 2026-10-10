import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareE2eServer } from '../scripts/e2e-server.mjs';
import { removeDirRobust } from '../scripts/e2e-cleanup.mjs';

const expected = [
  'level-name=world',
  'level-type=minecraft\\:flat',
  'generate-structures=false',
  'difficulty=peaceful',
  'spawn-monsters=false',
  'spawn-animals=false',
  'spawn-npcs=false',
  'online-mode=false',
  'server-ip=127.0.0.1',
  'enforce-secure-profile=false',
  'view-distance=4',
  'simulation-distance=4',
];

function fixture(t, source) {
  const tmpRoot = fileURLToPath(new URL('../../.tmp/', import.meta.url));
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, 't12-server-'));
  t.after(() => {
    assert.equal(removeDirRobust(dir), true);
    assert.equal(existsSync(dir), false);
  });
  const testServer = join(dir, 'test-server');
  const runDir = join(dir, 'isolated-run');
  mkdirSync(join(testServer, 'world'), { recursive: true });
  writeFileSync(join(testServer, 'world', 'sentinel'), 'player world');
  writeFileSync(join(testServer, 'server.properties'), source, 'utf8');
  const paths = prepareE2eServer(testServer, runDir);
  assert.equal(paths.config, join(runDir, 'server.properties'));
  assert.equal(paths.plugins, join(runDir, 'plugins'));
  assert.deepEqual(readdirSync(paths.plugins), []);
  assert.equal(readFileSync(join(testServer, 'server.properties'), 'utf8'), source);
  assert.deepEqual(readdirSync(join(testServer, 'world')), ['sentinel']);
  assert.equal(readFileSync(join(testServer, 'world', 'sentinel'), 'utf8'), 'player world');
  return readFileSync(paths.config, 'utf8');
}

test('isolated server replaces every override, including duplicate keys', t => {
  const source = expected.map(line => `${line.split('=')[0]}=old`).join('\n')
    + '\ndifficulty=hard\n';
  assert.equal(fixture(t, source), expected.join('\n') + '\ndifficulty=peaceful\n');
});

test('isolated server preserves other keys, comments, blank lines and CRLF', t => {
  const unchanged = '# difficulty=hard\r\n! level-name=player-world\r\n\r\n'
    + 'server-port=25566\r\ngenerator-settings={}\r\nmotd=custom=message\r\n';
  const source = unchanged + expected.map(line => `${line.split('=')[0]} = old`).join('\r\n');
  assert.equal(fixture(t, source), unchanged + expected.join('\r\n'));
});

test('isolated server appends missing keys without joining the final base line', t => {
  assert.equal(fixture(t, 'server-port=25566\ndifficulty=hard'),
    'server-port=25566\ndifficulty=peaceful\n'
    + expected.filter(line => !line.startsWith('difficulty=')).join('\n') + '\n');
});

test('isolated server handles an empty properties base', t => {
  assert.equal(fixture(t, ''), expected.join('\n') + '\n');
});

test('e2e.mjs only touches test-server/ops.json for the commands scenario', () => {
  const source = readFileSync(new URL('../scripts/e2e.mjs', import.meta.url), 'utf8');
  assert.match(source, /scenario === 'commands'[\s\S]*ensureCompanionOp/u);
  assert.match(source, /restore ops\.json[\s\S]*opsBackup/u, 'cleanup must restore the original ops.json');
});
