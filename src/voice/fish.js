import { resolveClock } from '../clock.js';

const endpoint = 'https://openrouter.ai/api/v1/audio/speech';

export function createFish({ apiKey, model = 'fish-audio/s2.1-pro-free:free', voice = '',
  timeoutMs = 15000, fetch = globalThis.fetch, eventlog, clock = {} } = {}) {
  const timers = resolveClock(clock);
  const now = timers.now;
  const schedule = timers.setTimeout;
  const clear = timers.clearTimeout;
  let disabled = false, cooldownUntil = 0;
  return { async synthesize(text, { signal, traceId, providerFallback = false } = {}) {
    const input = Array.from(String(text ?? '').trim()).slice(0, 200).join('');
    const started = now();
    let firstChunkMs = null, ok = false, reader, timer;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const log = (kind, payload) => eventlog?.append(kind, { provider: 'fish', ...payload }, traceId);
    try {
      if (!input) return { skipped: 'empty' };
      if (signal?.aborted) return { skipped: 'interrupted' };
      if (disabled) return { skipped: 'disabled' };
      if (now() < cooldownUntil) return { skipped: 'rate_limited' };
      signal?.addEventListener('abort', abort, { once: true });
      const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => {
        void reader?.cancel().catch(() => {});
        reject(new Error('aborted'));
      }, { once: true }));
      timer = schedule(abort, timeoutMs);
      const attempt = async () => {
        const response = await fetch(endpoint, { method: 'POST', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, input, response_format: 'pcm', ...(voice ? { voice } : {}) }) });
        if (controller.signal.aborted) { void response.body?.cancel?.().catch(() => {}); throw new Error('aborted'); }
        if (response.status !== 200) {
          void response.body?.cancel?.().catch(() => {});
          if (response.status === 429) {
            cooldownUntil = now() + 60000;
            log('voice.rate_limited', { model, cooldownMs: 60000 });
            return { skipped: 'rate_limited' };
          }
          if ([400, 401, 402, 403].includes(response.status)) {
            disabled = true; log('voice.disabled', { status: response.status });
            return { skipped: 'disabled' };
          }
          log('voice.error', { status: response.status });
          return { skipped: 'failed' };
        }
        const parts = (response.headers.get('Content-Type') ?? '').split(';').map(p => p.trim().toLowerCase());
        const params = Object.fromEntries(parts.slice(1).map(p => p.split('=').map(v => v.trim())));
        const rate = Number(params.rate);
        if (parts[0] !== 'audio/pcm' || !/^\d+$/u.test(params.rate ?? '') ||
            !Number.isSafeInteger(rate) || rate < 1 || params.channels !== '1') {
          void response.body?.cancel?.().catch(() => {}); throw new Error('format');
        }
        reader = response.body.getReader();
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) throw new Error('aborted');
          if (done) break;
          if (value.length) { firstChunkMs ??= now() - started; chunks.push(Buffer.from(value)); }
        }
        const pcm = Buffer.concat(chunks);
        if (!pcm.length || pcm.length % 2) throw new Error('PCM');
        ok = true;
        return { pcm, sampleRate: rate, model };
      };
      return await Promise.race([attempt(), aborted]);
    } catch {
      if (signal?.aborted) return { skipped: 'interrupted' };
      log('voice.error', { reason: controller.signal.aborted ? 'timeout' : 'synthesis' });
      return { skipped: 'failed' };
    } finally {
      clear(timer); signal?.removeEventListener('abort', abort);
      void reader?.cancel().catch(() => {});
      log('voice.synth', { model, firstChunkMs, totalMs: now() - started, ok,
        fallbackUsed: providerFallback, chars: Array.from(input).length });
    }
  }, synthesizeOnce({ text, signal, ...options }) { return this.synthesize(text, { signal, ...options }); } };
}
