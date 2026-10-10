// P0 probe model adapters — thin wrappers over the REAL providers:
//   <BRAIN_MODEL> : the user's real configured brain, dispatched on BRAIN_PROVIDER —
//                   'gemini' → createGeminiProvider, 'openai' (or unset while a base
//                   url is present) → createOpenAIProvider. The cell key IS the
//                   actual model name from config (never a hardcoded label).
//   inkling       : createOpenAIProvider(OPENROUTER_API_KEY) @ https://openrouter.ai/api/v1,
//                   model 'thinkingmachines/inkling:free' (403-gated on this key)
//   jev           : createJev(TYPESAFE_API_KEY) — paradigm B choice questions only
// A model with no key is skipped wholesale and listed in the report.

import { createOpenAIProvider } from '../../src/brain/providers/openai.js';
import { createGeminiProvider } from '../../src/brain/providers/gemini.js';
import { createJev } from '../../src/decision/jev.js';

export function buildModels(env = process.env) {
  const models = [];
  const skipped = [];

  const brainKey = env.BRAIN_API_KEY?.trim();
  const brainBase = env.BRAIN_BASE_URL?.trim();
  const brainModel = env.BRAIN_MODEL?.trim();
  const brainProvider = (env.BRAIN_PROVIDER ?? '').trim().toLowerCase();
  if (brainKey && brainBase && brainModel) {
    // Calls mirror the real brain's parse path (src/brain/llm.js request()):
    // non-stream, json mode on, thinking level = BRAIN_PARSE_THINKING (medium).
    const common = { key: brainModel, kind: 'chat', paradigms: ['A', 'B'],
      model: brainModel, json: true };
    let provider = null;
    if (brainProvider === 'gemini') {
      provider = createGeminiProvider({ baseUrl: brainBase, apiKey: brainKey });
      models.push({ ...common, providerKind: 'gemini',
        thinking: env.BRAIN_PARSE_THINKING?.trim() || 'medium', provider });
    } else if (brainProvider === 'openai' || !brainProvider) {
      provider = createOpenAIProvider({ baseUrl: brainBase, apiKey: brainKey });
      models.push({ ...common, providerKind: 'openai', provider });
    } else {
      skipped.push({ key: brainModel, reason: `BRAIN_PROVIDER=${brainProvider} unsupported by probe (expected gemini|openai)` });
    }
    // BRAIN_FALLBACK_MODELS are part of the real brain config (llm.js walks
    // [primary, ...fallbacks] per request). Probe them as separate rows keyed
    // by their real model names so per-model rates stay attributable — the
    // deviation from runtime failover semantics is noted in the report.
    if (provider) {
      const extra = (env.BRAIN_FALLBACK_MODELS ?? '').split(',').map(v => v.trim())
        .filter(name => name && name !== brainModel);
      const providerKind = brainProvider === 'gemini' ? 'gemini' : 'openai';
      for (const name of extra) {
        models.push({ ...common, key: name, model: name, providerKind,
          thinking: env.BRAIN_PARSE_THINKING?.trim() || 'medium', provider });
      }
    }
  } else {
    skipped.push({ key: brainModel || 'brain', reason: 'BRAIN_BASE_URL/BRAIN_API_KEY/BRAIN_MODEL not configured' });
  }

  if (env.OPENROUTER_API_KEY?.trim()) {
    models.push({
      // The spec says base https://openrouter.ai/api + model
      // 'openrouter/thinkingmachines/inkling:free'; both 404 in practice —
      // OpenRouter serves /api/v1 and the real id has no 'openrouter/' prefix
      // (that prefix is the pi-ai namespaced form used elsewhere in this repo).
      key: 'inkling', kind: 'chat', paradigms: ['A', 'B'],
      model: 'thinkingmachines/inkling:free', providerKind: 'openai', json: true,
      provider: createOpenAIProvider({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: env.OPENROUTER_API_KEY.trim() }),
    });
  } else {
    skipped.push({ key: 'inkling', reason: 'OPENROUTER_API_KEY not configured' });
  }

  // P0r: DeepSeek as its own column — OpenAI-compatible endpoint, model from
  // DEEPSEEK_MODEL (default deepseek-chat). Keyed by the real model name like
  // the brain fallbacks, so swapping DEEPSEEK_MODEL never silently mixes
  // results from two different models under one row.
  const dsModel = env.DEEPSEEK_MODEL?.trim() || 'deepseek-chat';
  if (env.DEEPSEEK_API_KEY?.trim()) {
    models.push({
      key: dsModel, kind: 'chat', paradigms: ['A', 'B'],
      model: dsModel, providerKind: 'openai', json: true,
      provider: createOpenAIProvider({ baseUrl: 'https://api.deepseek.com/v1', apiKey: env.DEEPSEEK_API_KEY.trim() }),
    });
  } else {
    skipped.push({ key: dsModel, reason: 'DEEPSEEK_API_KEY not configured' });
  }

  if (env.TYPESAFE_API_KEY?.trim()) {
    models.push({
      key: 'jev', kind: 'jev', paradigms: ['B'],
      jev: createJev({ apiKey: env.TYPESAFE_API_KEY.trim(), timeoutMs: 15_000 }),
    });
  } else {
    skipped.push({ key: 'jev', reason: 'TYPESAFE_API_KEY not configured' });
  }

  return { models, skipped };
}

// Chat-model completion → { ok, text, latencyMs, usage, status }
// Passes through the model's thinking/json flags; OpenAI's generate ignores
// `thinking` (not in its signature), Gemini ignores nothing relevant here.
export async function complete(model, { system, user, timeoutMs = 90_000 }) {
  const signal = AbortSignal.timeout(timeoutMs);
  const result = await model.provider.generate({ model: model.model, system, user, signal,
    thinking: model.thinking, json: model.json ?? false });
  return { ok: result.ok, text: result.text ?? '', latencyMs: result.totalMs ?? 0,
    usage: result.usage ?? null, status: result.status ?? null };
}

// Paradigm-B pick for chat models: expect JSON { "choice": "<key>" }.
export async function pickByChat(model, { task, stateText, options, history = [], timeoutMs = 90_000 }) {
  const lines = options.map(o => `- "${o.key}": ${o.description}`).join('\n');
  const done = history.length ? `\n已执行的动作：${history.join(' → ')}` : '';
  const system = '你在控制一个 Minecraft bot 逐步完成任务。每一步从候选动作中选择一个。\n'
    + '只输出一个 JSON 对象：{"choice":"<候选key>"}，不要输出别的。';
  const user = `任务：${task.description}\n\n当前状态：\n${stateText}${done}\n\n候选动作：\n${lines}\n\n选哪个？`;
  const resp = await complete(model, { system, user, timeoutMs });
  return resp;
}

// Paradigm-B pick for Jev: one choice question over candidate keys.
export async function pickByJev(model, { task, state, options, history = [] }) {
  const criteria = Object.fromEntries(options.map(o => [o.key, o.description]));
  const response = await model.jev.ask({
    state: { task: task.description, world: state, recent_actions: history },
    questions: { pick: { type: 'choice',
      instructions: 'Choose exactly one candidate action that best completes the task. Never invent a key.',
      criteria } },
  });
  return response;
}
