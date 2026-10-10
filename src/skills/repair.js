import { isObject } from './format.js';

// T29 A1: mechanical draft repairs applied before validateDraft at the two
// model-facing entry points (llm.js teach branch, handler.js unknownActionStep
// path). Each rule only fixes a shape that is plainly wrong but unambiguous in
// intent — no semantic guessing — and appends its rule name to `repairs` so
// callers can log `skills.repaired`. The input draft is never mutated; the
// returned draft is a new object whenever any rule fired.
//
// P2 A1/A3 removed two former rules on purpose: `at_dollar_id` (rewriting
// `at:"$id"` to `at:"id"`) and `minecraft_prefix` (stripping `minecraft:` from
// catalog fields). Both forms are legal grammar now, so keeping the rewrites
// would only churn legal drafts into equivalent shapes and report noise —
// validation and resolution handle them directly (format.js/bindings.js), and
// library storage still canonicalizes catalog names to bare form.

// Node shape keys recognized by validateDraft (see format.js inspectBody).
const NODE_FORMS = ['primitive', 'call', 'repeat', 'if', 'fail', 'obtain'];
// Canonical fields on a primitive node; anything else belongs in params.
const PRIMITIVE_FIELDS = new Set(['primitive', 'params', 'id', 'at', 'timeoutMs']);
// Node fields holding nested bodies.
const BODY_FIELDS = ['body', 'then', 'else'];
const XYZ = ['x', 'y', 'z'];

export function normalizeDraft(draft, { registry } = {}) {
  const repairs = [];

  const fixNode = node => {
    if (!isObject(node)) return node;
    let out = { ...node };
    // (e) {"<primitiveName>": {...}, id?/at?/timeoutMs?} shorthand → canonical
    // primitive node. Only when the node has no canonical shape key and holds
    // exactly one whitelisted primitive name.
    if (!NODE_FORMS.some(key => Object.hasOwn(out, key))) {
      const shorthand = Object.keys(out)
        .filter(key => registry?.has?.(key) === true && isObject(out[key]));
      if (shorthand.length === 1) {
        const [name] = shorthand;
        const { [name]: params, ...rest } = out;
        out = { primitive: name, params: { ...params }, ...rest };
        repairs.push('shorthand_primitive');
      }
    }
    if (out.primitive !== undefined) {
      // (c) primitive node without params → empty params.
      if (!Object.hasOwn(out, 'params')) {
        out.params = {};
        repairs.push('missing_params');
      }
      // P2 round-2: {"primitive":"say","text":"..."} — params fields written at
      // node level. Lift stray non-shape fields into params (params wins on a
      // collision); runs before at_xyz so lifted x/y/z still get stripped.
      const stray = Object.keys(out).filter(key => !PRIMITIVE_FIELDS.has(key));
      if (stray.length) {
        out.params = { ...Object.fromEntries(stray.map(key => [key, out[key]])), ...out.params };
        for (const key of stray) delete out[key];
        repairs.push('lift_params');
      }
      // (b) `at` already supplies the position; stray x/y/z would be rejected.
      if (out.at !== undefined && isObject(out.params)
          && XYZ.some(key => Object.hasOwn(out.params, key))) {
        out.params = { ...out.params };
        for (const key of XYZ) delete out.params[key];
        repairs.push('at_xyz');
      }
    }
    // (d) an empty else branch is dead weight.
    if (Array.isArray(out.else) && out.else.length === 0) {
      delete out.else;
      repairs.push('empty_else');
    }
    // P2 round-2: {"if":c,"then":[]} reads as "do nothing when c" — with a
    // nonempty else it is `{"if":{"not":c},"then":else}`; with no else at all
    // the node is a no-op and drops out. A dropped node can empty the whole
    // body — validateDraft reports that honestly.
    if (out.if !== undefined && Array.isArray(out.then) && out.then.length === 0) {
      if (Array.isArray(out.else) && out.else.length > 0) {
        out = { if: { not: out.if }, then: out.else };
        repairs.push('empty_then');
      } else {
        return null;
      }
    }
    for (const key of BODY_FIELDS) {
      if (Array.isArray(out[key])) out[key] = out[key].map(fixNode).filter(Boolean);
    }
    return out;
  };

  if (!isObject(draft)) return { draft, repairs };
  const normalized = { ...draft };
  if (Array.isArray(normalized.body)) normalized.body = normalized.body.map(fixNode).filter(Boolean);
  return { draft: normalized, repairs };
}
