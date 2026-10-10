import * as craft from '../primitives/craft.js';
import * as dig from '../primitives/dig.js';
import * as place from '../primitives/place.js';
import * as smelt from '../primitives/smelt.js';

// Auto-approach: a primitive may declare `reach` — the farthest distance to
// its resolved target at which it can still act. Before a resolved step whose
// params carry a target position (x/y/z merged from `at` or literals) runs,
// the executor walks into reach with an implicit goTo. Drafts never spell the
// approach by hand: movement itself (goTo/goToEntity/follow), speech and
// queries declare no reach, and give/attack/deposit/withdraw/collectDrops
// already navigate inside their own run — their reach is their business.
// Primitives are listed explicitly so a module forgetting its `reach` export
// stays out instead of silently walking to reach=undefined.
const REACHED = new Map([craft, dig, place, smelt].map(module => [module.name, module.reach]));

export const reachOf = name => REACHED.get(name) ?? null;

// The stand cell beside `target` on `origin`'s side — never the target
// itself. GoalNear's isEnd is a sphere around the goal: centered on the
// target, on-top (dist²=1) beats standing beside it (dist²≥2) at every
// range ≥1, so she could arrive standing on the very block she must dig
// (unsafe_below). A neighbouring column with range 1.2 admits only the
// four cross-adjacent stand cells (dist²=1) — the goal column (0),
// diagonals (2) and on-top (2) all stay outside.
export function adjacentGoal(origin, target) {
  const dx = origin.x - target.x, dz = origin.z - target.z;
  if (Math.abs(dx) >= Math.abs(dz)) return { x: target.x + Math.sign(dx || 1), y: target.y, z: target.z };
  return { x: target.x, y: target.y, z: target.z + Math.sign(dz || 1) };
}

// Standing on the target means it is the block directly under her feet —
// inside `reach` by distance, but dig's unsafe_below refuses it. Treat the
// on-top cell as out-of-reach so the approach still runs.
const standingOn = (origin, { x, y, z }) =>
  x === Math.floor(origin.x) && z === Math.floor(origin.z) && y === Math.floor(origin.y) - 1;

// Primitives measure reach from her eye (+1.62) to the block centre — the
// strictest of the common conventions. A corner-to-feet check would call the
// 4.2–4.5 band "in reach" while dig/place still fail it out there (sim).
const eyeToCenter = (origin, { x, y, z }) =>
  Math.hypot(origin.x - (x + 0.5), origin.y + 1.62 - (y + 0.5), origin.z - (z + 0.5));

// Resolves to the goTo run outcome when a walk happened (an {ok:false} there
// is the step's failure — the caller must not run the primitive), or null
// when the step needs no approach. `run` dispatches like registry.run.
export async function ensureReach({ primitive, params, origin, run }) {
  const reach = reachOf(primitive);
  if (!reach || !origin) return null;
  const { x, y, z } = params ?? {};
  if (![x, y, z].every(Number.isFinite)) return null;
  if (!standingOn(origin, { x, y, z }) && eyeToCenter(origin, { x, y, z }) <= reach) return null;
  return run('goTo', { ...adjacentGoal(origin, { x, y, z }), range: 1.2 });
}
