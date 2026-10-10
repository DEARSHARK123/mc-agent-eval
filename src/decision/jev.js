import { resolveClock } from '../clock.js';

function finite01(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function errorResult(code, started, now, model) {
  return { ok: false, error: { code }, latencyMs: Math.max(0, now() - started), model };
}

function validateAnswer(question, answer) {
  if (!answer || typeof answer !== 'object') return false;
  if (question.type === 'choice') {
    return typeof answer.choice === 'string' && Object.hasOwn(question.criteria ?? {}, answer.choice) && finite01(answer.confidence);
  }
  if (question.type === 'score') {
    return typeof answer.score === 'number' && Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= question.criteria.length - 1 + 0.1
      && (answer.confidence === undefined || finite01(answer.confidence));
  }
  if (question.type === 'noul') return finite01(answer.noul);
  return false;
}

export function createJev({ apiKey, model = 'jev-latest', baseUrl = 'https://api.typesafe.ai', timeoutMs = 2_000,
  fetch: fetchImpl = globalThis.fetch, eventlog = { append() {} }, clock = {}, } = {}) {
  const endpoint = `${String(baseUrl).replace(/\/+$/u, '')}/v1/systemone`;
  const timers = resolveClock(clock);
  const now = timers.now;
  const ask = async ({ state, questions, signal, traceId } = {}) => {
    const started = now();
    const questionIds = Object.keys(questions ?? {});
    const log = (result, usage) => {
      try {
        eventlog.append('jev.call', { model, question_ids: questionIds, ok: result.ok,
          ...(result.ok ? { latency_ms: result.latencyMs, ...(usage?.input_tokens !== undefined ? { input_tokens: usage.input_tokens } : {}),
            ...(usage?.output_tokens !== undefined ? { output_tokens: usage.output_tokens } : {}) }
            : { latency_ms: result.latencyMs, error_code: result.error.code }) }, traceId);
      } catch {}
      return result;
    };
    if (signal?.aborted) return log(errorResult('cancelled', started, now, model));
    if (typeof fetchImpl !== 'function' || typeof apiKey !== 'string' || !apiKey.trim()) {
      return log(errorResult('network', started, now, model));
    }
    const controller = new AbortController();
    let timeout;
    const cancel = () => controller.abort(signal?.reason ?? new Error('cancelled'));
    const timer = () => controller.abort(new Error('timeout'));
    try {
      signal?.addEventListener('abort', cancel, { once: true });
      timeout = timers.setTimeout(timer, timeoutMs);
      let response;
      try {
        const request = fetchImpl(endpoint, { method: 'POST', headers: {
          Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json',
        }, body: JSON.stringify({ state, model, questions }), signal: controller.signal });
        const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
        response = await Promise.race([request, aborted]);
      } catch (error) {
        if (signal?.aborted || (controller.signal.aborted && signal?.aborted)) return log(errorResult('cancelled', started, now, model));
        if (controller.signal.aborted) return log(errorResult('timeout', started, now, model));
        return log(errorResult('network', started, now, model));
      }
      if (!response?.ok) return log(errorResult(`http_${response?.status ?? 0}`, started, now, model));
      let body;
      try {
        const bodyRead = response.json();
        const aborted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
        body = await Promise.race([bodyRead, aborted]);
      } catch {
        if (signal?.aborted) return log(errorResult('cancelled', started, now, model));
        if (controller.signal.aborted) return log(errorResult('timeout', started, now, model));
        return log(errorResult('bad_response', started, now, model));
      }
      if (!body || typeof body !== 'object' || !body.answers || typeof body.answers !== 'object') {
        return log(errorResult('bad_response', started, now, model));
      }
      for (const [id, question] of Object.entries(questions ?? {})) {
        if (!validateAnswer(question, body.answers[id])) return log(errorResult('bad_response', started, now, model));
      }
      const latencyMs = Math.max(0, now() - started);
      return log({ ok: true, answers: body.answers, usage: body.usage ?? {}, latencyMs, model }, body.usage);
    } finally {
      if (timeout !== undefined) timers.clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
    }
  };
  return { ask, model, enabled: Boolean(apiKey) };
}
