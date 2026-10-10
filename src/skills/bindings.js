import { adjacentGoal } from './approach.js';

// P2 round-2: ids accept camelCase (`atChest`, `plankCount`) — the `<id>`
// placeholder in the grammar and the camelCase param names (itemName,
// entityName) both invite it; ids live in their own namespace so case costs
// nothing. First char still lowercase so `$Owner` ≠ `$owner`.
export const stepIdPattern = /^[a-z][a-zA-Z0-9_]{0,15}$/;
// `$self` alone means the block she stands in (floor of her position) —
// `$self.below` is the ground under that. On find* centers it is a no-op
// "search near me", which is exactly what models write it for (P2 R4).
export const specialTargets = new Set(['$self', '$self.below', '$self.front', '$owner']);
// P1 §2a: `$<id>.below`/`$<id>.above` offset a bound step result by one block.
export const offsetAtPattern = /^\$([a-z][a-zA-Z0-9_]{0,15})\.(below|above)$/;
// P1 §2b: `$<id>.<field>` reads one whitelisted field off a bound step result.
export const stepRefPattern = /^\$([a-z][a-zA-Z0-9_]{0,15})\.([a-zA-Z][a-zA-Z0-9_]*)$/;
// P2 A1: `at:"$<id>"` is equivalent to `at:"<id>"` — both address a bound
// step result's position. Models write the `$` form by analogy with
// `$owner`/`$self.*`/`$id.below`; the grammar now accepts it outright.
export const dollarAtPattern = /^\$([a-z][a-zA-Z0-9_]{0,15})$/;
// P2 A4: say.text interpolates `$owner`, `$<id>` and `$<id>.<field>` tokens.
export const textRefPattern = /\$(owner|[a-z][a-zA-Z0-9_]{0,15})(?:\.([a-zA-Z][a-zA-Z0-9_]*))?/g;
// P2 A2: x/y/z expose a bound result's coordinates as single numbers.
export const resultFields = new Set(['uuid', 'entityName', 'blockName', 'name', 'count', 'x', 'y', 'z']);
// P2 A3: `minecraft:` is a legal namespace alias; canonical names are bare.
export const bareName = value => typeof value === 'string' && value.startsWith('minecraft:')
  ? value.slice('minecraft:'.length) : value;

function fail(code, message, extra = {}) {
  throw Object.assign(new Error(message), { code, ...extra });
}

const coordinates = value => value && ['x', 'y', 'z'].every(key => Number.isFinite(value[key]));
const floor = value => Object.fromEntries(['x', 'y', 'z'].map(key => [key, Math.floor(value[key])]));
const boundResult = (priorResults, id) =>
  priorResults instanceof Map ? priorResults.get(id) : priorResults?.[id];

// P2 A4: how a bound value speaks in chat — its name when it has one (a stored
// findBlock blockName counts), else its position, else JSON. Scalars just
// stringify; the result is always a string, never a fabricated name. Exported
// for interpreter.js: a whole-string `$id.field` ref in say.text lands there
// as the raw value and renders the same way.
export const renderBound = (value, id, priorResults) => {
  if (typeof value === 'string') return bareName(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const named = bareName(value?.entityName ?? value?.blockName ?? value?.name
    ?? priorResults?.blockNames?.get?.(id));
  if (typeof named === 'string' && named) return named;
  if (coordinates(value)) return `(${value.x}, ${value.y}, ${value.z})`;
  return JSON.stringify(value);
};

// P2 A4: `$owner` in say text speaks the owner's visible name — players list
// first, then the entities map, mirroring the `$owner` at-target lookup.
function ownerLabel(bot, ownerUuid) {
  const wanted = String(ownerUuid ?? '').toLowerCase();
  if (wanted) {
    for (const player of Object.values(bot?.players ?? {})) {
      if (player?.uuid?.toLowerCase() === wanted || player?.entity?.uuid?.toLowerCase() === wanted) {
        const label = player.username ?? player.entity?.username ?? player.entity?.name;
        if (label) return label;
      }
    }
    for (const entity of Object.values(bot?.entities ?? {})) {
      if (entity?.uuid?.toLowerCase() === wanted && entity.isValid !== false) {
        const label = entity.username ?? entity.name;
        if (label) return label;
      }
    }
  }
  fail('target_not_found', '找不到目标');
}

// P2 A4: a token that resolves to nothing fails the step like a field ref —
// chat must never emit the raw `$...` text or make a value up.
function interpolateText(text, priorResults, { bot, ownerUuid }) {
  return text.replace(textRefPattern, (match, id, field) => {
    if (id === 'owner' && field === undefined) return ownerLabel(bot, ownerUuid);
    const bound = boundResult(priorResults, id);
    const resolved = field === undefined ? bound
      : (typeof bound === 'number' && field === 'count' ? bound : bound?.[field]);
    if (resolved === undefined || resolved === null) fail('target_not_found', '找不到目标');
    return renderBound(resolved, id, priorResults);
  });
}

export function resolveStep(step, priorResults, { bot, ownerUuid } = {}) {
  const params = { ...step.params };
  // P2 A3: `minecraft:` prefixes normalize to bare catalog names before the
  // registry sees them. say.text is free text — a prefix there is content.
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && !(step.primitive === 'say' && key === 'text')) {
      params[key] = bareName(value);
    }
  }
  if (step.primitive === 'say' && typeof params.text === 'string' && params.text.includes('$')) {
    params.text = interpolateText(params.text, priorResults, { bot, ownerUuid });
  }
  if (step.at !== undefined) {
    if (['x', 'y', 'z'].some(key => Object.hasOwn(params, key))) {
      fail('invalid_binding', '绑定坐标时不能指定 x/y/z');
    }
    let target;
    let blockBound = false;
    if (step.at === '$owner') {
      const candidates = [...Object.values(bot?.entities ?? {}),
        ...Object.values(bot?.players ?? {}).map(player => player.entity && {
          ...player.entity, uuid: player.entity.uuid ?? player.uuid,
        })];
      const owner = candidates.find(entity => entity?.uuid?.toLowerCase() === ownerUuid?.toLowerCase()
        && entity.isValid !== false && coordinates(entity.position));
      if (!owner) fail('owner_not_found', '找不到玩家');
      target = floor(owner.position);
    } else if (step.at === '$self' || step.at === '$self.below' || step.at === '$self.front') {
      if (!coordinates(bot?.entity?.position)) fail('target_not_found', '找不到目标');
      target = floor(bot.entity.position);
      if (step.at === '$self.below') target.y--;
      else if (step.at === '$self.front') {
        if (!Number.isFinite(bot.entity.yaw)) fail('target_not_found', '找不到目标');
        // Mineflayer yaw: 0 faces -Z, pi/2 faces -X.
        const facing = ((Math.round(bot.entity.yaw / (Math.PI / 2)) % 4) + 4) % 4;
        const [dx, dz] = [[0, -1], [-1, 0], [0, 1], [1, 0]][facing];
        target.x += dx;
        target.z += dz;
      }
    } else {
      // `$<id>.below`/`$<id>.above`, a bare `$<id>` (P2 A1) and a bare `<id>`
      // share the bound-id lookup; `$self.*` and `$owner` matched their
      // dedicated branches above, so the key here is always a step id.
      const offset = typeof step.at === 'string' ? offsetAtPattern.exec(step.at) : null;
      const dollar = offset === null && typeof step.at === 'string' ? dollarAtPattern.exec(step.at) : null;
      const key = offset ? offset[1] : dollar ? dollar[1] : step.at;
      if (typeof key !== 'string' || !stepIdPattern.test(key)) {
        fail('invalid_binding', '未知坐标来源');
      }
      const result = boundResult(priorResults, key);
      if (!coordinates(result)) {
        const blockName = priorResults?.blockNames?.get(key) ?? result?.blockName;
        fail('target_not_found', '找不到目标', blockName ? { blockName } : {});
      }
      blockBound = (priorResults?.blockNames?.has(key) ?? false) || result?.blockName !== undefined;
      target = { x: result.x, y: result.y, z: result.z };
      if (offset) target.y += offset[2] === 'below' ? -1 : 1;
    }
    Object.assign(params, target);
    // Stay close enough for automatic pickup even before a newly dug drop is visible.
    if (step.primitive === 'goTo') {
      // A block-bound target (dig → approach → dig) would land her on top of
      // it — unsafe_below. Aim beside it like the executor's auto-approach.
      if (blockBound && coordinates(bot?.entity?.position)) {
        Object.assign(params, adjacentGoal(bot.entity.position, target), { range: 1.2 });
      } else {
        params.range = 1;
      }
    }
  }
  return { primitive: step.primitive, params, timeoutMs: step.timeoutMs };
}
