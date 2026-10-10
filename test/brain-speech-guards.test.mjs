import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { agentEnvironment, runAgentScenario } from '../scripts/e2e-agent.mjs';
import { companionRoot } from '../src/brain/manager.js';
import { join } from 'node:path';

test('src has no direct typebox imports', () => {
  function scan(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) scan(path);
      else assert.doesNotMatch(readFileSync(path, 'utf8'), /from\s*['"]typebox['"]/u);
    }
  }
  scan(new URL('../src/', import.meta.url));
});

test('agent forwards isolated pi home TypeSafe key and autonomy 2', () => {
  assert.deepEqual(agentEnvironment({ TYPESAFE_API_KEY: 'fake-type' }, () => {}, () => true),
    { PI_BIN: 'pi', PI_HOME: join(companionRoot, 'pi-home'), TYPESAFE_API_KEY: 'fake-type', LEARNING_AUTONOMY: '2' });
});
test('missing either key skips normally without exposing keys', () => {
  for (const env of [{}, { OPENROUTER_API_KEY: 'secret' }, { TYPESAFE_API_KEY: 'secret' }]) {
    const lines = [];
    assert.equal(agentEnvironment(env, line => lines.push(line), () => false), null);
    assert.match(lines[0], /^E2E AGENT SKIP: /u);
    assert.ok(!lines[0].includes('secret'));
  }
});

test('e2e wires agent config and runner while preserving default and jev settings', () => {
  const source = readFileSync(new URL('../scripts/e2e.mjs', import.meta.url), 'utf8');
  assert.match(source, /scenario === 'agent' \? agentEnvironment\(process.env\)/u);
  assert.ok(source.indexOf("!agentEnvironment(process.env)") < source.indexOf('mkdirSync(tmpRoot'));
  assert.match(source, /await runAgentScenario\(\{ app: appA, owner, countDirt: \(\) => itemCount\(appA.bot, 'dirt'\), delay \}\)/u);
  assert.ok(source.includes("LEARNING_AUTONOMY: ['jev', 'goals', 'proactive', 'v1'].includes(scenario) ? '2' : '0'"));
  assert.ok(source.includes("TYPESAFE_API_KEY: scenario === 'jev' ? process.env.TYPESAFE_API_KEY : ''"));
});

function fixture({ badSpeech = false, callOk = true, status = 'succeeded', gain = 3, stale = false,
  noSpeech = false, noIntent = false } = {}) {
  let clock = 0, dirt = 7, step = 0;
  const rows = stale ? [{ id: 1, kind: 'agent.call', payload: { ok: true } },
    { id: 2, kind: 'speech', payload: { text: 'old' } }] : [];
  const lines = [], messages = [];
  const add = (kind, payload) => rows.push({ id: rows.length + 1, kind, payload, ts: clock });
  return { lines, messages, run: () => runAgentScenario({
    app: { eventlog: { query: () => [...rows] } },
    owner: { chat(text) {
      messages.push(text); step++;
      if (step === 1 && !stale) {
        add('agent.call', { ok: callOk, prompt: 'PRIVATE', api_key: 'SECRET' });
        add('agent.fallback', { reason: 'test' });
        if (!noSpeech) add('speech', { text: badSpeech ? '主人' : '今天很好' });
      }
      if (step === 2 && !noIntent) {
        add('intent.start', {}); add('intent.step', {}); add('intent.end', { status }); dirt += gain;
      }
    } }, countDirt: () => dirt, now: () => clock,
    delay: async ms => { clock += ms; }, log: line => lines.push(line),
  }), elapsed: () => clock };
}
test('chat ok and speech then collection succeeds with three additional dirt; safe diagnostics and all speech', async () => {
  const f = fixture(); await f.run();
  assert.deepEqual(f.messages, ['今天过得怎么样', '能帮我收集一点泥土吗，三块就够']);
  for (const kind of ['agent.call', 'agent.fallback', 'intent.start', 'intent.step', 'intent.end', 'speech'])
    assert.ok(f.lines.some(line => line.startsWith('E2E AGENT EVENT ') && JSON.parse(line.slice(16)).kind === kind));
  assert.ok(f.lines.includes('E2E AGENT SPEECH 今天很好'));
  assert.ok(f.lines.includes('E2E AGENT PASS'));
  assert.ok(f.lines.every(line => !/PRIVATE|SECRET|prompt|api_key/u.test(line)));
});
test('rejects speech containing 主人 after printing diagnostics', async () => {
  const f = fixture({ badSpeech: true }); await assert.rejects(f.run());
  assert.ok(f.lines[0].startsWith('E2E AGENT EVENT '));
});
test('requires fresh successful agent call within 30 seconds', async () => {
  for (const options of [{ callOk: false }, { stale: true }, { noSpeech: true }]) {
    const f = fixture(options); await assert.rejects(f.run(), /Timed out/u);
    assert.equal(f.elapsed(), 30_000);
  }
});
test('rejects failed intent and insufficient dirt within 120 seconds', async () => {
  const failed = fixture({ status: 'failed' }); await assert.rejects(failed.run());
  const short = fixture({ gain: 2 }); await assert.rejects(short.run(), /Timed out/u);
  assert.equal(short.elapsed(), 120_000);
  const absent = fixture({ noIntent: true }); await assert.rejects(absent.run(), /Timed out/u);
  assert.equal(absent.elapsed(), 120_000);
});
