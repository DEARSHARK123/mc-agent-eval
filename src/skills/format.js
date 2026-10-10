import { createRequire } from 'node:module';
import { stepIdPattern, specialTargets, offsetAtPattern, stepRefPattern, dollarAtPattern,
  textRefPattern, resultFields, bareName } from './bindings.js';

const mcData = createRequire(import.meta.url)('minecraft-data')('1.20.4');
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const namePattern = /^[a-z][a-zA-Z0-9_]{1,40}$/;
const types = new Set(['block', 'item', 'count', 'number', 'quantity']);
// P1 §2b: field refs resolve at runtime, but draft-time schema checks still
// need a placeholder value of the right shape for each whitelisted field. P2
// A2 adds x/y/z — number-typed, usable wherever a count/number ref fits.
const fieldExamples = { uuid: '00000000-0000-0000-0000-000000000000', entityName: 'zombie',
  blockName: 'stone', name: 'stone', count: 1, x: 1, y: 1, z: 1 };
// P1 §2c: hasEffect takes a snake_case effect name; mcData keys are PascalCase.
const effectNames = new Set(Object.keys(mcData.effectsByName ?? {})
  .map(name => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()));
const ownFields = (value, fields) => Object.keys(value).every(key => fields.includes(key));

export function validValue(type, value) {
  // P2 A3: `minecraft:` is a legal namespace alias for catalog names.
  if (type === 'block' || type === 'item') return typeof value === 'string'
    && Object.hasOwn(mcData[type === 'block' ? 'blocksByName' : 'itemsByName'], bareName(value));
  if (type === 'count') return Number.isInteger(value) && value >= 1 && value <= 16;
  if (type === 'quantity') return Number.isInteger(value) && value >= 1 && value <= 64;
  return type === 'number' && Number.isFinite(value) && value >= -64 && value <= 320;
}

export function validateArgs(params = {}, args = {}, { partial = false } = {}) {
  if (!isObject(params) || !isObject(args)) return { ok: false, args: {} };
  const output = {};
  let ok = true;
  // P2 A3: catalog-typed values canonicalize to bare names on the way out.
  const canonical = (type, value) => ['block', 'item'].includes(type) ? bareName(value) : value;
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(params, key) || !validValue(params[key].type, value)) ok = false;
    else output[key] = canonical(params[key].type, value);
  }
  if (!partial) for (const [key, rule] of Object.entries(params)) {
    if (!Object.hasOwn(args, key)) {
      if (rule.required) ok = false;
      else if (Object.hasOwn(rule, 'default')) output[key] = canonical(rule.type, rule.default);
    }
  }
  return { ok, args: output };
}

// T13 permits quantities but does not grant a skill for a new object.
export function allowsArgOverride(skill, args = {}) {
  return isObject(args) && Object.entries(args).every(([key, value]) =>
    key === 'count' || (Object.hasOwn(skill.params ?? {}, key)
      && Object.hasOwn(skill.params[key], 'default')
      && bareName(value) === bareName(skill.params[key].default)));
}

export function substitute(values = {}, args = {}) {
  // `$id.field` step references are not declared params; they survive
  // substitution and the interpreter resolves them from bindings (P1 §2b).
  // P2 A4: an embedded `$param` inside a longer string inlines the declared
  // argument (say text interpolation), while an unknown `$name` stays put for
  // the bindings pass to judge — including bare `$id` step references, which
  // are not declared params either.
  const whole = /^\$([a-z][a-zA-Z0-9_]{0,15})$/;
  const embedded = /\$([a-z][a-zA-Z0-9_]{0,15})(?!\.)/g;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => {
    if (typeof value !== 'string' || !value.includes('$') || stepRefPattern.test(value)) return [key, value];
    const single = whole.exec(value);
    if (single) return [key, Object.hasOwn(args, single[1]) ? args[single[1]] : value];
    return [key, value.replace(embedded,
      (token, name) => (Object.hasOwn(args, name) ? String(args[name]) : token))];
  }));
}

export function validateDraft(draft, { taught = false, registry, skills = [] } = {}) {
  const errors = [];
  const reject = message => errors.push(message);
  if (!isObject(draft)) return { ok: false, errors: ['draft must be an object'] };
  if (!ownFields(draft, ['name', 'description', 'params', 'body'])) reject('draft has unknown fields');
  if (typeof draft.name !== 'string' || !namePattern.test(draft.name)) reject('invalid skill name');
  if (draft.description !== undefined && typeof draft.description !== 'string') reject('description must be a string');
  const params = draft.params ?? {};
  if (!isObject(params) || Object.keys(params).length > 4) reject('params must contain at most 4 declarations');
  else for (const [key, rule] of Object.entries(params)) {
    if (!stepIdPattern.test(key) || !isObject(rule) || !ownFields(rule, ['type', 'required', 'default'])
      || !types.has(rule.type) || (rule.required !== undefined && typeof rule.required !== 'boolean')
      || (Object.hasOwn(rule, 'default') && !validValue(rule.type, rule.default))) reject(`invalid parameter ${key}`);
  }
  if (errors.length) return { ok: false, errors };
  const graph = new Map(skills.map(skill => [skill.name, skill]));
  graph.set(draft.name, draft);
  const examples = { block: 'stone', item: 'stone', count: 1, number: 1, quantity: 1 };
  function reference(value, declarations, expected, ids) {
    if (typeof value !== 'string' || !value.startsWith('$')) return value;
    // A dotted first segment is a step-result reference (`$id.field`, P1 §2b),
    // valid only where `ids` is passed (primitive params); a bare name is a
    // declared-parameter reference as before.
    const stepRef = stepRefPattern.exec(value);
    if (stepRef) {
      if (!resultFields.has(stepRef[2]) || !ids?.has(stepRef[1])) {
        reject(`invalid or invisible step reference ${value}`);
        return undefined;
      }
      return fieldExamples[stepRef[2]];
    }
    const rule = declarations[value.slice(1)];
    if (!Object.hasOwn(declarations, value.slice(1)) || !rule || (expected && !expected.includes(rule.type))) {
      reject(`undeclared or incompatible parameter ${value}`);
      return undefined;
    }
    return examples[rule.type];
  }
  function condition(value, declarations, ids, depth = 0) {
    if (!isObject(value) || depth > 3) { reject('invalid condition or condition depth exceeds 3'); return; }
    if (ownFields(value, ['found']) && typeof value.found === 'string') {
      if (!ids.has(value.found)) reject('found must reference an earlier visible id');
    } else if (ownFields(value, ['hasItem', 'atLeast']) && Object.hasOwn(value, 'hasItem') && Object.hasOwn(value, 'atLeast')) {
      if (!validValue('item', reference(value.hasItem, declarations, ['item', 'block']))) reject('invalid hasItem');
      const n = reference(value.atLeast, declarations, ['count', 'number']);
      if (!Number.isInteger(n) || n < 1 || n > 2304) reject('invalid atLeast');
    } else if (ownFields(value, ['healthBelow']) && Object.hasOwn(value, 'healthBelow')) {
      // P1 §2c body predicates: integer 1..20 thresholds and mcData effect names.
      if (!Number.isInteger(value.healthBelow) || value.healthBelow < 1 || value.healthBelow > 20) reject('invalid healthBelow');
    } else if (ownFields(value, ['foodBelow']) && Object.hasOwn(value, 'foodBelow')) {
      if (!Number.isInteger(value.foodBelow) || value.foodBelow < 1 || value.foodBelow > 20) reject('invalid foodBelow');
    } else if (ownFields(value, ['hasEffect']) && Object.hasOwn(value, 'hasEffect')) {
      if (typeof value.hasEffect !== 'string' || !effectNames.has(bareName(value.hasEffect))) reject('invalid hasEffect');
    } else if (ownFields(value, ['not']) && Object.hasOwn(value, 'not')) condition(value.not, declarations, ids, depth + 1);
    else if ((ownFields(value, ['all']) || ownFields(value, ['any'])) && Array.isArray(value.all ?? value.any)
      && (value.all ?? value.any).length > 0) {
      for (const child of value.all ?? value.any) condition(child, declarations, ids, depth + 1);
    } else reject('invalid condition fields');
  }
  function inspectBody(body, declarations, outer, depth, stack, budget, restrict) {
    if (!Array.isArray(body) || body.length === 0) { reject('body must be nonempty'); return new Set(); }
    const ids = new Set(outer);
    const local = new Set();
    // P2 round-2: ids bound inside if/repeat sub-bodies stay visible to later
    // siblings — a branch that ran really did bind its results, and one that
    // did not fails at runtime with target_not_found like any unbound ref.
    const boundHere = new Set();
    for (const node of body) {
      if (++budget.count > budget.limit) { reject(`node budget exceeds ${budget.limit}`); return boundHere; }
      if (!isObject(node)) { reject('node must be an object'); continue; }
      const forms = ['primitive', 'call', 'repeat', 'if', 'fail', 'obtain'].filter(key => Object.hasOwn(node, key));
      if (forms.length !== 1) { reject('node must have exactly one shape'); continue; }
      const form = forms[0];
      const fields = { primitive: ['primitive', 'params', 'id', 'at', 'timeoutMs'], call: ['call', 'args'],
        repeat: ['repeat', 'body'], if: ['if', 'then', 'else'], fail: ['fail'], obtain: ['obtain'] };
      if (!ownFields(node, fields[form])) reject('node has unknown fields');
      if (form === 'primitive') {
        if (restrict && ['say', 'follow'].includes(node.primitive)) reject(`taught skills cannot use ${node.primitive}`);
        if (node.primitive === 'command') reject('skills cannot use command');
        if (!registry?.has(node.primitive)) reject('unknown primitive');
        if (!isObject(node.params)) reject('primitive params must be an object');
        else {
          const input = {};
          let schema;
          try { schema = registry?.describe?.(node.primitive)?.params; } catch { schema = undefined; }
          for (const [key, value] of Object.entries(node.params)) {
            if (!['string', 'number', 'boolean'].includes(typeof value) && value !== null) reject('primitive params must be JSON scalar values');
            if (node.primitive === 'say' && key === 'text' && typeof value === 'string') {
              // P2 A4: say text interpolates `$owner`, `$id` and `$id.field`
              // tokens at execution. Every token must name the owner, a visible
              // bound id (with a whitelisted field when dotted) or a declared
              // parameter — anything else is a typo caught here, not at chat.
              input[key] = value;
              for (const match of value.matchAll(textRefPattern)) {
                const [, token, field] = match;
                if (token === 'owner' && field === undefined) continue;
                if (field !== undefined) {
                  if (!ids.has(token) || !resultFields.has(field)) {
                    reject(`invalid or invisible step reference ${match[0]}`);
                  }
                } else if (!ids.has(token) && !Object.hasOwn(declarations, token)) {
                  reject(`invalid or invisible step reference ${match[0]}`);
                }
              }
            } else {
              input[key] = reference(value, declarations, undefined, ids);
            }
            // P2 A3: catalog-typed params take `minecraft:` as an alias; the
            // registry's catalog check wants the bare canonical name.
            if (typeof input[key] === 'string' && schema?.[key]?.catalog) input[key] = bareName(input[key]);
          }
          if (node.at !== undefined) {
            // T29 A4: `at` only makes sense for primitives whose schema takes
            // x/y/z; say so instead of surfacing a cryptic "unknown field x".
            if (isObject(schema) && !['x', 'y', 'z'].every(key => Object.hasOwn(schema, key))) {
              reject(`${node.primitive} does not take 'at'`);
            } else {
              const offset = typeof node.at === 'string' ? offsetAtPattern.exec(node.at) : null;
              const dollar = typeof node.at === 'string' ? dollarAtPattern.exec(node.at) : null;
              // P2 A1: `at:"$id"` is equivalent to `at:"<id>"` — a bound id.
              if (!specialTargets.has(node.at) && !ids.has(node.at) && !(offset && ids.has(offset[1]))
                  && !(dollar && ids.has(dollar[1]))) {
                reject('at must reference an earlier visible id');
              }
              if (['x', 'y', 'z'].some(key => Object.hasOwn(node.params, key))) reject('params cannot contain x/y/z with at');
              Object.assign(input, { x: 0, y: 0, z: 0 });
            }
          }
          // P3: coordinates that will only exist at runtime — an `at` binding's
          // {0,0,0} probe or a `$id.x`/declared-param string standing in a
          // coordinate slot — cannot be judged against the ambit statically.
          // Defer to the run()/query() re-check instead of letting the
          // placeholder's distance from the world origin reject the draft.
          const refCoord = ['x', 'y', 'z'].some(key => typeof node.params?.[key] === 'string');
          const deferAmbit = node.at !== undefined || refCoord;
          try { registry?.validate(node.primitive, input, { deferAmbit }); } catch (error) { reject(error.message); }
        }
        if (node.timeoutMs !== undefined && (!Number.isFinite(node.timeoutMs) || node.timeoutMs <= 0 || node.timeoutMs > 2147483647)) reject('invalid timeoutMs');
        if (node.id !== undefined) {
          if (typeof node.id !== 'string' || !stepIdPattern.test(node.id) || local.has(node.id)) reject('id must be valid and unique');
          local.add(node.id); ids.add(node.id); boundHere.add(node.id);
        }
      } else if (form === 'fail') {
        if (!['missing_item', 'target_not_found', 'cannot'].includes(node.fail)) reject('invalid fail code');
      } else if (form === 'obtain') {
        const goal = node.obtain;
        if (!isObject(goal) || !ownFields(goal, ['item', 'count'])) { reject('obtain must be { item, count }'); continue; }
        if (!Object.hasOwn(goal, 'item') || !Object.hasOwn(goal, 'count')) { reject('obtain must be { item, count }'); continue; }
        if (!validValue('item', reference(goal.item, declarations, ['item']))) reject('invalid obtain item');
        const amount = reference(goal.count, declarations, ['quantity', 'count']);
        if (!Number.isInteger(amount) || amount < 1 || amount > 64) reject('invalid obtain count');
      } else {
        if (depth + 1 > 4) { reject('nesting depth exceeds 4'); continue; }
        if (form === 'repeat') {
          if (!validValue('count', reference(node.repeat, declarations, ['count']))) reject('invalid repeat');
          for (const id of inspectBody(node.body, declarations, ids, depth + 1, stack, budget, restrict) ?? []) {
            ids.add(id); boundHere.add(id);
          }
        } else if (form === 'if') {
          condition(node.if, declarations, ids);
          const thenBound = inspectBody(node.then, declarations, ids, depth + 1, stack, budget, restrict);
          const elseBound = node.else !== undefined
            ? inspectBody(node.else, declarations, ids, depth + 1, stack, budget, restrict) : new Set();
          for (const id of [...thenBound ?? [], ...elseBound ?? []]) { ids.add(id); boundHere.add(id); }
        } else {
          const child = graph.get(node.call);
          if (!child) { reject('unknown skill'); continue; }
          // P3: `{"call":"x"}` on a parameterless skill omits args — same
          // convention as a primitive's `params`. Required-param callees still
          // fail validateArgs on the empty object.
          const callArgs = node.args === undefined ? {} : node.args;
          if (!isObject(callArgs)) { reject('call args must be an object'); continue; }
          const args = Object.fromEntries(Object.entries(callArgs).map(([key, value]) => [key, reference(value, declarations)]));
          if (!validateArgs(child.params, args).ok) reject('invalid call args');
          if (stack.includes(node.call)) { reject('skill cycle'); continue; }
          // Callee nodes have their own static budget and their own binding scope.
          inspectBody(child.body, child.params ?? {}, new Set(), depth + 1, [...stack, node.call],
            { count: 0, limit: restrict ? 24 : 64 }, restrict);
        }
      }
    }
    return boundHere;
  }
  inspectBody(draft.body, params, new Set(), 1, [draft.name], { count: 0, limit: taught ? 24 : 64 }, taught);
  // Replacing a child must not invalidate the depth or cycles of an existing parent.
  for (const skill of skills) if (skill.name !== draft.name) {
    inspectBody(skill.body, skill.params ?? {}, new Set(), 1, [skill.name], { count: 0, limit: 64 }, false);
  }
  return { ok: errors.length === 0, errors };
}
