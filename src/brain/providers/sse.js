// Decode UTF-8 and SSE lines incrementally: neither characters nor lines align with chunks.
export async function readSse(body, onData, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = [];
  let stopped = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  function line(value) {
    if (!value) {
      if (!event.length) return;
      const data = event.join('\n');
      event = [];
      if (data === '[DONE]' || onData(JSON.parse(data)) === false) stopped = true;
    } else if (value.startsWith('data:')) {
      event.push(value.slice(5).trimStart());
    }
  }
  try {
    while (!stopped && !signal?.aborted) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end;
      while (!stopped && (end = buffer.indexOf('\n')) !== -1) {
        line(buffer.slice(0, end).replace(/\r$/u, ''));
        buffer = buffer.slice(end + 1);
      }
      if (done) {
        if (!stopped && buffer) line(buffer.replace(/\r$/u, ''));
        if (!stopped) line('');
        break;
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
