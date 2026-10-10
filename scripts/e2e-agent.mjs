import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { companionRoot } from '../src/brain/manager.js';

export function agentEnvironment(env, log = console.log, hasAuth = existsSync) {
  const piHome = resolve(companionRoot, env.PI_HOME || 'pi-home');
  const missing = [...(!hasAuth(join(piHome, 'auth.json')) ? ['PI_HOME/auth.json'] : []), ...(!env.TYPESAFE_API_KEY ? ['TYPESAFE_API_KEY'] : [])];
  if (missing.length) {
    log(`E2E AGENT SKIP: ${missing.join(', ')} is not set`);
    return null;
  }
  return { PI_BIN: env.PI_BIN || 'pi', PI_HOME: piHome,
    TYPESAFE_API_KEY: env.TYPESAFE_API_KEY, LEARNING_AUTONOMY: '2' };
}

export async function runAgentScenario({ app, owner, countDirt, delay,
  now = Date.now, log = console.log }) {
  const events = () => app.eventlog.query({ limit: Number.MAX_SAFE_INTEGER }).sort((a, b) => a.id - b.id);
  const diagnostics = () => {
    for (const row of events().filter(row => ['agent.call', 'agent.fallback', 'speech'].includes(row.kind)
      || row.kind.startsWith('intent.'))) {
      // Only known diagnostic fields are emitted; credentials and prompts never reach output.
      const fields = ['ok', 'model', 'mode', 'error_code', 'reason', 'status', 'text', 'chosen', 'candidate_keys'];
      const payload = Object.fromEntries(fields.filter(key => row.payload?.[key] !== undefined)
        .map(key => [key, row.payload[key]]));
      log(`E2E AGENT EVENT ${JSON.stringify({ kind: row.kind, ts: row.ts, payload })}`);
    }
  };
  const wait = async (predicate, timeout) => {
    const deadline = now() + timeout;
    while (!predicate()) {
      if (now() >= deadline) throw new Error('Timed out waiting for agent scenario');
      await delay(100);
    }
  };
  try {
    if (app.agentAvailable) await wait(() => app.agentAvailable(), 30000);
    const beforeChat = events().at(-1)?.id ?? 0;
    owner.chat('今天过得怎么样');
    await wait(() => events().some(row => row.id > beforeChat && row.kind === 'agent.call' && row.payload.ok === true)
      && events().some(row => row.id > beforeChat && row.kind === 'speech'), 30_000);
    diagnostics();
    const speech = events().filter(row => row.id > beforeChat && row.kind === 'speech');
    assert.ok(speech.length);
    for (const row of speech) assert.equal(row.payload.text.includes('主人'), false);
    const beforeDirt = countDirt();
    const beforeIntent = events().at(-1)?.id ?? 0;
    const collectionStart = now();
    owner.chat('能帮我收集一点泥土吗，三块就够');
    await wait(() => events().some(row => row.id > beforeIntent && row.kind === 'intent.end') , 120_000);
    await wait(() => countDirt() >= beforeDirt + 3, 120_000 - (now() - collectionStart));
    diagnostics();
    const end = events().filter(row => row.id > beforeIntent && row.kind === 'intent.end').at(-1);
    assert.equal(end.payload.status, 'succeeded');
    assert.ok(countDirt() >= beforeDirt + 3);
    log('E2E AGENT PASS');
  } finally {
    diagnostics();
    for (const row of events().filter(row => row.kind === 'speech')) log(`E2E AGENT SPEECH ${row.payload.text}`);
  }
}
