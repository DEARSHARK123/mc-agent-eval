import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from '../src/primitives/helpers.js';
import { decideProactive, PROACTIVE_PRIMITIVES } from '../src/proactive/decide.js';
import { createProactive } from '../src/proactive/index.js';
import { createLearningBudget } from '../src/proactive/budget.js';
import { createDialogue } from '../src/dialogue.js';
import { proactiveEnvironment } from '../scripts/e2e-proactive.mjs';
const data = createRequire(import.meta.url)('minecraft-data')('1.20.4');
const OWNER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const s = (v = {}) => ({ now: 100_000, isSleeping: false, idle: true, owner: null,
  ownerHurtAt: -Infinity, nightfall: false, drops: [], freeSlots: 5, lastGiveAt: -Infinity,
  quietSince: 0, openQuestion: false, proposal: null, budget: { remaining: 30, reserve: 8 },
  last: {}, ...v });
const own = (v = {}) => ({ uuid: 'owner-uuid', distance: 4, health: 20, ...v });
const drop = (v = {}) => ({ distance: 5, ownerDistance: null, ...v });
const kind = v => decideProactive(s(v), {})?.kind ?? null;

test('sleeping suppresses every action including remarks', () => {
  for (const v of [{ owner: own(), ownerHurtAt: 99_500 }, { owner: own(), nightfall: true },
    { drops: [drop()] }, { owner: own({ distance: 30 }) },
    { owner: own(), proposal: { item: 'stick', count: 1 } }]) {
    assert.equal(kind({ ...v, isSleeping: true }), null);
  }
});

test('owner_hurt threshold, null health, window and cooldown', () => {
  const hurt = v => decideProactive(s({ owner: own(v), ownerHurtAt: 99_500, ...v }), {});
  assert.deepEqual(hurt({ health: 14 }), { kind: 'remark', reason: 'owner_hurt', health: 14 });
  assert.deepEqual(hurt({ health: null }), { kind: 'remark', reason: 'owner_hurt', health: null });
  assert.equal(hurt({ health: 18 }), null);
  assert.equal(kind({ owner: own({ health: 10 }), ownerHurtAt: 96_000 }), null, 'hurt older than 3s');
  assert.equal(kind({ owner: own({ health: 10 }), ownerHurtAt: 99_500, last: { owner_hurt: 95_000 } }), null, 'within 60s cooldown');
  assert.deepEqual(decideProactive(s({ owner: own({ health: 10 }), ownerHurtAt: 99_500, last: { owner_hurt: 40_000 } }), {}).reason, 'owner_hurt');
  assert.equal(kind({ owner: own({ distance: 33, health: 10 }), ownerHurtAt: 99_500 }), 'stay_near', 'past 32 blocks the hurt is ignored');
});

test('nightfall remarks even while the arbiter is busy', () => {
  assert.deepEqual(decideProactive(s({ owner: own(), nightfall: true }), {}), { kind: 'remark', reason: 'nightfall', bed: 'none' });
  assert.deepEqual(decideProactive(s({ owner: own(), nightfall: true, idle: false }), {}), { kind: 'remark', reason: 'nightfall', bed: 'none' });
  assert.equal(kind({ owner: own({ distance: 33 }), nightfall: true }), 'stay_near');
  assert.equal(kind({ nightfall: true }), null, 'no owner means nobody to remind');
});

test('busy arbiter blocks pickup stay_near and propose but not remarks', () => {
  for (const v of [
    { drops: [drop()] },
    { owner: own({ distance: 30 }) },
    { owner: own(), proposal: { item: 'stick', count: 1 }, quietSince: 0 },
  ]) assert.equal(kind({ ...v, idle: false }), null);
});

test('pickup rules distance owner proximity free slots give and cooldown', () => {
  const base = { drops: [drop()], freeSlots: 5 };
  assert.deepEqual(decideProactive(s(base), {}).steps, [{ primitive: 'collectDrops', params: { radius: 8 } }]);
  assert.equal(kind({ drops: [drop({ distance: 9 })] }), null, 'drop outside pickup radius');
  assert.equal(kind({ drops: [drop({ distance: 5, ownerDistance: 2 })] }), null, 'drop at the owner feet stays');
  assert.deepEqual(decideProactive(s({ drops: [drop({ distance: 5, ownerDistance: 4 })] }), {}).kind, 'pickup');
  assert.equal(kind({ ...base, freeSlots: 0 }), null, 'full inventory');
  assert.equal(kind({ ...base, lastGiveAt: 95_000 }), null, 'gave something 5s ago');
  assert.deepEqual(decideProactive(s({ ...base, lastGiveAt: 84_000 }), {}).kind, 'pickup', 'gave 16s ago');
  assert.equal(kind({ ...base, last: { pickup: 97_000 } }), null, 'pickup cooldown 4s');
  assert.equal(decideProactive(s({ ...base, last: { pickup: 96_000 } }), {}).kind, 'pickup');
});

test('stay_near distance band and cooldown', () => {
  const action = decideProactive(s({ owner: own({ distance: 7 }) }), {});
  assert.deepEqual(action.steps, [{ primitive: 'goToEntity', params: { uuid: 'owner-uuid', range: 3 } }]);
  assert.equal(kind({ owner: own({ distance: 5 }) }), null);
  assert.equal(kind({ owner: own({ distance: 70 }) }), null);
  assert.equal(kind({ owner: own({ distance: 7 }), last: { stay_near: 99_000 } }), null, '2s cooldown');
  assert.equal(decideProactive(s({ owner: own({ distance: 7 }), last: { stay_near: 98_000 } }), {}).kind, 'stay_near');
});

test('proposal needs every condition', () => {
  const c = { idleProposalMs: 30_000, proposalCooldownMs: 60_000 };
  const good = { owner: own({ distance: 6 }), proposal: { item: 'wooden_pickaxe', count: 1 }, quietSince: 0 };
  assert.deepEqual(decideProactive(s(good), c), { kind: 'propose', item: 'wooden_pickaxe', count: 1 });
  for (const v of [
    { owner: own({ distance: 9 }), last: { stay_near: 100_000 } }, { owner: null }, { proposal: null },
    { budget: { remaining: 7, reserve: 8 } }, { quietSince: 99_000 },
    { last: { propose: 99_000 } }, { openQuestion: true },
  ]) assert.equal(decideProactive(s({ ...good, ...v }), c), null, JSON.stringify(v));
  assert.equal(decideProactive(s({ ...good, last: { propose: 30_000 } }), c).kind, 'propose');
});

test('rule order: remarks precede idle block, pickup precedes stay_near', () => {
  // owner_hurt wins over a pending pickup even while the arbiter is busy.
  assert.equal(kind({ owner: own({ health: 10 }), ownerHurtAt: 99_500, idle: false, drops: [drop()] }), 'remark');
  assert.equal(kind({ owner: own({ distance: 30 }), drops: [drop()] }), 'pickup', 'pickup wins over stay_near');
});

test('randomized snapshots only ever emit whitelisted primitives', () => {
  let seed = 0x5eed;
  const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  for (let i = 0; i < 2_000; i++) {
    const snapshot = s({
      now: Math.floor(rand() * 1_000_000),
      isSleeping: rand() < 0.1, idle: rand() < 0.7, nightfall: rand() < 0.1,
      ownerHurtAt: Math.floor(rand() * 1_000_000),
      owner: rand() < 0.3 ? null : own({ distance: rand() * 100, health: rand() < 0.3 ? null : rand() * 20 }),
      drops: Array.from({ length: Math.floor(rand() * 3) }, () => drop({ distance: rand() * 20, ownerDistance: rand() < 0.4 ? null : rand() * 10 })),
      freeSlots: Math.floor(rand() * 6), lastGiveAt: Math.floor(rand() * 1_000_000),
      quietSince: Math.floor(rand() * 1_000_000), openQuestion: rand() < 0.2,
      proposal: rand() < 0.4 ? { item: 'stick', count: 1 } : null,
      budget: { remaining: Math.floor(rand() * 30), reserve: 8 },
      last: { pickup: Math.floor(rand() * 1_000_000), stay_near: Math.floor(rand() * 1_000_000),
        propose: Math.floor(rand() * 1_000_000), owner_hurt: Math.floor(rand() * 1_000_000) },
    });
    const action = decideProactive(snapshot, {});
    if (!action) continue;
    for (const step of action.steps ?? []) assert.ok(PROACTIVE_PRIMITIVES.includes(step.primitive), step.primitive);
  }
});

function eventlogFake() {
  const rows = [];
  return {
    rows,
    append(kind, payload, traceId) { rows.push({ kind, payload, trace_id: traceId, ts: rows.now?.() ?? Date.now(), id: rows.length + 1 }); },
    query({ kind, since, limit = 100 } = {}) {
      return rows.filter(row => (kind === undefined || row.kind === kind) && (since === undefined || row.ts >= since)).slice(0, limit);
    },
  };
}

function proactiveFixture(overrides = {}, options = {}) {
  const events = [], tasks = [], narrations = [], timers = new Map();
  const arbiterEvents = new EventEmitter();
  let time = options.time ?? 200_000;
  const ownerEntity = options.ownerEntity === undefined
    ? { uuid: OWNER, position: new Vec3(30, 64, 0), metadata: { 9: 20 } } : options.ownerEntity;
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0, 64, 0), metadata: [] },
    isSleeping: false, time: { isDay: true }, entities: {},
    players: ownerEntity ? { TestOwner: { uuid: OWNER, entity: ownerEntity } } : {},
    inventory: { items: () => [], emptySlotCount: () => 10 },
    findBlock: () => null, blockAt: () => null,
  }, overrides);
  const clock = { now: () => time, setInterval: fn => { timers.set(1, fn); return 1; }, clearInterval: id => timers.delete(id) };
  const eventlog = eventlogFake();
  eventlog.rows.now = () => time;
  const arbiter = {
    current: () => options.current ?? null,
    submit(intent) { tasks.push(intent); return { accepted: true, done: Promise.resolve({ status: 'completed' }) }; },
    on: (e, f) => arbiterEvents.on(e, f), off: (e, f) => arbiterEvents.off(e, f),
  };
  const dialogue = options.dialogue ?? createDialogue({ clock });
  const budget = options.budget ?? createLearningBudget({ eventlog, limit: 30, clock });
  const goals = options.goals ?? { feasibility: () => ({ ok: false, reason: 'no_source' }) };
  const proactive = createProactive({ bot, registry: { validate() {} }, arbiter, eventlog,
    mcData: data, ownerUuid: OWNER, goals, budget, dialogue,
    narrate: (situation, traceId) => { narrations.push({ situation, traceId }); return Promise.resolve({ kind: situation.kind, text: 'x' }); },
    config: { tickMs: 1000, idleProposalMs: options.idleProposalMs ?? 1000, proposalCooldownMs: options.proposalCooldownMs ?? 60_000 },
    clock });
  return { bot, proactive, tasks, narrations, eventlog, arbiterEvents, dialogue, budget,
    ownerEntity, timers,
    advance(ms = 1000) { time += ms; proactive.tick(); },
    setTime(value) { time = value; } };
}

test('distant owner submits an idle goToEntity and a busy arbiter skips it', () => {
  const f = proactiveFixture();
  f.proactive.tick();
  assert.equal(f.tasks.length, 1);
  assert.equal(f.tasks[0].source, 'idle');
  assert.equal(f.tasks[0].label, 'proactive:stay_near');
  assert.deepEqual(f.tasks[0].steps, [{ primitive: 'goToEntity', params: { uuid: OWNER, range: 3 } }]);
  assert.deepEqual(f.eventlog.rows.filter(r => r.kind === 'proactive.action').map(r => r.payload.kind), ['stay_near']);
  const busy = proactiveFixture({}, { current: { source: 'owner', label: 'x' } });
  busy.proactive.tick();
  assert.equal(busy.tasks.length, 0);
});

test('owner entityHurt narrates owner_hurt; strangers do not', () => {
  const f = proactiveFixture({}, { ownerEntity: { uuid: OWNER, position: new Vec3(3, 64, 0), metadata: { 9: 10 } } });
  f.proactive.tick();
  f.bot.emit('entityHurt', { uuid: 'stranger', position: new Vec3(3, 64, 0) });
  f.proactive.tick();
  assert.equal(f.narrations.length, 0);
  f.bot.emit('entityHurt', f.ownerEntity);
  f.proactive.tick();
  assert.deepEqual(f.narrations.map(n => [n.situation.kind, n.situation.reason]), [['proactive_remark', 'owner_hurt']]);
  assert.equal(f.narrations[0].situation.ownerHealth, 10);
  assert.deepEqual(f.eventlog.rows.filter(r => r.kind === 'proactive.action').map(r => r.payload.reason), ['owner_hurt']);
  f.proactive.tick();
  assert.equal(f.narrations.length, 1, 'one remark per hurt');
  // A metadata health drop covers servers that never emit entityHurt for players.
  const g = proactiveFixture({}, { ownerEntity: { uuid: OWNER, position: new Vec3(3, 64, 0), metadata: { 9: 20 } } });
  g.proactive.tick();
  g.ownerEntity.metadata[9] = 9;
  g.proactive.tick();
  assert.deepEqual(g.narrations.map(n => n.situation.reason), ['owner_hurt']);
});

test('day to night reminds once, re-arms next night, silent when started at night', () => {
  const f = proactiveFixture();
  f.bot.entity.position = new Vec3(28, 64, 0); // stand next to the owner
  f.proactive.tick();
  f.bot.time.isDay = false;
  f.proactive.tick();
  assert.deepEqual(f.narrations.map(n => n.situation.reason), ['nightfall']);
  f.proactive.tick();
  assert.equal(f.narrations.length, 1, 'same night never repeats');
  f.bot.time.isDay = true;
  f.proactive.tick();
  f.bot.time.isDay = false;
  f.proactive.tick();
  assert.equal(f.narrations.length, 2, 'a new night re-arms');
  const night = proactiveFixture({ time: { isDay: false } });
  night.proactive.tick();
  assert.equal(night.narrations.length, 0, 'starting at night does not remind');
});

test('a give within fifteen seconds suppresses pickup', () => {
  const dropEntity = { position: new Vec3(5, 64, 0), getDroppedItem: () => ({ name: 'cobblestone' }) };
  const f = proactiveFixture({ entities: { d1: dropEntity } });
  f.eventlog.append('primitive.end', { name: 'give' });
  f.proactive.tick();
  assert.equal(f.tasks.filter(task => task.label === 'proactive:pickup').length, 0, 'fresh give suppresses pickup');
  f.advance(16_000);
  const pickup = f.tasks.find(task => task.label === 'proactive:pickup');
  assert.ok(pickup, 'pickup resumes once the give is fifteen seconds old');
  assert.deepEqual(pickup.steps, [{ primitive: 'collectDrops', params: { radius: 8 } }]);
  assert.equal(pickup.source, 'idle');
});

test('drops at the owner feet are left alone', () => {
  const f = proactiveFixture({}, { ownerEntity: { uuid: OWNER, position: new Vec3(3, 64, 0), metadata: {} } });
  f.bot.entities = { d1: { position: new Vec3(4, 64, 0), getDroppedItem: () => ({ name: 'dirt' }) } };
  f.proactive.tick();
  assert.equal(f.tasks.length, 0);
});

test('proposal candidates follow feasibility and set propose_goal without spending', () => {
  const goals = { feasibility: ({ item }) => item === 'wooden_pickaxe' ? { ok: true, plan: { summary: 'x' } } : { ok: false, reason: 'no_source' } };
  const f = proactiveFixture({}, { goals, ownerEntity: { uuid: OWNER, position: new Vec3(4, 64, 0), metadata: {} } });
  f.proactive.tick();
  assert.equal(f.narrations.length, 0, 'quiet period not met yet');
  f.advance(2_000);
  assert.deepEqual(f.narrations.map(n => n.situation.kind), ['propose']);
  assert.equal(f.narrations[0].situation.item, 'wooden_pickaxe');
  const question = f.dialogue.getQuestion();
  assert.equal(question.type, 'propose_goal');
  assert.deepEqual(question.args, { item: 'wooden_pickaxe', count: 1 });
  assert.equal(f.eventlog.rows.filter(r => r.kind === 'budget.learning_spent').length, 0, 'proposing never spends');
  assert.equal(f.tasks.length, 0);
});

test('proposal skips infeasible candidates in order', () => {
  const goals = { feasibility: ({ item }) => item === 'oak_log' ? { ok: true, plan: { summary: 'x' } } : { ok: false, reason: 'no_source' } };
  const f = proactiveFixture({ findBlock: () => ({ name: 'oak_log' }) },
    { goals, ownerEntity: { uuid: OWNER, position: new Vec3(4, 64, 0), metadata: {} } });
  f.advance(2_000);
  assert.equal(f.narrations[0].situation.item, 'oak_log');
  assert.equal(f.narrations[0].situation.count, 8);
  const stone = proactiveFixture({ inventory: { items: () => [{ name: 'wooden_pickaxe', count: 1 }], emptySlotCount: () => 10 } },
    { goals: { feasibility: ({ item }) => item === 'stone_pickaxe' ? { ok: true, plan: { summary: 'x' } } : { ok: false, reason: 'x' } },
      ownerEntity: { uuid: OWNER, position: new Vec3(4, 64, 0), metadata: {} } });
  stone.advance(2_000);
  assert.equal(stone.narrations[0].situation.item, 'stone_pickaxe');
});

test('budget below reserve and open questions block proposals', () => {
  const goals = { feasibility: () => ({ ok: true, plan: { summary: 'x' } }) };
  const poor = proactiveFixture({}, { goals, budget: { remaining: () => 7, reserve: 8, spend: () => true },
    ownerEntity: { uuid: OWNER, position: new Vec3(4, 64, 0), metadata: {} } });
  poor.advance(2_000);
  assert.equal(poor.narrations.length, 0);
  const asked = proactiveFixture({}, { goals, ownerEntity: { uuid: OWNER, position: new Vec3(4, 64, 0), metadata: {} } });
  asked.dialogue.setQuestion({ type: 'propose_goal', action: 'x', args: { item: 'stick', count: 1 } });
  asked.advance(2_000);
  assert.equal(asked.narrations.length, 0);
  const chatted = proactiveFixture({}, { goals, ownerEntity: { uuid: OWNER, position: new Vec3(4, 64, 0), metadata: {} } });
  chatted.advance(800);
  chatted.proactive.noteOwnerChat();
  chatted.advance(500);
  assert.equal(chatted.narrations.length, 0, 'fresh owner chat resets the quiet clock');
  chatted.advance(600);
  assert.equal(chatted.narrations.length, 1, 'the quiet period restarts from the chat');
});

test('stop clears the timer, listeners, submissions and narration', () => {
  const f = proactiveFixture();
  f.proactive.tick();
  assert.equal(f.tasks.length, 1);
  f.proactive.stop();
  f.proactive.stop();
  assert.equal(f.timers.size, 0);
  assert.equal(f.bot.listenerCount('entityHurt'), 0);
  assert.equal(f.arbiterEvents.listenerCount('done'), 0);
  f.proactive.tick();
  f.bot.emit('entityHurt', f.ownerEntity);
  f.proactive.tick();
  assert.equal(f.tasks.length, 1);
  assert.equal(f.narrations.length, 0);
});

test('arbiter done events keep the quiet clock warm', () => {
  const goals = { feasibility: () => ({ ok: true, plan: { summary: 'x' } }) };
  const f = proactiveFixture({}, { goals, ownerEntity: { uuid: OWNER, position: new Vec3(4, 64, 0), metadata: {} } });
  f.advance(500);
  f.arbiterEvents.emit('done', { status: 'completed' });
  f.advance(800);
  assert.equal(f.narrations.length, 0, 'task completion resets quietSince');
});

test('a drop surviving two pickup submissions is marked unreachable and cooled', () => {
  const dropEntity = { position: new Vec3(5, 64, 0), getDroppedItem: () => ({ name: 'cobblestone' }) };
  const far = { position: new Vec3(12, 64, 0), getDroppedItem: () => ({ name: 'dirt' }) };
  const f = proactiveFixture({ entities: { d1: dropEntity, far1: far } });
  const pickups = () => f.tasks.filter(task => task.label === 'proactive:pickup').length;
  f.proactive.tick(); // submission #1 — first sighting, no strike
  assert.equal(pickups(), 1);
  f.advance(5_000); // #2 — same drop still there: strike 1
  assert.equal(pickups(), 2);
  f.advance(5_000); // #3 — strike 2 → marked unreachable
  assert.equal(pickups(), 3);
  assert.ok(f.eventlog.rows.some(row => row.kind === 'proactive.drop_unreachable'
    && row.payload.entityId === 'd1' && row.payload.strikes === 2), 'unreachable marking logged with entity id');
  f.advance(5_000);
  f.advance(5_000);
  assert.equal(pickups(), 3, 'cooling drop no longer triggers pickup');
  f.advance(120_000); // cooldown expires — the drop earns fresh attempts
  assert.equal(pickups(), 4);
  f.advance(5_000); // still no progress: strike 2 → re-marked
  assert.equal(pickups(), 5);
  f.advance(5_000);
  assert.equal(pickups(), 5, 're-marked after the same no-progress count');
  // A drop outside pickup radius never participates at all.
  assert.equal(f.eventlog.rows.filter(row => row.kind === 'proactive.drop_unreachable'
    && row.payload.entityId === 'far1').length, 0, 'far drops are never pickup targets');
});

test('collected drops earn no strike; tracking is per entity', () => {
  const a = { position: new Vec3(5, 64, 0), getDroppedItem: () => ({ name: 'cobblestone' }) };
  const b = { position: new Vec3(6, 64, 0), getDroppedItem: () => ({ name: 'dirt' }) };
  const f = proactiveFixture({ entities: { da: a, db: b } });
  const pickups = () => f.tasks.filter(task => task.label === 'proactive:pickup').length;
  f.proactive.tick(); // #1 targets {da,db}
  f.bot.entities = { db: b }; // da got collected between submissions
  f.advance(5_000); // #2 targets {db}: db strike 1, da's watch pruned
  assert.equal(pickups(), 2);
  assert.equal(f.eventlog.rows.filter(row => row.kind === 'proactive.drop_unreachable').length, 0);
  f.bot.entities = { db: b, dc: { position: new Vec3(4, 64, 0), getDroppedItem: () => ({ name: 'sand' }) } };
  f.advance(5_000); // #3 targets {db,dc}: db strike 2 → marked; dc first sighting
  assert.equal(pickups(), 3);
  f.advance(5_000); // #4 targets {dc} only (db cooling): dc strike 1
  assert.equal(pickups(), 4);
  f.advance(5_000); // #5 targets {dc}: strike 2 → marked; every drop now cooling
  assert.equal(pickups(), 5);
  f.advance(5_000);
  assert.equal(pickups(), 5, 'all unreachable drops silenced');
});

function budgetLog() {
  const rows = [];
  return {
    rows,
    append(kind, payload, traceId) { rows.push({ kind, payload, trace_id: traceId, ts: rows.now(), id: rows.length + 1 }); },
    query({ kind, since, limit = 100 } = {}) {
      return rows.filter(row => (kind === undefined || row.kind === kind) && (since === undefined || row.ts >= since)).slice(0, limit);
    },
  };
}

test('budget counts only events since local midnight', () => {
  const noon = new Date(2026, 9, 10, 12).getTime();
  const clock = { now: () => noon };
  const eventlog = budgetLog();
  eventlog.rows.now = () => noon;
  const budget = createLearningBudget({ eventlog, limit: 30, clock });
  assert.equal(budget.remaining(), 30);
  eventlog.append('budget.learning_spent', { kind: 'goal', item: 'stick' }, 't1');
  eventlog.rows[0].ts = noon - 86_400_000;
  eventlog.append('budget.learning_spent', { kind: 'jev', item: 'dirt' }, 't2');
  assert.equal(budget.remaining(), 29, 'yesterday does not count');
});

test('spend persists through restart and refuses when exhausted', () => {
  const noon = new Date(2026, 9, 10, 12).getTime();
  const clock = { now: () => noon };
  const eventlog = budgetLog();
  eventlog.rows.now = () => noon;
  const first = createLearningBudget({ eventlog, limit: 2, clock });
  assert.equal(first.spend({ kind: 'goal', item: 'stick' }, 't1'), true);
  assert.equal(first.spend({ kind: 'jev', item: 'dirt' }, 't2'), true);
  assert.equal(first.spend({ kind: 'goal', item: 'chest' }, 't3'), false);
  const restarted = createLearningBudget({ eventlog, limit: 2, clock });
  assert.equal(restarted.remaining(), 0, 'restart keeps the count');
  const before = eventlog.rows.length;
  assert.equal(restarted.spend({ kind: 'goal', item: 'chest' }, 't4'), false);
  assert.equal(eventlog.rows.length, before, 'a refused spend writes nothing');
  const spent = eventlog.rows.filter(r => r.kind === 'budget.learning_spent');
  assert.deepEqual(spent[0].payload, { kind: 'goal', item: 'stick' });
  assert.equal(spent[0].trace_id, 't1');
});

test('limit zero forbids every spend and reserve follows the formula', () => {
  const clock = { now: () => Date.now() };
  const eventlog = budgetLog();
  eventlog.rows.now = () => Date.now();
  const none = createLearningBudget({ eventlog, limit: 0, clock });
  assert.equal(none.remaining(), 0);
  assert.equal(none.spend({ kind: 'goal', item: 'x' }, 't'), false);
  assert.equal(eventlog.rows.length, 0);
  for (const [limit, reserve] of [[0, 1], [1, 1], [4, 1], [30, 8], [31, 8], [40, 10], [1000, 250]]) {
    assert.equal(createLearningBudget({ eventlog: budgetLog(), limit, clock }).reserve, reserve, `limit ${limit}`);
  }
});

test('proactive modules stay pure: no Date.now or Math.random inside decide/budget paths', () => {
  for (const file of ['decide.js', 'budget.js']) {
    const source = readFileSync(new URL(`../src/proactive/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /Math\.random|process\.env/);
  }
});

test('e2e proactive gate is opt-in', () => {
  const lines = [];
  assert.equal(proactiveEnvironment({}, line => lines.push(line)), false);
  assert.match(lines[0], /SKIP/);
  assert.equal(proactiveEnvironment({ E2E_PROACTIVE: '1' }), true);
});

test('nightfall remark carries the bed fact: nearby, inventory or none', () => {
  for (const [overrides, expected] of [
    [{}, 'none'],
    [{ inventory: { items: () => [{ name: 'white_bed' }], emptySlotCount: () => 10 } }, 'inventory'],
    [{ findBlock: () => ({ name: 'red_bed' }) }, 'nearby'],
  ]) {
    const f = proactiveFixture(overrides, { ownerEntity: { uuid: OWNER, position: new Vec3(3, 64, 0), metadata: {} } });
    f.bot.time.isDay = false;
    f.proactive.tick(); // first tick is only armed on a day->night transition
    f.bot.time.isDay = true; f.proactive.tick();
    f.bot.time.isDay = false; f.proactive.tick();
    const remark = f.narrations.find(n => n.situation.reason === 'nightfall');
    assert.ok(remark, expected);
    assert.equal(remark.situation.bed, expected);
  }
});
