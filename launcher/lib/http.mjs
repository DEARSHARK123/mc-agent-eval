import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function authorize(req, token, port) {
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return 403;
  const received = req.headers['x-launcher-token'];
  if (typeof received !== 'string') return 401;
  const actual = Buffer.from(received);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? 200 : 401;
}

async function jsonBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw Object.assign(new Error('仅接受 application/json'), { status: 415 });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw Object.assign(new Error('请求体超过 64KB'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw Object.assign(new Error('JSON 请求无效'), { status: 400 }); }
}

export function createLauncherHttp({ token, store, manager, uiFile, skinFile, quit = async () => {} }) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const port = server.address().port;
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return reply(res, 403, { error: 'Host 不允许' });
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname.startsWith('/api/')) {
        const auth = authorize(req, token, port);
        if (auth !== 200) return reply(res, auth, { error: '启动器鉴权失败' });
        if (req.method === 'GET' && url.pathname === '/api/state') return reply(res, 200, manager.state());
        if (req.method === 'GET' && url.pathname === '/api/logs') {
          const source = url.searchParams.get('source');
          const after = Number(url.searchParams.get('after') ?? 0);
          if (!Object.hasOwn(manager.logs, source) || !Number.isSafeInteger(after) || after < 0) return reply(res, 400, { error: '日志参数无效' });
          return reply(res, 200, { lines: manager.logs[source].after(after) });
        }
        if (req.method !== 'POST') return reply(res, 405, { error: '请求方法不允许' });
        const body = await jsonBody(req);
        if (url.pathname === '/api/settings') return reply(res, 200, store.update(body));
        if (url.pathname === '/api/detect') return reply(res, 200, store.redetect());
        if (url.pathname === '/api/start' || url.pathname === '/api/restart-companion') {
          const operation = url.pathname === '/api/start' ? manager.start() : manager.restartCompanion();
          operation.catch(() => {});
          return reply(res, 202, { ok: true });
        }
        if (url.pathname === '/api/stop') { await manager.stop(); return reply(res, 200, { ok: true }); }
        if (url.pathname === '/api/demo') { manager.demo(); return reply(res, 202, { ok: true }); }
        if (url.pathname === '/api/give-planks') { manager.givePlanks(); return reply(res, 200, { ok: true }); }
        if (url.pathname === '/api/quit') {
          await manager.stop();
          reply(res, 200, { ok: true });
          setImmediate(() => { Promise.resolve(quit()).catch(() => {}); });
          return;
        }
        return reply(res, 404, { error: '接口不存在' });
      }
      if (req.method === 'GET' && ['/', '/skin.png'].includes(url.pathname)) {
        const skin = url.pathname === '/skin.png';
        const data = readFileSync(skin ? skinFile : uiFile);
        res.writeHead(200, { 'Content-Type': skin ? 'image/png' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data);
        return;
      }
      reply(res, 404, { error: '页面不存在' });
    } catch (error) {
      reply(res, error.status ?? 400, { error: error.code ? '操作失败，请检查文件权限或设置' : error.message });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return server;
}

export async function listenAvailable(server, firstPort = 37615) {
  for (let port = firstPort; port <= 65535; port++) {
    try {
      await new Promise((resolve, reject) => {
        const failed = error => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', failed); resolve(); };
        server.once('error', failed);
        server.once('listening', ready);
        server.listen(port, '127.0.0.1');
      });
      return server.address().port;
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  throw new Error('没有可用启动器端口');
}
