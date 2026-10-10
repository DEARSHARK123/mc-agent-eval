import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelationship } from '../src/relationship.js';

const ownerUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function fixture(brain = { enabled: true, nickname: async () => '阿测' }, rows = []) {
  const eventlog = {
    query: ({ kind }) => rows.filter(row => row.kind === kind),
    append(kind, payload) { rows.push({ kind, payload }); },
  };
  const create = () => createRelationship({ eventlog, brain, ownerUuid });
  return { relationship: create(), create, rows };
}

test('relationship: uses the current game name until generation, persists and reuses after restart', async () => {
  let calls = 0;
  const f = fixture({ enabled: true, nickname: async ({ playerName, persona, memory }) => {
    calls++;
    assert.equal(playerName, 'TestOwner');
    assert.ok(persona.includes(playerName));
    assert.deepEqual(memory, {});
    return '阿测';
  } });
  assert.equal(f.relationship.ownerName(), null);
  assert.equal(f.relationship.nickname(), null);
  f.relationship.setOwnerName('TestOwner');
  assert.equal(f.relationship.nickname(), 'TestOwner');
  assert.equal(await f.relationship.ensureNickname(), '阿测');
  assert.deepEqual(f.rows, [{ kind: 'relationship.nickname', payload: {
    ownerUuid, playerName: 'TestOwner', nickname: '阿测', source: 'brain',
  } }]);
  const restarted = f.create();
  restarted.setOwnerName('TestOwner');
  assert.equal(restarted.nickname(), '阿测');
  assert.equal(await restarted.ensureNickname(), '阿测');
  assert.equal(calls, 1);
  restarted.setOwnerName(null);
  assert.equal(restarted.ownerName(), null);
  assert.equal(restarted.nickname(), null);
});

test('relationship: a renamed player needs a new nickname', async () => {
  const names = [];
  const f = fixture({ enabled: true, nickname: async ({ playerName }) => {
    names.push(playerName);
    return `昵称${names.length}`;
  } });
  f.relationship.setOwnerName('TestOwner');
  await f.relationship.ensureNickname();
  f.relationship.setOwnerName('RenamedOwner');
  assert.equal(f.relationship.nickname(), 'RenamedOwner');
  assert.equal(await f.relationship.ensureNickname(), '昵称2');
  assert.deepEqual(names, ['TestOwner', 'RenamedOwner']);
  assert.equal(f.rows.length, 2);
});

test('relationship: concurrent generation shares the exact same promise and does not block the name', async () => {
  let resolve;
  let calls = 0;
  const f = fixture({ enabled: true, nickname: () => {
    calls++;
    return new Promise(done => { resolve = done; });
  } });
  f.relationship.setOwnerName('TestOwner');
  const first = f.relationship.ensureNickname();
  assert.equal(f.relationship.ensureNickname(), first);
  assert.equal(f.relationship.nickname(), 'TestOwner');
  await Promise.resolve();
  assert.equal(calls, 1);
  resolve('阿测');
  assert.equal(await first, '阿测');
  assert.equal(f.rows.length, 1);
});

test('relationship: a rename during generation is handled serially with correct event names', async () => {
  let resolve;
  let active = 0;
  const names = [];
  const f = fixture({ enabled: true, nickname: async ({ playerName }) => {
    assert.equal(active++, 0);
    names.push(playerName);
    const result = names.length === 1 ? await new Promise(done => { resolve = done; }) : '新昵称';
    active--;
    return result;
  } });
  f.relationship.setOwnerName('TestOwner');
  const pending = f.relationship.ensureNickname();
  await Promise.resolve();
  f.relationship.setOwnerName('RenamedOwner');
  assert.equal(f.relationship.ensureNickname(), pending);
  assert.equal(f.relationship.nickname(), 'RenamedOwner');
  resolve('旧昵称');
  assert.equal(await pending, '新昵称');
  assert.deepEqual(f.rows.map(row => row.payload.playerName), ['TestOwner', 'RenamedOwner']);
});

test('relationship: null and thrown failures are not retried for that name in this process', async () => {
  for (const throws of [false, true]) {
    let calls = 0;
    const f = fixture({ enabled: true, nickname: async () => {
      calls++;
      if (throws) throw new Error('unavailable');
      return null;
    } });
    f.relationship.setOwnerName('TestOwner');
    if (throws) await assert.rejects(f.relationship.ensureNickname(), /unavailable/u);
    else assert.equal(await f.relationship.ensureNickname(), 'TestOwner');
    await f.relationship.ensureNickname();
    f.relationship.setOwnerName(null);
    f.relationship.setOwnerName('TestOwner');
    await f.relationship.ensureNickname();
    assert.equal(calls, 1);
    assert.equal(f.rows.length, 0);
    f.relationship.setOwnerName('RenamedOwner');
    if (throws) await assert.rejects(f.relationship.ensureNickname());
    else await f.relationship.ensureNickname();
    assert.equal(calls, 2);
  }
});

test('relationship: disabled brain or unknown name never calls the brain', async () => {
  for (const enabled of [false, true]) {
    const f = fixture({ enabled, nickname: () => assert.fail('must not generate') });
    assert.equal(await f.relationship.ensureNickname(), null);
    if (!enabled) {
      f.relationship.setOwnerName('TestOwner');
      assert.equal(await f.relationship.ensureNickname(), 'TestOwner');
    }
    assert.equal(f.rows.length, 0);
  }
});

test('relationship: restores only the latest event for this UUID, case insensitive', async () => {
  const rows = ['旧昵称', '新昵称'].map(nickname => ({ kind: 'relationship.nickname', payload: {
    ownerUuid: ownerUuid.toUpperCase(), playerName: 'TestOwner', nickname, source: 'brain',
  } }));
  rows.push({ kind: 'relationship.nickname', payload: {
    ownerUuid: 'other-uuid', playerName: 'TestOwner', nickname: '他人昵称', source: 'brain',
  } });
  const f = fixture({ enabled: true, nickname: () => assert.fail('already stored') }, rows);
  f.relationship.setOwnerName('TestOwner');
  assert.equal(await f.relationship.ensureNickname(), '新昵称');
});
