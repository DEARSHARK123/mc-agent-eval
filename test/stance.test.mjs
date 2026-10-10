import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from '../src/primitives/helpers.js';
import { decide } from '../src/survival/decide.js';
import { createSurvival } from '../src/survival/index.js';
import { decideProactive } from '../src/proactive/decide.js';
import {
  createStanceEngine, validateStance, defaultStance, allowedSpec,
  ALLOWED_STANCES, STANCE_NAMES, STANCE_DEFAULTS,
} from '../src/stance/index.js';
import { createTriggers } from '../src/stance/triggers.js';
import { createBrain } from '../src/brain/llm.js';
import { loadConfig } from '../src/config.js';
import * as persona from '../src/persona.js';
import { stanceEnvironment } from '../scripts/e2e-stance.mjs';

const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.4');
const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CONF = { fleeHealth: 8, foodUrgent: 6, foodComfort: 14 };
const flush = () => new Promise(resolve => setImmediate(resolve));
const mob = (name = 'zombie', distance = 5) => ({ name, distance, dx: distance, dz: 0, hasLineOfSight: true });
const snap = v => ({
  now: 20000, health: 20, food: 20, oxygen: 20, isSleeping: false, onFire: false, inLava: false,
  inWater: false, yPosition: 64, minY: -64, isNight: false, hostiles: [], hurtRecently: false,
  weapon: 'iron', hasFood: true, bedNearby: false, ownerDistance: null, arbiter: { busy: false },
  lastAction: null, stance: null, ...v,
});

// In-memory eventlog shaped like src/eventlog.js: ascending ids, ts-based since.
function fakeLog() {
  const rows = [];
  let id = 0;
  return {
    rows,
    append(kind, payload, traceId) {
      const row = { id: ++id, ts: fakeLog.now(), kind, payload, trace_id: traceId ?? null };
      rows.push(row);
      return row;
    },
    query({ kind, since, limit = 100 } = {}) {
      return rows
        .filter(r => (kind === undefined || r.kind === kind)
          && (since === undefined || r.ts >= since))
        .slice(0, limit);
    },
  };
}
// Shared mutable clock so engine, triggers and the fake eventlog agree.
let logTime = 1_000_000;
fakeLog.now = () => logTime;

function makeEngine({ brain = null, snapshot = () => null, goals = null, speak = null,
  protection = null, body = null, log = fakeLog() } = {}) {
  const timers = new Map();
  let seq = 0;
  const clock = {
    now: () => logTime,
    setInterval: fn => { timers.set(++seq, fn); return seq; },
    clearInterval: id => timers.delete(id),
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout() {},
  };
  const said = [];
  const engine = createStanceEngine({
    eventlog: log, brain, getSnapshot: snapshot, goals, protection, body,
    ownerUuid: UUID, clock,
    speak: (situation, traceId) => { said.push({ situation, traceId }); return Promise.resolve(null); },
    config: { tickMs: 1000, cooldownMs: 30_000 },
  });
  return { engine, log, said, timers, advance: ms => { logTime += ms; engine.tick(); } };
}

// --- whitelist / schema validation ---------------------------------------

test('validateStance: rejects shape, unknown, disallowed, bad params; line is cosmetic', () => {
  assert.equal(validateStance(null, 'night_pressure').ok, false);
  assert.equal(validateStance('clear_then_sleep', 'night_pressure').ok, false);
  assert.equal(validateStance({ stance: 'not_a_stance' }, 'night_pressure').reason, 'unknown_stance');
  assert.equal(validateStance({ stance: 'redo' }, 'owner_tease').reason, 'disallowed');
  assert.equal(validateStance({ stance: 'keep_distance', params: { followDistance: 99 } }, 'owner_tease').reason, 'param_followDistance');
  assert.equal(validateStance({ stance: 'ask_owner', params: { waitSec: 12.5 } }, 'trapped_artificial').reason, 'param_waitSec');
  assert.equal(validateStance({ stance: 'resume', params: { sneak: 1 } }, 'items_taken').reason, 'param_sneak');
  assert.equal(validateStance({ stance: 'retreat_to_shelter', params: { target: 'moon' } }, 'owner_far_danger').reason, 'param_target');
  assert.equal(validateStance({ stance: 'guard_night', params: { ttlSec: 20 } }, 'night_pressure').reason, 'param_ttlSec');
  assert.equal(validateStance({ stance: 'stay_with_owner', params: { fleeHealth: 14 } }, 'night_pressure').reason, 'param_fleeHealth');
  const ok = validateStance({ stance: 'keep_distance', params: { followDistance: 8 }, line: '先离远一点\n第二行' }, 'owner_tease');
  assert.equal(ok.ok, true);
  assert.equal(ok.line, '先离远一点 第二行');
  assert.deepEqual(validateStance({ stance: 'resume', params: {} }, 'owner_tease'), { ok: true, name: 'resume', params: {}, line: null });
});

test('defaultStance: full table including items_taken first/subsequent', () => {
  assert.deepEqual(defaultStance('night_pressure', { hasHut: true }), { name: 'retreat_to_shelter', params: { target: 'hut' } });
  assert.equal(defaultStance('night_pressure', { hasHut: false }).name, 'stay_with_owner');
  assert.equal(defaultStance('goal_pressure').name, 'resume');
  assert.deepEqual(defaultStance('owner_far_danger'), { name: 'retreat_to_shelter', params: { target: 'owner' } });
  assert.equal(defaultStance('owner_tease').name, 'resume');
  assert.equal(defaultStance('items_taken', { itemsTakenFires: 1 }).name, 'redo');
  assert.equal(defaultStance('items_taken', { itemsTakenFires: 2 }).name, 'ask_owner');
  assert.equal(defaultStance('trapped_artificial').name, 'ask_owner');
});

// --- trigger detectors -----------------------------------------------------

test('triggers: owner_tease needs 2 owner events in 2 min; non-owner ignored', () => {
  const log = fakeLog();
  const triggers = createTriggers({ eventlog: log, ownerUuid: UUID });
  log.append('body.hurt', { by: 'mob', mob: 'zombie' });
  assert.equal(triggers.poll(logTime, null).length, 0);
  log.append('body.hurt', { by: 'owner' });
  assert.equal(triggers.poll(logTime, null).length, 0, 'a single tease event is not enough');
  log.append('body.ground_lost', { by: 'owner' });
  const fired = triggers.poll(logTime, null);
  assert.equal(fired[0]?.kind, 'owner_tease');
  assert.equal(fired[0].detail.count, 2);
});

test('triggers: goal_pressure counts 3 suspends in 60s only', () => {
  const log = fakeLog();
  const triggers = createTriggers({ eventlog: log, ownerUuid: UUID });
  log.append('goal.suspended', { item: 'planks', attempt: 0 });
  log.append('goal.suspended', { item: 'planks', attempt: 1 });
  assert.equal(triggers.poll(logTime, null).length, 0);
  log.append('goal.suspended', { item: 'planks', attempt: 2 });
  assert.equal(triggers.poll(logTime, null)[0]?.kind, 'goal_pressure');
  // An old suspend outside the 60 s window drops out.
  log.rows.forEach(r => { if (r.kind === 'goal.suspended') r.ts = logTime - 61_000; });
  assert.equal(triggers.poll(logTime, null).length, 0);
});

test('triggers: owner_far_danger continuous; items_taken consumes once', () => {
  const log = fakeLog();
  const triggers = createTriggers({ eventlog: log, ownerUuid: UUID });
  const snapNow = { health: 9, ownerDistance: 30 };
  assert.equal(triggers.poll(logTime, snapNow)[0]?.kind, 'owner_far_danger');
  assert.equal(triggers.poll(logTime + 1000, { health: 12, ownerDistance: 30 }).length, 0);
  log.append('body.items_taken', { by: 'owner', item: 'iron_ingot', count: 1, where: 'drops' });
  const fired = triggers.poll(logTime + 2000, null).find(t => t.kind === 'items_taken');
  assert.ok(fired);
  triggers.consumed(fired);
  assert.equal(triggers.poll(logTime + 3000, null).find(t => t.kind === 'items_taken'), undefined);
  log.append('goal.end', { status: 'failed', reason: 'items_taken' });
  assert.ok(triggers.poll(logTime + 4000, null).find(t => t.kind === 'items_taken'));
});

test('triggers: night_pressure via 3 fight interrupts or 90s awake, owner task pauses it', () => {
  const log = fakeLog();
  const triggers = createTriggers({ eventlog: log, ownerUuid: UUID });
  const night = { isNight: true, bedNearby: true, isSleeping: false, arbiter: { busy: false, source: null } };
  // Accumulator path: nothing happens for 89 s.
  triggers.poll(logTime, night);
  assert.equal(triggers.poll(logTime + 89_000, night).find(t => t.kind === 'night_pressure'), undefined);
  assert.equal(triggers.poll(logTime + 91_000, night)[0]?.kind, 'night_pressure');
  // Interrupt path: fresh engine, three preempts inside the window.
  const log2 = fakeLog();
  const triggers2 = createTriggers({ eventlog: log2, ownerUuid: UUID });
  const preempt = () => log2.append('arbiter.preempt', { label: 'survival:sleep', source: 'plan', by_source: 'reflex', by_label: 'survival:fight' });
  preempt(); preempt(); preempt();
  const fired = triggers2.poll(logTime, night).find(t => t.kind === 'night_pressure');
  assert.ok(fired && fired.detail.interrupted >= 3);
  // An owner-goal in flight is work, not "cannot sleep": the awake clock never
  // starts while he is using her, then counts a fresh 90 s once he is not.
  const log3 = fakeLog();
  const triggers3 = createTriggers({ eventlog: log3, ownerUuid: UUID });
  const busyNight = { ...night, arbiter: { busy: true, source: 'owner' } };
  for (let i = 0; i < 5; i++) triggers3.poll(logTime + i * 40_000, busyNight);
  assert.equal(triggers3.poll(logTime + 200_000, busyNight).find(t => t.kind === 'night_pressure'), undefined);
  triggers3.poll(logTime + 200_001, night);
  assert.equal(triggers3.poll(logTime + 289_999, night).find(t => t.kind === 'night_pressure'), undefined, '89 998 ms awake is still shy of 90 s');
  assert.equal(triggers3.poll(logTime + 290_001, night)[0]?.kind, 'night_pressure');
});

test('triggers: trapped_artificial needs 20s of continuous reporting, freed resets', () => {
  const log = fakeLog();
  const triggers = createTriggers({ eventlog: log, ownerUuid: UUID });
  log.append('body.trapped', { kind: 'artificial', blocks: 4 });
  // A single stale report is not evidence of an ongoing trap.
  assert.equal(triggers.poll(logTime + 25_000, null).find(t => t.kind === 'trapped_artificial'), undefined);
  // Continuous reporting for >20 s fires.
  const start = logTime;
  for (let i = 0; i <= 22; i += 2) {
    const row = log.append('body.trapped', { kind: 'artificial', blocks: 4 });
    row.ts = start + i * 1000;
  }
  const fired = triggers.poll(start + 22_000, null).find(t => t.kind === 'trapped_artificial');
  assert.ok(fired);
  log.append('body.freed', { kind: 'artificial' });
  assert.equal(triggers.poll(start + 30_000, null).find(t => t.kind === 'trapped_artificial'), undefined);
});

// --- engine behaviour -------------------------------------------------------

test('engine: owner_tease without brain falls back to resume and speaks once', async () => {
  const { engine, log, said, advance } = makeEngine();
  log.append('body.hurt', { by: 'owner' });
  log.append('body.ground_lost', { by: 'owner' });
  engine.tick();
  await flush();
  const current = engine.current();
  assert.equal(current?.name, 'resume');
  assert.equal(current.trigger, 'owner_tease');
  const set = log.rows.filter(r => r.kind === 'stance.set');
  assert.equal(set.length, 1);
  assert.equal(set[0].payload.via, 'default');
  assert.equal(said.length, 1);
  assert.equal(said[0].situation.kind, 'stance');
  assert.equal(said[0].situation.name, 'resume');
  engine.stop();
});

test('engine: per-trigger 30s cooldown and refresh without re-speak', async () => {
  const { engine, log, said, advance } = makeEngine();
  log.append('body.hurt', { by: 'owner' });
  log.append('body.hurt', { by: 'owner' });
  engine.tick();
  await flush();
  // New tease events inside the cooldown do not re-fire.
  advance(10_000);
  log.append('body.hurt', { by: 'owner' });
  advance(1_000);
  await flush();
  assert.equal(log.rows.filter(r => r.kind === 'stance.set').length, 1);
  // Past the cooldown a fresh tease event re-decides; same stance refreshes,
  // keeping the ttl alive without a second spoken line.
  advance(30_000);
  log.append('body.hurt', { by: 'owner' });
  advance(1_000);
  await flush();
  const sets = log.rows.filter(r => r.kind === 'stance.set');
  assert.equal(sets.length, 2);
  assert.equal(sets[1].payload.refreshed, true);
  assert.equal(said.length, 1);
  engine.stop();
});

test('engine: brain pick applied with via=brain; partial params get defaults', async () => {
  const calls = [];
  const brain = { enabled: true, stance: async args => { calls.push(args); return { stance: 'keep_distance', params: { followDistance: 9 }, line: '等下再说' }; } };
  const { engine, log, said } = makeEngine({ brain });
  log.append('body.hurt', { by: 'owner' });
  log.append('body.knocked', { by: 'owner' });
  engine.tick();
  await flush(); await flush();
  const current = engine.current();
  assert.equal(current?.name, 'keep_distance');
  assert.equal(current.params.followDistance, 9);
  assert.equal(current.params.ttlSec, 300);
  assert.equal(log.rows.find(r => r.kind === 'stance.set').payload.via, 'brain');
  assert.equal(said[0].situation.line, '等下再说');
  assert.deepEqual(calls[0].allowed.map(a => a.name), [...ALLOWED_STANCES.owner_tease]);
  assert.ok(calls[0].priorities.order.length >= 5);
  engine.stop();
});

test('engine: invalid/garbage/timeout brain output falls back to default table', async () => {
  for (const [output, wantName] of [
    [{ stance: 'redo', params: { maxRetries: 2 } }, 'resume'],           // disallowed for tease
    [{ stance: 'keep_distance', params: { followDistance: 99 } }, 'resume'], // out of range
    [{ garbage: true }, 'resume'],                                      // shape
    ['not json at all', 'resume'],
    [null, 'resume'],                                                   // brain returned nothing
  ]) {
    const brain = { enabled: true, stance: async () => output };
    const { engine, log } = makeEngine({ brain });
    log.append('body.hurt', { by: 'owner' });
    log.append('body.ground_lost', { by: 'owner' });
    engine.tick();
    await flush(); await flush();
    assert.equal(engine.current()?.name, wantName, JSON.stringify(output));
    if (output !== null) assert.ok(log.rows.some(r => r.kind === 'stance.invalid'), JSON.stringify(output));
    engine.stop();
  }
});

test('engine: one brain decision in flight; second trigger waits', async () => {
  let calls = 0;
  let release;
  const brain = { enabled: true, stance: () => { calls++; return new Promise(r => { release = r; }); } };
  const { engine, log } = makeEngine({ brain });
  log.append('body.hurt', { by: 'owner' });
  log.append('body.hurt', { by: 'owner' });
  engine.tick();
  engine.tick();
  log.append('goal.suspended', {}); log.append('goal.suspended', {}); log.append('goal.suspended', {});
  engine.tick();
  assert.equal(calls, 1, 'only one decision while the first is pending');
  release({ stance: 'resume' });
  await flush(); await flush();
  assert.equal(engine.current()?.name, 'resume');
  engine.tick();
  await flush();
  assert.equal(calls, 2, 'queued conflict gets its own decision');
  engine.stop();
});

test('engine: deviation logged for brain pick contradicting priorities', async () => {
  const brain = { enabled: true, stance: async () => ({ stance: 'guard_night', params: { patrolRadius: 6 } }) };
  const { engine, log } = makeEngine({ brain, snapshot: () => ({ health: 8, ownerDistance: 40 }) });
  engine.tick();
  await flush(); await flush();
  assert.equal(engine.current()?.name, 'guard_night', 'still applied');
  const dev = log.rows.find(r => r.kind === 'stance.deviation');
  assert.equal(dev?.payload.name, 'guard_night');
  assert.equal(dev?.payload.trigger, 'owner_far_danger');
  engine.stop();
});

test('engine: expiry clears stance and logs stance.expired; dawn ends night stances', async () => {
  const { engine, log, advance } = makeEngine({ snapshot: () => ({ health: 9, ownerDistance: 40 }) });
  engine.tick();
  await flush();
  assert.equal(engine.current()?.name, 'retreat_to_shelter');
  advance(301_000);
  await flush();
  assert.ok(log.rows.some(r => r.kind === 'stance.expired' && r.payload.reason === 'ttl'));
  // Continuous trigger refires after expiry — simulate daybreak instead.
  engine.stop();
  // guard_night expires at dawn even before ttl.
  const brain = { enabled: true, stance: async () => ({ stance: 'guard_night' }) };
  let night = true;
  const second = makeEngine({ brain, snapshot: () => ({ isNight: night, bedNearby: true, isSleeping: false, health: 20, ownerDistance: 5, timeOfDay: 20000, arbiter: { busy: false } }) });
  for (let i = 0; i < 3; i++) second.log.append('arbiter.preempt', { label: 'survival:sleep', source: 'plan', by_source: 'reflex', by_label: 'survival:fight' });
  second.engine.tick();
  await flush(); await flush();
  assert.equal(second.engine.current()?.name, 'guard_night');
  night = false;
  second.advance(1_000);
  assert.equal(second.engine.current(), null);
  assert.ok(second.log.rows.some(r => r.kind === 'stance.expired' && r.payload.reason === 'dawn'));
  second.engine.stop();
});

test('engine: ask_owner waits for owner chat, logs reply, falls back on silence', async () => {
  const brain = { enabled: true, stance: async () => ({ stance: 'ask_owner', params: { waitSec: 20 } }) };
  const { engine, log, advance } = makeEngine({ brain });
  log.append('body.items_taken', { by: 'owner', item: 'iron_ingot', count: 1 });
  engine.tick();
  await flush(); await flush();
  assert.equal(engine.current()?.name, 'ask_owner');
  // Owner replies inside waitSec.
  log.append('chat', { username: 'TestOwner', message: '我的错', uuid: UUID, from_owner: true });
  advance(1_000);
  assert.ok(log.rows.some(r => r.kind === 'stance.owner_replied'));
  advance(30_000);
  assert.equal(engine.current()?.name, 'ask_owner', 'answered ask does not fall back');
  engine.stop();
  // Silence: waitSec elapses → default table for the trigger (2nd+ items_taken → ask_owner
  // keeps the same stance; use owner_tease where the default differs).
  const { engine: e2, log: l2, advance: a2 } = makeEngine({ brain });
  l2.append('body.hurt', { by: 'owner' });
  l2.append('body.hurt', { by: 'owner' });
  e2.tick();
  await flush(); await flush();
  assert.equal(e2.current()?.name, 'ask_owner');
  a2(21_000);
  await flush();
  assert.equal(e2.current()?.name, 'resume');
  assert.ok(l2.rows.some(r => r.kind === 'stance.expired' && r.payload.reason === 'no_reply'));
  e2.stop();
});

test('engine: items_taken fires redo first, ask_owner second; redo replans via goals', async () => {
  const obtains = [];
  const goals = {
    lastRequest: () => ({ item: 'iron_ingot', count: 2, giveToOwner: true }),
    obtain: args => { obtains.push(args); return { accepted: true, done: Promise.resolve({ status: 'succeeded' }) }; },
  };
  const { engine, log, advance } = makeEngine({ goals });
  log.append('body.items_taken', { by: 'owner', item: 'iron_ingot', count: 1 });
  engine.tick();
  await flush(); await flush();
  assert.equal(engine.current()?.name, 'redo');
  await flush(); await flush();
  assert.deepEqual(obtains, [{ item: 'iron_ingot', count: 2, giveToOwner: true }]);
  assert.ok(log.rows.some(r => r.kind === 'stance.redo' && r.payload.status === 'succeeded'));
  // Second take past the cooldown asks instead.
  advance(31_000);
  log.append('body.items_taken', { by: 'owner', item: 'iron_ingot', count: 1 });
  engine.tick();
  await flush(); await flush();
  assert.equal(engine.current()?.name, 'ask_owner');
  assert.equal(obtains.length, 1, 'ask_owner does not re-obtain');
  engine.stop();
});

test('engine: trapped_artificial default asks owner', async () => {
  const { engine, log } = makeEngine();
  const start = logTime;
  log.append('body.trapped', { kind: 'artificial', blocks: 4 });
  log.rows.at(-1).ts = start;
  for (let i = 2; i <= 22; i += 2) {
    log.append('body.trapped', { kind: 'artificial', blocks: 4 });
    log.rows.at(-1).ts = start + i * 1000;
  }
  logTime = start + 22_000;
  engine.tick();
  await flush();
  assert.equal(engine.current()?.name, 'ask_owner');
  assert.equal(engine.current().trigger, 'trapped_artificial');
  engine.stop();
});

test('engine: clear_then_sleep giveUp falls back when still awake, clears when asleep', async () => {
  let sheltered = true;
  const brain = { enabled: true, stance: async () => ({ stance: 'clear_then_sleep', params: { fightRadius: 10, giveUpSec: 30 } }) };
  const snapFn = () => ({ isNight: true, bedNearby: sheltered, isSleeping: false, health: 20, ownerDistance: 5, timeOfDay: 20000, arbiter: { busy: false } });
  const { engine, log, advance } = makeEngine({ brain, snapshot: snapFn, protection: { zones: () => [{ x: 9, y: 64, z: 0, radius: 6, reason: 'own_build' }] } });
  for (let i = 0; i < 3; i++) log.append('arbiter.preempt', { label: 'survival:sleep', source: 'plan', by_source: 'reflex', by_label: 'survival:fight' });
  engine.tick();
  await flush(); await flush();
  assert.equal(engine.current()?.name, 'clear_then_sleep');
  assert.equal(engine.current().params.fightRadius, 10);
  // The pressure is gone (bed lost) — giveUp converts to the hut default and
  // does not immediately re-decide.
  sheltered = false;
  advance(31_000);
  await flush();
  assert.equal(engine.current()?.name, 'retreat_to_shelter');
  assert.equal(engine.current().params.target, 'hut');
  assert.ok(log.rows.some(r => r.kind === 'stance.expired' && r.payload.reason === 'give_up'));
  engine.stop();
});

// --- survival/proactive application -----------------------------------------

test('decide: fightRadius narrows and widens engagement without touching flee', () => {
  const base = snap({ hostiles: [mob('zombie', 5)] });
  assert.equal(decide(base, CONF)?.kind, 'fight');
  assert.equal(decide(snap({ hostiles: [mob('zombie', 5)], stance: { name: 'stay_with_owner', fightRadius: 3 } }), CONF), null);
  // Widened radius (clear_then_sleep 4–12) also covers the bed-clearing range.
  assert.equal(decide(snap({ hostiles: [mob('zombie', 10)], stance: { fightRadius: 12 } }), CONF)?.kind, 'fight');
  assert.equal(decide(snap({ hostiles: [mob('zombie', 10)] }), CONF), null);
  // Flee predicates still use the fixed <=8 close list even with a stance.
  const crowded = { hostiles: [mob('zombie', 4), mob('skeleton', 5), mob('spider', 6)], stance: { fightRadius: 3 } };
  assert.equal(decide(snap(crowded), CONF)?.kind, 'flee');
});

test('decide: retreat runs before sleep, patrol replaces sleep for guard_night', () => {
  const night = snap({ isNight: true, bedNearby: true, arbiter: { busy: false, active: false } });
  const retreat = { name: 'retreat_to_shelter', retreatTo: { x: 20, y: 64, z: 0 }, retreatDistance: 20 };
  const action = decide(snap({ ...night, stance: retreat }), CONF);
  assert.equal(action.kind, 'retreat');
  assert.deepEqual(action.steps[0], { primitive: 'goTo', params: { x: 20, y: 64, z: 0, range: 2 } });
  // Inside the radius the stance steps aside and normal sleep resumes.
  assert.equal(decide(snap({ ...night, stance: { ...retreat, retreatDistance: 2 } }), CONF)?.kind, 'sleep');
  // guard_night: no sleep, patrol when outside the radius.
  const guard = { name: 'guard_night', skipSleep: true, patrolAnchor: { x: 20, y: 64, z: 0 }, patrolRadius: 6, patrolDistance: 12 };
  assert.equal(decide(snap({ ...night, stance: guard }), CONF)?.kind, 'patrol');
  assert.equal(decide(snap({ ...night, stance: { ...guard, patrolDistance: 5 } }), CONF), null, 'no sleep while guarding');
  // Any in-flight arbiter task — including idle — blocks stance movement.
  assert.equal(decide(snap({ ...night, stance: retreat, arbiter: { busy: true, source: 'idle', active: true } }), CONF), null);
});

test('survival: fleeHealth clamped to [default,12]; retreat does not preempt an idle task', () => {
  const fixture = (overrides, stanceRef, current = null) => {
    const tasks = [];
    const timers = new Map();
    let time = 20000;
    const bot = Object.assign(new EventEmitter(), {
      entity: { position: new Vec3(0, 64, 0), metadata: [], effects: {} },
      health: 20, food: 20, oxygenLevel: 20, time: { isDay: true },
      entities: {}, players: {}, inventory: { items: () => [{ name: 'iron_sword', type: data.itemsByName.iron_sword.id }] },
      findBlock: () => null,
      blockAt: p => p.y < 64 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' },
      setControlState: () => {},
    }, overrides);
    const clock = { now: () => time, setInterval: fn => { timers.set(1, fn); return 1; }, clearInterval: id => timers.delete(id) };
    const arbiter = {
      current: () => current,
      submit: t => {
        tasks.push(t);
        if (current) return { accepted: false, reason: 'busy', done: Promise.resolve({ status: 'rejected' }) };
        current = { source: t.source, label: t.label };
        return { accepted: true, done: new Promise(() => {}) };
      },
    };
    const survival = createSurvival({ bot, registry: { validate() {} }, arbiter,
      eventlog: { append() {} }, mcData: data, config: CONF, clock, stance: stanceRef });
    return { bot, tasks, survival, advance: () => { time += 4000; timers.get(1)?.(); }, current: () => current };
  };
  const hostile = { zombie: { name: 'zombie', type: 'hostile', position: new Vec3(5, 64, 0), isValid: true } };
  // stance fleeHealth 12 -> flees at health 10; default 8 would fight.
  const high = fixture({ health: 10, entities: hostile }, { current: () => ({ name: 'stay_with_owner', params: { fleeHealth: 12 } }) });
  high.advance();
  assert.equal(high.tasks[0]?.label, 'survival:flee');
  high.survival.stop();
  // stance fleeHealth 5 (below default) is clamped up to 8 -> still fights.
  const low = fixture({ health: 10, entities: hostile }, { current: () => ({ name: 'stay_with_owner', params: { fleeHealth: 5 } }) });
  low.advance();
  assert.equal(low.tasks[0]?.label, 'survival:fight');
  low.survival.stop();
  // An in-flight idle task is never preempted by a stance move.
  const busy = fixture({}, { current: () => ({ name: 'retreat_to_shelter', params: { target: 'hut' } }) }, { source: 'idle', label: 'survival:eat_comfort' });
  busy.advance();
  assert.equal(busy.tasks.length, 0, 'retreat yields to the running idle task');
  busy.survival.stop();
});

test('proactive decide: stance followDistance and proposal suppression', () => {
  const s = { now: 100_000, isSleeping: false, idle: true, owner: { uuid: 'u', distance: 9, health: null },
    ownerHurtAt: -Infinity, nightfall: false, bed: 'none', drops: [], freeSlots: 1,
    lastGiveAt: -Infinity, quietSince: 0, openQuestion: false, proposal: null,
    budget: { remaining: 10, reserve: 1 }, last: {} };
  // Default distance 6: owner at 9 triggers stay_near with the default range 3.
  assert.deepEqual(decideProactive(s, {}).steps[0].params.range, 3);
  // keep_distance pushes both trigger and approach out to 9.
  const wide = decideProactive({ ...s, owner: { ...s.owner, distance: 7 } }, { followDistance: 8, followRange: 8 });
  assert.equal(wide, null, 'inside a widened band she does not approach');
  const far = decideProactive({ ...s, owner: { ...s.owner, distance: 12 } }, { followDistance: 8, followRange: 8 });
  assert.equal(far.steps[0].params.range, 8);
  const proposal = { ...s, owner: { ...s.owner, distance: 5 }, proposal: { item: 'oak_log', count: 8 }, suppressProposals: false };
  assert.equal(decideProactive(proposal, { idleProposalMs: 10 })?.kind, 'propose');
  assert.equal(decideProactive({ ...proposal, suppressProposals: true }, { idleProposalMs: 10 }), null);
});

// --- brain/config/persona plumbing ------------------------------------------

test('brain: stance uses parse path with its own deadline and returns raw JSON', async () => {
  const key = 'fake-t28-key';
  const requests = [];
  const events = [];
  const geminiData = text => ({ candidates: [{ content: { parts: [{ text }] } }] });
  const brain = createBrain({ provider: 'gemini', baseUrl: 'https://example.invalid/v1beta/', apiKey: key,
    model: 'primary', parseModel: 'parser', fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200, json: async () => geminiData('{"stance":"resume","params":{}}') };
    }, eventlog: { append: (kind, payload) => events.push({ kind, payload }) } });
  const out = await brain.stance({ situation: { trigger: { kind: 'owner_tease' } }, allowed: [{ name: 'resume' }] });
  assert.deepEqual(out, { stance: 'resume', params: {} });
  assert.ok(requests[0].url.includes('/parser:generateContent'));
  assert.equal(requests[0].body.generationConfig.responseMimeType, 'application/json');
  assert.equal(events[0].payload.purpose, 'stance');
  assert.equal(JSON.stringify(events).includes(key), false);
  let signal;
  const stalling = createBrain({ provider: 'gemini', baseUrl: 'https://example.invalid/', apiKey: key, model: 'm',
    stanceTimeoutMs: 15, fetch: async (_, options) => { signal = options.signal; return new Promise(() => {}); } });
  assert.equal(await stalling.stance({}), null);
  assert.equal(signal.aborted, true);
  const disabled = createBrain({ fetch: () => assert.fail('disabled must not fetch') });
  assert.equal(await disabled.stance({}), null);
});

test('config: stance timeout/cooldown defaults, overrides, invalid rejection', () => {
  const env = { OWNER_UUID: UUID };
  const defaults = loadConfig(env);
  assert.equal(defaults.brainStanceTimeoutMs, 8000);
  assert.equal(defaults.stanceCooldownMs, 30_000);
  assert.equal(Object.keys(defaults).includes('brainStanceTimeoutMs'), false);
  const config = loadConfig({ ...env, BRAIN_STANCE_TIMEOUT_MS: '1234', STANCE_COOLDOWN_MS: '45000' });
  assert.equal(config.brainStanceTimeoutMs, 1234);
  assert.equal(config.stanceCooldownMs, 45_000);
  for (const name of ['BRAIN_STANCE_TIMEOUT_MS', 'STANCE_COOLDOWN_MS']) {
    assert.throws(() => loadConfig({ ...env, [name]: 'secret-invalid' }), e => e.message.includes(name) && !e.message.includes('secret-invalid'));
  }
});

test('persona: behaviour priorities exported; stance fact line is a plain fact', () => {
  assert.ok(Array.isArray(persona.BEHAVIOUR_PRIORITIES.order));
  assert.equal(persona.BEHAVIOUR_PRIORITIES.order.length, 5);
  assert.match(persona.BEHAVIOUR_PRIORITIES.order[0], /安全/);
  assert.ok(persona.BEHAVIOUR_PRIORITIES.habits.length >= 3);
  const line = persona.factLine({ kind: 'stance', name: 'guard_night' });
  assert.equal(line, '决定今晚守夜不睡。');
  assert.equal(persona.factLine({ kind: 'stance', name: 'nonsense' }), null);
});

test('allowedSpec and tables stay frozen and mutually consistent', () => {
  const names = new Set(STANCE_NAMES);
  for (const [trigger, list] of Object.entries(ALLOWED_STANCES)) {
    assert.ok(list.length >= 2);
    for (const name of list) assert.ok(names.has(name));
    const spec = allowedSpec(trigger);
    assert.equal(spec.length, list.length);
    assert.ok(spec.every(s => 'ttlSec' in s.params && 'fleeHealth' in s.params));
    assert.throws(() => { ALLOWED_STANCES[trigger] = []; });
  }
  for (const name of STANCE_NAMES) assert.ok(name in STANCE_DEFAULTS);
  // The engine must not reach into the teaching layer — speech is injected.
  const source = readFileSync(new URL('../src/stance/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /teaching\//);
});

test('e2e stance gate + dispatcher wiring present', () => {
  const lines = [];
  assert.equal(stanceEnvironment({}, x => lines.push(x)), false);
  assert.match(lines[0], /SKIP/);
  assert.equal(stanceEnvironment({ E2E_STANCE: '1' }), true);
  const source = readFileSync(new URL('../scripts/e2e.mjs', import.meta.url), 'utf8');
  assert.match(source, /stanceEnvironment/);
  assert.match(source, /runStanceScenario\(\{/);
  assert.match(source, /scenario === 'stance'/);
  assert.match(source, /'stance'\]\.includes\(scenario\)/);
});
