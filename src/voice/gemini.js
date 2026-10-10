import { readSse } from '../brain/providers/sse.js';
import { resolveClock } from '../clock.js';

export function createGemini({ baseUrl, apiKey, model = 'gemini-3.8-flash-lite-tts',
  fallbackModels = ['gemini-3.8-flash-tts'], voice = 'Leda', timeoutMs = 15000,
  fetch = globalThis.fetch, eventlog, clock = {} } = {}) {
  const timers = resolveClock(clock);
  const now = timers.now;
  const schedule = timers.setTimeout;
  const unschedule = timers.clearTimeout;
  const models = [...new Set([model, ...fallbackModels])];
  let disabled = false;
  const cooldownUntil = new Map();
  const log = (kind, payload, traceId) => eventlog?.append(kind, payload, traceId);

  return {
    async synthesize(text, { style, traceId, signal, providerFallback = false } = {}) {
      const spoken = Array.from(String(text ?? '').trim()).slice(0, 200).join('');
      const started = now();
      let usedModel = model;
      let firstChunkMs = null;
      let fallbackUsed = false;
      let ok = false;
      try {
        if (!spoken) return { skipped: 'empty' };
        if (signal?.aborted) return { skipped: 'interrupted' };
        if (disabled) return { skipped: 'disabled' };
        for (const [index, candidate] of models.entries()) {
          if (now() < (cooldownUntil.get(candidate) ?? 0)) continue;
          usedModel = candidate;
          fallbackUsed = index > 0;
          const controller = new AbortController();
          const abort = () => controller.abort();
          signal?.addEventListener('abort', abort, { once: true });
          let timer;
          let onAbort;
          try {
            // Race the whole attempt, including reading the stream, against its deadline.
            const aborted = new Promise((_, reject) => {
              onAbort = () => reject(new Error('aborted'));
              controller.signal.addEventListener('abort', onAbort, { once: true });
            });
            timer = schedule(() => controller.abort(), timeoutMs);
            const attempt = async () => {
              const response = await fetch(`${baseUrl.replace(/\/+$/u, '')}/models/${encodeURIComponent(candidate)}:streamGenerateContent?alt=sse`, {
                method: 'POST', signal: controller.signal,
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                body: JSON.stringify({ contents: [{ parts: [{ text: style
                  ? `### DIRECTOR'S NOTES\nStyle: ${style}\n\n### TRANSCRIPT\n${spoken}` : spoken }] }],
                  generationConfig: { responseModalities: ['AUDIO'],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } }),
              });
              if (controller.signal.aborted) throw new Error('aborted');
              if (!response.ok) {
                void response.body?.cancel?.().catch(() => {});
                return { status: response.status };
              }
              const chunks = [];
              let sampleRate = null;
              await readSse(response.body, data => {
                if (controller.signal.aborted) return false;
                for (const part of data.candidates?.[0]?.content?.parts ?? []) {
                  if (!part.inlineData?.data) continue;
                  const mime = /^audio\/l16;\s*rate=(\d+);\s*channels=1$/iu.exec(part.inlineData.mimeType);
                  if (!mime || (sampleRate !== null && sampleRate !== Number(mime[1]))) throw new Error('invalid audio format');
                  sampleRate = Number(mime[1]);
                  if (!Number.isSafeInteger(sampleRate) || sampleRate < 1) throw new Error('invalid sample rate');
                  const chunk = Buffer.from(part.inlineData.data, 'base64');
                  if (chunk.length) {
                    if (firstChunkMs === null) firstChunkMs = now() - started;
                    chunks.push(chunk);
                  }
                }
              }, controller.signal);
              if (controller.signal.aborted) throw new Error('aborted');
              const pcm = Buffer.concat(chunks);
              if (!pcm.length || pcm.length % 2) throw new Error('invalid PCM');
              return { pcm, sampleRate, model: candidate };
            };
            const result = await Promise.race([attempt(), aborted]);
            if (result.pcm) { ok = true; return result; }
            if (result.status === 429) {
              cooldownUntil.set(candidate, now() + 60000);
              log('voice.rate_limited', { model: candidate, cooldownMs: 60000 }, traceId);
              continue;
            }
            log('voice.error', { model: candidate, status: result.status }, traceId);
            if ([400, 401, 403].includes(result.status)) {
              disabled = true;
              log('voice.disabled', { reason: 'http', status: result.status }, traceId);
              return { skipped: 'disabled' };
            }
            if (![500, 503].includes(result.status)) return { skipped: 'failed' };
          } catch {
            if (signal?.aborted) return { skipped: 'interrupted' };
            log('voice.error', { model: candidate, reason: controller.signal.aborted ? 'timeout' : 'synthesis' }, traceId);
          } finally {
            unschedule(timer);
            signal?.removeEventListener('abort', abort);
            controller.signal.removeEventListener('abort', onAbort);
            controller.abort();
          }
        }
        return { skipped: models.every(candidate => now() < (cooldownUntil.get(candidate) ?? 0))
          ? 'rate_limited' : 'failed' };
      } finally {
        log('voice.synth', { model: usedModel, firstChunkMs, totalMs: now() - started,
          ok, fallbackUsed: fallbackUsed || providerFallback, chars: Array.from(spoken).length }, traceId);
      }
    },
  };
}
