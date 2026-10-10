import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isObject, validateDraft } from './format.js';
import { bareName } from './bindings.js';
import { resolveClock } from '../clock.js';

export { validateDraft } from './format.js';

// P2 A3: `minecraft:` is a legal alias in the grammar, so validateDraft accepts
// it — but the library still stores canonical bare names. The walk covers every
// catalog-typed position (param defaults, primitive params, call args, if and
// obtain values) except say.text: free text where a prefix is content.
function canonicalNames(value) {
  if (typeof value === 'string') return bareName(value);
  if (Array.isArray(value)) return value.map(canonicalNames);
  if (!isObject(value)) return value;
  const sayParams = value.primitive === 'say' && isObject(value.params);
  let changed = false;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    let next;
    if (sayParams && key === 'params') {
      const params = { ...item };
      for (const paramKey of Object.keys(params)) {
        if (paramKey !== 'text') params[paramKey] = canonicalNames(params[paramKey]);
      }
      next = params;
    } else {
      next = canonicalNames(item);
    }
    if (next !== item) changed = true;
    out[key] = next;
  }
  return changed ? out : value;
}
const DAY_MS = 86_400_000;

export class InvalidSkillError extends Error {
  constructor(errors) {
    super(`Invalid skill: ${errors.join('; ')}`);
    this.name = 'InvalidSkillError';
    this.errors = errors;
  }
}

export class UnknownSkillError extends Error {
  constructor(name) {
    super(`Unknown skill: ${String(name)}`);
    this.name = 'UnknownSkillError';
    this.skillName = name;
  }
}

export function createSkillLibrary({ dataDir, registry, eventlog, clock = {} }) {
  const now = resolveClock(clock).now;
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'skills.sqlite'));
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        name TEXT PRIMARY KEY, description TEXT NOT NULL,
        steps TEXT NOT NULL CHECK(json_valid(steps)), proficiency REAL NOT NULL,
        uses INTEGER NOT NULL, successes INTEGER NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, last_used_at INTEGER, version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skill_provenance (
        id INTEGER PRIMARY KEY, skill_name TEXT NOT NULL, version INTEGER NOT NULL,
        teacher_uuid TEXT NOT NULL, taught_at INTEGER NOT NULL, context TEXT NOT NULL
      );
    `);
    db.exec('BEGIN IMMEDIATE');
    const addColumns = (table, columns) => {
      const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
      for (const [name, declaration] of Object.entries(columns)) if (!existing.has(name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
      }
    };
    addColumns('skills', { params: "TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(params))",
      format: 'INTEGER NOT NULL DEFAULT 1' });
    addColumns('skill_provenance', { route: "TEXT NOT NULL DEFAULT 'taught'", parent_skill: 'TEXT', trace_id: 'TEXT' });
    const legacy = db.prepare('SELECT name, steps FROM skills WHERE format = 1').all();
    for (const row of legacy) {
      const body = JSON.parse(row.steps).map(node => node.skill === undefined ? node : { call: node.skill, args: {} });
      db.prepare('UPDATE skills SET steps = ?, format = 2 WHERE name = ?').run(JSON.stringify(body), row.name);
    }
    db.prepare("UPDATE skill_provenance SET route = 'innate' WHERE teacher_uuid = 'innate'").run();
    db.exec('COMMIT');
    if (legacy.length) eventlog?.append('skills.migrated', { count: legacy.length });
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    db.close();
    throw error;
  }
  const select = db.prepare('SELECT * FROM skills WHERE name = ?');
  const teachings = db.prepare(`
    SELECT teacher_uuid, taught_at, version, context, route, parent_skill, trace_id
    FROM skill_provenance WHERE skill_name = ? ORDER BY id
  `);
  const rows = db.prepare('SELECT * FROM skills ORDER BY name');
  let closed = false;
  function get(name) {
    const row = select.get(name);
    if (!row) return null;
    const body = JSON.parse(row.steps);
    return { ...row, params: JSON.parse(row.params), body, steps: body,
      provenance: teachings.all(name).map(row => ({ ...row })) };
  }
  function requireSkill(name) {
    const skill = get(name);
    if (!skill) throw new UnknownSkillError(name);
    return skill;
  }
  const list = () => rows.all().map(row => get(row.name));
  const validate = (draft, options) => validateDraft(draft, { ...options, registry, skills: list() });

  function learn(draft, { teacherUuid, context, route = 'taught', parentSkill = null, traceId = null } = {}) {
    const validation = validate(draft, { taught: route === 'taught' });
    if (!validation.ok) throw new InvalidSkillError(validation.errors);
    const errors = [];
    if (!['taught', 'innate'].includes(route)) errors.push('unsupported learning route');
    if (typeof teacherUuid !== 'string' || !teacherUuid) errors.push('teacherUuid must be a nonempty string');
    if (typeof context !== 'string') errors.push('context must be a string');
    if (parentSkill !== null && typeof parentSkill !== 'string') errors.push('invalid parentSkill');
    if (traceId !== null && typeof traceId !== 'string') errors.push('invalid traceId');
    if (errors.length) throw new InvalidSkillError(errors);
    const timestamp = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = get(draft.name);
      const version = previous ? previous.version + 1 : 1;
      db.prepare(`
        INSERT INTO skills (name, description, steps, params, format, proficiency, uses, successes,
          created_at, updated_at, last_used_at, version)
        VALUES (?, ?, ?, ?, 2, 0.3, 0, 0, ?, ?, NULL, ?)
        ON CONFLICT(name) DO UPDATE SET
          description = excluded.description, steps = excluded.steps, params = excluded.params, format = 2,
          proficiency = MAX(skills.proficiency, 0.3), updated_at = excluded.updated_at, version = excluded.version
      `).run(draft.name, draft.description ?? '', JSON.stringify(canonicalNames(draft.body)),
        JSON.stringify(canonicalNames(draft.params ?? {})), timestamp, timestamp, version);
      db.prepare(`
        INSERT INTO skill_provenance (skill_name, version, teacher_uuid, taught_at, context, route, parent_skill, trace_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(draft.name, version, teacherUuid, timestamp, context, route, parentSkill, traceId);
      const skill = get(draft.name);
      db.exec('COMMIT');
      return { skill, isNew: !previous, previousTeachings: previous?.provenance ?? [] };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function learnSelfProgram({ name, description, params = {}, body, traceId, context, nowMs } = {}) {
    const draft = { name, description, params, body };
    const validation = validate(draft);
    const errors = validation.ok ? [] : [...validation.errors];
    if (typeof traceId !== 'string' || !traceId) errors.push('traceId must be a nonempty string');
    if (errors.length) throw new InvalidSkillError(errors);
    const timestamp = nowMs ?? now();
    const storedContext = typeof context === 'string' ? context : JSON.stringify(context ?? null);
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = get(name);
      if (!previous) {
        db.prepare(`
          INSERT INTO skills (name, description, steps, params, format, proficiency, uses, successes,
            created_at, updated_at, last_used_at, version)
          VALUES (?, ?, ?, ?, 2, 0.3, 0, 0, ?, ?, NULL, 1)
        `).run(name, draft.description, JSON.stringify(canonicalNames(draft.body)),
          JSON.stringify(canonicalNames(draft.params)), timestamp, timestamp);
      }
      db.prepare(`
        INSERT INTO skill_provenance (skill_name, version, teacher_uuid, taught_at, context, route, parent_skill, trace_id)
        VALUES (?, ?, ?, ?, ?, 'self', NULL, ?)
      `).run(name, previous ? previous.version : 1, 'self', timestamp, storedContext, traceId);
      const skill = get(name);
      db.exec('COMMIT');
      return { skill, isNew: !previous };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function learnSelf({ item, count, traceId, plan, nowMs } = {}) {
    return learnSelfProgram({ name: `make_${String(item)}`, description: `Obtain ${item}`,
      params: { count: { type: 'quantity', default: 1 } },
      body: [{ obtain: { item, count: '$count' } }],
      traceId, context: { goal: { item, count }, plan }, nowMs });
  }
  return {
    validateDraft: validate, learn, learnSelf, learnSelfProgram, get, list,
    has: name => select.get(name) !== undefined,
    recordOutcome(name, ok) {
      requireSkill(name);
      const timestamp = now();
      db.prepare(`
        UPDATE skills SET uses = uses + 1, successes = successes + ?,
          proficiency = CASE WHEN ? THEN proficiency + (1 - proficiency) * 0.25 ELSE proficiency * 0.8 END,
          last_used_at = ?, updated_at = ? WHERE name = ?
      `).run(ok ? 1 : 0, ok ? 1 : 0, timestamp, timestamp, name);
    },
    effectiveProficiency(name) {
      const skill = requireSkill(name);
      const elapsedDays = (now() - (skill.last_used_at ?? skill.created_at)) / DAY_MS;
      return Math.max(0.05, skill.proficiency * 0.97 ** Math.max(0, elapsedDays - 7));
    },
    close() {
      if (closed) return;
      db.close();
      closed = true;
    },
  };
}
