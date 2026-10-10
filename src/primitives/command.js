import { checkSignal, codedError, Vec3 } from './helpers.js';
import { resolveClock } from '../clock.js';

export const name = 'command';
export const description = 'Place or clear framework marker glass blocks only.';
export const params = {
  kind: { type: 'string', required: true },
  marker: { type: 'string', required: true },
  from: { type: 'object', required: true },
  to: { type: 'object' },
};
export const defaultTimeoutMs = 5_000;

export const MARKERS = Object.freeze([
  'white_stained_glass', 'light_blue_stained_glass', 'yellow_stained_glass',
  'lime_stained_glass', 'pink_stained_glass', 'orange_stained_glass',
]);

const RANGE = 32;
const Y_MIN = -64;
const Y_MAX = 319;
const MAX_VOLUME = 512;
const WINDOW_MS = 60_000;
const MAX_COMMANDS = 30;
const MAX_WINDOW_VOLUME = 2_048;
const VERIFY_MS = 2_000;
const POLL_MS = 50;

const notAllowed = field => { throw codedError('not_allowed', `command not_allowed: ${field} is not whitelisted`); };

function checkPoint(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) notAllowed(field);
  const keys = Object.keys(value);
  if (keys.length !== 3 || !['x', 'y', 'z'].every(key => keys.includes(key))) notAllowed(field);
  for (const key of ['x', 'y', 'z']) {
    if (!Number.isSafeInteger(value[key])) notAllowed(`${field}.${key}`);
  }
  return value;
}

function volumeOf({ from, to }) {
  const end = to ?? from;
  return (Math.abs(end.x - from.x) + 1)
    * (Math.abs(end.y - from.y) + 1)
    * (Math.abs(end.z - from.z) + 1);
}

// Stateless validation: shape, marker whitelist, integer coordinates, range,
// volume and protection zones. Runs inside the registry's checked() so arbiter
// submissions are rejected before the primitive ever touches the bot.
export function check(value, { bot, protection } = {}) {
  if (!['setblock', 'fill', 'clear'].includes(value.kind)) notAllowed('kind');
  if (!MARKERS.includes(value.marker)) notAllowed('marker');
  const from = checkPoint(value.from, 'from');
  if (value.kind === 'setblock') {
    if (value.to !== undefined) notAllowed('to');
  } else if (value.to === undefined) {
    notAllowed('to');
  }
  const to = value.kind === 'setblock' ? from : checkPoint(value.to, 'to');
  const origin = bot?.entity?.position;
  if (!origin) throw codedError('out_of_range', 'command out_of_range: bot position unavailable');
  for (const point of [from, to]) {
    if (point.y < Y_MIN || point.y > Y_MAX) {
      throw codedError('out_of_range', `command out_of_range: y must be within ${Y_MIN}..${Y_MAX}`);
    }
    if (Math.abs(point.x - origin.x) > RANGE || Math.abs(point.y - origin.y) > RANGE
      || Math.abs(point.z - origin.z) > RANGE) {
      throw codedError('out_of_range', `command out_of_range: coordinates must stay within ${RANGE} blocks per axis`);
    }
  }
  if (volumeOf({ from, to }) > MAX_VOLUME) {
    throw codedError('too_large', `command too_large: volume must stay <= ${MAX_VOLUME}`);
  }
  // T25 gap: the whitelisted setblock/fill region must not touch a protection
  // zone. intersects tests the whole normalized box; without it, fall back to
  // the endpoints like dig's point-in-zone check.
  if (protection) {
    const region = {
      from: { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), z: Math.min(from.z, to.z) },
      to: { x: Math.max(from.x, to.x), y: Math.max(from.y, to.y), z: Math.max(from.z, to.z) },
    };
    const hit = typeof protection.intersects === 'function'
      ? protection.intersects(region)
      : (protection.contains?.(from) === true || protection.contains?.(to) === true);
    if (hit) throw codedError('protected', 'command protected: target region intersects a protection zone');
  }
}

// Sliding-window rate limit, one instance per registry. Timestamps come from the
// registry clock so fake clocks can advance the window in tests.
export function createLimiter({ now = Date.now } = {}) {
  const entries = [];
  return Object.freeze({
    spend(volume) {
      const t = now();
      while (entries.length && t - entries[0].t >= WINDOW_MS) entries.shift();
      if (entries.length >= MAX_COMMANDS) {
        throw codedError('rate_limited', `command rate_limited: more than ${MAX_COMMANDS} commands in ${WINDOW_MS}ms`);
      }
      const used = entries.reduce((total, entry) => total + entry.volume, 0);
      if (used + volume > MAX_WINDOW_VOLUME) {
        throw codedError('rate_limited', `command rate_limited: window volume exceeds ${MAX_WINDOW_VOLUME}`);
      }
      entries.push({ t, volume });
    },
  });
}

function buildText({ kind, marker, from, to }) {
  if (kind === 'setblock') return `setblock ${from.x} ${from.y} ${from.z} ${marker} keep`;
  if (kind === 'clear') return `fill ${from.x} ${from.y} ${from.z} ${to.x} ${to.y} ${to.z} air replace ${marker}`;
  return `fill ${from.x} ${from.y} ${from.z} ${to.x} ${to.y} ${to.z} ${marker} keep`;
}

function watchPoints({ kind, from, to }) {
  if (kind === 'setblock' || !to) return [from];
  const middle = {
    x: Math.floor((from.x + to.x) / 2),
    y: Math.floor((from.y + to.y) / 2),
    z: Math.floor((from.z + to.z) / 2),
  };
  return [from, to, middle];
}

export async function run({ bot, commandLimiter, clock }, params, signal) {
  checkSignal(signal);
  // Rate limiting lives here, right before the send: checked() also runs during
  // arbiter submission, so counting there would double-charge every command.
  commandLimiter.spend(volumeOf(params));
  const expected = params.kind === 'clear' ? 'air' : params.marker;
  // bot.blockAt requires a real Vec3; the structured params stay plain objects.
  const points = watchPoints(params).map(pos => {
    const vec = new Vec3(pos.x, pos.y, pos.z);
    return { pos: vec, before: bot.blockAt?.(vec)?.name ?? 'air' };
  });
  let denied = null;
  const onMessage = message => {
    const text = String(message?.toString?.() ?? message);
    // Purpur hides op-only commands from non-ops entirely ("Unknown command."),
    // vanilla answers "I'm sorry, but you do not have permission...".
    if (/unknown (or incomplete )?command|do not have permission/iu.test(text)) denied = text;
  };
  bot.on('message', onMessage);
  const timers = resolveClock(clock);
  try {
    bot.chat(`/${buildText(params)}`);
    const deadline = timers.now() + VERIFY_MS;
    while (timers.now() < deadline && !denied) {
      if (points.every(point => bot.blockAt?.(point.pos)?.name === expected)) break;
      await new Promise(resolve => timers.setTimeout(resolve, POLL_MS));
      checkSignal(signal);
    }
    checkSignal(signal);
    if (denied) throw codedError('no_permission', `command no_permission: ${denied}`);
    const states = points.map(point => ({ ...point, after: bot.blockAt?.(point.pos)?.name }));
    const changed = states.every(point => point.after === expected);
    const unexplained = states.some(point => point.after !== expected && point.after !== point.before);
    return { [params.kind === 'clear' ? 'cleared' : 'placed']: changed,
      ...(unexplained ? { verified: false } : {}) };
  } finally {
    bot.removeListener('message', onMessage);
  }
}
