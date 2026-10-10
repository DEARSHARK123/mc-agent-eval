import { Vec3 } from 'vec3';
import { planGoal } from './planner.js';
import { runIntent } from './stepper.js';
import { resolveClock } from '../clock.js';
import { abortStatus } from '../outcome.js';
import { arbiterFree } from '../arbiter.js';
import { MUTATING } from '../cost.js';

export function createGoalRunner({ registry, arbiter, bot, mcData, jev = null, eventlog, confidenceMin, clock = {}, deadlineMs = 900000, cost = null }) {
  const timers = resolveClock(clock);
  const now = timers.now;
  let current;
  // T28: the last feasible owner goal request, so a `redo` stance can resubmit
  // it without guessing what was interrupted.
  let lastGoalRequest = null;
  let tablePos = null;
  let furnacePos = null;
  const inventory = () => {
    const stock = {};
    for (const i of bot.inventory.items()) stock[i.name] = (stock[i.name] ?? 0) + i.count;
    return stock;
  };
  const nearby = name => bot.findBlock?.({ matching: mcData.blocksByName[name]?.id, maxDistance: 4 });
  const knownBlock = name => {
    const memory = { crafting_table: tablePos, furnace: furnacePos };
    const remember = pos => { if (name === 'crafting_table') tablePos = pos; else if (name === 'furnace') furnacePos = pos; };
    const near = nearby(name);
    if (near) { remember(near.position); return near.position; }
    if (memory[name] && bot.blockAt(memory[name])?.name === name) return memory[name];
    const found = bot.findBlock?.({ matching: mcData.blocksByName[name]?.id, maxDistance: 32 });
    if (found) { remember(found.position); return found.position; }
    return null;
  };
  const knownTable = () => knownBlock('crafting_table');
  const knownFurnace = () => knownBlock('furnace');
  function preferredLog() {
    const logs = Object.values(mcData.blocksByName).filter(b => b.name.endsWith('_log'));
    let preferred = 'oak_log', most = 0;
    for (const log of logs) {
      const n = bot.findBlocks?.({ matching: log.id, maxDistance: 32, count: 4096 })?.length ?? 0;
      if (n > most) { most = n; preferred = log.name; }
    }
    return preferred;
  }
  function feasibility({ item, count } = {}) {
    if (!Object.hasOwn(mcData.itemsByName, item) || !Number.isInteger(count) || count < 1 || count > 64) {
      return { ok: false, reason: 'invalid_goal' };
    }
    const plan = planGoal({ item, count, inventory: inventory(), mcData, options: { preferredLog: preferredLog(), tableNearby: Boolean(knownTable()), furnaceNearby: Boolean(knownFurnace()), smelting: true, availableBlocks: null } });
    if (!plan.ok) return { ok: false, reason: plan.reason, detail: plan.detail };
    return { ok: true, plan };
  }
  function execution(plan, { item, count, giveToOwner, traceId, source, deferPreempted = false, shared = { taken: {}, takenEvents: 0 } }) {
    let final, index;
    const emit = (kind, payload) => { try { eventlog?.append(kind, payload, traceId); } catch {} };
    // T29 §C.1: an inline obtain runs under the caller's arbiter source, so
    // self-initiated (idle/plan) obtains pay the same per-mutation budget as
    // arbiter steps — reflex and owner work is never checked or charged. A
    // broken event log fails open rather than stranding the goal, mirroring
    // the arbiter's own guard.
    const billed = () => cost != null && (source === 'idle' || source === 'plan');
    const overBudget = name => {
      if (!billed() || !MUTATING.has(name)) return false;
      try { return cost.remaining() <= 0; } catch { return false; }
    };
    const spend = name => {
      if (!billed() || !MUTATING.has(name)) return;
      try { cost.trySpend({ source, primitive: name }, traceId); } catch {}
    };
    const finish = (status, reason, detail, given) => {
      if (final) return final;
      final = { status, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}), ...(index !== undefined && status !== 'succeeded' ? { failedStep: index } : {}), have: { [item]: inventory()[item] ?? 0 }, ...(given !== undefined ? { given } : {}), plan: { stepCount: plan.steps.length } };
      // Resumable obtains report a reflex preemption themselves: the caller decides
      // between goal.suspended (it will retry) and a single terminal goal.end.
      if (!(deferPreempted && (status === 'preempted' || reason === 'items_taken'))) {
        emit('goal.end', { status, reason, failedStep: final.failedStep, have: final.have });
      }
      return final;
    };
    const run = async context => {
      const { signal, isActive = () => true } = context ?? {};
      const started = now();
      const check = () => {
        if (signal?.aborted || !isActive()) throw { status: abortStatus(signal) };
        if (now() - started >= deadlineMs) throw { reason: 'deadline' };
      };
      const noteTaken = r => {
        const drops = r?.result?.takenByOwner;
        if (drops && typeof drops === 'object') {
          for (const [name, n] of Object.entries(drops)) {
            if (n > 0) { shared.taken[name] = (shared.taken[name] ?? 0) + n; shared.takenEvents++; }
          }
        }
        const smeltTaken = r?.result?.taken;
        if (smeltTaken > 0 && r.result?.output) {
          shared.taken[r.result.output] = (shared.taken[r.result.output] ?? 0) + smeltTaken;
          shared.takenEvents++;
        }
      };
      const takenOf = name => shared.taken[name] ?? 0;
      // The owner grabbing her drops/furnace output counts as delivery for
      // giveToOwner goals; other goals replan once, twice, then stop honestly.
      const takenAtStart = shared.takenEvents;
      const checkTaken = name => {
        if (!giveToOwner && takenOf(name) > 0 && shared.takenEvents > takenAtStart) {
          throw { reason: 'items_taken' };
        }
      };
      const run = async (name, params, timeoutMs) => {
        check();
        // An exhausted budget refuses the mutation before it is attempted —
        // an honest step failure that aborts the plan with a named reason.
        if (overBudget(name)) throw { reason: 'action_budget_exhausted' };
        let r;
        const attempt = async () => {
          try {
            const result = await registry.run(name, params, { signal, traceId, ...(timeoutMs ? { timeoutMs } : {}) });
            // A resolved run means the primitive actually attempted — success
            // or failure, it still costs (same rule as the arbiter).
            spend(name);
            return result;
          } catch { return { ok: false, error: { code: 'primitive_failed' } }; }
        };
        r = await attempt();
        if (r?.ok === false && r.error?.disturbed) r = await attempt();
        noteTaken(r);
        check(); return r;
      };
      const countItem = async name => {
        // countItem is a free query: registry.query() skips the primitive.start/
        // end rows a run() writes on every call. Harnesses that only stub run()
        // keep working through the fallback.
        const r = typeof registry.query === 'function'
          ? await registry.query('countItem', { itemName: name }).then(result => ({ ok: true, result }), error => ({ ok: false, error }))
          : await run('countItem', { itemName: name });
        if (r.ok === false || !Number.isFinite(r.result)) throw { reason: 'count_failed' };
        return r.result;
      };
      const placeBlock = async itemName => {
        const remember = pos => { if (itemName === 'crafting_table') tablePos = pos; else if (itemName === 'furnace') furnacePos = pos; };
        let lastError;
        for (let attempt = 0; attempt < 3; attempt++) {
          const p = bot.entity.position.floored?.() ?? new Vec3(Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y), Math.floor(bot.entity.position.z));
          for (let y = -1; y <= 1; y++) for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
            const q = p.offset(x, y, z);
            if ((!x && !z && (y === 0 || y === 1)) || q.distanceTo(bot.entity.position) > 4) continue;
            const target = bot.blockAt(q), below = bot.blockAt(q.offset(0, -1, 0));
            if (!['air', 'cave_air', 'void_air'].includes(target?.name) || below?.boundingBox !== 'block') continue;
            const r = await run('place', { itemName, x: q.x, y: q.y, z: q.z });
            if (r.ok !== false) { remember(q); return; }
            lastError = r.error;
          }
          if (attempt < 2) {
            const angle = Math.random() * Math.PI * 2;
            await run('goTo', { x: Math.round(p.x + Math.cos(angle) * 2), y: p.y, z: Math.round(p.z + Math.sin(angle) * 2), range: 1 });
          }
        }
        throw { reason: itemName === 'crafting_table' ? 'no_place_for_table' : 'no_place_for_furnace', detail: lastError };
      };
      const placeTable = () => placeBlock('crafting_table');
      const ensureTable = async () => {
        if (nearby('crafting_table')) return;
        const pos = knownTable();
        if (pos) {
          await run('goTo', { x: pos.x, y: pos.y, z: pos.z, range: 2 }, 30000);
          if (nearby('crafting_table')) return;
        }
        const stock = inventory();
        if (!(stock.crafting_table > 0)) {
          if (!Object.entries(stock).some(([name, n]) => name.endsWith('_planks') && n >= 4)) throw { reason: 'no_table' };
          const r = await run('craft', { itemName: 'crafting_table', count: 1, useTable: false });
          if (r.ok === false) throw { reason: 'no_table' };
        }
        await placeTable();
      };
      const ensureFurnace = async () => {
        if (nearby('furnace')) return;
        const pos = knownFurnace();
        if (pos) {
          await run('goTo', { x: pos.x, y: pos.y, z: pos.z, range: 2 }, 30000);
          if (nearby('furnace')) return;
        }
        if (!(inventory().furnace > 0)) throw { reason: 'no_furnace' };
        await placeBlock('furnace');
      };
      emit('goal.start', { item, count, summary: plan.summary });
      try {
        if (plan.steps.length > 48) throw { reason: 'step_budget' };
        for (index = 0; index < plan.steps.length; index++) {
          check(); const s = plan.steps[index];
          emit('goal.step', { index, type: s.type, item: s.item ?? s.itemName, count: s.count ?? s.times * s.yields });
          check();
          if (s.type === 'equip') {
            if ((await run('equip', { itemName: s.itemName, slot: 'hand' })).ok === false) throw { reason: 'equip_failed' };
          } else if (s.type === 'place_table') await placeTable();
          else if (s.type === 'place_furnace') {
            if (!nearby('furnace')) await placeBlock('furnace');
          } else if (s.type === 'smelt') {
            await ensureFurnace();
            const r = await run('smelt', { itemName: s.input, count: s.count, fuel: s.fuel },
              Math.min(900000, 20000 + s.count * 12000));
            if (r.ok === false) throw { reason: 'smelt_failed', detail: r.error };
            checkTaken(r.result?.output ?? item);
          } else if (s.type === 'craft') {
            // findBlock can disagree with itself across the 4-block boundary or a
            // chunk refresh: on no_table re-run ensureTable once before failing.
            let r;
            for (let attempt = 0; attempt < 2; attempt++) {
              if (s.needsTable) await ensureTable();
              r = await run('craft', { itemName: s.item, count: s.times * s.yields, useTable: s.needsTable });
              if (r.ok !== false || r.error?.code !== 'no_table') break;
            }
            if (r.ok === false) throw { reason: 'craft_failed', detail: r.error };
          } else if (s.type === 'collect') {
            if (s.tool && bot.heldItem?.name !== s.tool && (await run('equip', { itemName: s.tool, slot: 'hand' })).ok === false) throw { reason: 'equip_failed' };
            const base = await countItem(s.item);
            // Pickups and server slot corrections can swap the held stack mid-intent;
            // digs only drop loot with the right tool, so re-assert it before every dig.
            const toolRegistry = Object.assign(Object.create(registry), {
              run: async (name, params, options) => {
                // The intent's inner steps bypass the `run` helper — bill them
                // here so a plan-sourced dig pays like any other mutation.
                if (overBudget(name)) return { ok: false, error: { code: 'action_budget_exhausted' } };
                if (name === 'dig' && s.tool && bot.heldItem?.name !== s.tool) {
                  const equipped = await registry.run('equip', { itemName: s.tool, slot: 'hand' }, options);
                  if (equipped.ok === false) return equipped;
                }
                const r = await registry.run(name, params, options);
                spend(name);
                if (name === 'collectDrops') noteTaken(r);
                return r;
              },
            });
            const r = await runIntent({ registry: toolRegistry, jev, bot, mcData, eventlog, confidenceMin, clock, traceId, ...context,
              intent: { goal: `Collect ${s.item}`, goalText: `Collect ${s.item}`, target: { blocks: s.blocks, item: s.item }, success: { hasItem: s.item, atLeast: base + s.count }, allowed: ['findBlock', 'goTo', 'dig', 'collectDrops'], maxSteps: 40, deadlineMs: Math.max(1, Math.min(180000, deadlineMs - (now() - started))), requestedCount: s.count, baseCount: base } });
            check();
            if (r.status !== 'succeeded') {
              // Owner pickups during the intent still count toward delivery;
              // otherwise they are a take event, not an intent failure.
              if (takenOf(s.item) >= s.count && giveToOwner) continue;
              if (takenOf(s.item) > 0) checkTaken(s.item);
              throw r;
            }
            checkTaken(s.item);
          } else if (s.type === 'kill') {
            const target = await countItem(s.item) + s.count, start = now();
            const reached = async () => await countItem(s.item) + (giveToOwner ? takenOf(s.item) : 0) >= target;
            let searches = 0, previous, failures = 0;
            for (let round = 0; !(await reached()); round++) {
              if (round >= 40) throw { reason: 'step_budget' };
              if (now() - start >= 240000) throw { reason: 'deadline' };
              const r = await run('attack', { entityName: s.entityName, maxHits: 20 });
              const reason = r.error?.code ?? r.error?.message ?? r.result?.reason;
              if (r.ok !== false && r.result?.killed) { searches = failures = 0; previous = undefined; await run('collectDrops', { radius: 8 }); checkTaken(s.item); }
              else if (reason === 'health_too_low') throw { reason };
              else if (reason === 'target_not_found') {
                failures = 0; previous = undefined;
                if (searches >= 6) throw { reason };
                const [x, z] = [[10, 0], [0, 10], [-10, 0], [0, -10]][searches++ % 4], p = bot.entity.position;
                await run('goTo', { x: Math.round(p.x + x), y: Math.round(p.y), z: Math.round(p.z + z), range: 1 });
              } else { failures = previous === reason ? failures + 1 : 1; previous = reason; searches = 0; if (failures >= 2) throw { reason: 'attack_failed' }; }
            }
          }
        }
        const haveNow = await countItem(item);
        if (haveNow + (giveToOwner ? takenOf(item) : 0) < count) throw { reason: giveToOwner ? 'give_failed' : 'insufficient_items' };
        let given = 0;
        if (giveToOwner && haveNow > 0) {
          const r = await run('give', { itemName: item, count: Math.min(count, haveNow) });
          if (r.ok === false) throw { reason: 'give_failed' };
          given = r.result?.given ?? Math.min(count, haveNow);
        }
        const delivered = Math.min(count, given + (giveToOwner ? takenOf(item) : 0));
        if (giveToOwner && delivered < count) throw { reason: 'give_failed', detail: `delivered ${delivered}/${count}` };
        return finish('succeeded', undefined, undefined, giveToOwner ? delivered : undefined);
      } catch (e) { return finish(['cancelled', 'preempted'].includes(e?.status) ? e.status : 'failed', e?.reason ?? (e instanceof Error ? `internal_error:${e.message}` : undefined), e?.detail); }
    };
    return { run, finish, get final() { return final; } };
  }
  function obtain({ item, count, giveToOwner = false, traceId } = {}) {
    const immediate = result => ({ accepted: false, done: Promise.resolve(result) });
    if (typeof giveToOwner !== 'boolean') return immediate({ status: 'failed', reason: 'invalid_goal' });
    const ready = feasibility({ item, count });
    if (!ready.ok) return immediate({ status: 'failed', reason: ready.reason, detail: ready.detail });
    lastGoalRequest = { item, count, giveToOwner };
    const emit = (kind, payload) => { try { eventlog?.append(kind, payload, traceId); } catch {} };
    const shared = { taken: {}, takenEvents: 0 };
    const start = plan => {
      const session = execution(plan, { item, count, giveToOwner, traceId, deferPreempted: true, shared, source: 'owner' });
      const task = arbiter.submit({ source: 'owner', label: `obtain ${item}`, traceId, dynamic: context => session.run(context) });
      return { session, task };
    };
    let attempt = start(ready.plan);
    current = attempt.task;
    // Reflex preemption (fighting, hazard escapes) suspends the goal instead of
    // ending it: once the reflex clears, replan from real stock and resubmit.
    const done = (async () => {
      let resumes = 0;
      for (;;) {
        const outcome = await attempt.task.done;
        const result = attempt.session.final ?? attempt.session.finish(
          ['cancelled', 'preempted'].includes(outcome.status) ? outcome.status : 'failed',
          outcome.reason ?? (outcome.status === 'rejected' ? 'busy' : undefined));
        if (current === attempt.task) current = null;
        // Owner taking her target mid-goal is a replan event, not a failure —
        // twice and she stops and reports it honestly.
        if (result.status === 'failed' && result.reason === 'items_taken') {
          const again = shared.takenEvents < 2 ? feasibility({ item, count }) : { ok: false };
          if (!again.ok) {
            emit('goal.end', { status: 'failed', reason: 'items_taken', have: result.have });
            return result;
          }
          emit('goal.resume', { item, count, attempt: ++resumes, reason: 'items_taken' });
          attempt = start(again.plan);
          if (attempt.task.accepted === false) {
            return { status: 'failed', reason: 'busy', have: result.have };
          }
          current = attempt.task;
          continue;
        }
        if (result.status !== 'preempted' || outcome.preemptedBy !== 'reflex') {
          if (result.status === 'preempted') {
            emit('goal.end', { status: 'preempted', failedStep: result.failedStep, have: result.have });
          }
          return result;
        }
        if (resumes >= 5) {
          emit('goal.end', { status: 'preempted', reason: 'resume_limit', have: result.have });
          return { ...result, reason: 'resume_limit' };
        }
        const cleared = await arbiterFree(arbiter, timers);
        if (cleared !== true) {
          emit('goal.end', { status: 'preempted', have: result.have });
          return result;
        }
        const again = feasibility({ item, count });
        if (!again.ok) {
          emit('goal.end', { status: 'failed', reason: again.reason, have: result.have });
          return { status: 'failed', reason: again.reason, detail: again.detail, have: result.have };
        }
        emit('goal.suspended', { item, count, have: result.have, attempt: resumes });
        emit('goal.resume', { item, count, attempt: ++resumes });
        attempt = start(again.plan);
        if (attempt.task.accepted === false) {
          emit('goal.end', { status: 'failed', reason: 'busy', have: result.have });
          return { status: 'failed', reason: 'busy', have: result.have };
        }
        current = attempt.task;
      }
    })();
    return { ...attempt.task, done };
  }
  function obtainInline({ item, count, giveToOwner = false, context, traceId = context?.traceId } = {}) {
    const ready = feasibility({ item, count });
    if (!ready.ok) return Promise.resolve({ status: 'failed', reason: ready.reason, detail: ready.detail });
    // The arbiter hands its task source down in the obtain context (arbiter.js
    // `source: task.source`); the execution bills inner mutations under it.
    return execution(ready.plan, { item, count, giveToOwner, traceId, source: context?.source }).run(context);
  }
  return { obtain, obtainInline, feasibility, preferredLog,
    lastRequest: () => (lastGoalRequest ? { ...lastGoalRequest } : null),
    cancel() { if (current) arbiter.cancel('owner'); } };
}
