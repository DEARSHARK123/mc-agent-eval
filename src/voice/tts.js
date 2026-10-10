import { createGemini } from './gemini.js';
import { createFish } from './fish.js';

export function createTts(options = {}) {
  const order = options.providers ?? (options.openrouterApiKey
    ? (options.primary === 'gemini' ? ['gemini', 'fish'] : ['fish', 'gemini']).filter(p => p === 'fish' || options.apiKey)
    : ['gemini']);
  const providers = order.map(provider => {
    const eventlog = { append(kind, payload, traceId) {
      options.eventlog?.append(kind, { ...payload, provider }, traceId);
    } };
    return provider === 'fish' ? createFish({ ...options, eventlog,
      apiKey: options.openrouterApiKey, model: options.fishModel, voice: options.fishVoice })
      : createGemini({ ...options, eventlog });
  });
  return { async synthesize(text, opts = {}) {
    const results = [];
    for (const [index, instance] of providers.entries()) {
      const result = await instance.synthesize(text, { ...opts, providerFallback: index > 0 });
      if (result.pcm || ['empty', 'interrupted'].includes(result.skipped)) return result;
      results.push(result.skipped);
    }
    if (!options.providers && providers.length === 1 && order[0] === 'gemini' && results[0] === 'disabled') return { skipped: 'disabled' };
    return { skipped: results.length && results.every(r => r === 'rate_limited') ? 'rate_limited' : 'failed' };
  } };
}
