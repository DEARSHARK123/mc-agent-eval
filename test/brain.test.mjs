import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrain } from '../src/brain/llm.js';
import { createGeminiProvider } from '../src/brain/providers/gemini.js';
import { createOpenAIProvider } from '../src/brain/providers/openai.js';
import { loadConfig } from '../src/config.js';
import * as persona from '../src/persona.js';

const key = 'fake-t7-private-key';
const ownerUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const baseUrl = 'https://example.invalid/v1beta/';
const recipe = { item: 'crafting_table', ingredients: [{ item: 'oak_planks', count: 4 }] };
const geminiData = (text, extra = {}) => ({ candidates: [{ content: { parts: [{ text, ...extra }] } }] });
const sse = values => values.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join('');

function streaming(chunks, { stall = false, onCancel = () => {} } = {}) {
  let index = 0;
  const encoder = new TextEncoder();
  return { ok: true, status: 200, body: new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        const chunk = chunks[index++];
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      } else if (!stall) controller.close();
    },
    cancel: onCancel,
  }) };
}

function brain(fetch, options = {}) {
  return createBrain({ provider: 'gemini', baseUrl, apiKey: key, model: 'primary', fetch, ...options });
}

test('Gemini: native JSON request uses header auth, thinking budget, and visible parts only', async () => {
  let request;
  const adapter = createGeminiProvider({ baseUrl, apiKey: key, fetch: async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({
      candidates: [{ content: { parts: [{ text: 'private thoughts', thought: true }, { text: 'visible' }, { text: ' text' }] } }],
      usageMetadata: { thoughtsTokenCount: 40, candidatesTokenCount: 2 },
    }) };
  } });
  const result = await adapter.generate({ model: 'gemini-test', system: 'system', user: '{}', thinking: 'high', json: true });
  assert.equal(request.url, 'https://example.invalid/v1beta/models/gemini-test:generateContent');
  assert.equal(request.url.includes(key), false);
  assert.equal(request.options.headers['x-goog-api-key'], key);
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'system' }] });
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: '{}' }] }]);
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'high');
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.ok(body.generationConfig.maxOutputTokens >= 2048);
  assert.equal(result.text, 'visible text');
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.ok(result.ttftMs >= 0);
  assert.ok(result.totalMs >= result.ttftMs);
  assert.deepEqual(result.usage, { thoughtsTokenCount: 40, candidatesTokenCount: 2 });
});

test('Gemini: SSE handles byte boundaries, comments, thought fragments, final unterminated line and usage', async () => {
  const wire = ': keepalive\n\n' + sse([geminiData('hidden', { thought: true }), geminiData('工作'), geminiData('台。')]) +
    `data: ${JSON.stringify({ usageMetadata: { candidatesTokenCount: 3 } })}`;
  const bytes = new TextEncoder().encode(wire);
  const chunks = Array.from(bytes, byte => Uint8Array.of(byte));
  const visible = [];
  let url;
  const result = await createGeminiProvider({ baseUrl, apiKey: key, fetch: async value => {
    url = value;
    return streaming(chunks);
  } }).generate({ model: 'test', system: '', user: '{}', thinking: 'low', stream: true,
    onText: text => { visible.push(text); } });
  assert.equal(url, 'https://example.invalid/v1beta/models/test:streamGenerateContent?alt=sse');
  assert.equal(result.text, '工作台。');
  assert.deepEqual(visible, ['工作', '台。']);
  assert.deepEqual(result.usage, { candidatesTokenCount: 3 });
});

test('OpenAI: SSE preserves chat/completions, skips role-only deltas and reads usage and DONE', async () => {
  let request;
  const adapter = createOpenAIProvider({ baseUrl, apiKey: key, fetch: async (url, options) => {
    request = { url, options };
    return streaming([sse([{ choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { content: '完成。' } }] }, { choices: [], usage: { completion_tokens: 3 } }]) + 'data: [DONE]\n\n']);
  } });
  const result = await adapter.generate({ model: 'openai-test', system: 'persona', user: '{}', stream: true });
  assert.equal(request.url, 'https://example.invalid/v1beta/chat/completions');
  assert.equal(request.options.headers.Authorization, `Bearer ${key}`);
  assert.equal(JSON.parse(request.options.body).stream, true);
  assert.equal(result.text, '完成。');
  assert.deepEqual(result.usage, { completion_tokens: 3 });
});

test('brain: speak cancels at first sentence without waiting for EOF and strips quotes, actions and newlines', async () => {
  let signal;
  let cancelled = false;
  const calls = [];
  const instance = brain(async (_, options) => {
    signal = options.signal;
    return streaming([sse([geminiData('“（低头。微笑）\n工作'), geminiData('台做好了！第二句。\n”')])],
      { stall: true, onCancel: () => { cancelled = true; } });
  }, { eventlog: { append: (kind, payload) => calls.push({ kind, payload }) } });
  assert.equal(await instance.speak(), '工作台做好了！');
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.ok, true);
});

test('brain: character limit counts Unicode characters and unfinished actions are suppressed', async () => {
  for (const text of ['字'.repeat(41), '😀'.repeat(41)]) {
    let signal;
    const output = await brain(async (_, options) => {
      signal = options.signal;
      return streaming([sse([geminiData(text)])], { stall: true });
    }).speak();
    assert.equal(Array.from(output).length, 40);
    assert.equal(signal.aborted, true);
  }
  assert.equal(await brain(async () => streaming([sse([geminiData('「[转身]【挥手】(微笑)完成。（未结束动作')])])).speak(), '完成。');
});

test('brain: empty results, fetch/body stalls, caller cancellation and pre-abort return null', async () => {
  assert.equal(await brain(async () => streaming([sse([geminiData('hidden', { thought: true })])])).speak(), null);
  for (const stallBody of [false, true]) {
    let signal;
    const events = [];
    const instance = brain(async (_, options) => {
      signal = options.signal;
      return stallBody ? streaming([], { stall: true }) : new Promise(() => {});
    }, { speakTimeoutMs: 15, eventlog: { append: (_, payload) => events.push(payload) } });
    assert.equal(await instance.speak(), null);
    assert.equal(signal.aborted, true);
    assert.equal(events[0].status, 'timeout');
  }
  const controller = new AbortController();
  const pending = brain(async () => new Promise(() => {})).speak({ signal: controller.signal });
  controller.abort();
  assert.equal(await pending, null);
  assert.equal(await brain(() => assert.fail('pre-abort must not fetch')).speak({ signal: controller.signal }), null);
});

test('brain: ordered fallback models recover from 503, 429, 500 and network errors; non-retryable errors stop', async () => {
  for (const status of [503, 429, 500, 'network']) {
    const models = [];
    const events = [];
    const instance = brain(async (url) => {
      const model = url.match(/models\/([^:]+)/u)[1];
      models.push(model);
      if (model === 'primary') {
        if (status === 'network') throw new Error(`network ${key}`);
        return { ok: false, status };
      }
      if (model === 'fallback-a') return { ok: false, status: 503 };
      return streaming([sse([geminiData('已完成。')])]);
    }, { fallbackModels: ['fallback-a', 'fallback-b'], eventlog: { append: (kind, payload) => events.push({ kind, payload }) } });
    assert.equal(await instance.speak(), '已完成。');
    assert.deepEqual(models, ['primary', 'fallback-a', 'fallback-b']);
    assert.equal(events.length, 3);
    assert.equal(events[2].payload.fallbackFrom, 'primary');
    assert.equal(events[2].payload.ok, true);
    assert.equal(JSON.stringify(events).includes(key), false);
  }
  let attempts = 0;
  assert.equal(await brain(async () => { attempts++; return { ok: false, status: 400 }; }, { fallbackModels: ['backup'] }).speak(), null);
  assert.equal(attempts, 1);
  assert.equal(await brain(async () => ({ ok: false, status: 503 }), { fallbackModels: ['backup'] }).speak(), null);
});

test('brain: all fallback attempts share one deadline', async () => {
  const signals = [];
  const events = [];
  const instance = brain(async (_, options) => {
    signals.push(options.signal);
    if (signals.length === 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
      return { ok: false, status: 503 };
    }
    return new Promise(() => {});
  }, { speakTimeoutMs: 50, fallbackModels: ['backup', 'never'], eventlog: { append: (_, event) => events.push(event) } });
  const start = performance.now();
  assert.equal(await instance.speak(), null);
  assert.ok(performance.now() - start < 150);
  assert.equal(signals.length, 2);
  assert.equal(signals[1].aborted, true);
  assert.equal(events[1].status, 'timeout');
});

test('brain: network failure while reading a stream retries without retaining partial output', async () => {
  let attempts = 0;
  const instance = brain(async () => {
    if (++attempts === 1) {
      let sent = false;
      return { ok: true, status: 200, body: new ReadableStream({ pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode(sse([geminiData('未完成片段')])));
        } else controller.error(new Error(`connection lost ${key}`));
      } }) };
    }
    return streaming([sse([geminiData('备用模型完成。')])]);
  }, { fallbackModels: ['backup'] });
  assert.equal(await instance.speak(), '备用模型完成。');
  assert.equal(attempts, 2);
});

test('brain: parsing uses fallback with its own thinking and JSON config under a single deadline', async () => {
  const requests = [];
  const events = [];
  const instance = brain(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (requests.length === 1) return { ok: false, status: 503 };
    return { ok: true, status: 200, json: async () => geminiData(JSON.stringify(recipe)) };
  }, { parseModel: 'parser', parseThinking: 'medium', fallbackModels: ['backup'],
    eventlog: { append: (_, payload) => events.push(payload) } });
  assert.deepEqual(await instance.parseTeaching('four boards make a workbench'), recipe);
  assert.ok(requests[1].url.endsWith('/backup:generateContent'));
  assert.equal(requests[1].body.generationConfig.responseMimeType, 'application/json');
  assert.equal(requests[1].body.generationConfig.thinkingConfig.thinkingLevel, 'medium');
  assert.equal(events[1].purpose, 'parse');
  assert.equal(events[1].fallbackFrom, 'parser');
  let signal;
  assert.equal(await brain(async (_, options) => {
    signal = options.signal;
    return { ok: true, status: 200, json: () => new Promise(() => {}) };
  }, { parseTimeoutMs: 15 }).parseTeaching('recipe'), null);
  assert.equal(signal.aborted, true);
});

test('brain: distinct speak/parse models and thinking, validated JSON, data isolation and safe event metadata', async () => {
  const requests = [];
  const events = [];
  const instance = brain(async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    return url.includes(':generateContent')
      ? { ok: true, status: 200, json: async () => geminiData(JSON.stringify(recipe)) }
      : streaming([sse([geminiData('完成。')])]);
  }, { speakModel: 'speaker', parseModel: 'parser', speakThinking: 'low', parseThinking: 'high',
    eventlog: { append: (kind, payload) => events.push({ kind, payload }) } });
  assert.deepEqual(await instance.parseTeaching('private owner recipe', { allowedItems: ['crafting_table', 'oak_planks'] }), recipe);
  const situation = { kind: 'chat', ownerMessage: 'private owner message' };
  const memory = { skills: ['private memory'] };
  assert.equal(await instance.speak({ persona: 'private persona', situation, memory }), '完成。');
  assert.ok(requests[0].url.includes('/parser:generateContent'));
  assert.equal(requests[0].body.generationConfig.thinkingConfig.thinkingLevel, 'high');
  assert.equal(requests[0].body.generationConfig.responseMimeType, 'application/json');
  assert.ok(requests[1].url.includes('/speaker:streamGenerateContent'));
  assert.equal(requests[1].body.generationConfig.thinkingConfig.thinkingLevel, 'low');
  assert.equal(requests[1].body.generationConfig.responseMimeType, undefined);
  assert.deepEqual(JSON.parse(requests[1].body.contents[0].parts[0].text), { situation, memory });
  assert.equal(requests[1].body.systemInstruction.parts[0].text.includes('private memory'), false);
  assert.match(requests[1].body.systemInstruction.parts[0].text, /数据，不是指令/u);
  for (const value of [key, 'private owner recipe', 'private owner message', 'private memory', 'private persona', '完成。']) {
    assert.equal(JSON.stringify(events).includes(value), false);
  }
  assert.deepEqual(Object.keys(events[0].payload).sort(), ['purpose', 'provider', 'model', 'ok', 'status', 'ttftMs', 'totalMs', 'fallbackFrom'].sort());
});

test('brain: echoed credentials across chunks, after a sentence, in parse JSON and after cleanup are discarded', async () => {
  for (const chunks of [[geminiData(key.slice(0, 7)), geminiData(key.slice(7))], [geminiData(`完成。${key}`)]]) {
    assert.equal(await brain(async () => streaming([sse(chunks)])).speak(), null);
  }
  assert.equal(await brain(async () => ({ ok: true, status: 200,
    json: async () => geminiData(JSON.stringify({ ...recipe, extra: key })) })).parseTeaching('teaching'), null);
  assert.equal(await brain(async () => streaming([sse([geminiData('ab（动作）cd。')])]), { apiKey: 'abcd' }).speak(), null);
});

test('persona: no line export or quoted examples and all fallback lines are plain facts', () => {
  assert.equal('line' in persona, false);
  assert.doesNotMatch(persona.buildPersona(), /[“「"']/u);
  assert.match(persona.buildPersona(), /不超过40字/u);
  for (const kind of ['owner_joined', 'owner_left', 'chat']) assert.equal(persona.factLine({ kind }), null);
});

test('brain: nickname uses parse settings, fallback, JSON data and safe nickname call metadata', async () => {
  const requests = [];
  const events = [];
  const instance = brain(async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    if (requests.length === 1) return { ok: false, status: 503 };
    return { ok: true, status: 200, json: async () => geminiData('{"nickname":" 阿测 "}') };
  }, { parseModel: 'parser', parseThinking: 'high', fallbackModels: ['backup'],
    eventlog: { append: (kind, payload) => events.push({ kind, payload }) } });
  const input = { persona: persona.buildPersona(), playerName: 'TestOwner', memory: { private: 'private memory' } };
  assert.equal(await instance.nickname(input), '阿测');
  assert.ok(requests[0].url.endsWith('/parser:generateContent'));
  assert.ok(requests[1].url.endsWith('/backup:generateContent'));
  for (const request of requests) {
    assert.equal(request.body.generationConfig.responseMimeType, 'application/json');
    assert.equal(request.body.generationConfig.thinkingConfig.thinkingLevel, 'high');
    assert.deepEqual(JSON.parse(request.body.contents[0].parts[0].text), { playerName: input.playerName, memory: input.memory });
    assert.doesNotMatch(request.body.systemInstruction.parts[0].text, /[“「]/u);
    assert.equal(request.body.systemInstruction.parts[0].text.includes('阿测'), false);
    assert.equal(request.body.systemInstruction.parts[0].text.includes('private memory'), false);
  }
  assert.equal(events.length, 2);
  assert.equal(events[1].payload.fallbackFrom, 'parser');
  for (const event of events) {
    assert.equal(event.kind, 'brain.call');
    assert.equal(event.payload.purpose, 'nickname');
  }
  for (const value of [key, input.persona, input.playerName, 'private memory', '阿测']) {
    assert.equal(JSON.stringify(events).includes(value), false);
  }
});

test('brain: nickname validates length, newlines, quotes, brackets, credentials and JSON', async () => {
  const generate = content => brain(async () => ({ ok: true, status: 200, json: async () => geminiData(content) })).nickname({ playerName: 'TestOwner' });
  for (const nickname of ['', '   ', '主人', '小主人', '字'.repeat(13), '换\n行', '\n边界', '换\r行', '换\u2028行',
    '双"引', "单'引", '中“引”', '角「引」', '圆(括)', '全（括）', '方[括]', '中【括】', '花{括}', key]) {
    assert.equal(await generate(JSON.stringify({ nickname })), null, nickname);
  }
  for (const value of ['not JSON', 'null', '{}', '[]', '{"nickname":42}']) assert.equal(await generate(value), null);
  for (const nickname of ['字', '字'.repeat(12), '𠮷'.repeat(12)]) {
    assert.equal(await generate(JSON.stringify({ nickname })), nickname);
  }
  assert.equal(await createBrain({ fetch: () => assert.fail('disabled') }).nickname(), null);
});

test('brain: nickname shares the parse deadline and supports cancellation', async () => {
  let signal;
  const events = [];
  const instance = brain(async (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  }, { parseTimeoutMs: 15, eventlog: { append: (_, payload) => events.push(payload) } });
  assert.equal(await instance.nickname({ playerName: 'TestOwner' }), null);
  assert.equal(signal.aborted, true);
  assert.equal(events[0].purpose, 'nickname');
  assert.equal(events[0].status, 'timeout');
  const controller = new AbortController();
  const pending = brain(async () => new Promise(() => {})).nickname({ signal: controller.signal });
  controller.abort();
  assert.equal(await pending, null);
});

test('persona: only the address prohibition contains 主人 and facts use game names without nicknames', () => {
  const prompt = persona.buildPersona({ playerName: 'TestOwner', nickname: '阿测' });
  assert.equal(prompt.split('主人').length - 1, 1);
  assert.ok(prompt.includes('不要称呼他主人'));
  assert.doesNotMatch(prompt, /[“「]/u);
  assert.ok(prompt.includes('taughtBy 不为空'));
  const situation = { itemName: '工作台', taughtWhen: '昨天', taughtBy: { playerName: 'TestOwner' },
    owner: { playerName: 'TestOwner', nickname: '阿测' } };
  assert.equal(persona.factLine({ ...situation, kind: 'remembered' }), '工作台：已做好（昨天 TestOwner 教的）。');
  assert.equal(persona.factLine({ ...situation, kind: 'relearned' }), '工作台：已重新学会（昨天 TestOwner 教过）。');
  for (const kind of ['learned', 'relearned', 'remembered', 'dont_know', 'try_failed', 'missing_item', 'skills_list',
    'unknown_word', 'chat', 'owner_joined', 'owner_left']) {
    const line = persona.factLine({ ...situation, kind });
    if (line !== null) assert.doesNotMatch(line, /主人|阿测/u);
  }
  assert.equal(persona.factLine({ kind: 'remembered', itemName: '工作台', taughtWhen: '昨天' }), '工作台：已做好（昨天学会的）。');
  assert.equal(persona.factLine({ ...situation, kind: 'remembered', taughtBy: { playerName: null } }), '工作台：已做好（昨天学会的）。');
});

test('config: all brain defaults and overrides are non-enumerable and immutable', () => {
  const defaults = loadConfig({ OWNER_UUID: ownerUuid, BRAIN_MODEL: 'default-model' });
  assert.equal(defaults.brainProvider, 'openai');
  assert.equal(defaults.brainSpeakModel, 'default-model');
  assert.equal(defaults.brainParseModel, 'default-model');
  assert.equal(defaults.brainSpeakThinking, 'low');
  assert.equal(defaults.brainParseThinking, 'medium');
  assert.equal(defaults.brainSpeakTimeoutMs, 6000);
  assert.equal(defaults.brainParseTimeoutMs, 15000);
  assert.deepEqual(defaults.brainFallbackModels, []);
  const config = loadConfig({ OWNER_UUID: ownerUuid, BRAIN_PROVIDER: 'gemini', BRAIN_API_KEY: key,
    BRAIN_MODEL: 'base', BRAIN_SPEAK_MODEL: 'speak', BRAIN_PARSE_MODEL: 'parse',
    BRAIN_SPEAK_THINKING: 'high', BRAIN_PARSE_THINKING: 'low',
    BRAIN_SPEAK_TIMEOUT_MS: '1234', BRAIN_PARSE_TIMEOUT_MS: '2345', BRAIN_FALLBACK_MODELS: ' first, , second ' });
  assert.equal(config.brainSpeakModel, 'speak');
  assert.equal(config.brainParseModel, 'parse');
  assert.equal(config.brainSpeakThinking, 'high');
  assert.equal(config.brainParseThinking, 'low');
  assert.equal(config.brainSpeakTimeoutMs, 1234);
  assert.equal(config.brainParseTimeoutMs, 2345);
  assert.deepEqual(config.brainFallbackModels, ['first', 'second']);
  assert.ok(Object.isFrozen(config.brainFallbackModels));
  assert.equal(Object.keys(config).some(name => name.startsWith('brain')), false);
  assert.equal(JSON.stringify(config).includes(key), false);
});

test('config: invalid provider, thinking and timeouts fail without including values or keys', () => {
  for (const [name, values] of [
    ['BRAIN_PROVIDER', ['unknown', key]], ['BRAIN_SPEAK_THINKING', ['minimal', key]],
    ['BRAIN_PARSE_THINKING', ['minimal', key]],
    ...['BRAIN_SPEAK_TIMEOUT_MS', 'BRAIN_PARSE_TIMEOUT_MS'].map(name => [name, ['0', '-1', '1.5', '', 'NaN', '2147483648', key]]),
  ]) {
    for (const value of values) assert.throws(() => loadConfig({ OWNER_UUID: ownerUuid, BRAIN_API_KEY: key, [name]: value }),
      error => error.message.includes(name) && !error.message.includes(key));
  }
});
