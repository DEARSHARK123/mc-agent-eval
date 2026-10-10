import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { removePathRobust } from '../src/fsutil.js';
import { createTts } from '../src/voice/tts.js';
import { createPlayer, isSafeVoicePath, pcmToWav } from '../src/voice/player.js';
import { createVoice } from '../src/voice/pipeline.js';
import { emotions, voiceStyle } from '../src/voice/style.js';
import { createMouth } from '../src/mouth.js';
import { createOwnerChatHandler } from '../src/teaching/handler.js';
import { startCompanion } from './fixtures/offline-main.mjs';
import { mcData } from '../src/teaching/lexicon.js';

const tmpRoot = fileURLToPath(new URL('../.tmp/', import.meta.url));
const OWNER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const secret = 'fake-tts-secret';
const pcm = Buffer.from([0xff, 0x7f, 0x00, 0x80, 0xe8, 0x03, 0x18, 0xfc]);
const tick = () => new Promise(resolve => setImmediate(resolve));
function logFixture() {
  const events = [];
  return { events, append(kind, payload, traceId) { events.push({ kind, payload, traceId }); } };
}
function directory(t) {
  mkdirSync(tmpRoot, { recursive: true });
  const dir = mkdtempSync(join(tmpRoot, 't17-test-'));
  t.after(() => {
    assert.equal(removePathRobust(dir), true);
    assert.equal(existsSync(dir), false);
  });
  return dir;
}
function audioResponse(chunks = [pcm], onChunk = () => {}) {
  const events = chunks.map(chunk => ({ candidates: [{ content: { parts: [
    { text: 'ignored' }, { inlineData: { mimeType: 'audio/l16; rate=24000; channels=1', data: chunk.toString('base64') } },
  ] } }] }));
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + 'data: [DONE]\n\n');
  let offset = 0;
  return { ok: true, status: 200, body: new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    onChunk(offset);
    // Deliberately split SSE lines, JSON, and base64 across transport chunks.
    const end = Math.min(offset + 17, bytes.length);
    controller.enqueue(bytes.slice(offset, end));
    offset = end;
  } }) };
}
function ttsFixture(fetch, overrides = {}) {
  const log = logFixture();
  const requests = [];
  const tts = createTts({ baseUrl: 'https://example.invalid/v1beta/', apiKey: secret,
    model: 'primary', fallbackModels: ['backup'], eventlog: log,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return fetch(url, options);
    }, ...overrides });
  return { tts, log, requests };
}
function spawnFixture() {
  const children = [];
  const calls = [];
  const spawn = (...args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.paths = [];
    child.kills = 0;
    child.stdin.write = line => { child.paths.push(line.trimEnd()); return true; };
    child.kill = () => { child.kills++; child.emit('exit', null, 'SIGTERM'); return true; };
    child.done = (path = child.paths.at(-1), status = 'done') => {
      child.stdout.emit('data', Buffer.from(`${status} ${path}\r`));
      child.stdout.emit('data', Buffer.from('\n'));
    };
    children.push(child);
    return child;
  };
  return { spawn, children, calls };
}
function playerFixture(t, overrides = {}) {
  const repoRoot = directory(t);
  const fake = spawnFixture();
  const log = logFixture();
  const player = createPlayer({ repoRoot, spawn: fake.spawn, eventlog: log, platform: 'win32', ...overrides });
  t.after(() => player.close());
  return { player, repoRoot, voiceDir: join(repoRoot, '.tmp', 'voice'), log, ...fake };
}

test('A1/A3 SSE joins every audio part, logs timing, and sends only the required audio request', async () => {
  let time = 100;
  const f = ttsFixture(async () => audioResponse([pcm.subarray(0, 3), pcm.subarray(3)], () => { time += 2; }),
    { voice: 'Kore', clock: { now: () => time } });
  const result = await f.tts.synthesize('测试台词。', { style: voiceStyle('learned'), traceId: 'voice-trace' });
  assert.deepEqual(result, { pcm, sampleRate: 24000, model: 'primary' });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, 'https://example.invalid/v1beta/models/primary:streamGenerateContent?alt=sse');
  assert.equal(f.requests[0].options.headers['x-goog-api-key'], secret);
  assert.equal(f.requests[0].options.method, 'POST');
  const body = JSON.parse(f.requests[0].options.body);
  assert.deepEqual(body.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  assert.equal(Object.hasOwn(body, 'systemInstruction'), false);
  assert.match(body.contents[0].parts[0].text, /^### DIRECTOR'S NOTES\n/u);
  assert.ok(body.contents[0].parts[0].text.endsWith('测试台词。'));
  assert.equal(body.contents[0].parts[0].text,
    `### DIRECTOR'S NOTES\nStyle: ${voiceStyle('learned')}\n\n### TRANSCRIPT\n测试台词。`);
  const event = f.log.events.find(event => event.kind === 'voice.synth');
  assert.equal(event.traceId, 'voice-trace');
  assert.equal(event.payload.model, 'primary');
  assert.equal(event.payload.ok, true);
  assert.equal(event.payload.fallbackUsed, false);
  assert.equal(event.payload.chars, 5);
  assert.ok(event.payload.firstChunkMs > 0);
  assert.ok(event.payload.totalMs >= event.payload.firstChunkMs);
  assert.equal(event.payload.totalMs, time - 100);
  assert.equal(JSON.stringify(f.log.events).includes(secret), false);
});

test('TTS truncates to 200 code points, empty input skips fetch, and absent style sends plain text', async () => {
  const f = ttsFixture(async () => audioResponse());
  assert.deepEqual(await f.tts.synthesize('  '), { skipped: 'empty' });
  assert.equal(f.requests.length, 0);
  for (const style of [undefined, '']) {
    await f.tts.synthesize('plain transcript', { style });
    assert.equal(JSON.parse(f.requests.at(-1).options.body).contents[0].parts[0].text, 'plain transcript');
  }
  await f.tts.synthesize('\u{20000}'.repeat(201));
  assert.equal(JSON.parse(f.requests.at(-1).options.body).contents[0].parts[0].text, '\u{20000}'.repeat(200));
  assert.equal(f.log.events.at(-1).payload.chars, 200);
});

for (const status of [500, 503]) {
  test(`HTTP ${status} switches model without retrying primary`, async () => {
    const f = ttsFixture(async url => url.includes('/primary:') ? { ok: false, status } : audioResponse(),
      { fallbackModels: ['primary', 'backup', 'backup'] });
    assert.equal((await f.tts.synthesize('hello')).model, 'backup');
    assert.equal(f.requests.filter(request => request.url.includes('/primary:')).length, 1);
    assert.equal(f.requests.length, 2);
    assert.equal(f.log.events.at(-1).payload.fallbackUsed, true);
  });
}

test('A2 primary 429 falls back immediately, skips cooled model, and restores primary at expiry', async () => {
  let time = 0;
  let limited = true;
  const f = ttsFixture(async url => limited && url.includes('/primary:')
    ? { ok: false, status: 429 } : audioResponse(), { clock: { now: () => time } });
  assert.equal((await f.tts.synthesize('one', { traceId: 'limited' })).model, 'backup');
  assert.deepEqual(f.requests.map(request => request.url.split('/models/')[1].split(':')[0]), ['primary', 'backup']);
  assert.equal(f.log.events.at(-1).payload.fallbackUsed, true);
  assert.equal(f.log.events.at(-1).payload.ok, true);
  const events = f.log.events.filter(event => event.kind === 'voice.rate_limited');
  assert.deepEqual(events, [{ kind: 'voice.rate_limited', payload: { provider: 'gemini', model: 'primary', cooldownMs: 60000 }, traceId: 'limited' }]);
  time = 59999;
  assert.equal((await f.tts.synthesize('two')).model, 'backup');
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests[2].url.includes('/backup:'));
  time = 60000;
  limited = false;
  assert.equal((await f.tts.synthesize('three')).model, 'primary');
  assert.equal(f.requests.length, 4);
  assert.ok(f.requests[3].url.includes('/primary:'));
  assert.equal(f.log.events.at(-1).payload.fallbackUsed, false);
});

test('A2 all models 429 skip fetch during cooldown and resume primary at expiry', async () => {
  let time = 0;
  let limited = true;
  const f = ttsFixture(async () => limited ? { ok: false, status: 429 } : audioResponse(),
    { clock: { now: () => time } });
  assert.deepEqual(await f.tts.synthesize('one'), { skipped: 'rate_limited' });
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.log.events.filter(event => event.kind === 'voice.rate_limited').map(event => event.payload.model),
    ['primary', 'backup']);
  time = 59999;
  assert.deepEqual(await f.tts.synthesize('two'), { skipped: 'rate_limited' });
  assert.equal(f.requests.length, 2);
  time = 60000;
  limited = false;
  assert.equal((await f.tts.synthesize('three')).model, 'primary');
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests[2].url.includes('/primary:'));
  assert.equal(f.log.events.filter(event => event.kind === 'voice.rate_limited').length, 2);
});

test('A2 rate-limited primary plus failing backup returns failed and keeps backup available', async () => {
  const f = ttsFixture(async url => ({ ok: false, status: url.includes('/primary:') ? 429 : 503 }),
    { clock: { now: () => 0 } });
  assert.deepEqual(await f.tts.synthesize('one'), { skipped: 'failed' });
  assert.deepEqual(await f.tts.synthesize('two'), { skipped: 'failed' });
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests[2].url.includes('/backup:'));
  assert.equal(f.log.events.filter(event => event.kind === 'voice.rate_limited').length, 1);
});

for (const status of [400, 401, 403]) {
  test(`HTTP ${status} disables synthesis for this instance and logs no credentials`, async () => {
    const f = ttsFixture(async () => ({ ok: false, status }));
    assert.deepEqual(await f.tts.synthesize('one'), { skipped: 'disabled' });
    assert.deepEqual(await f.tts.synthesize('two'), { skipped: 'disabled' });
    assert.equal(f.requests.length, 1);
    assert.ok(f.log.events.some(event => event.kind === 'voice.error' && event.payload.status === status));
    assert.equal(f.log.events.filter(event => event.kind === 'voice.disabled').length, 1);
    assert.equal(JSON.stringify(f.log.events).includes(secret), false);
  });
}

test('all models failing returns skipped without throwing or logging request/error secrets', async () => {
  const f = ttsFixture(async () => { throw new Error(secret); });
  assert.deepEqual(await f.tts.synthesize('hello'), { skipped: 'failed' });
  assert.equal(f.requests.length, 2);
  assert.equal(f.log.events.at(-1).payload.ok, false);
  assert.equal(JSON.stringify(f.log.events).includes(secret), false);
});

test('timeout switches model even when fetch ignores abort', async () => {
  let fireTimeout;
  const f = ttsFixture(async url => url.includes('/primary:') ? new Promise(() => {}) : audioResponse(),
    { clock: { setTimeout(fn) { fireTimeout = fn; return 1; }, clearTimeout() {} } });
  const result = f.tts.synthesize('hello');
  fireTimeout();
  assert.equal((await result).model, 'backup');
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].options.signal.aborted, true);
});

test('caller abort cancels stream and does not fall back or return partial audio', async () => {
  let cancelled = false;
  const controller = new AbortController();
  const f = ttsFixture(async () => ({ ok: true, body: new ReadableStream({ cancel() { cancelled = true; } }) }));
  const result = f.tts.synthesize('hello', { signal: controller.signal });
  await tick();
  controller.abort();
  assert.deepEqual(await result, { skipped: 'interrupted' });
  assert.equal(f.requests.length, 1);
  await tick();
  assert.equal(cancelled, true);
});

test('missing or unsupported audio fails without playing a partial/invalid result', async () => {
  for (const body of ['data: {}\n\n', 'data: not-json\n\n']) {
    const f = ttsFixture(async () => ({ ok: true, body: new ReadableStream({ start(c) {
      c.enqueue(new TextEncoder().encode(body)); c.close();
    } }) }));
    assert.deepEqual(await f.tts.synthesize('hello'), { skipped: 'failed' });
  }
});

test('WAV header is mono 24kHz 16-bit LE; volume scales without overflow or input mutation', () => {
  const original = Buffer.from(pcm);
  const wav = pcmToWav(pcm, 24000, 50);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(wav.readUInt32LE(16), 16);
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt32LE(28), 48000);
  assert.equal(wav.readUInt16LE(32), 2);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual([0, 2, 4, 6].map(i => wav.readInt16LE(44 + i)), [16384, -16384, 500, -500]);
  assert.deepEqual(pcmToWav(pcm, 24000, 100).subarray(44), pcm);
  assert.ok(pcmToWav(pcm, 24000, 0).subarray(44).every(value => value === 0));
  assert.deepEqual(pcm, original);
  assert.throws(() => pcmToWav(pcm, 24000, 101));
  assert.throws(() => pcmToWav(Buffer.from([1]), 24000));
});

test('player writes only under .tmp/voice, scales volume, deletes after done and reuses process', async t => {
  const f = playerFixture(t, { volume: 50 });
  const first = f.player.play(pcm, 24000, { traceId: 'first' });
  assert.equal(f.calls[0][0], 'powershell.exe');
  assert.deepEqual(f.calls[0][1].slice(0, 6), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('../src/voice/player.ps1', import.meta.url))]);
  assert.equal(f.calls[0][2].shell, false);
  assert.equal(f.calls[0][2].windowsHide, true);
  const child = f.children[0];
  const path = child.paths[0];
  assert.equal(isSafeVoicePath(path, f.voiceDir), true);
  assert.equal(readFileSync(path).readInt16LE(44), 16384);
  child.done();
  assert.equal(await first, 'played');
  assert.equal(existsSync(path), false);
  const second = f.player.play(pcm, 24000);
  assert.equal(f.calls.length, 1);
  child.done();
  assert.equal(await second, 'played');
  assert.deepEqual(readdirSync(f.voiceDir), []);
  await f.player.close();
  assert.equal(child.kills, 1);
  assert.equal(existsSync(f.voiceDir), false);
  assert.equal(await f.player.play(pcm, 24000), 'failed');
});

test('interrupt resolves current and queued as interrupted, deletes files, and restarts next play', async t => {
  const f = playerFixture(t);
  const tasks = [f.player.play(pcm, 24000), f.player.play(pcm, 24000), f.player.play(pcm, 24000)];
  assert.equal(readdirSync(f.voiceDir).length, 3);
  await f.player.interrupt();
  assert.deepEqual(await Promise.all(tasks), ['interrupted', 'interrupted', 'interrupted']);
  assert.equal(f.children[0].paths.length, 1);
  assert.equal(f.children[0].kills, 1);
  assert.deepEqual(readdirSync(f.voiceDir), []);
  const next = f.player.play(pcm, 24000);
  assert.equal(f.children.length, 2);
  f.children[1].done();
  assert.equal(await next, 'played');
});

test('UTF-8 Chinese paths split across stdout bytes still complete and remove audio', { skip: 'needs a checkout path containing CJK characters' }, async t => {
  const f = playerFixture(t);
  const task = f.player.play(pcm, 24000);
  const child = f.children[0];
  const path = child.paths[0];
  assert.match(path, /[\u3400-\u9fff]/u);
  for (const byte of Buffer.from(`done ${path}\n`)) child.stdout.emit('data', Buffer.from([byte]));
  assert.equal(await task, 'played');
  assert.equal(existsSync(path), false);
});

test('interruption waits for child exit before removing its open WAV and resumes fresh queued speech', async t => {
  const f = playerFixture(t);
  const first = f.player.play(pcm, 24000);
  const child = f.children[0];
  const path = child.paths[0];
  child.kill = () => { child.kills++; return true; };
  const interrupted = f.player.interrupt();
  assert.equal(existsSync(path), true);
  const next = f.player.play(pcm, 24000);
  assert.equal(f.children.length, 1);
  child.emit('exit');
  await interrupted;
  assert.equal(await first, 'interrupted');
  assert.equal(existsSync(path), false);
  assert.equal(f.children.length, 2);
  f.children[1].done();
  assert.equal(await next, 'played');
});

test('queue keeps at most three pending utterances and drops the oldest pending one', async t => {
  const f = playerFixture(t);
  const tasks = Array.from({ length: 5 }, (_, i) => f.player.play(pcm, 24000, { traceId: `q${i}` }));
  assert.equal(await tasks[1], 'interrupted');
  assert.equal(readdirSync(f.voiceDir).length, 4);
  assert.equal(f.log.events.find(event => event.kind === 'voice.dropped').traceId, 'q1');
  for (let i = 0; i < 4; i++) f.children[0].done();
  assert.deepEqual(await Promise.all(tasks), ['played', 'interrupted', 'played', 'played', 'played']);
  assert.deepEqual(readdirSync(f.voiceDir), []);
});

test('unsafe paths are rejected before anything is sent to the child', async t => {
  const f = playerFixture(t);
  const name = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.wav';
  for (const path of [join(f.repoRoot, name), join(f.voiceDir, 'bad.wav'),
    join(f.voiceDir, `bad';stop-process.wav`), `${join(f.voiceDir, name)}\ncommand`,
    join(f.voiceDir, '..', name)]) assert.equal(isSafeVoicePath(path, f.voiceDir), false);
  const unsafeRoot = join(directory(t), "unsafe'root");
  const unsafe = createPlayer({ repoRoot: unsafeRoot, spawn: f.spawn, platform: 'win32' });
  try { assert.equal(await unsafe.play(pcm, 24000), 'failed'); } finally { await unsafe.close(); }
  assert.equal(f.calls.length, 0);
});

test('player rejects a redirected .tmp directory and preserves external data', async t => {
  const root = directory(t);
  const outside = directory(t);
  mkdirSync(join(outside, 'voice'));
  writeFileSync(join(outside, 'voice', 'keep.txt'), 'keep');
  symlinkSync(outside, join(root, '.tmp'), 'junction');
  const f = spawnFixture();
  const player = createPlayer({ repoRoot: root, spawn: f.spawn, platform: 'win32' });
  assert.equal(await player.play(pcm, 24000), 'failed');
  await player.close();
  assert.equal(readFileSync(join(outside, 'voice', 'keep.txt'), 'utf8'), 'keep');
  assert.equal(f.calls.length, 0);
});

test('child exit/error fails current play, removes audio, and next play restarts', async t => {
  const f = playerFixture(t);
  for (const event of ['exit', 'error']) {
    const task = f.player.play(pcm, 24000);
    f.children.at(-1).emit(event, event === 'error' ? new Error('spawn failure') : 1);
    assert.equal(await task, 'failed');
    assert.deepEqual(readdirSync(f.voiceDir), []);
  }
  const task = f.player.play(pcm, 24000);
  assert.equal(f.children.length, 3);
  f.children.at(-1).done();
  assert.equal(await task, 'played');
});

test('three consecutive startup failures disable player without leftover files', async t => {
  let calls = 0;
  const f = playerFixture(t, { spawn() { calls++; throw new Error('spawn failed'); } });
  for (let i = 0; i < 4; i++) assert.equal(await f.player.play(pcm, 24000), 'failed');
  assert.equal(calls, 3);
  assert.equal(f.log.events.filter(event => event.kind === 'voice.disabled').length, 1);
  assert.deepEqual(readdirSync(f.voiceDir), []);
});

test('close kills child, clears queue, removes files and is idempotent', async t => {
  const f = playerFixture(t);
  const tasks = [f.player.play(pcm, 24000), f.player.play(pcm, 24000)];
  await f.player.close();
  await f.player.close();
  assert.deepEqual(await Promise.all(tasks), ['interrupted', 'interrupted']);
  assert.equal(f.children[0].kills, 1);
  assert.equal(existsSync(f.voiceDir), false);
});

test('startup removes stale WAVs and non-Windows playback reports unsupported only once', async t => {
  const root = directory(t);
  const voiceDir = join(root, '.tmp', 'voice');
  mkdirSync(voiceDir, { recursive: true });
  writeFileSync(join(voiceDir, 'old.wav'), pcm);
  const fake = spawnFixture();
  const log = logFixture();
  const player = createPlayer({ repoRoot: root, spawn: fake.spawn, eventlog: log, platform: 'linux' });
  assert.deepEqual(readdirSync(voiceDir), []);
  assert.equal(await player.play(pcm, 24000), 'failed');
  assert.equal(await player.play(pcm, 24000), 'failed');
  assert.equal(log.events.filter(event => event.kind === 'voice.unsupported').length, 1);
  assert.equal(fake.calls.length, 0);
  await player.close();
});

test('mouth returns chat immediately despite slow or throwing voice and logs speech first', async () => {
  for (const mode of ['slow', 'throw', 'reject', 'off']) {
    const log = logFixture();
    const chats = [];
    let voiceCall;
    const voice = mode === 'off' ? undefined : { say(...args) {
      assert.equal(log.events.at(-1).kind, 'speech');
      voiceCall = args;
      if (mode === 'throw') throw new Error('voice');
      if (mode === 'reject') return Promise.reject(new Error('voice'));
      return new Promise(() => {});
    } };
    const mouth = createMouth({ bot: { chat: text => chats.push(text) }, eventlog: log, voice, minIntervalMs: 0 });
    assert.equal(await mouth.say('hello', 'trace', { kind: 'learned' }), 'hello');
    assert.deepEqual(chats, ['hello']);
    if (voice) assert.deepEqual(voiceCall, ['hello', 'trace', { kind: 'learned' }]);
    else assert.equal(voiceCall, undefined);
    await tick();
  }
});

test('mouth never forwards failed chat to voice', async () => {
  let voices = 0;
  const mouth = createMouth({ bot: { chat() { throw new Error('chat failed'); } }, eventlog: logFixture(),
    voice: { say() { voices++; } }, minIntervalMs: 0 });
  await assert.rejects(mouth.say('hello'), /chat failed/u);
  assert.equal(voices, 0);
});

test('pipeline serializes synthesis/playback and aborts current and pending utterances', async () => {
  const calls = [];
  const pending = [];
  let interrupts = 0;
  const voice = createVoice({ tts: { synthesize(text, options) {
    calls.push({ text, options });
    return new Promise(resolve => pending.push(resolve));
  } }, player: { play: async () => { calls.push('play'); }, interrupt() { interrupts++; }, close() {} } });
  const one = voice.say('one', 'one', { kind: 'learned' });
  const two = voice.say('two', 'two');
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.style, voiceStyle('learned'));
  pending.shift()({ pcm, sampleRate: 24000 });
  await one;
  await tick();
  assert.equal(calls[1], 'play');
  assert.equal(calls[2].text, 'two');
  const three = voice.say('three', 'three');
  voice.interrupt();
  assert.equal(calls[2].options.signal.aborted, true);
  const four = voice.say('four', 'four');
  await tick();
  assert.equal(calls[3].text, 'four');
  pending.shift()({ pcm, sampleRate: 24000 });
  await two;
  await three;
  assert.equal(calls.filter(call => call === 'play').length, 1);
  pending.shift()({ pcm, sampleRate: 24000 });
  await four;
  assert.equal(interrupts, 1);
  assert.equal(calls.some(call => call.text === 'three'), false);
  await voice.close();
  await voice.say('after close');
  assert.equal(calls.some(call => call.text === 'after close'), false);
});

test('handler interrupts at entry; rule-mode voice uses default style', async () => {
  const order = [];
  const spoken = [];
  const handler = createOwnerChatHandler({ library: { list: () => [] }, arbiter: { cancel: () => false },
    ownerUuid: OWNER, eventlog: { append() {}, query: () => [] },
    dialogue: { record() { order.push('record'); }, getQuestion: () => null, recentLines: () => [], recent: () => [] },
    voice: { interrupt() { order.push('interrupt'); } },
    mouth: { say(text, traceId, options) { spoken.push({ text, traceId, options }); return text; } } });
  await handler.handle('停下', 'trace');
  assert.equal(order[0], 'interrupt');
  assert.equal(spoken[0].options.kind, undefined);
});

test('handler forwards situation kind for generated speech and tolerates interrupt failure', async () => {
  const spoken = [];
  const handler = createOwnerChatHandler({ library: { list: () => [] }, arbiter: { cancel: () => false },
    ownerUuid: OWNER, eventlog: { append() {}, query: () => [] },
    brain: { enabled: true, speak: async () => '生成的文字。' },
    voice: { interrupt() { throw new Error('interrupt'); } },
    mouth: { say(text, traceId, options) { spoken.push({ text, traceId, options }); return text; } } });
  await handler.narrate({ kind: 'owner_joined' }, 'trace');
  assert.equal(spoken[0].options.kind, 'owner_joined');
  await handler.handle('停下');
  assert.equal(spoken[1].options.kind, 'idle');
});

test('style maps every known kind and defaults unknown kinds to warm English descriptors', () => {
  for (const [kind, emotion] of Object.entries(emotions)) {
    assert.ok(voiceStyle(kind).includes(emotion));
    assert.match(voiceStyle(kind), /soft, sweet young girl voice, clingy/u);
    assert.doesNotMatch(voiceStyle(kind), /[\u3400-\u9fff]/u);
  }
  assert.equal(voiceStyle('unknown'), voiceStyle());
  assert.equal(voiceStyle('__proto__'), voiceStyle());
  assert.ok(voiceStyle().includes('warm'));
});

test('config defaults, overrides, validation, and non-enumerable TTS fields', () => {
  const config = loadConfig({ OWNER_UUID: OWNER });
  assert.equal(config.ttsEnabled, false);
  assert.equal(config.ttsModel, 'gemini-3.8-flash-lite-tts');
  assert.deepEqual(config.ttsFallbackModels, ['gemini-3.8-flash-tts']);
  assert.equal(config.ttsVoice, 'Leda');
  assert.equal(config.ttsVolume, 80);
  assert.equal(config.ttsTimeoutMs, 15000);
  assert.equal(Object.keys(config).some(key => key.startsWith('tts')), false);
  for (const voice of ['', 'a', 'Leda1', 'Leda;cmd', '中文', 'a'.repeat(33)]) {
    assert.throws(() => loadConfig({ OWNER_UUID: OWNER, TTS_VOICE: voice }), /TTS_VOICE/u);
  }
  for (const volume of ['', ' ', '-1', '101', 'NaN', 'Infinity', 'bad']) {
    assert.throws(() => loadConfig({ OWNER_UUID: OWNER, TTS_VOLUME: volume }), /TTS_VOLUME/u);
  }
  for (const timeout of ['0', 'bad', '2147483648']) {
    assert.throws(() => loadConfig({ OWNER_UUID: OWNER, TTS_TIMEOUT_MS: timeout }), /TTS_TIMEOUT_MS/u);
  }
  const enabled = loadConfig({ OWNER_UUID: OWNER, BRAIN_PROVIDER: 'gemini', BRAIN_API_KEY: secret,
    TTS_ENABLED: '1', TTS_MODEL: 'voice-model', TTS_FALLBACK_MODELS: 'backup, spare ',
    TTS_VOICE: 'Kore', TTS_VOLUME: '0', TTS_TIMEOUT_MS: '2000' });
  assert.equal(enabled.ttsEnabled, true);
  assert.equal(enabled.ttsModel, 'voice-model');
  assert.deepEqual(enabled.ttsFallbackModels, ['backup', 'spare']);
  assert.equal(enabled.ttsVoice, 'Kore');
  assert.equal(enabled.ttsVolume, 0);
  assert.equal(enabled.ttsTimeoutMs, 2000);
  assert.equal(JSON.stringify(enabled).includes(secret), false);
  assert.equal(loadConfig({ OWNER_UUID: OWNER, TTS_ENABLED: '1', BRAIN_PROVIDER: 'gemini' }).ttsEnabled, false);
});

function mainBot() {
  const bot = new EventEmitter();
  Object.assign(bot, { username: 'Companion', players: {}, entities: {}, chats: [],
    entity: { position: { x: 0, y: 0, z: 0 } },
    lookAt: async () => {}, loadPlugin() {}, quit() {}, chat(text) { this.chats.push(text); } });
  return bot;
}

test('main logs invalid provider/missing key once and disabled voice creates no player', async t => {
  for (const settings of [{}, { TTS_ENABLED: '0', OPENROUTER_API_KEY: secret,
    BRAIN_PROVIDER: 'gemini', BRAIN_API_KEY: secret }, { TTS_ENABLED: '1', BRAIN_API_KEY: secret },
    { TTS_ENABLED: '1', BRAIN_PROVIDER: 'gemini' }]) {
    const root = directory(t);
    const bot = mainBot();
    let spawns = 0;
    const config = loadConfig({ OWNER_UUID: OWNER, COMPANION_DATA_DIR: join(root, 'data'), ...settings });
    const app = startCompanion({ config, repoRoot: root, signals: new EventEmitter(),
      createBot: () => bot, pathfinderPlugin: () => {}, mcData,
      spawn() { spawns++; throw new Error('must not spawn'); }, fetch() { throw new Error('must not fetch'); } });
    t.after(() => app.close());
    bot.emit('spawn');
    await app.ready;
    const events = app.eventlog.query({ kind: 'voice.disabled' });
    assert.equal(events.length, settings.TTS_ENABLED === '1' ? 1 : 0);
    if (settings.TTS_ENABLED === '1') assert.equal(events[0].payload.reason, config.ttsDisabledReason);
    assert.equal(spawns, 0);
    assert.equal(existsSync(join(root, '.tmp', 'voice')), false);
    await app.close();
  }
});

test('main rule-mode speech reaches configured TTS/player and SIGINT aborts and cleans playback', async t => {
  const root = directory(t);
  const fake = spawnFixture();
  const bot = mainBot();
  const signals = new EventEmitter();
  const requests = [];
  const app = startCompanion({ repoRoot: root, signals,
    config: loadConfig({ OWNER_UUID: OWNER, COMPANION_DATA_DIR: join(root, 'data'),
      TTS_ENABLED: '1', BRAIN_PROVIDER: 'gemini', BRAIN_API_KEY: secret,
      BRAIN_BASE_URL: 'https://example.invalid', TTS_MODEL: 'voice-model', TTS_VOICE: 'Kore', TTS_VOLUME: '50' }),
    createBot: () => bot, pathfinderPlugin: () => {}, mcData, spawn: fake.spawn,
    fetch: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return audioResponse(); } });
  t.after(() => app.close());
  bot.emit('spawn');
  await app.ready;
  bot.players.Owner = { uuid: OWNER, username: 'Owner' };
  bot.emit('chat', 'Owner', '做个工作台');
  for (let i = 0; i < 100 && !fake.children.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fake.children.length, 1);
  assert.deepEqual(bot.chats, ['工作台：还不会。']);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.includes('/voice-model:'));
  assert.equal(requests[0].body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  assert.equal(requests[0].body.contents[0].parts[0].text,
    `### DIRECTOR'S NOTES\nStyle: ${voiceStyle()}\n\n### TRANSCRIPT\n${bot.chats[0]}`);
  assert.equal(readFileSync(fake.children[0].paths[0]).readInt16LE(44), 16384);
  signals.emit('SIGINT');
  await app.close();
  assert.equal(fake.children[0].kills, 1);
  assert.equal(existsSync(join(root, '.tmp', 'voice')), false);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});
