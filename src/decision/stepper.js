import { assertValidIntent, validateIntent } from './intent.js';
import { resolveClock } from '../clock.js';
import { abortStatus } from '../outcome.js';
import { LOG_NAME, naturalLog } from '../primitives/findBlock.js';
import { unsafeReason } from '../primitives/dig.js';

const hostileNames = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'witch', 'enderman', 'pillager', 'phantom', 'drowned', 'husk', 'stray']);
const clone = value => structuredClone(value);
const distance = (a, b) => Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.y ?? 0) - (b?.y ?? 0), (a?.z ?? 0) - (b?.z ?? 0));
const position = value => ({ x: Math.round(value.x), y: Math.round(value.y), z: Math.round(value.z) });

function allowed(intent, primitive) { return intent.allowed.includes(primitive); }

// T29 B2: free (query-type) primitives are read-only, so a successful result
// is safe and useful to surface back into the Jev state via recent_actions —
// the model then sees what the last query observed, not just that it ran.
// Compact shapes only: coordinates and scalar fields, capped small; never
// raw bot objects. `registry.describe` is authoritative where present and
// the small known set covers older doubles without it.
const FREE_PRIMITIVES = new Set(['pos', 'blockAt', 'findEntity', 'inventory', 'heldItem', 'body', 'findBlock', 'countItem']);
const RESULT_SCALAR_FIELDS = ['x', 'y', 'z', 'count', 'blockName', 'entityName', 'name', 'uuid', 'health', 'food', 'oxygen', 'onGround', 'free'];
const isScalar = value => value === null || ['number', 'string', 'boolean'].includes(typeof value);
function compactResult(value) {
  if (value === undefined) return undefined;
  if (isScalar(value)) return value;
  if (typeof value !== 'object') return undefined;
  const compact = {};
  for (const field of RESULT_SCALAR_FIELDS) {
    if (isScalar(value[field])) compact[field] = value[field];
  }
  if (Array.isArray(value.slots)) compact.slots = value.slots.slice(0, 6).map(slot => ({ name: slot?.name ?? null, count: slot?.count ?? null }));
  if (Array.isArray(value.effects)) compact.effects = value.effects.filter(entry => typeof entry === 'string').slice(0, 6);
  return Object.keys(compact).length > 0 ? compact : undefined;
}
function isFreePrimitive(registry, name) {
  if (!name) return false;
  if (typeof registry?.describe === 'function') {
    try { if (registry.describe(name)?.free === true) return true; } catch {}
  }
  return FREE_PRIMITIVES.has(name);
}

function countNearbyTargetDrops(bot, item) {
  const origin = bot?.entity?.position ?? { x: 0, y: 0, z: 0 };
  return Object.values(bot?.entities ?? {}).reduce((count, entity) => {
    if (!entity?.position || distance(origin, entity.position) > 8 || !entity.getDroppedItem) return count;
    try {
      const dropped = entity.getDroppedItem();
      return dropped?.name === item ? count + (dropped.count ?? 1) : count;
    } catch { return count; }
  }, 0);
}

export function generateCandidates({ bot, intent, mcData, searchCount = 0, protection = null,
  nearbyTargetDrops = countNearbyTargetDrops(bot, intent.target.item) }) {
  const origin = bot?.entity?.position ?? { x: 0, y: 0, z: 0 };
  const candidates = [];
  let blocks = [];
  try {
    const names = intent.target.blocks ?? [intent.target.block];
    const ids = names.map(name => (mcData ?? bot?.mcData)?.blocksByName?.[name]?.id).filter(id => id !== undefined);
    if (bot?.findBlocks && ids.length) blocks = bot.findBlocks({ matching: ids, maxDistance: 32, count: 3 }) ?? [];
    else if (bot?.findBlock) {
      const block = bot.findBlock({ matching: ids, maxDistance: 32 });
      if (block?.position) blocks = [block.position];
    }
  } catch {}
  blocks = blocks.filter(Boolean).sort((a, b) => distance(origin, a) - distance(origin, b)).slice(0, 3);
  blocks.forEach((point, index) => {
    const n = index + 1;
    const pos = position(point);
    const observed = bot?.blockAt?.(point)?.name;
    const blockName = observed ?? intent.target.block ?? intent.target.blocks?.[0];
    // Same safety as the findBlock primitive: never offer a protected block or a
    // non-natural log as a collect candidate, so the rule cannot be bypassed.
    if (protection?.contains(pos)) return;
    if (LOG_NAME.test(observed ?? '') && !naturalLog(bot, point)) return;
    const d = Math.max(0, Math.round(distance(origin, point)));
    const direction = `${point.x < origin.x ? 'left' : point.x > origin.x ? 'right' : 'ahead'}${point.z < origin.z ? '-ahead' : point.z > origin.z ? '-behind' : ''}`;
    if (allowed(intent, 'dig') && d <= 4.5 && !unsafeReason(bot, pos)) candidates.push({ key: `dig_block_${n}`, category: 'dig', description: `dig the ${blockName} block ${d} blocks ${direction}`, primitive: 'dig', params: pos });
    else if (allowed(intent, 'goTo')) candidates.push({ key: `goto_block_${n}`, category: 'approach', description: `go to the ${blockName} block ${d} blocks ${direction}`, primitive: 'goTo', params: { ...pos, range: 1 } });
  });
  const entities = Object.values(bot?.entities ?? {});
  if (nearbyTargetDrops > 0 && allowed(intent, 'collectDrops')) candidates.push({ key: 'collect_drops', category: 'collect',
    description: `pick up the ${nearbyTargetDrops} ${intent.target.item} items lying within 8 blocks`, primitive: 'collectDrops', params: { radius: 8 } });
  const hostile = entities.find(entity => {
    if (!entity?.position || distance(origin, entity.position) > 16) return false;
    return entity.hostile === true || entity.type === 'mob' && (entity.mobType === 'hostile' || hostileNames.has(entity.name));
  });
  if (hostile && allowed(intent, 'goTo')) {
    const dx = origin.x - hostile.position.x;
    const dz = origin.z - hostile.position.z;
    const length = Math.hypot(dx, dz) || 1;
    candidates.push({ key: 'flee', category: 'flee', description: 'flee to a reachable point about eight blocks away from the hostile mob', primitive: 'goTo',
      params: { x: Math.round(origin.x + dx / length * 8), y: Math.round(origin.y), z: Math.round(origin.z + dz / length * 8), range: 1 } });
  }
  if (allowed(intent, 'goTo')) {
    const directions = [[10, 0], [0, 10], [-10, 0], [0, -10]];
    const [dx, dz] = directions[searchCount % directions.length];
    candidates.push({ key: 'search', category: 'search', description: 'walk eight to twelve blocks in a new direction and search again', primitive: 'goTo',
      params: { x: Math.round(origin.x + dx), y: Math.round(origin.y), z: Math.round(origin.z + dz), range: 1 } });
  }
  return [...candidates.slice(0, 10), { key: 'escalate', category: 'escalate',
    description: 'give up: the goal cannot be reached from here', primitive: null, params: {} }];
}

function stateFor(intent, candidates, history, { currentCount, nearbyTargetDrops, bot }) {
  const base = intent.baseCount ?? 0;
  return JSON.stringify({ goal: intent.goal, goalText: intent.goalText, success: intent.success,
    progress: { have: currentCount - base, need: intent.requestedCount ?? intent.success.atLeast - base, item: intent.target.item },
    nearby_target_drops: nearbyTargetDrops, inventory_full: bot?.inventory?.emptySlotCount?.() === 0,
    candidates: candidates.map(({ key, description }) => ({ key, description })), recent_actions: history.slice(-3) });
}

function outcome(status, reason, steps, actions) {
  return { status, ...(reason ? { reason } : {}), steps, actions: actions.slice(0, 60) };
}

function ruleCandidate(candidates, { currentCount, successAtLeast, nearbyTargetDrops }) {
  const flee = candidates.find(candidate => candidate.key === 'flee');
  if (flee) return flee;
  const collect = candidates.find(candidate => candidate.key === 'collect_drops');
  const remaining = Math.max(0, successAtLeast - currentCount);
  const hasDig = candidates.some(candidate => candidate.category === 'dig');
  if (collect && (nearbyTargetDrops >= remaining || !hasDig)) return collect;
  const dig = candidates.find(candidate => candidate.category === 'dig');
  if (dig) return dig;
  const approach = candidates.find(candidate => candidate.category === 'approach');
  if (approach) return approach;
  return candidates.find(candidate => candidate.key === 'search');
}

export async function runIntent({ intent, registry, jev, bot, eventlog = { append() {} }, clock = {}, signal,
  confidenceMin = 0.7, traceId, isActive = () => true, mcData, sameStateLimit = 3 }) {
  const valid = validateIntent(intent, { mcData });
  if (!valid.ok) return outcome('failed', 'invalid_intent', 0, []);
  const currentIntent = valid.intent;
  const now = resolveClock(clock).now;
  const started = now();
  const actions = [];
  const history = [];
  let lastFailure = null;
  let consecutiveFailures = 0;
  let currentCount = 0;
  let steps = 0;
  let consecutiveRuleSteps = 0;
  let lastState = null;
  let sameState = 0;
  const emit = (kind, payload) => { try { eventlog.append(kind, payload, traceId); } catch {} };
  const stepPayload = (candidates, payload) => ({
    ...payload,
    candidates: candidates.slice(0, 12).map(({ key, category, description }) => ({ key, category, description })),
  });
  emit('intent.start', { goal: currentIntent.goal, success: currentIntent.success, allowed: currentIntent.allowed });
  const finish = (status, reason) => { const result = outcome(status, reason, steps, actions); emit('intent.end', { status, ...(reason ? { reason } : {}), steps, actions: result.actions }); return result; };
  const countSuccess = async () => {
    if (!isActive() || signal?.aborted) return false;
    try {
      // T29 B3: countItem is a free query primitive — go through
      // registry.query() (no arbiter task, no primitive.start/end rows, no
      // cost). Older test doubles may only expose run(); fall back then.
      const result = typeof registry.query === 'function'
        ? await registry.query('countItem', { itemName: currentIntent.success.hasItem })
        : await registry.run('countItem', { itemName: currentIntent.success.hasItem }, { signal });
      const count = result?.result ?? result ?? 0;
      currentCount = Number.isFinite(count) ? count : 0;
      return currentCount >= currentIntent.success.atLeast;
    } catch { return false; }
  };
  while (steps < currentIntent.maxSteps) {
    if (!isActive() || signal?.aborted) return finish(abortStatus(signal));
    if (now() - started > currentIntent.deadlineMs) return finish('failed', 'deadline');
    if (await countSuccess()) return finish('succeeded');
    if (!isActive() || signal?.aborted) return finish(abortStatus(signal));
    const nearbyTargetDrops = countNearbyTargetDrops(bot, currentIntent.target.item);
    const candidates = generateCandidates({ bot, intent: currentIntent, mcData, nearbyTargetDrops,
      protection: registry?.protection ?? null,
      searchCount: history.filter(entry => entry.chosen === 'search').length });
    const criteria = Object.fromEntries(candidates.map(candidate => [candidate.key, candidate.description]));
    const questions = {
      next_action: { type: 'choice', instructions: 'Choose exactly one candidate action that best advances the goal. Never invent a key.', criteria },
      danger: { type: 'score', instructions: 'Score the immediate danger in the current situation.', criteria: ['no immediate danger', 'some danger or uncertainty', 'immediate danger requiring urgent escape'] },
    };
    // T29 B1 state cache: the serialized state is everything the model can
    // see — candidates, progress, drops, inventory fullness, and the recent
    // action log (params included, so a rotated search leg or a different
    // dig target never counts as "same"). An identical observation means the
    // previous pick ran and changed nothing visible: the same question would
    // buy the same answer, so the ask is skipped — but the turn still takes
    // a step through the deterministic rule decision, or the loop would
    // spin without acting. The rule fallback is also a fresh chance to move
    // the world (a rotated search leg, an approach); if the state still
    // comes back identical, that is the stall. `sameStateLimit` consecutive
    // identical observations end the intent as `no_progress` (Infinity opts
    // out, e.g. tests with a deliberately static world); any real change —
    // a mob leaves, a drop lands, a dig removes its block — resets the
    // counter. (A stalled failure cannot reach this: two identical
    // consecutive failures already finish `repeated_failure`.) Without a
    // Jev there is no model call to suppress, so the cache stays off.
    const state = jev ? stateFor(currentIntent, candidates, history, { currentCount, nearbyTargetDrops, bot }) : null;
    const identical = Boolean(jev) && Number.isFinite(sameStateLimit) && state === lastState;
    if (identical) sameState++;
    else { sameState = 0; lastState = state; }
    if (identical && sameState >= sameStateLimit) {
      emit('intent.step', stepPayload(candidates, { step: steps + 1, chosen: null, candidate_keys: candidates.map(candidate => candidate.key), confidence: null, danger: null, decided_by: 'state_cache', ok: false, error_code: 'no_progress', same_state: sameState }));
      return finish('failed', 'no_progress');
    }
    const askedJev = Boolean(jev) && !identical;
    const response = askedJev ? await jev.ask({ state, questions, signal, traceId }) : { ok: true, answers: {} };
    const answer = response?.ok && response.answers?.next_action;
    const danger = response?.ok ? response.answers?.danger?.score : undefined;
    if (!response?.ok) {
      emit('intent.step', stepPayload(candidates, { step: steps + 1, chosen: null, candidate_keys: candidates.map(candidate => candidate.key), confidence: null, danger: danger ?? null, decided_by: 'jev', ok: false, error_code: response?.error?.code ?? 'jev_failed' }));
      return finish('failed', 'jev_failed');
    }
    const probabilities = answer?.probabilities;
    let chosen = candidates.find(candidate => candidate.key === answer?.choice);
    const confidence = answer?.confidence;
    let category;
    let categoryProb;
    if (probabilities && typeof probabilities === 'object') {
      const grouped = new Map();
      for (const candidate of candidates) {
        const probability = probabilities[candidate.key];
        if (Number.isFinite(probability)) grouped.set(candidate.category, (grouped.get(candidate.category) ?? 0) + probability);
      }
      for (const [name, probability] of grouped) if (categoryProb === undefined || probability > categoryProb) { category = name; categoryProb = probability; }
      if (categoryProb !== undefined && categoryProb >= confidenceMin) {
        const categoryCandidates = candidates.filter(candidate => candidate.category === category);
        chosen = categoryCandidates.sort((a, b) => (probabilities[b.key] ?? -Infinity) - (probabilities[a.key] ?? -Infinity))[0];
      } else {
        chosen = undefined;
      }
    }
    const flee = candidates.find(candidate => candidate.key === 'flee');
    const dangerous = Number.isFinite(danger) && danger >= 1.5 && Boolean(flee);
    if (askedJev && !probabilities && !dangerous && (!Number.isFinite(confidence) || !answer?.choice || (!chosen && confidence >= confidenceMin))) {
      emit('intent.step', stepPayload(candidates, { step: steps + 1, chosen: answer?.choice ?? null, candidate_keys: candidates.map(candidate => candidate.key), confidence: confidence ?? null, danger: danger ?? null, decided_by: 'jev', ok: false, error_code: 'bad_response' }));
      return finish('failed', 'jev_failed');
    }
    const jevConfident = askedJev ? (probabilities ? categoryProb !== undefined && categoryProb >= confidenceMin : Number.isFinite(confidence) && confidence >= confidenceMin) : false;
    let decidedBy = dangerous ? 'safety' : jevConfident ? 'jev' : 'rule';
    if (dangerous) chosen = flee;
    else if (!jevConfident) chosen = ruleCandidate(candidates, { currentCount, successAtLeast: currentIntent.success.atLeast, nearbyTargetDrops });
    if (!chosen) {
      emit('intent.step', stepPayload(candidates, { step: steps + 1, chosen: null, candidate_keys: candidates.map(candidate => candidate.key), confidence: confidence ?? null, category: category ?? null, category_prob: categoryProb ?? null, danger: danger ?? null, decided_by: 'rule', ok: false, error_code: 'no_candidate' }));
      return finish('failed', 'no_candidate');
    }
    if (decidedBy === 'rule') consecutiveRuleSteps++;
    else consecutiveRuleSteps = 0;
    if (chosen.key === 'escalate' && decidedBy === 'jev') {
      emit('intent.step', stepPayload(candidates, { step: steps + 1, chosen: chosen.key, candidate_keys: candidates.map(candidate => candidate.key), confidence, category: chosen.category, category_prob: categoryProb ?? null, danger: danger ?? null, decided_by: decidedBy, ok: false, error_code: 'escalated' }));
      return finish('failed', 'escalated');
    }
    steps++;
    if (!isActive() || signal?.aborted) return finish(abortStatus(signal));
    let result;
    try { result = await registry.run(chosen.primitive, clone(chosen.params), { signal, traceId }); }
    catch (error) { result = { ok: false, error: { message: error?.message ?? String(error) } }; }
    const ok = result?.ok !== false;
    if (!isActive() || signal?.aborted) return finish(abortStatus(signal));
    // T29 B2: history entries carry the executed params plus — for a free
    // query primitive that ran ok — its compact result, and through
    // recent_actions they reach the next Jev state: a pick leaves a visible
    // observation, not just ok:true, and two different picks never collapse
    // into one stale entry. Failure entries keep the error message as before.
    const compact = ok && isFreePrimitive(registry, chosen.primitive) ? compactResult(result?.result ?? result) : undefined;
    actions.push({ primitive: chosen.primitive, params: clone(chosen.params), ok, ...(compact !== undefined ? { result: compact } : {}) });
    history.push({ chosen: chosen.key, primitive: chosen.primitive, params: clone(chosen.params), ok, result: ok ? compact : result?.error?.message });
    emit('intent.step', stepPayload(candidates, { step: steps, chosen: chosen.key, candidate_keys: candidates.map(candidate => candidate.key), confidence: confidence ?? null, category: chosen.category, category_prob: categoryProb ?? null, danger: danger ?? null, decided_by: decidedBy, ok, ...(identical ? { same_state: sameState } : {}), ...(ok ? {} : { error_code: result?.error?.code ?? 'action_failed' }) }));
    if (jev && decidedBy === 'rule' && consecutiveRuleSteps >= 6) return finish('failed', 'low_confidence');
    if (!ok) {
      const failureKey = `${chosen.primitive}:${JSON.stringify(chosen.params)}`;
      consecutiveFailures = failureKey === lastFailure ? consecutiveFailures + 1 : 1;
      lastFailure = failureKey;
      if (consecutiveFailures >= 2) return finish('failed', 'repeated_failure');
    } else {
      lastFailure = null;
      consecutiveFailures = 0;
      if (await countSuccess()) return finish('succeeded');
    }
  }
  return finish('failed', 'step_budget');
}

export function createIntentStepper(options) {
  assertValidIntent(options.intent);
  return { run: extra => runIntent({ ...options, ...extra }), submit: () => submitIntent(options) };
}

export function submitIntent({ arbiter, intent, ...options }) {
  assertValidIntent(intent);
  return arbiter.submit({ source: options.source ?? 'owner', label: options.label ?? intent.goalText,
    traceId: options.traceId, dynamic: context => runIntent({ ...options, ...context, intent }) });
}
