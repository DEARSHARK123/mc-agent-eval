import { createTraceId } from '../trace.js';
import { resolveClock } from '../clock.js';
import { errorPayload } from '../outcome.js';
import { createRequire } from 'node:module';
import { step, codedError } from './helpers.js';
import { ensureReach } from '../skills/approach.js';
import * as goTo from './goTo.js';
import * as goToEntity from './goToEntity.js';
import * as lookAt from './lookAt.js';
import * as say from './say.js';
import * as findBlock from './findBlock.js';
import * as dig from './dig.js';
import * as collectDrops from './collectDrops.js';
import * as countItem from './countItem.js';
import * as craft from './craft.js';
import * as place from './place.js';
import * as follow from './follow.js';
import * as equip from './equip.js';
import * as eat from './eat.js';
import * as attack from './attack.js';
import * as give from './give.js';
import * as sleep from './sleep.js';
import * as deposit from './deposit.js';
import * as withdraw from './withdraw.js';
import * as smelt from './smelt.js';
import * as command from './command.js';
import { queryPrimitives } from './queries.js';

// P1 §3: a world-mutating primitive's resolved target must stay within 32
// blocks of her. Existing tighter checks still bind; this is the uniform
// backstop, not a relaxation.
export const AMB_RADIUS = 32;

// countItem and findBlock are also free queries (P1 §1); marking them at
// registration keeps their modules untouched.
const asFree = primitive => Object.freeze({ ...primitive, free: true });
const primitives = new Map(
  [goTo, goToEntity, lookAt, say, asFree(findBlock), dig, collectDrops, asFree(countItem), craft, place, follow, equip, eat, attack, give, sleep, deposit, withdraw, smelt, ...queryPrimitives]
    .map(primitive => [primitive.name, primitive])
);
const require = createRequire(import.meta.url);

export class UnknownPrimitiveError extends Error {
  constructor(name) {
    super(`Unknown primitive: ${String(name)}`);
    this.name = 'UnknownPrimitiveError';
    this.primitiveName = name;
  }
}

export class InvalidParamsError extends Error {
  constructor(field, reason) {
    super(`Invalid parameter ${field}: ${reason}`);
    this.name = 'InvalidParamsError';
    this.field = field;
  }
}

function validate(schema, input, mcData) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new InvalidParamsError('params', 'expected an object');
  }
  // P2 round-3: models write `item`/`block`/`entity` where schemas declare the
  // `*Name` form. A bare key matching no field but whose `<key>Name` variant
  // exists aliases to it — unless the canonical field is also present, in
  // which case the bare key stays unknown and fails as before.
  for (const field of Object.keys(input)) {
    if (!Object.hasOwn(schema, field) && Object.hasOwn(schema, `${field}Name`)
        && !Object.hasOwn(input, `${field}Name`)) {
      input = { ...input, [`${field}Name`]: input[field] };
      delete input[field];
    }
  }
  for (const field of Object.keys(input)) {
    if (!Object.hasOwn(schema, field)) throw new InvalidParamsError(field, 'unknown field');
  }
  const output = {};
  for (const [field, rule] of Object.entries(schema)) {
    const value = Object.hasOwn(input, field) ? input[field] : rule.default;
    const fail = reason => { throw new InvalidParamsError(field, reason); };
    if (value === undefined) {
      if (rule.required) fail('required');
      continue;
    }
    if (typeof value !== rule.type) fail(`expected ${rule.type}`);
    if (rule.type === 'number') {
      if (!Number.isFinite(value)) fail('must be finite');
      if (rule.integer && !Number.isSafeInteger(value)) fail('must be a safe integer');
      if (rule.min !== undefined && value < rule.min) fail(`must be >= ${rule.min}`);
      if (rule.max !== undefined && value > rule.max) fail(`must be <= ${rule.max}`);
      if (rule.exclusiveMin !== undefined && value <= rule.exclusiveMin) fail(`must be > ${rule.exclusiveMin}`);
    }
    if (rule.type === 'string') {
      const length = Array.from(value).length;
      if (rule.minLength !== undefined && length < rule.minLength) fail(`length must be >= ${rule.minLength}`);
      if (rule.maxLength !== undefined && length > rule.maxLength) fail(`length must be <= ${rule.maxLength}`);
      if (rule.pattern && !new RegExp(rule.pattern).test(value)) fail('invalid format');
      if (rule.enum && !rule.enum.includes(value)) fail('not in enum');
      if (rule.catalog && !Object.hasOwn(mcData[rule.catalog] ?? {}, value)) fail('unknown Minecraft name');
    }
    output[field] = value;
  }
  return output;
}

export function createPrimitiveRegistry({ bot, eventlog, mcData, clock = {}, ownerUuid, commands = false, protection = null, body = null } = {}) {
  mcData ??= require('minecraft-data')('1.20.4');
  const timers = resolveClock(clock);
  const now = timers.now;
  const schedule = timers.setTimeout;
  const unschedule = timers.clearTimeout;
  // `command` only exists in the registry when explicitly enabled; without it
  // has()/run()/validate() treat the name like any other unknown primitive.
  const active = commands ? new Map([...primitives, [command.name, command]]) : primitives;
  const commandLimiter = commands ? command.createLimiter({ now }) : null;
  const ctx = { bot, eventlog, mcData, clock, ownerUuid, commandLimiter, protection, body };
  // list() is the model-facing catalog: the free query primitives are listed
  // too (describe() marks them free: true) so model-written skills can use them.
  const listedNames = [...active.keys()].filter(name =>
    (ownerUuid ?? bot?.ownerUuid) || !['follow', 'give', 'withdraw'].includes(name));
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  // The give target is always the owner; resolve her/him the way follow does.
  const ownerEntity = () => {
    const wanted = String(ownerUuid ?? bot?.ownerUuid ?? '').toLowerCase();
    if (!wanted) return null;
    const entity = Object.values(bot?.entities ?? {}).find(value =>
      value?.uuid?.toLowerCase() === wanted && value.isValid !== false && value.position);
    if (entity) return entity;
    const player = Object.values(bot?.players ?? {}).find(value =>
      value?.uuid?.toLowerCase() === wanted && value.entity?.isValid !== false && value.entity?.position);
    return player?.entity ?? null;
  };
  // §3 ambit target resolution, best effort and bot-call-free (a submission-time
  // check must not touch the bot beyond what the primitives already did):
  // coordinates from the params, the attack target entity, the give owner
  // entity, or a find* query's explicit search center (P2 B3 — a query is
  // perception, not teleport). deposit/withdraw take only items and find their
  // container inside a 16-block search, so nothing resolvable ever exceeds the
  // ambit; command already enforces its own 32-block per-axis bound inside
  // check(). Anything unresolvable returns [] and the primitive's own checks
  // decide.
  const ambitTargets = (primitive, value, origin) => {
    switch (primitive.name) {
      case 'dig':
      case 'place':
        return [{ x: value.x, y: value.y, z: value.z }];
      case 'craft':
      case 'smelt':
        // An `at`-bound station (table/furnace) is the mutating target; without
        // coordinates the runtime search-center stays hers — always in ambit.
        return ['x', 'y', 'z'].every(key => Number.isFinite(value[key]))
          ? [{ x: value.x, y: value.y, z: value.z }]
          : [];
      case 'attack': {
        const owner = String(ownerUuid ?? bot?.ownerUuid ?? '').toLowerCase();
        const target = Object.values(bot?.entities ?? {})
          .filter(entity => entity?.name === value.entityName && entity.type !== 'player'
            && entity.isValid !== false && entity.position
            && (!owner || entity.uuid?.toLowerCase() !== owner))
          .sort((a, b) => distance(origin, a.position) - distance(origin, b.position))[0];
        return target ? [target.position] : [];
      }
      case 'give': {
        const owner = ownerEntity();
        return owner ? [owner.position] : [];
      }
      case 'findBlock':
      case 'findEntity':
        // P2 B3: an explicit x/y/z search center is the query's "target" —
        // it obeys the same 32-block perception ambit as mutating targets.
        // All-or-none was already enforced above, so this sees either a full
        // triple or nothing (no override = her position = always in ambit).
        return ['x', 'y', 'z'].every(key => Object.hasOwn(value, key))
          ? [{ x: value.x, y: value.y, z: value.z }]
          : [];
      default:
        return [];
    }
  };
  const checked = (primitive, input, { deferAmbit = false } = {}) => {
    const value = validate(primitive.params, input, mcData);
    // P2 B1: primitives may declare an optional x/y/z target override
    // (`at` merges bound coordinates into these) — findBlock/findEntity as a
    // search center, craft/smelt as the bound station. The three are
    // all-or-none — a partial override is always a mistake, not a default to
    // guess. Schemas declaring required coordinates (dig/place/goTo/lookAt)
    // already fail partials on the required check.
    if (['x', 'y', 'z'].every(key => primitive.params[key]?.type === 'number' && !primitive.params[key].required)) {
      const given = ['x', 'y', 'z'].filter(key => Object.hasOwn(value, key));
      if (given.length > 0 && given.length < 3) {
        throw new InvalidParamsError('params', 'x, y and z must be given together');
      }
    }
    if (primitive === attack && !attack.allowed(value.entityName, mcData)) {
      throw new InvalidParamsError('entityName', 'target is not allowed');
    }
    // Smelt inputs must actually smelt and fuels must burn; like attack.allowed this fails in
    // the validate phase so a bad request never reaches the bot.
    if (primitive === smelt) {
      if (!smelt.smeltable(value.itemName)) throw new InvalidParamsError('itemName', 'item cannot be smelted');
      if (!smelt.usableFuel(value.fuel)) throw new InvalidParamsError('fuel', 'item cannot be used as fuel');
    }
    // Protected zones reject the dig at submission time: bot.dig is never called.
    if (primitive === dig && protection?.contains({ x: value.x, y: value.y, z: value.z })) {
      throw new InvalidParamsError('position', 'protected');
    }
    // T29 §C.2: placing a block on a protected claim is rejected the same way,
    // except zones her own finished builds registered — a bed placed inside her
    // own_build hut is a normal survival action (T26). A point-sized box
    // reuses intersects' reason allow-list; dig keeps no exemption because
    // breaking blocks stays protected even inside her own zone.
    if (primitive === place && protection?.intersects?.(
        { from: { x: value.x, y: value.y, z: value.z }, to: { x: value.x, y: value.y, z: value.z } },
        { allow: ['own_build'] })) {
      throw new InvalidParamsError('position', 'protected');
    }
    // Body-safe digging: below her feet, above her head under gravity blocks,
    // or next to lava/flowing water — all rejected before bot.dig is reached.
    if (primitive === dig) {
      const reason = dig.unsafeReason(bot, value);
      if (reason) throw new InvalidParamsError('position', reason);
    }
    // Never deliberately stare down an enderman: a look within 10 degrees of
    // the line to an enderman's head provokes it.
    if (primitive === lookAt && bot?.entity?.position) {
      const eye = bot.entity.position.offset(0, 1.62, 0);
      const aim = { x: value.x - eye.x, y: value.y - eye.y, z: value.z - eye.z };
      const aimLen = Math.hypot(aim.x, aim.y, aim.z);
      if (aimLen > 0) {
        for (const entity of Object.values(bot.entities ?? {})) {
          if (entity?.name !== 'enderman' || !entity.position || entity.isValid === false) continue;
          const head = { x: entity.position.x - eye.x, y: entity.position.y + 2.55 - eye.y, z: entity.position.z - eye.z };
          const dist = Math.hypot(head.x, head.y, head.z);
          if (dist <= 0 || dist > 64) continue;
          const cos = (aim.x * head.x + aim.y * head.y + aim.z * head.z) / (aimLen * dist);
          if (cos > Math.cos(Math.PI / 18)) throw new InvalidParamsError('position', 'gaze_enderman');
        }
      }
    }
    // Stateless whitelist/range/volume/protection checks run at submission
    // time; the sliding-window rate limit stays inside run so it is counted once.
    if (primitive === command) command.check(value, { bot, protection });
    // P1 §3 uniform ambit: every resolved target of a world-mutating primitive
    // — and a find* query's explicit search center (P2 B3) — stays within
    // AMB_RADIUS of her. Runs last so the tighter, more specific rejections
    // above (protected, out_of_range, unsafe_*) win when both apply.
    // P3: draft-time probes carry placeholder coordinates (an `at` binding's
    // {0,0,0} sentinel or a `$id.x` field example) — their true target is
    // unknowable statically and run()/query() re-check ambit on the resolved
    // numbers anyway, so format.js asks for deferAmbit instead of letting a
    // placeholder's distance from origin reject a legal draft (the latent
    // ">32 blocks from spawn kills every at-bound skill" bug P0r2 exposed).
    const origin = bot?.entity?.position;
    if (origin && !deferAmbit) {
      for (const target of ambitTargets(primitive, value, origin)) {
        if (distance(origin, target) > AMB_RADIUS) {
          throw codedError('out_of_ambit',
            `${primitive.name} target is beyond the ${AMB_RADIUS}-block ambit`);
        }
      }
    }
    return value;
  };

  async function execute(primitive, params, { signal, traceId, timeoutMs }) {
    const started = now();
    const controller = new AbortController();
    let timer;
    let outcome;
    let interrupt;
    const interrupted = new Promise(resolve => { interrupt = resolve; });
    const stop = timedOut => {
      if (controller.signal.aborted) return;
      const error = new Error(timedOut ? 'Primitive timed out' : 'Primitive cancelled');
      error.name = timedOut ? 'TimeoutError' : 'AbortError';
      controller.abort(error);
      interrupt({ ok: false, error: errorPayload(error), cancelled: !timedOut, timed_out: timedOut });
    };
    const abort = () => stop(false);
    try {
      eventlog.append('primitive.start', { name: primitive.name, params }, traceId);
      if (signal?.aborted) {
        stop(false);
        outcome = await interrupted;
      } else {
        signal?.addEventListener('abort', abort, { once: true });
        timer = schedule(() => stop(true), timeoutMs);
        const operation = Promise.resolve().then(async () => {
          controller.signal.throwIfAborted();
          if (primitive.name !== 'sleep' && bot.isSleeping) {
            try { await stepWake(); } catch (error) {
              if (controller.signal.aborted) throw error;
              try { eventlog.append('primitive.wake_failed', errorPayload(error), traceId); } catch {}
            }
          }
          controller.signal.throwIfAborted();
          return primitive.run(ctx, params, controller.signal);
        }).then(
          result => ({ ok: true, result, cancelled: false, timed_out: false }),
          error => ({ ok: false, error: errorPayload(error), cancelled: false, timed_out: false })
        );
        // bot.wake() resolves a moment before the client flips isSleeping; wait for it so the next move is not swallowed.
        function stepWake() {
          return step(controller.signal, async () => {
            await bot.wake();
            const deadline = now() + 2_000;
            while (bot.isSleeping && now() < deadline) await new Promise(resolve => schedule(resolve, 50));
          });
        }
        outcome = await Promise.race([interrupted, operation]);
      }
    } catch (error) {
      outcome = { ok: false, error: errorPayload(error), cancelled: false, timed_out: false };
    } finally {
      if (timer !== undefined) unschedule(timer);
      signal?.removeEventListener('abort', abort);
    }
    // A failure right after a shove/nudge/fall is probably the bump, not the
    // plan; goals retry the same step once on this flag.
    if (!outcome.ok && body?.state?.disturbed?.()
        && ['goTo', 'dig', 'place', 'attack'].includes(primitive.name) && outcome.error) {
      outcome.error = { ...outcome.error, disturbed: true };
    }
    try {
      eventlog.append('primitive.end', {
        name: primitive.name, ...outcome, duration_ms: Math.max(0, now() - started),
      }, traceId);
    } catch (error) {
      outcome = { ...outcome, ok: false, error: errorPayload(error) };
      delete outcome.result;
    }
    return outcome;
  }

  function run(name, input = {}, options = {}) {
    const primitive = active.get(name);
    if (!primitive) throw new UnknownPrimitiveError(name);
    const params = checked(primitive, input);
    const timeoutMs = options.timeoutMs ?? primitive.defaultTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw new InvalidParamsError('timeoutMs', 'must be a positive timer duration <= 2147483647');
    }
    const traceId = options.traceId ?? createTraceId();
    if (typeof traceId !== 'string' || !traceId) throw new InvalidParamsError('traceId', 'must be a nonempty string');
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
      throw new InvalidParamsError('signal', 'must be an AbortSignal');
    }
    return execute(primitive, params, { signal: options.signal, traceId, timeoutMs });
  }

  return {
    protection,
    list: () => [...listedNames],
    has: name => active.has(name),
    validate(name, input, options = {}) {
      const primitive = active.get(name);
      if (!primitive) throw new UnknownPrimitiveError(name);
      return checked(primitive, input, options);
    },
    describe(name) {
      const primitive = active.get(name);
      if (!primitive) throw new UnknownPrimitiveError(name);
      return structuredClone({
        name: primitive.name, description: primitive.description,
        params: primitive.params, defaultTimeoutMs: primitive.defaultTimeoutMs,
        ...(primitive.free === true ? { free: true } : {}),
        ...(primitive.reach !== undefined ? { reach: primitive.reach } : {}),
      });
    },
    // Auto-approach: a resolved step whose primitive declares `reach` and whose
    // params carry a target beyond it walks in via an implicit goTo first —
    // through this same checked+execute path, so the walk is logged like any
    // primitive run. Returns the goTo outcome ({ok:false} means the step must
    // not run — the approach itself failed) or null when no walk was needed.
    approach(resolved, options = {}) {
      return ensureReach({
        primitive: resolved?.primitive,
        params: resolved?.params,
        origin: bot?.entity?.position,
        run: (name, params) => run(name, params, options),
      });
    },
    // P1 §1 free queries: validate through the same checked() path, then run
    // the primitive directly — no arbiter task, no primitive.start/end rows,
    // no cost. Always async: primitives may return a bare value (countItem) or
    // a promise, and callers uniformly await; only `free` primitives may be
    // queried.
    async query(name, input = {}) {
      const primitive = active.get(name);
      if (!primitive) throw new UnknownPrimitiveError(name);
      if (primitive.free !== true) {
        const error = new InvalidParamsError('name', `primitive '${name}' is not queryable`);
        error.code = 'not_queryable';
        throw error;
      }
      const params = checked(primitive, input);
      return primitive.run(ctx, params, new AbortController().signal);
    },
    run,
  };
}
