import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureReach, reachOf } from '../src/skills/approach.js';
import { createPrimitiveRegistry } from '../src/primitives/registry.js';
import { createArbiter } from '../src/arbiter.js';
import { validateDraft } from '../src/skills/format.js';
import { mcData } from '../src/teaching/lexicon.js';

// Auto-approach: primitives declare `reach`; the executor inserts an implicit
// goTo when a resolved step's target sits beyond it (spec ②).
const OWNER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const position = { x: 0, y: 0, z: 0 };
const bot = { entity: { position }, entities: {}, players: {} };

test('approach: reach declarations cover exactly the coordinate-targeted primitives', () => {
  assert.equal(reachOf('dig'), 4.5);
  assert.equal(reachOf('place'), 4.5);
  assert.equal(reachOf('craft'), 4);
  assert.equal(reachOf('smelt'), 4);
  for (const name of ['goTo', 'goToEntity', 'say', 'findBlock', 'give', 'attack', 'deposit', 'collectDrops']) {
    assert.equal(reachOf(name), null, name);
  }
});

test('approach: ensureReach walks to a far target, idles otherwise', async () => {
  const calls = [];
  const run = async (name, params) => { calls.push({ name, params }); return { ok: true, result: params }; };
  const far = await ensureReach({ primitive: 'dig', params: { x: 10, y: 0, z: 0 }, origin: position, run });
  // Approaches the adjacent column on her side (9,0,0), never the target —
  // center-approach at any range ≥1 lets her stand on the block (unsafe_below).
  assert.deepEqual(calls, [{ name: 'goTo', params: { x: 9, y: 0, z: 0, range: 1.2 } }]);
  assert.equal(far.ok, true);
  calls.length = 0;
  // Inside reach — no walk.
  assert.equal(await ensureReach({ primitive: 'dig', params: { x: 2, y: 0, z: 0 }, origin: position, run }), null);
  // The 4.2–4.5 band: corner-distance says reachable, but dig/place measure
  // eye→centre and would still refuse — so she walks (T91 repeat_dig caught it).
  await ensureReach({ primitive: 'dig', params: { x: 3, y: 0, z: 3 }, origin: position, run });
  assert.deepEqual(calls, [{ name: 'goTo', params: { x: 2, y: 0, z: 3, range: 1.2 } }]);
  calls.length = 0;
  // …unless "inside reach" means standing on it — dig would refuse
  // unsafe_below, so she steps off to the adjacent column first.
  const onTop = { x: 2.5, y: 1, z: 0.5 };
  await ensureReach({ primitive: 'dig', params: { x: 2, y: 0, z: 0 }, origin: onTop, run });
  assert.deepEqual(calls, [{ name: 'goTo', params: { x: 3, y: 0, z: 0, range: 1.2 } }]);
  calls.length = 0;
  // No coordinate target — nothing to approach.
  assert.equal(await ensureReach({ primitive: 'craft', params: { itemName: 'stick' }, origin: position, run }), null);
  // No reach declaration — never auto-walked.
  assert.equal(await ensureReach({ primitive: 'say', params: { x: 9, y: 0, z: 0 }, origin: position, run }), null);
  // A craft bound to a station beyond its 4-block reach walks to the
  // neighbouring column on her side.
  await ensureReach({ primitive: 'craft', params: { itemName: 'stick', x: 5, y: 0, z: 0 }, origin: position, run });
  assert.deepEqual(calls, [{ name: 'goTo', params: { x: 4, y: 0, z: 0, range: 1.2 } }]);
});

test('approach: registry.approach drives the walk through the real run path', async () => {
  const appended = [];
  const registry = createPrimitiveRegistry({
    bot, mcData, ownerUuid: OWNER,
    eventlog: { append: (kind, payload, traceId) => appended.push({ kind, name: payload?.name }) },
  });
  // In reach / no reach declaration: nothing happens, nothing logged.
  assert.equal(await registry.approach({ primitive: 'dig', params: { x: 1, y: 0, z: 0 } }), null);
  assert.equal(await registry.approach({ primitive: 'say', params: { text: 'hi' } }), null);
  assert.equal(appended.length, 0);
  // Far target: the implicit goTo runs the full checked+execute path — the
  // stub bot has no pathfinder so the walk itself fails, but it must have
  // been attempted and logged like a real primitive run.
  const outcome = await registry.approach({ primitive: 'dig', params: { x: 10, y: 0, z: 0 } });
  assert.equal(outcome.ok, false);
  assert.deepEqual(appended.map(entry => [entry.kind, entry.name]),
    [['primitive.start', 'goTo'], ['primitive.end', 'goTo']]);
});

test('approach: craft and smelt accept `at`-merged and literal coordinates', () => {
  const registry = createPrimitiveRegistry({ mcData, ownerUuid: OWNER });
  // Optional coordinate triples validate; partials are rejected all-or-none.
  assert.doesNotThrow(() => registry.validate('craft', { itemName: 'stick', useTable: true, x: 1, y: 2, z: 3 }));
  assert.throws(() => registry.validate('craft', { itemName: 'stick', x: 1 }),
    /x, y and z must be given together/);
  assert.doesNotThrow(() => registry.validate('smelt', { itemName: 'sand', fuel: 'coal', x: 1, y: 2, z: 3 }));
  assert.throws(() => registry.validate('smelt', { itemName: 'sand', fuel: 'coal', x: 1, y: 2 }),
    /x, y and z must be given together/);
  // Drafts may bind a station with `at` — previously "does not take 'at'".
  const ok = value => validateDraft(value, { registry });
  const find = (blockName, id) => ({ primitive: 'findBlock', params: { blockName }, id });
  assert.equal(ok({ name: 's1', description: 't', params: {}, body: [
    find('crafting_table', 't'),
    { primitive: 'craft', params: { itemName: 'stick', useTable: true }, at: '$t' },
  ] }).ok, true);
  assert.equal(ok({ name: 's2', description: 't', params: {}, body: [
    find('furnace', 'f'),
    { primitive: 'smelt', params: { itemName: 'sand', fuel: 'coal' }, at: '$f' },
  ] }).ok, true);
});

test('approach: arbiter walks before the step and fails on a failed approach', async () => {
  const order = [];
  const go = async approachResult => {
    const arbiter = createArbiter({
      registry: {
        has: () => true,
        validate() {},
        async approach(resolved) { order.push(['approach', resolved.primitive, resolved.params]); return approachResult; },
        async run(primitive, params) { order.push(['run', primitive]); return { ok: true, result: params }; },
      },
      eventlog: { append() {} },
      clock: { now: () => 42 },
    });
    return arbiter.submit({ source: 'owner', label: 't', traceId: 'trace-approach',
      program: { body: [{ primitive: 'dig', params: { x: 9, y: 0, z: 0 } }], params: {}, args: {} } }).done;
  };
  // Approach ran first, then the step — and a no-op approach still defers to it.
  let outcome = await go(null);
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(order, [['approach', 'dig', { x: 9, y: 0, z: 0 }], ['run', 'dig']]);
  order.length = 0;
  // A failed approach is the step's failure; the primitive never runs.
  outcome = await go({ ok: false, error: { name: 'TimeoutError', message: 'no path' } });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error.name, 'TimeoutError');
  assert.deepEqual(order, [['approach', 'dig', { x: 9, y: 0, z: 0 }]]);
});
