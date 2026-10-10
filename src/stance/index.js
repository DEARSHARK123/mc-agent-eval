import { resolveClock } from '../clock.js';
import { createTraceId } from '../trace.js';
import { createTriggers } from './triggers.js';
import { BEHAVIOUR_PRIORITIES } from '../persona.js';

// T28: the stance layer. Deterministic triggers detect a conflict; the brain
// (when configured) may pick the stance, but only inside the whitelist below —
// invalid output, timeouts and a missing brain all fall back to the default
// table, so behaviour is never worse than T27. Reflexes still run first: the
// stance only writes a small state object that survival/proactive consult.

export const TRIGGER_KINDS = Object.freeze([
  'night_pressure', 'goal_pressure', 'owner_far_danger',
  'owner_tease', 'items_taken', 'trapped_artificial',
]);

export const STANCE_NAMES = Object.freeze([
  'clear_then_sleep', 'retreat_to_shelter', 'stay_with_owner', 'guard_night',
  'keep_distance', 'ask_owner', 'redo', 'resume',
]);

// Whitelist per trigger (T28 §3): a brain answer outside this list is invalid.
export const ALLOWED_STANCES = Object.freeze({
  night_pressure: Object.freeze(['clear_then_sleep', 'retreat_to_shelter', 'stay_with_owner', 'guard_night', 'ask_owner']),
  goal_pressure: Object.freeze(['resume', 'ask_owner', 'stay_with_owner', 'keep_distance']),
  owner_far_danger: Object.freeze(['retreat_to_shelter', 'stay_with_owner', 'ask_owner', 'guard_night', 'clear_then_sleep']),
  owner_tease: Object.freeze(['keep_distance', 'resume', 'ask_owner']),
  items_taken: Object.freeze(['redo', 'ask_owner', 'resume']),
  trapped_artificial: Object.freeze(['ask_owner', 'stay_with_owner', 'resume']),
});

export const PARAM_RULES = Object.freeze({
  clear_then_sleep: Object.freeze({ fightRadius: { min: 4, max: 12 }, giveUpSec: { min: 30, max: 180, integer: true } }),
  retreat_to_shelter: Object.freeze({ target: { enum: ['hut', 'bed', 'owner'] } }),
  stay_with_owner: Object.freeze({ followDistance: { min: 2, max: 6 }, fightRadius: { min: 3, max: 8 } }),
  guard_night: Object.freeze({ patrolRadius: { min: 4, max: 10 } }),
  keep_distance: Object.freeze({ followDistance: { min: 4, max: 10 } }),
  ask_owner: Object.freeze({ waitSec: { min: 20, max: 90, integer: true } }),
  redo: Object.freeze({ maxRetries: { min: 0, max: 2, integer: true } }),
  resume: Object.freeze({}),
});
// Shared by every stance: ttl is bounded by dawn at apply time, and fleeHealth
// may only become *more* conservative — the [default, 12] clamp is enforced by
// the consumer (survival tick); the rule here keeps it inside its ceiling.
const COMMON_RULES = Object.freeze({
  ttlSec: { min: 60, max: 1_800, integer: true },
  fleeHealth: { min: 1, max: 12 },
});

export const STANCE_DEFAULTS = Object.freeze({
  clear_then_sleep: Object.freeze({ fightRadius: 8, giveUpSec: 90 }),
  retreat_to_shelter: Object.freeze({ target: 'hut' }),
  stay_with_owner: Object.freeze({ followDistance: 4, fightRadius: 6 }),
  guard_night: Object.freeze({ patrolRadius: 6 }),
  keep_distance: Object.freeze({ followDistance: 8 }),
  ask_owner: Object.freeze({ waitSec: 45 }),
  redo: Object.freeze({ maxRetries: 1 }),
  resume: Object.freeze({}),
});

// Deterministic default table (T28 §4) for no-brain/timeout/invalid runs.
export function defaultStance(trigger, ctx = {}) {
  switch (trigger) {
    case 'night_pressure':
      return ctx.hasHut
        ? { name: 'retreat_to_shelter', params: { target: 'hut' } }
        : { name: 'stay_with_owner', params: { ...STANCE_DEFAULTS.stay_with_owner } };
    case 'goal_pressure':
      return { name: 'resume', params: {} };
    case 'owner_far_danger':
      return { name: 'retreat_to_shelter', params: { target: 'owner' } };
    case 'owner_tease':
      return { name: 'resume', params: {} };
    case 'items_taken':
      return (ctx.itemsTakenFires ?? 0) <= 1
        ? { name: 'redo', params: { maxRetries: 1 } }
        : { name: 'ask_owner', params: { waitSec: 60 } };
    case 'trapped_artificial':
      return { name: 'ask_owner', params: { waitSec: 60 } };
    default:
      return { name: 'resume', params: {} };
  }
}

// Choices that contradict the behaviour-priority order for a trigger (T28 §5):
// still applied, but logged as stance.deviation.
const DEVIATING = {
  owner_far_danger: new Set(['guard_night', 'clear_then_sleep']),
  goal_pressure: new Set(['keep_distance']),
  trapped_artificial: new Set(['stay_with_owner']),
};

// Schema + whitelist validation of the brain's JSON answer. `raw` is whatever
// brain.stance() returned (already JSON.parsed by llm.js, nothing domain-validated).
export function validateStance(raw, trigger) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'shape' };
  const name = typeof raw.stance === 'string' ? raw.stance
    : typeof raw.name === 'string' ? raw.name : null;
  if (!name || !STANCE_NAMES.includes(name)) return { ok: false, reason: 'unknown_stance' };
  if (!(ALLOWED_STANCES[trigger] ?? []).includes(name)) return { ok: false, reason: 'disallowed' };
  const rules = { ...PARAM_RULES[name], ...COMMON_RULES };
  const input = raw.params ?? {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'shape' };
  const params = {};
  for (const [key, value] of Object.entries(input)) {
    const rule = rules[key];
    if (!rule) return { ok: false, reason: `param_${key}` };
    if (rule.enum) {
      if (!rule.enum.includes(value)) return { ok: false, reason: `param_${key}` };
    } else if (typeof value !== 'number' || !Number.isFinite(value)
        || (rule.integer === true && !Number.isSafeInteger(value))
        || value < rule.min || value > rule.max) {
      return { ok: false, reason: `param_${key}` };
    }
    params[key] = value;
  }
  // A malformed extra line costs only the line, never the stance itself.
  let line = null;
  if (typeof raw.line === 'string') {
    const flat = raw.line.replace(/[\r\n\u2028\u2029]/gu, ' ').trim();
    const text = Array.from(flat).slice(0, 40).join('');
    if (text && !text.includes('主人')) line = text;
  }
  return { ok: true, name, params, line };
}

// The whitelist rendered as data for the brain prompt (T28 §2/§3).
export function allowedSpec(trigger) {
  return (ALLOWED_STANCES[trigger] ?? []).map(name => ({
    name,
    params: Object.fromEntries(Object.entries({ ...PARAM_RULES[name], ...COMMON_RULES })
      .map(([key, rule]) => [key, rule.enum ?? [rule.min, rule.max]])),
  }));
}

export function createStanceEngine({ bot, eventlog, registry, arbiter, survival, goals, brain,
  protection, body, speak, getSnapshot, ownerUuid, config = {}, clock = {} } = {}) {
  const timers = resolveClock(clock);
  const now = timers.now;
  const tickMs = config.tickMs ?? 1_000;
  const cooldownMs = config.cooldownMs ?? 30_000;
  const triggers = createTriggers({ eventlog, ownerUuid, body, clock });
  const log = (kind, payload, traceId) => { try { eventlog?.append?.(kind, payload, traceId); } catch {} };
  let stopped = false;
  let deciding = false;
  let inflight = null;              // AbortController for the brain call in flight
  let stance = null;                // { name, params, trigger, setAt, expiresAt, ... }
  const firedAt = {};               // trigger kind -> engine-clock of last decision
  const history = [];               // last <=3 applied stances, for the prompt
  const fires = {};                 // per-kind decision count (items_taken defaults)

  const snapshot = () => {
    try { return getSnapshot?.() ?? survival?.snapshot?.() ?? null; } catch { return null; }
  };
  const hasHut = snap => Boolean(snap?.hut)
    || (protection?.zones?.() ?? []).some(zone => zone.reason === 'own_build');

  // ttlSec bounds expiry; for night stances dawn is the real upper bound
  // (24000 - timeOfDay ticks at 50 ms each).
  const dawnAt = (at, snap) => {
    const tod = snap?.timeOfDay;
    if (snap?.isNight === true && Number.isFinite(tod)) {
      return at + Math.max(0, (24_000 - tod) % 24_000 || 24_000) * 50;
    }
    return Infinity;
  };

  const defaultCtx = (kind, snap) => ({
    hasHut: hasHut(snap),
    itemsTakenFires: fires.items_taken ?? 0,
  });

  function say(current) {
    if (typeof speak !== 'function') return;
    try {
      const situation = { kind: 'stance', name: current.name, trigger: current.trigger,
        ...(current.line ? { line: current.line } : {}) };
      Promise.resolve(speak(situation, current.traceId))
        .catch(error => log('stance.error', { name: error?.name ?? 'Error', stage: 'speak' }, current.traceId));
    } catch (error) {
      log('stance.error', { name: error?.name ?? 'Error', stage: 'speak' }, current.traceId);
    }
  }

  function clearStance(reason, at) {
    if (!stance) return;
    const last = history.at(-1);
    if (last && last.ended === undefined) last.ended = reason;
    log('stance.expired', { name: stance.name, trigger: stance.trigger, reason,
      heldMs: at - stance.setAt }, stance.traceId);
    stance = null;
  }

  function apply(choice, trigger, { via, snap, at }) {
    const params = { ...(STANCE_DEFAULTS[choice.name] ?? {}), ...(choice.params ?? {}) };
    params.ttlSec ??= choice.name === 'guard_night' ? 1_800 : 300;
    const expiresAt = Math.min(at + params.ttlSec * 1_000, dawnAt(at, snap));
    if (stance && stance.name === choice.name && stance.trigger === trigger.kind) {
      // Same stance re-chosen for a continuing conflict: refresh, don't re-say.
      stance.expiresAt = expiresAt;
      stance.via = via;
      log('stance.set', { name: stance.name, trigger: trigger.kind, params: stance.params,
        ttlSec: params.ttlSec, via, refreshed: true }, stance.traceId);
      return;
    }
    if (stance) clearStance('replaced', at);
    const traceId = createTraceId();
    stance = {
      name: choice.name, params, trigger: trigger.kind, via,
      line: choice.line ?? null, traceId,
      setAt: at, expiresAt,
      nightOnly: ['guard_night', 'clear_then_sleep'].includes(choice.name),
      asked: choice.name === 'ask_owner',
      answered: false,
      waitUntil: choice.name === 'ask_owner' ? at + params.waitSec * 1_000 : null,
      giveUpAt: choice.name === 'clear_then_sleep' ? at + params.giveUpSec * 1_000 : null,
    };
    history.push({ name: stance.name, trigger: trigger.kind, at, via });
    while (history.length > 3) history.shift();
    log('stance.set', { name: stance.name, trigger: trigger.kind, params, ttlSec: params.ttlSec, via }, traceId);
    say(stance);
    if (stance.name === 'redo') void runRedo(stance);
  }

  // redo (items_taken): re-run the last owner goal request via goals.obtain —
  // the goal runner re-plans from real stock, so a second take ends honestly.
  async function runRedo(target) {
    const attempts = Math.max(0, Math.floor(target.params.maxRetries ?? 0));
    const request = typeof goals?.lastRequest === 'function' ? goals.lastRequest() : null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (stopped || stance !== target) return;
      if (!request || typeof goals?.obtain !== 'function') {
        log('stance.redo', { attempt, reason: 'no_goal' }, target.traceId);
        return;
      }
      try {
        const submitted = goals.obtain({ item: request.item, count: request.count,
          giveToOwner: request.giveToOwner });
        const result = await submitted?.done;
        log('stance.redo', { item: request.item, attempt, status: result?.status ?? 'unknown' },
          target.traceId);
        if (result?.status === 'succeeded') return;
      } catch (error) {
        log('stance.redo', { item: request.item, attempt, reason: 'error',
          name: error?.name ?? 'Error' }, target.traceId);
        return;
      }
      if (attempt < attempts) await new Promise(resolve => timers.setTimeout(resolve, 2_000));
    }
  }

  // Stance housekeeping each tick: owner replies to ask_owner, give-up timers,
  // ttl/dawn expiry. May replace the stance (ask_owner -> default table).
  function maintain(at, snap) {
    if (!stance) return;
    if (stance.asked && !stance.answered) {
      if (triggers.ownerChatAfter(stance.setAt)) {
        stance.answered = true;
        log('stance.owner_replied', { trigger: stance.trigger, name: stance.name }, stance.traceId);
      } else if (stance.waitUntil !== null && at >= stance.waitUntil) {
        // He did not answer inside waitSec: fall back to the default table.
        const fallback = defaultStance(stance.trigger, defaultCtx(stance.trigger, snap));
        if (fallback.name === stance.name) {
          // The default is also "ask": don't nag twice — stop waiting quietly.
          stance.asked = false;
        } else {
          const kind = stance.trigger;
          clearStance('no_reply', at);
          apply(fallback, { kind }, { via: 'default', snap, at });
          return;
        }
      }
    }
    if (!stance) return;
    if (stance.name === 'clear_then_sleep' && stance.giveUpAt !== null && at >= stance.giveUpAt) {
      const kind = stance.trigger;
      if (snap?.isSleeping) { clearStance('slept', at); return; }
      // giveUpSec passed and she still is not asleep: default table takes over.
      clearStance('give_up', at);
      apply(defaultStance(kind, defaultCtx(kind, snap)), { kind }, { via: 'default', snap, at });
      return;
    }
    if (at >= stance.expiresAt) return clearStance('ttl', at);
    if (stance.nightOnly && snap && snap.isNight === false) clearStance('dawn', at);
  }

  function buildSituation(trigger, snap) {
    const hostile = e => ({ name: e.name, distance: Math.round(e.distance * 10) / 10,
      ...(e.nearBed === true ? { nearBed: true } : {}) });
    return {
      trigger: { kind: trigger.kind, ...(trigger.detail ?? {}) },
      time: { isNight: snap?.isNight ?? null, timeOfDay: snap?.timeOfDay ?? null,
        thundering: snap?.thundering ?? null },
      self: { health: snap?.health ?? null, food: snap?.food ?? null,
        sleeping: snap?.isSleeping ?? null, position: snap?.position ?? null },
      hostiles: (snap?.hostiles ?? []).slice(0, 8).map(hostile),
      owner: { distance: snap?.ownerDistance ?? null, health: snap?.ownerHealth ?? null,
        position: snap?.ownerPosition ?? null },
      shelter: { bed: snap?.bedPosition ?? null, hut: snap?.hut ?? null },
      task: { busy: snap?.arbiter?.busy ?? arbiter?.isBusy?.() ?? false,
        source: snap?.arbiter?.source ?? arbiter?.current?.()?.source ?? null,
        label: snap?.arbiter?.label ?? arbiter?.current?.()?.label ?? null },
      lastAction: snap?.lastAction ?? null,
      recentStances: history.map(h => ({ name: h.name, trigger: h.trigger, via: h.via, ended: h.ended ?? null })),
      priorities: BEHAVIOUR_PRIORITIES,
    };
  }

  async function decide(trigger, snap, at) {
    deciding = true;
    firedAt[trigger.kind] = at;
    triggers.consumed(trigger);
    fires[trigger.kind] = (fires[trigger.kind] ?? 0) + 1;
    inflight = new AbortController();
    const traceId = createTraceId();
    try {
      let raw = null;
      if (brain?.enabled === true && typeof brain.stance === 'function') {
        try {
          raw = await brain.stance({
            situation: buildSituation(trigger, snap),
            allowed: allowedSpec(trigger.kind),
            priorities: BEHAVIOUR_PRIORITIES,
            signal: inflight.signal,
          });
        } catch { raw = null; }
      }
      if (stopped) return;
      const checked = raw ? validateStance(raw, trigger.kind) : null;
      let choice;
      let via;
      if (checked?.ok) {
        choice = checked;
        via = 'brain';
      } else {
        if (raw != null) log('stance.invalid', { trigger: trigger.kind, reason: checked?.reason ?? 'unparsed' }, traceId);
        choice = defaultStance(trigger.kind, defaultCtx(trigger.kind, snap));
        via = 'default';
      }
      if (via === 'brain' && DEVIATING[trigger.kind]?.has(choice.name)) {
        log('stance.deviation', { trigger: trigger.kind, name: choice.name,
          priorities: [...BEHAVIOUR_PRIORITIES.order] }, traceId);
      }
      apply(choice, trigger, { via, snap, at: now() });
    } catch (error) {
      log('stance.error', { name: error?.name ?? 'Error', stage: 'decide' }, traceId);
    } finally {
      deciding = false;
      inflight = null;
    }
  }

  function tick() {
    if (stopped) return;
    try {
      const at = now();
      const snap = snapshot();
      maintain(at, snap);
      if (deciding) return;
      const fired = (triggers.poll(at, snap) ?? []).find(trigger =>
        at - (firedAt[trigger.kind] ?? -Infinity) >= cooldownMs
        && (trigger.continuous === true || trigger.at > (firedAt[trigger.kind] ?? -Infinity)));
      if (!fired) return;
      void decide(fired, snap, at);
    } catch (error) {
      log('stance.error', { name: error?.name ?? 'Error', stage: 'tick' });
    }
  }

  const timer = timers.setInterval(tick, tickMs);
  return Object.freeze({
    tick,
    // Read by survival/proactive each of their own ticks; expires lazily.
    current() {
      const at = now();
      if (stance && at >= stance.expiresAt) clearStance('ttl', at);
      return stance && {
        name: stance.name, params: { ...stance.params }, trigger: stance.trigger,
        setAt: stance.setAt, expiresAt: stance.expiresAt,
      };
    },
    history: () => history.map(entry => ({ ...entry })),
    stop() {
      if (stopped) return;
      stopped = true;
      timers.clearInterval(timer);
      inflight?.abort();
      inflight = null;
    },
  });
}
