import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTraceId } from './trace.js';

export function createEventLog(dataDir, { now = Date.now } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'events.sqlite'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      trace_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL CHECK(json_valid(payload))
    );
  `);
  const insert = db.prepare(
    'INSERT INTO events (ts, trace_id, kind, payload) VALUES (?, ?, ?, ?)'
  );
  let closed = false;

  return {
    append(kind, payload, traceId = createTraceId()) {
      if (closed) return null;
      if (typeof kind !== 'string' || !kind) throw new Error('kind is required');
      if (typeof traceId !== 'string' || !traceId) throw new Error('traceId is required');
      const json = JSON.stringify(payload);
      if (json === undefined) throw new Error('payload must be JSON serializable');
      const ts = now();
      const { lastInsertRowid } = insert.run(ts, traceId, kind, json);
      return { id: Number(lastInsertRowid), ts, trace_id: traceId, kind, payload: JSON.parse(json) };
    },
    query({ kind, since, limit = 100 } = {}) {
      if (closed) return [];
      if (!Number.isSafeInteger(limit) || limit < 0) {
        throw new Error('limit must be a non-negative safe integer');
      }
      if (since !== undefined && !Number.isSafeInteger(since)) {
        throw new Error('since must be an integer timestamp');
      }
      const filters = [];
      const params = [];
      if (kind !== undefined) {
        filters.push('kind = ?');
        params.push(kind);
      }
      if (since !== undefined) {
        filters.push('ts >= ?');
        params.push(since);
      }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      return db.prepare(`SELECT * FROM events ${where} ORDER BY id ASC LIMIT ?`)
        .all(...params, limit)
        .map(row => ({ ...row, payload: JSON.parse(row.payload) }));
    },
    close() {
      if (closed) return;
      db.close();
      closed = true;
    },
  };
}
