import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTts } from '../src/voice/tts.js';
import { createFish } from '../src/voice/fish.js';
import { loadConfig } from '../src/config.js';
import { pcmToWav } from '../src/voice/player.js';
import { createGameTools } from '../src/brain/tools.js';
import { allowsProvenanceClaim } from '../src/brain/agent.js';
import { setup, closeFixtures } from './fixtures/agent-fixture.mjs';
afterEach(closeFixtures);
const key = 'secret-fish-test-key';
const owner = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const pcm = Buffer.from([255, 127, 0, 128]);
const fishResponse = (mime = 'audio/pcm;rate=44100;channels=1', bytes = pcm) => new Response(bytes, { headers: { 'Content-Type': mime } });
const geminiResponse = () => new Response('data: ' + JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: {
  mimeType: 'audio/l16;rate=24000;channels=1', data: pcm.toString('base64') } }] } }] }) + '\n\n');
function fixture(fish, options = {}) {
  const calls = [], events = [];
  const tts = createTts({ baseUrl: 'https://gemini.invalid', apiKey: 'gemini-secret', openrouterApiKey: key,
    fallbackModels: [], timeoutMs: 20, eventlog: { append(kind, payload) { events.push({ kind, payload }); } },
    fetch: async (url, init) => { calls.push({ url, init }); return url.includes('gemini.invalid') ? geminiResponse() : fish(init); }, ...options });
  return { tts, calls, events };
}
test('exact Fish request optional voice ignores style Unicode truncation empty', async () => {
  for (const voice of ['', 'voice_1']) {
    const f = fixture(() => fishResponse(), { fishVoice: voice });
    const input = '😀'.repeat(201);
    assert.equal((await f.tts.synthesize(' ' + input + ' ', { style: 'never read this' })).sampleRate, 44100);
    assert.equal(f.calls.length, 1);
    const { url, init } = f.calls[0];
    assert.equal(url, 'https://openrouter.ai/api/v1/audio/speech'); assert.equal(init.method, 'POST');
    assert.deepEqual(init.headers, { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` });
    assert.deepEqual(JSON.parse(init.body), { model: 'fish-audio/s2.1-pro-free:free', input: '😀'.repeat(200), response_format: 'pcm', ...(voice ? { voice } : {}) });
    assert.deepEqual(await f.tts.synthesize('  '), { skipped: 'empty' }); assert.equal(f.calls.length, 1);
  }
});
test('PCM validates header rate channels length and falls back', async () => {
  for (const [mime, bytes] of [['audio/pcm;channels=1', pcm], ['audio/pcm;rate=44100;channels=2', pcm],
    ['audio/pcm;rate=0;channels=1', pcm], ['audio/pcm;rate=1.5;channels=1', pcm],
    ['audio/pcm;rate=no;channels=1', pcm], ['audio/pcm;rate=44100;channels=1', Buffer.alloc(0)],
    ['audio/pcm;rate=44100;channels=1', Buffer.alloc(3)]]) {
    const f = fixture(() => fishResponse(mime, bytes));
    assert.equal((await f.tts.synthesize('你好')).sampleRate, 24000); assert.equal(f.calls.length, 2);
  }
});
test('Fish success short circuits and 429 cooldown expires at 60 seconds', async () => {
  let now = 0, status = 429;
  const f = fixture(() => status === 200 ? fishResponse() : new Response(null, { status }), { clock: { now: () => now } });
  assert.equal((await f.tts.synthesize('你好')).sampleRate, 24000);
  now = 59999; await f.tts.synthesize('你好'); assert.equal(f.calls.filter(c => !c.url.includes('gemini.invalid')).length, 1);
  now = 60000; status = 200; assert.equal((await f.tts.synthesize('你好')).sampleRate, 44100);
  assert.equal(f.calls.length, 4); assert.ok(f.events.some(e => e.kind === 'voice.rate_limited' && e.payload.provider === 'fish' && e.payload.cooldownMs === 60000));
});
test('transient status timeout network never cool down; permanent statuses disable', async () => {
  for (const failure of [500, 502, 503, 'timeout', 'network', 400, 401, 402, 403]) {
    const f = fixture(() => {
      if (failure === 'timeout') return new Promise(() => {});
      if (failure === 'network') throw new Error(key);
      return new Response(null, { status: failure });
    });
    for (let i = 0; i < 2; i++) assert.equal((await f.tts.synthesize('你好')).sampleRate, 24000);
    const permanent = [400, 401, 402, 403].includes(failure);
    assert.equal(f.calls.filter(c => !c.url.includes('gemini.invalid')).length, permanent ? 1 : 2);
    assert.equal(f.events.some(e => e.kind === 'voice.rate_limited'), false);
    if (permanent) assert.ok(f.events.some(e => e.kind === 'voice.disabled' && e.payload.provider === 'fish' && e.payload.status === failure));
  }
});
test('all failures return skipped all cooldowns rate_limited', async () => {
  const f = fixture(() => { throw new Error(key); }, { fetch: async () => { throw new Error(key); } });
  assert.deepEqual(await f.tts.synthesize('你好'), { skipped: 'failed' });
  const cooling = fixture(() => {}, { fetch: async () => new Response(null, { status: 429 }) });
  assert.deepEqual(await cooling.tts.synthesize('你好'), { skipped: 'rate_limited' });
  assert.deepEqual(await cooling.tts.synthesize('你好'), { skipped: 'rate_limited' });
});
test('abort cancels request and partial stream without Gemini', async () => {
  for (const partial of [false, true]) {
    let cancelled = false, requestSignal;
    const f = fixture(init => { requestSignal = init.signal;
      if (!partial) return new Promise(() => {});
      return { status: 200, headers: new Headers({ 'Content-Type': 'audio/pcm;rate=44100;channels=1' }),
        body: new ReadableStream({ start(c) { c.enqueue(pcm); }, cancel() { cancelled = true; } }) };
    }, { timeoutMs: 1000 });
    const controller = new AbortController(); const result = f.tts.synthesize('你好', { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve)); controller.abort();
    assert.deepEqual(await result, { skipped: 'interrupted' }); assert.equal(requestSignal.aborted, true);
    assert.equal(f.calls.length, 1); if (partial) assert.equal(cancelled, true);
  }
});
test('A5 stream concatenates transport chunks and measures first chunk latency', async () => {
  let time = 0, metrics;
  const fish = createFish({ apiKey: key, clock: { now: () => time },
    eventlog: { append(kind, payload) { if (kind === 'voice.synth') metrics = payload; } },
    fetch: async () => ({ status: 200, headers: new Headers({ 'Content-Type': 'audio/pcm; channels=1; rate=44100' }),
      body: { getReader() { let index = 0; return {
        async read() {
          index++; time = index === 1 ? 7 : 12;
          return index <= 2 ? { done: false, value: index === 1 ? pcm.subarray(0, 1) : pcm.subarray(1) } : { done: true };
        }, async cancel() {},
      }; } } }) });
  const result = await fish.synthesizeOnce({ text: '你好' });
  assert.deepEqual(result.pcm, pcm); assert.equal(result.sampleRate, 44100);
  assert.equal(metrics.firstChunkMs, 7); assert.equal(metrics.totalMs, 12);
});
test('timeout bounds stream read cancels partial audio and falls back without cooldown', async () => {
  let cancellations = 0;
  const f = fixture(() => ({ status: 200, headers: new Headers({ 'Content-Type': 'audio/pcm;rate=44100;channels=1' }),
    body: new ReadableStream({ start(c) { c.enqueue(pcm); }, cancel() { cancellations++; } }) }));
  for (let i = 0; i < 2; i++) assert.equal((await f.tts.synthesize('你好')).sampleRate, 24000);
  assert.equal(cancellations, 2); assert.equal(f.calls.length, 4);
  assert.equal(f.events.some(e => e.kind === 'voice.rate_limited'), false);
});
test('synth metrics provider fallback and events contain no secrets bodies URLs', async () => {
  const f = fixture(() => fishResponse()); await f.tts.synthesize('私密请求文字');
  const success = f.events.find(e => e.kind === 'voice.synth');
  assert.equal(success.payload.provider, 'fish'); assert.equal(success.payload.ok, true);
  assert.equal(success.payload.fallbackUsed, false); assert.equal(typeof success.payload.firstChunkMs, 'number');
  const fallback = fixture(() => { throw new Error(key + ' https://openrouter.ai/api/v1/audio/speech'); });
  await fallback.tts.synthesize('私密请求文字');
  assert.ok(fallback.events.some(e => e.kind === 'voice.synth' && e.payload.provider === 'gemini' && e.payload.fallbackUsed));
  assert.doesNotMatch(JSON.stringify([...f.events, ...fallback.events]), /secret-fish-test-key|gemini-secret|私密请求文字|https:|inlineData|response_format/u);
});
test('config Fish only order missing keys voice validation nonenumerable disabled', async () => {
  const env = { OWNER_UUID: owner, TTS_ENABLED: '1', OPENROUTER_API_KEY: key };
  const fish = loadConfig(env); assert.equal(fish.ttsEnabled, true); assert.deepEqual(fish.ttsProviders, ['fish']);
  assert.equal(fish.openrouterApiKey, key); assert.equal(Object.keys(fish).includes('openrouterApiKey'), false); assert.ok(!JSON.stringify(fish).includes(key));
  const both = loadConfig({ ...env, BRAIN_PROVIDER: 'gemini', BRAIN_API_KEY: 'g', TTS_PRIMARY: 'gemini' });
  assert.deepEqual(both.ttsProviders, ['gemini', 'fish']);
  const f = fixture(() => fishResponse(), { providers: both.ttsProviders });
  assert.equal((await f.tts.synthesize('你好')).sampleRate, 24000); assert.equal(f.calls.length, 1);
  for (const provider of ['openai', 'gemini']) {
    const c = loadConfig({ OWNER_UUID: owner, TTS_ENABLED: '1', BRAIN_PROVIDER: provider });
    assert.equal(c.ttsEnabled, false); assert.equal(c.ttsDisabledReason, provider === 'gemini' ? 'missing_key' : 'provider');
  }
  for (const invalid of ['秘密值!', 'x'.repeat(65), 'invalid voice']) {
    assert.throws(() => loadConfig({ ...env, TTS_FISH_VOICE: invalid }), e => !e.message.includes(invalid) && e.message.includes('TTS_FISH_VOICE'));
  }
  assert.equal(loadConfig({ ...env, TTS_ENABLED: '0' }).ttsEnabled, false);
});
test('credential and endpoint source isolation', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const scan = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`; if (entry.isDirectory()) scan(path);
    else { const source = readFileSync(path, 'utf8');
      assert.doesNotMatch(source, /HTTP-Referer|X-Title/u);
      if (!path.endsWith('/voice/fish.js')) assert.doesNotMatch(source, /openrouter\.ai/u);
      if (/\/(agent|manager|bridge|rpcClient)\.js$/u.test(path) || path.includes('/pi-extension/')) assert.doesNotMatch(source, /openrouterApiKey|OPENROUTER_API_KEY/u);
    }
  } };
  scan(root + '/src'); scan(root + '/pi-extension');
});
test('WAV 44100 and 24000 byte rate alignment scaling never overflows', () => {
  for (const rate of [44100, 24000]) for (const volume of [0, 50, 100]) {
    const wav = pcmToWav(pcm, rate, volume); assert.equal(wav.readUInt32LE(24), rate);
    assert.equal(wav.readUInt32LE(28), rate * 2); assert.equal(wav.readUInt16LE(32), 2);
    assert.equal(wav.readInt16LE(44), Math.round(32767 * volume / 100));
    assert.equal(wav.readInt16LE(46), Math.round(-32768 * volume / 100) || 0);
  }
});
const innate = { name: '捡东西', description: '收集掉落物', provenance: [{ route: 'innate', teacher_uuid: 'innate', taught_at: 1 }] };
const taught = { name: '挖草方块', description: '挖一个草方块', provenance: [{ route: 'taught', teacher_uuid: owner, taught_at: 2 }] };
const self = { name: 'make_stone_pickaxe', description: 'Obtain stone_pickaxe',
  provenance: [{ route: 'self', teacher_uuid: 'self', taught_at: 3, trace_id: 'tr' }] };
test('list_skills sanitizes built in taught teacher UUID and timestamps', async () => {
  const tools = createGameTools({ library: { list: () => [innate, taught] }, ownerUuid: owner });
  const result = await tools[0].execute('id', {}); const [a, b] = result.details;
  assert.equal(a.origin, 'built_in'); assert.ok(!JSON.stringify(a).includes('teacher')); assert.ok(!JSON.stringify(a).includes('taught_at'));
  assert.equal(b.origin, 'taught'); assert.equal(b.taught_at, 2); assert.equal(b.teacher_is_owner, true);
  assert.ok(!JSON.stringify(result).includes(owner));
});
test('list_skills reports self provenance as self_learned without teacher fields', async () => {
  const tools = createGameTools({ library: { list: () => [self, innate, taught] }, ownerUuid: owner });
  const [a] = (await tools[0].execute('id', {})).details;
  assert.equal(a.origin, 'self_learned');
  assert.equal(a.learned_at, 3);
  assert.ok(!JSON.stringify(a).includes('teacher'));
  assert.equal(allowsProvenanceClaim('你教过我make_stone_pickaxe', [self]), false);
  assert.equal(allowsProvenanceClaim('你教过我make_stone_pickaxe', [self, taught]), false);
  assert.equal(allowsProvenanceClaim('你教过我挖草方块', [self, taught]), true);
});
test('run_skill treats quantity params with the 1..64 goal bounds', async () => {
  const skill = { name: 'make_stone', params: { count: { type: 'quantity', default: 1 } },
    body: [{ obtain: { item: 'stone', count: '$count' } }], provenance: [self.provenance[0]] };
  let program;
  const run = () => createGameTools({ ownerUuid: owner,
    library: { has: name => name === skill.name, get: name => name === skill.name ? skill : null,
      list: () => [skill], recordOutcome() {} },
    arbiter: { submit: input => { program = input.program; return { done: Promise.resolve({ status: 'completed' }) }; },
      cancel: () => true } }).find(t => t.name === 'run_skill');
  for (const count of [0, 65, 'two', 1.5]) {
    program = undefined;
    assert.equal((await run().execute('id', { name: skill.name, args: { count } })).details.error, 'invalid_args', String(count));
    assert.equal(program, undefined);
  }
  assert.equal((await run().execute('id', { name: skill.name, args: { count: 40 } })).details.status, 'completed');
  assert.equal(program.body[0].obtain.item, 'stone');
  assert.equal(program.args.count, 40);
  assert.equal((await run().execute('id', { name: skill.name })).details.status, 'completed');
  assert.equal(program.args.count, 1);
});
test('guard covers all teaching phrases requires taught matching skill', async () => {
  for (const phrase of ['教过我', '教我的', '教会了我', '教给我', '是阿星教的']) {
    assert.equal(allowsProvenanceClaim(phrase + '捡东西', [innate]), false);
    assert.equal(allowsProvenanceClaim(phrase + '捡东西', [innate, taught]), false);
    assert.equal(allowsProvenanceClaim(phrase + '挖草方块', [innate, taught]), true);
  }
  for (const [skills, text, allowed] of [[[innate], '阿星教过我捡东西', false],
    [[innate, taught], '阿星教过我挖草方块', true], [[innate, taught], '阿星教过我捡东西', false]]) {
    const s = setup([{ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' }],
      { dependencies: { library: { list: () => skills } } });
    const result = await s.agent.run({ message: '聊聊', owner: '阿星' });
    assert.deepEqual(result, allowed ? { text } : { fallback: true });
    assert.equal(s.logs.some(e => e.kind === 'agent.fallback' && e.payload.reason === 'provenance_claim'), !allowed);
  }
});
