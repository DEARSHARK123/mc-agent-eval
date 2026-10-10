import { Vec3 } from 'vec3';
import { BLUEPRINTS, blueprintGeometry, buildSegments, frameBoxes, volumeBox } from './blueprints.js';
import { findSite, plantSet } from './site.js';
import { resolveClock } from '../clock.js';
import { abortStatus } from '../outcome.js';
import { arbiterFree } from '../arbiter.js';

const PLACE_REACH = 4.2;

export function createBuilder({ registry, arbiter, bot, mcData, goals, eventlog, clock = {}, deadlineMs = 600000,
  ownerPosition = () => null, protection = null }) {
  const timers = resolveClock(clock);
  const now = timers.now;
  const plants = plantSet(mcData);
  const remembered = new Map();
  const blockAt = (x, y, z) => bot.blockAt(new Vec3(x, y, z));
  const stock = name => bot.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
  const resolveBlueprint = blueprint => typeof blueprint === 'string' ? BLUEPRINTS[blueprint] : blueprint;
  const solidCells = cells => cells.filter(cell => cell.role !== 'door');

  function pickMaterial() {
    let best = null;
    let most = 0;
    for (const item of bot.inventory.items()) {
      if (!item.name.endsWith('_planks')) continue;
      const count = stock(item.name);
      if (count > most) { most = count; best = item.name; }
    }
    if (best) return best;
    const fallback = `${(goals?.preferredLog?.() ?? 'oak_log').replace(/_log$/u, '')}_planks`;
    return Object.hasOwn(mcData.itemsByName, fallback) ? fallback : 'oak_planks';
  }

  function inspect({ blueprint } = {}) {
    const plan = resolveBlueprint(blueprint);
    if (!plan) return { ok: false, reason: 'unknown_blueprint' };
    const site = findSite({ blueprint: plan, origin: bot.entity.position, blockAt, owner: ownerPosition(), plants,
      remembered: remembered.get(plan.key) ?? null, protection });
    if (!site.ok) return { ok: false, reason: site.reason };
    const material = pickMaterial();
    const cells = solidCells(blueprintGeometry(plan, site).cells);
    return { ok: true, site, material, need: cells.filter(cell => blockAt(cell.x, cell.y, cell.z)?.name !== material).length,
      have: stock(material) };
  }

  function build({ blueprint, traceId } = {}) {
    const plan = resolveBlueprint(blueprint);
    const emit = (kind, payload) => { try { eventlog?.append(kind, payload, traceId); } catch {} };
    // Each attempt owns a fresh state/final so a reflex-preempted build can be
    // resubmitted and keep going from the remembered site.
    const startAttempt = () => {
      const state = { frame: false, markers: false, material: null, site: null, cells: [] };
      let final;
      const finish = (status, reason, detail) => {
        if (final) return final;
        const placed = state.cells.filter(cell => blockAt(cell.x, cell.y, cell.z)?.name === state.material).length;
        final = { status, ...(reason ? { reason } : {}), ...(detail !== undefined ? { detail } : {}), placed,
          frame: state.frame, material: state.material, site: state.site };
        // A preempted attempt is only an intermediate: the caller resumes it or
        // emits the terminal build.end itself.
        emit(status === 'preempted' ? 'build.suspended' : 'build.end', { status, reason, placed, frame: state.frame });
        return final;
      };
    const run = async context => {
      const { signal, isActive = () => true } = context ?? {};
      const started = now();
      const check = (deadline = true) => {
        if (signal?.aborted || !isActive()) throw { status: abortStatus(signal) };
        if (deadline && now() - started >= deadlineMs) throw { reason: 'deadline' };
      };
      const call = async (name, params, deadline = true) => {
        check(deadline);
        let result;
        try { result = await registry.run(name, params, { signal, traceId }); }
        catch (error) { result = { ok: false, error: { code: error?.code ?? 'primitive_failed', message: error?.message } }; }
        check(deadline);
        return result;
      };
      let outcome = null;
      try {
        if (!plan) throw { reason: 'unknown_blueprint' };
        const info = inspect({ blueprint: plan });
        if (!info.ok) throw { reason: info.reason };
        const { site, material } = info;
        const geometry = blueprintGeometry(plan, site);
        const solid = solidCells(geometry.cells);
        Object.assign(state, { material, site: { origin: site.origin, rotation: site.rotation, resumed: site.resumed }, cells: solid });
        state.markers = site.resumed;
        remembered.set(plan.key, { origin: site.origin, rotation: site.rotation });
        emit('build.start', { blueprint: plan.key, site: site.origin, rotation: site.rotation, material,
          need: info.need, resumed: site.resumed });

        if (info.have < info.need) {
          const got = await goals.obtainInline({ item: material, count: Math.min(64, info.need), context });
          if (['cancelled', 'preempted'].includes(got?.status)) throw { status: got.status };
          if (got?.status !== 'succeeded') throw { reason: 'materials_failed', detail: got?.reason };
        }

        for (let y = 0; y < plan.size.y; y++) for (let x = 0; x < plan.size.x; x++) for (let z = 0; z < plan.size.z; z++) {
          const at = { x: site.origin.x + x, y: site.origin.y + y, z: site.origin.z + z };
          if (!plants.has(blockAt(at.x, at.y, at.z)?.name)) continue;
          await call('goTo', { ...at, range: 3 });
          if (plants.has(blockAt(at.x, at.y, at.z)?.name)) await call('dig', at);
        }

        await call('goTo', { ...geometry.center, range: 1 });

        if (registry.has('command')) {
          state.frame = true;
          let sent = 0;
          for (const box of frameBoxes(geometry.cells)) {
            const r = await call('command', { kind: 'fill', marker: plan.marker, from: box.from, to: box.to });
            if (r.ok === false) { state.frame = false; break; }
            state.markers = true;
            sent++;
          }
          if (!state.frame && sent > 0) {
            const whole = volumeBox(geometry.cells);
            await call('command', { kind: 'clear', marker: plan.marker, from: whole.from, to: whole.to });
          }
        }

        const failed = new Set();
        const placeCell = async cell => {
          if (blockAt(cell.x, cell.y, cell.z)?.name === material) return true;
          if (stock(material) < 1) throw { reason: 'materials_failed', detail: 'out_of_material' };
          if (bot.entity.position.distanceTo(new Vec3(cell.x, cell.y, cell.z)) > PLACE_REACH) {
            // Walk up to the cell itself: from the hut centre the far roof
            // corners sit at ~4.1 blocks, past the primitive's 4.5 reach once
            // she stops a step short, and a failed centre approach leaves her
            // even farther out.
            await call('goTo', { x: cell.x, y: cell.y, z: cell.z, range: 3 });
            if (bot.entity.position.distanceTo(new Vec3(cell.x, cell.y, cell.z)) > PLACE_REACH) {
              await call('goTo', { ...geometry.center, range: 1 });
            }
          }
          const r = await call('place', { itemName: material, x: cell.x, y: cell.y, z: cell.z });
          return r.ok !== false;
        };
        for (const segment of buildSegments(geometry.cells)) {
          if (state.frame) {
            const r = await call('command', { kind: 'clear', marker: plan.marker, from: segment.box.from, to: segment.box.to });
            if (r.ok === false) state.frame = false;
          }
          for (const cell of segment.cells) if (!await placeCell(cell)) failed.add(cell);
        }
        for (const cell of [...failed]) if (await placeCell(cell)) failed.delete(cell);
        if (failed.size) throw { reason: 'blocked', detail: failed.size };
      } catch (error) {
        if (error?.status === 'cancelled' || error?.status === 'preempted') return finish(error.status);
        outcome = { reason: error?.reason ?? 'build_failed', detail: error?.detail };
      }

      if (state.site) {
        try {
          if (state.markers && registry.has('command')) {
            const whole = volumeBox(blueprintGeometry(plan, state.site).cells);
            await call('command', { kind: 'clear', marker: plan.marker, from: whole.from, to: whole.to }, false);
          }
          await call('goTo', { ...blueprintGeometry(plan, state.site).frontCell, range: 1 }, false);
        } catch (error) {
          if (error?.status) return finish(error.status);
        }
      }
      const done = state.cells.length > 0 && state.cells.every(cell => blockAt(cell.x, cell.y, cell.z)?.name === state.material);
      if (!outcome && done) {
        remembered.delete(plan.key);
        const center = blueprintGeometry(plan, state.site).center;
        protection?.add({ x: Math.floor(center.x), y: Math.floor(center.y), z: Math.floor(center.z),
          radius: 5, reason: 'own_build' }, traceId);
        finish('succeeded');
        return { status: 'completed' };
      }
      finish('failed', outcome?.reason ?? 'blocked', outcome?.detail);
      return { status: 'failed', reason: final.reason };
    };
      const task = arbiter.submit({ source: 'owner', label: `build ${plan?.key ?? 'unknown'}`, traceId, dynamic: context => run(context) });
      return { task, finish, get final() { return final; } };
    };
    let attempt = startAttempt();
    // Same reflex-resume rule as goals.obtain: a fight/hazard interruption
    // suspends the build; the remembered site makes the resubmission resume.
    const done = (async () => {
      let resumes = 0;
      for (;;) {
        const outcome = await attempt.task.done;
        const result = attempt.final ?? attempt.finish(
          ['cancelled', 'preempted'].includes(outcome.status) ? outcome.status : 'failed',
          outcome.reason ?? (outcome.status === 'rejected' ? 'busy' : undefined));
        if (result.status !== 'preempted' || outcome.preemptedBy !== 'reflex') {
          if (result.status === 'preempted') emit('build.end', { status: 'preempted', placed: result.placed, frame: result.frame });
          return result;
        }
        if (resumes >= 5) {
          emit('build.end', { status: 'preempted', reason: 'resume_limit', placed: result.placed, frame: result.frame });
          return { ...result, reason: 'resume_limit' };
        }
        const cleared = await arbiterFree(arbiter, timers);
        if (cleared !== true) {
          emit('build.end', { status: 'preempted', placed: result.placed, frame: result.frame });
          return result;
        }
        emit('build.resume', { blueprint: plan?.key, attempt: ++resumes });
        attempt = startAttempt();
        if (attempt.task.accepted === false) {
          emit('build.end', { status: 'failed', reason: 'busy' });
          return { status: 'failed', reason: 'busy' };
        }
      }
    })();
    return { ...attempt.task, done };
  }

  return { inspect, build };
}
