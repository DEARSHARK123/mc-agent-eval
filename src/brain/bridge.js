import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';

export function createBridge({ tools = [] } = {}) {
  const token = randomBytes(32).toString('hex');
  const events = new EventEmitter();
  let run = null, url, host, closed = false;
  const controllers = new Set();
  const manifest = () => tools.map(({ name, description, parameters }) =>
    ({ name, description, parameters: JSON.parse(JSON.stringify(parameters)) }));
  const server = http.createServer(async (req, res) => {
    const reply = (status, body) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); } };
    const supplied = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /u, ''));
    const expected = Buffer.from(token);
    if (req.headers.host !== host) return reply(403, { error: 'host' });
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401, { error: 'auth' });
    if (req.method === 'GET' && req.url === '/manifest') return reply(200, manifest());
    if (req.method === 'GET' && req.url === '/run') return run ? reply(200, { systemPrompt: run.systemPrompt }) : reply(409, { error: 'no_run' });
    if (req.method !== 'POST' || !['/tool', '/report'].includes(req.url)) return reply(404, { error: 'route' });
    const controller = new AbortController();
    controllers.add(controller);
    req.on('aborted', () => controller.abort());
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) { reply(413, { error: 'body_limit' }); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, { error: 'json' }); }
      if (req.url === '/report') {
        if (!['ready', 'tools_mismatch'].includes(body.kind) || !Array.isArray(body.tools)) return reply(400, { error: 'report' });
        const names = manifest().map(t => t.name).sort();
        const actual = body.tools.filter(t => typeof t === 'string').sort();
        const kind = body.kind === 'ready' && JSON.stringify(names) === JSON.stringify(actual) ? 'ready' : 'tools_mismatch';
        events.emit('report', { kind, tools: actual });
        return reply(200, { ok: true });
      }
      const current = run;
      if (!current || current.signal?.aborted) return reply(409, { error: 'no_run' });
      const tool = current.tools.find(t => t.name === body.name);
      if (!tool) return reply(400, { error: 'tool' });
      const abort = () => controller.abort();
      current.signal?.addEventListener('abort', abort, { once: true });
      try {
        const result = await tool.execute(body.toolCallId, body.args, controller.signal);
        events.emit('tool_result', result);
        reply(200, { content: result.content, details: result.details });
      } finally { current.signal?.removeEventListener('abort', abort); }
    } catch { reply(500, { error: 'bridge_failed' }); }
    finally { controllers.delete(controller); }
  });
  return { events, server, manifest, get url() { return url; }, get token() { return token; },
    setTools(value) { tools = value; }, setRun(value) { run = value; },
    async start() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      host = `127.0.0.1:${server.address().port}`; url = `http://${host}`;
    },
    close() {
      if (closed) return Promise.resolve();
      closed = true; run = null;
      for (const controller of controllers) controller.abort();
      return new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    } };
}
