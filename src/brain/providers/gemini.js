import { readSse } from './sse.js';

export function createGeminiProvider({ baseUrl, apiKey, fetch = globalThis.fetch }) {
  return {
    async generate({ model, system, user, thinking, json = false, stream = false, signal, onText }) {
      const start = performance.now();
      let text = '';
      let status = null;
      let ttftMs = null;
      let usage = null;
      const result = ok => ({ ok, text, status, ttftMs, totalMs: performance.now() - start, usage });
      const accept = data => {
        usage = data.usageMetadata ?? usage;
        const visible = (data.candidates?.[0]?.content?.parts ?? [])
          .filter(part => part.thought !== true && typeof part.text === 'string').map(part => part.text).join('');
        if (!visible) return;
        ttftMs ??= performance.now() - start;
        text += visible;
        return onText?.(visible);
      };
      try {
        const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
        const response = await fetch(`${baseUrl.replace(/\/+$/u, '')}/models/${encodeURIComponent(model)}:${method}`, {
          method: 'POST', signal,
          headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            // T29 A5: thinking shares the output budget — JSON parse intents
            // (drafts plus repairs) need more headroom than one spoken line.
            generationConfig: { thinkingConfig: { thinkingLevel: thinking }, maxOutputTokens: stream ? 2048 : 4096,
              ...(json ? { responseMimeType: 'application/json' } : {}) } }),
        });
        status = response.status ?? (response.ok ? 200 : null);
        if (!response.ok) return result(false);
        if (stream) await readSse(response.body, accept, signal);
        else accept(await response.json());
        return result(true);
      } catch {
        status = null;
        return result(false);
      }
    },
  };
}
