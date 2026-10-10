import { substitute, validateArgs, validValue } from './format.js';
import { stepRefPattern, bareName, renderBound } from './bindings.js';

const coordinates = value => value && ['x', 'y', 'z'].every(key => Number.isFinite(value[key]));
const failure = code => Object.assign(new Error(code), { code });

function scope(parent) {
  const result = new Map(parent);
  result.blockNames = new Map(parent?.blockNames);
  return result;
}

export async function interpret({ program, library, runPrimitive, isActive, trace, obtain }) {
  const validated = validateArgs(program.params, program.args);
  if (!validated.ok) throw failure('invalid_args');
  const value = (input, args) => typeof input === 'string' && input.startsWith('$') ? args[input.slice(1)] : input;
  const remember = entry => {
    if (trace.length < 64) { trace.push(entry); return entry; }
    return entry;
  };
  let executed = 0;
  // `$id.field` params values survive substitute untouched (they are not
  // declared args) and resolve here against the step's bound result (P1 §2b).
  function resolveResultRefs(params, bindings) {
    return Object.fromEntries(Object.entries(params ?? {}).map(([key, value]) => {
      const stepRef = typeof value === 'string' ? stepRefPattern.exec(value) : null;
      if (!stepRef) return [key, value];
      const bound = bindings?.get?.(stepRef[1]);
      // T29 §C.3: countItem binds a bare count, not an object — `$id.count`
      // resolves to the number itself. Every other field on a scalar still
      // fails target_not_found.
      const resolved = typeof bound === 'number' && stepRef[2] === 'count' ? bound : bound?.[stepRef[2]];
      if (resolved === undefined || resolved === null) throw failure('target_not_found');
      return [key, resolved];
    }));
  }
  async function primitive(node, bindings) {
    if (!isActive()) return null;
    if (executed >= 256) throw failure('budget_exceeded');
    executed++;
    const resolved = resolveResultRefs(node.params, bindings);
    // P2 A4: a whole-string `$id.field` in say.text resolves to its raw value
    // here; text is string-typed, so it renders the way interpolation does —
    // scalars stringify, richer results speak a readable name — and the
    // resolver still never sees a raw `$...` token left to chat.
    if (node.primitive === 'say' && resolved.text !== undefined && resolved.text !== null
        && typeof resolved.text !== 'string') {
      const match = typeof node.params?.text === 'string' ? stepRefPattern.exec(node.params.text) : null;
      resolved.text = renderBound(resolved.text, match?.[1], bindings);
    }
    return runPrimitive({ ...node, params: resolved }, bindings);
  }
  async function condition(test, args, bindings, depth = 0) {
    if (!isActive()) return false;
    if (depth > 3) throw failure('invalid_condition');
    if (test.found !== undefined) return Boolean(coordinates(bindings.get(test.found)));
    if (test.hasItem !== undefined) {
      const itemName = bareName(value(test.hasItem, args));
      const atLeast = value(test.atLeast, args);
      if (!validValue('item', itemName) || !Number.isInteger(atLeast) || atLeast < 1 || atLeast > 2304) throw failure('invalid_args');
      const result = await primitive({ primitive: 'countItem', params: { itemName } }, bindings);
      return result !== null && result >= atLeast;
    }
    // P1 §2c body predicates go through the free `body` query primitive the
    // same way hasItem goes through countItem; a missing snapshot is false.
    if (test.healthBelow !== undefined || test.foodBelow !== undefined || test.hasEffect !== undefined) {
      const threshold = test.healthBelow ?? test.foodBelow;
      if (threshold !== undefined && (!Number.isInteger(threshold) || threshold < 1 || threshold > 20)) {
        throw failure('invalid_args');
      }
      if (test.hasEffect !== undefined && typeof test.hasEffect !== 'string') throw failure('invalid_args');
      const snapshot = await primitive({ primitive: 'body', params: {} }, bindings);
      if (test.healthBelow !== undefined) return Number.isFinite(snapshot?.health) && snapshot.health < test.healthBelow;
      if (test.foodBelow !== undefined) return Number.isFinite(snapshot?.food) && snapshot.food < test.foodBelow;
      const effects = snapshot?.effects;
      return (Array.isArray(effects) && effects.includes(test.hasEffect))
        || (effects instanceof Set && effects.has(test.hasEffect));
    }
    if (test.not !== undefined) return !await condition(test.not, args, bindings, depth + 1);
    if (test.all) {
      for (const child of test.all) if (!await condition(child, args, bindings, depth + 1)) return false;
      return true;
    }
    if (test.any) {
      for (const child of test.any) if (await condition(child, args, bindings, depth + 1)) return true;
      return false;
    }
    throw failure('invalid_condition');
  }
  async function body(nodes, args, bindings, depth = 0, calls = []) {
    // The handler's quantity repeat/call adds two levels above a validated skill.
    if (depth > 5) throw failure('budget_exceeded');
    for (const node of nodes) {
      if (!isActive()) return;
      if (node.primitive !== undefined) {
        await primitive({ ...node, params: substitute(node.params, args) }, bindings);
      } else if (node.fail !== undefined) throw failure(node.fail);
      else if (node.repeat !== undefined) {
        const count = value(node.repeat, args);
        if (!validValue('count', count)) throw failure('invalid_args');
        const entry = remember({ node: 'repeat', depth, count, completed: 0 });
        for (let i = 0; i < count && isActive(); i++) {
          await body(node.body, args, scope(bindings), depth + 1, calls);
          if (isActive()) entry.completed++;
        }
      } else if (node.if !== undefined) {
        const selected = await condition(node.if, args, bindings);
        if (!isActive()) return;
        remember({ node: 'if', depth, branch: selected ? 'then' : 'else' });
        if (selected || node.else) await body(selected ? node.then : node.else, args, scope(bindings), depth + 1, calls);
      } else if (node.obtain !== undefined) {
        if (typeof obtain !== 'function') throw failure('invalid_program');
        if (!isActive()) return;
        if (executed >= 256) throw failure('budget_exceeded');
        executed++;
        const item = bareName(value(node.obtain.item, args));
        const count = value(node.obtain.count, args);
        if (!validValue('item', item) || !Number.isInteger(count) || count < 1 || count > 64) {
          throw failure('invalid_args');
        }
        remember({ node: 'obtain', depth, item, count });
        await obtain({ item, count });
      } else if (node.call !== undefined) {
        if (calls.includes(node.call)) throw failure('budget_exceeded');
        const skill = library?.get(node.call);
        if (!skill) throw failure('unknown_skill');
        const input = validateArgs(skill.params, substitute(node.args, args));
        if (!input.ok) throw failure('invalid_args');
        const entry = remember({ node: 'call', depth, name: node.call, version: skill.version, completed: false });
        await body(skill.body, input.args, scope(), depth + 1, [...calls, node.call]);
        if (isActive()) entry.completed = true;
      } else throw failure('invalid_program');
    }
  }
  await body(program.body, validated.args, scope());
}
