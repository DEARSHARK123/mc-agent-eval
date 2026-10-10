import assert from 'node:assert/strict';
import { decideProactive, PROACTIVE_PRIMITIVES } from './decide.js';
import { displayName } from '../teaching/lexicon.js';
import { resolveClock } from '../clock.js';
import { createTraceId } from '../trace.js';

export function createProactive({ bot, registry, arbiter, eventlog, mcData, ownerUuid, goals, budget,
  dialogue, narrate, config, clock = {}, stance = null }) {
  const timers = resolveClock(clock);
  const now = timers.now;
  const schedule = timers.setInterval;
  const clear = timers.clearInterval;
  const startedAt = now();
  const decideConfig = {
    followDistance: 6,
    pickupRadius: 8,
    idleProposalMs: config?.idleProposalMs ?? 180_000,
    proposalCooldownMs: config?.proposalCooldownMs ?? 600_000,
  };
  // No-progress guard (S7/T71 class): a drop that survives N consecutive pickup
  // submissions is unreachable in practice — on a column, inside a block — and
  // re-firing pickup for it spins forever. Mark it unreachable for a cooldown.
  const pickupStrikesNeeded = config?.pickupNoProgressStrikes ?? 2;
  const dropUnreachableMs = config?.pickupUnreachableMs ?? 120_000;
  const dropStrikes = new Map();
  const dropCooldown = new Map();
  let prevPickupTargets = new Set();
  let stopped = false;
  let ownerHurtAt = -Infinity;
  let nightfallPending = false;
  let wasDay = bot.time?.isDay !== false;
  let lastChatAt = startedAt;
  let lastTaskDoneAt = startedAt;
  let lastOwnerHealth = null;
  const last = {};

  const log = (kind, payload, traceId) => { try { eventlog.append(kind, payload, traceId); } catch {} };
  const speak = (situation, traceId) => {
    try {
      Promise.resolve(narrate(situation, traceId))
        .catch(error => log('proactive.error', { name: error?.name ?? 'Error', stage: 'narrate' }, traceId));
    } catch (error) {
      log('proactive.error', { name: error?.name ?? 'Error', stage: 'narrate' }, traceId);
    }
  };

  function ownerEntity() {
    const player = Object.values(bot.players ?? {})
      .find(entry => ownerUuid && entry?.uuid?.toLowerCase() === ownerUuid.toLowerCase());
    return player?.entity ?? null;
  }

  function ownerHealth(entity) {
    const raw = entity?.metadata?.[9];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  }

  function inventory() {
    try { return bot.inventory?.items() ?? []; } catch { return []; }
  }

  function proposalCandidate() {
    const items = inventory();
    const countOf = name => items.filter(item => item?.name === name).reduce((n, item) => n + item.count, 0);
    const candidates = [];
    if (!items.some(item => item?.name?.endsWith('_pickaxe'))) {
      candidates.push({ item: 'wooden_pickaxe', count: 1 });
    } else if (countOf('wooden_pickaxe') > 0
        && !['stone_pickaxe', 'golden_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']
          .some(name => countOf(name) > 0)) {
      candidates.push({ item: 'stone_pickaxe', count: 1 });
    }
    const logs = items.filter(item => item?.name?.endsWith('_log')).reduce((n, item) => n + item.count, 0);
    const planks = items.filter(item => item?.name?.endsWith('_planks')).reduce((n, item) => n + item.count, 0);
    if (logs + planks / 4 < 8) {
      try {
        const block = bot.findBlock?.({ matching: b => typeof b?.name === 'string' && b.name.endsWith('_log'), maxDistance: 32 });
        if (block && Object.hasOwn(mcData?.itemsByName ?? {}, block.name)) {
          candidates.push({ item: block.name, count: 8 });
        }
      } catch {}
    }
    for (const candidate of candidates) {
      try {
        if (goals.feasibility({ item: candidate.item, count: candidate.count })?.ok) return candidate;
      } catch {}
    }
    return null;
  }

  function tick() {
    if (stopped || !bot.entity?.position) return;
    try {
      const at = now();
      const position = bot.entity.position;
      const isDay = bot.time?.isDay !== false;
      if (wasDay && !isDay) nightfallPending = true;
      if (isDay) nightfallPending = false;
      wasDay = isDay;

      const entity = ownerEntity();
      let owner = null;
      if (entity?.position) {
        const health = ownerHealth(entity);
        // entityHurt is the primary trigger; a metadata health drop covers platforms
        // where hurt packets for other players never reach the client.
        if (health !== null && lastOwnerHealth !== null && health < lastOwnerHealth) ownerHurtAt = at;
        lastOwnerHealth = health;
        owner = { uuid: ownerUuid, distance: position.distanceTo(entity.position), health };
      } else {
        lastOwnerHealth = null;
      }

      const drops = Object.entries(bot.entities ?? {})
        .filter(([, e]) => e?.position && e !== entity && typeof e.getDroppedItem === 'function' && e.getDroppedItem())
        .map(([key, e]) => ({ id: e.id ?? key, distance: position.distanceTo(e.position),
          ownerDistance: entity?.position ? entity.position.distanceTo(e.position) : null }))
        .filter(drop => drop.distance <= 16);
      // Forget drops that left sight (picked up or despawned) and un-mark drops
      // whose cooldown expired — they get fresh attempts.
      const seen = new Set(drops.map(drop => drop.id));
      for (const id of dropStrikes.keys()) if (!seen.has(id)) dropStrikes.delete(id);
      for (const [id, until] of dropCooldown) {
        if (!seen.has(id)) dropCooldown.delete(id);
        else if (until <= at) { dropCooldown.delete(id); dropStrikes.delete(id); }
      }
      const visibleDrops = drops.filter(drop => !dropCooldown.has(drop.id));
      const freeSlots = bot.inventory?.emptySlotCount?.() ?? 0;
      const gives = eventlog.query({ kind: 'primitive.end', since: at - 15_000, limit: 50 })
        .filter(row => row.payload?.name === 'give');
      const lastGiveAt = gives.length ? Math.max(...gives.map(row => row.ts)) : -Infinity;

      let bed = 'none';
      try {
        if (bot.findBlock?.({ matching: b => typeof b?.name === 'string' && b.name.endsWith('_bed'), maxDistance: 32 })) {
          bed = 'nearby';
        } else if (inventory().some(item => item?.name?.endsWith('_bed'))) {
          bed = 'inventory';
        }
      } catch {}

      const snapshot = {
        now: at,
        isSleeping: !!bot.isSleeping,
        idle: arbiter.current() === null,
        owner,
        ownerHurtAt,
        nightfall: nightfallPending,
        bed,
        drops: visibleDrops,
        freeSlots,
        lastGiveAt,
        quietSince: Math.max(startedAt, lastChatAt, lastTaskDoneAt),
        openQuestion: Boolean(dialogue?.getQuestion?.()),
        proposal: null,
        budget: { remaining: budget?.remaining?.() ?? 0, reserve: budget?.reserve ?? 1 },
        last,
      };
      // Only ask the planner when every other proposal gate already passes.
      if (snapshot.idle && owner && owner.distance <= 8 && !snapshot.openQuestion
          && snapshot.budget.remaining >= snapshot.budget.reserve
          && at - snapshot.quietSince >= decideConfig.idleProposalMs
          && at - (last.propose ?? -Infinity) >= decideConfig.proposalCooldownMs) {
        snapshot.proposal = proposalCandidate();
      }

      // T28: an active stance may move the follow band and quiet proposals.
      const activeStance = stance?.current?.() ?? null;
      const stanceFollow = Number.isFinite(activeStance?.params?.followDistance)
        ? activeStance.params.followDistance : null;
      decideConfig.followDistance = stanceFollow ?? 6;
      decideConfig.followRange = stanceFollow ?? 3;
      snapshot.suppressProposals = activeStance?.name === 'keep_distance';

      const action = decideProactive(snapshot, decideConfig);
      if (!action) return;
      const traceId = createTraceId();
      if (action.kind === 'remark') {
        last[action.reason] = at;
        if (action.reason === 'nightfall') nightfallPending = false;
        speak({ kind: 'proactive_remark', reason: action.reason,
          ...(action.bed != null ? { bed: action.bed } : {}),
          ...(action.health != null ? { ownerHealth: action.health } : {}) }, traceId);
        log('proactive.action', { kind: 'remark', reason: action.reason, decidedAt: at }, traceId);
        return;
      }
      if (action.kind === 'propose') {
        last.propose = at;
        dialogue.setQuestion({ type: 'propose_goal', action: displayName(action.item),
          args: { item: action.item, count: action.count } });
        speak({ kind: 'propose', item: action.item, itemName: displayName(action.item), count: action.count }, traceId);
        log('proactive.action', { kind: 'propose', item: action.item, count: action.count, decidedAt: at }, traceId);
        return;
      }
      for (const step of action.steps ?? []) assert.ok(PROACTIVE_PRIMITIVES.includes(step.primitive));
      for (const step of action.steps ?? []) registry.validate?.(step.primitive, step.params);
      const label = `proactive:${action.kind}`;
      if (arbiter.current() !== null) return;
      const result = arbiter.submit({ source: 'idle', label, steps: action.steps });
      if (!result?.accepted) return;
      if (action.kind === 'pickup') {
        // A drop still present at the next submission made no progress.
        const targets = new Set(visibleDrops
          .filter(drop => drop.distance <= decideConfig.pickupRadius)
          .map(drop => drop.id));
        for (const id of targets) {
          if (!prevPickupTargets.has(id)) continue;
          const strikes = (dropStrikes.get(id) ?? 0) + 1;
          if (strikes >= pickupStrikesNeeded) {
            dropCooldown.set(id, at + dropUnreachableMs);
            dropStrikes.delete(id);
            log('proactive.drop_unreachable', { entityId: id, strikes, until: at + dropUnreachableMs }, traceId);
          } else {
            dropStrikes.set(id, strikes);
          }
        }
        prevPickupTargets = targets;
      }
      last[action.kind] = at;
      log('proactive.action', { kind: action.kind, label, decidedAt: at }, traceId);
    } catch (error) {
      log('proactive.error', { name: error?.name ?? 'Error' });
    }
  }

  const onHurt = entity => {
    const owner = ownerEntity();
    if ((owner && entity === owner) || (entity?.uuid?.toLowerCase() === ownerUuid?.toLowerCase())) {
      ownerHurtAt = now();
    }
  };
  const onDone = () => { lastTaskDoneAt = now(); };
  bot.on?.('entityHurt', onHurt);
  arbiter.on?.('done', onDone);
  const timer = schedule(tick, config?.tickMs ?? 1000);

  return Object.freeze({
    tick,
    noteOwnerChat() { lastChatAt = now(); },
    stop() {
      if (stopped) return;
      stopped = true;
      clear(timer);
      bot.off?.('entityHurt', onHurt);
      arbiter.off?.('done', onDone);
    },
  });
}
