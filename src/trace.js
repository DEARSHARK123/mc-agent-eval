import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export function createTraceId() {
  return randomUUID();
}

export function span(traceId, name) {
  const started = performance.now();
  let result;
  return {
    end() {
      result ??= { trace_id: traceId, name, duration_ms: performance.now() - started };
      return result;
    },
  };
}
