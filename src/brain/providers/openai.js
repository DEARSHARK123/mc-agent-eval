import { readSse } from './sse.js';

export function createOpenAIProvider({ baseUrl, apiKey, fetch = globalThis.fetch }) {
  return {
    async generate({ model, system, user, json = false, stream = false, signal, onText }) {
      const start = performance.now();
      let text = '';
      let status = null;
      let ttftMs = null;
      let usage = null;
      const result = ok => ({ ok, text, status, ttftMs, totalMs: performance.now() - start, usage });
      const accept = data => {
        usage = data.usage ?? usage;
        const visible = stream ? data.choices?.[0]?.delta?.content : data.choices?.[0]?.message?.content;
        if (typeof visible !== 'string' || !visible) return;
        ttftMs ??= performance.now() - start;
        text += visible;
        return onText?.(visible);
      };
      try {
        const response = await fetch(`${baseUrl.replace(/\/+$/u, '')}/chat/completions`, {
          method: 'POST', signal,
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            stream, ...(json ? { response_format: { type: 'json_object' } } : {}) }),
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
