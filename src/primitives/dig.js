import { blockCoordinates, checkSignal, codedError, point, step } from './helpers.js';
import { resolveClock } from '../clock.js';

export const name = 'dig';
export const description = 'Dig a diggable block within 4.5 blocks.';
export const params = blockCoordinates;
// skills/approach.js walks her within reach-1.5 before the run.
export const reach = 4.5;
export const defaultTimeoutMs = 15_000;

const LAND_WAIT_MS = 2_000;
const STALL_SLACK_MS = 1_500;
const STALL_POLL_MS = 300;
const MAX_DIG_ATTEMPTS = 3;

// mineflayer bakes digTime once when bot.dig() starts, and a transient airborne
// tick (mid-hop, landing) inflates it 5x — a 7.5s stone dig then outlives the
// primitive timeout (observed on the real server: started at onGround=false,
// expected 37.5s, aborted at 15s with the block still there). Wait briefly for
// the landing so the dig starts grounded; a genuinely floating bot still digs.
async function waitForGround(bot, signal, timers) {
  const deadline = timers.now() + LAND_WAIT_MS;
  while (bot.entity.onGround === false && timers.now() < deadline) {
    let timer;
    try {
      await step(signal, () => new Promise(resolve => {
        timer = timers.setTimeout(resolve, 50);
      }));
    } finally {
      if (timer !== undefined) timers.clearTimeout(timer);
    }
  }
}

// bot.dig() never settles if its internal finish timer is lost or inflated;
// watch the live digTime and re-issue the dig instead of waiting forever.
async function digOnce(bot, block, signal, timers) {
  const started = timers.now();
  let stalled = false;
  let watch;
  if (typeof bot.digTime === 'function') {
    watch = timers.setInterval(() => {
      if (stalled || !bot.targetDigBlock) return;
      let expected;
      try { expected = bot.digTime(bot.targetDigBlock); } catch { return; }
      if (Number.isFinite(expected) && timers.now() - started > expected + STALL_SLACK_MS) {
        stalled = true;
        try { bot.stopDigging(); } catch {}
      }
    }, STALL_POLL_MS);
  }
  try {
    await step(signal, () => bot.dig(block), () => bot.stopDigging());
  } catch (error) {
    if (stalled && error?.message === 'Digging aborted') {
      throw codedError('dig_stalled', `Dig stalled past its expected dig time at ${block.position}`);
    }
    throw error;
  } finally {
    if (watch !== undefined) timers.clearInterval(watch);
  }
}

const FALLING = new Set(['sand', 'red_sand', 'gravel']);
const AIR = new Set(['air', 'cave_air', 'void_air']);
const NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// Submission-time body safety (registry rejects before bot.dig is called):
// the cell under her feet, a block above her with gravity blocks on top, or a
// cell whose neighbours include lava / flowing (non-source) water.
export function unsafeReason(bot, { x, y, z } = {}) {
  const p = bot?.entity?.position;
  if (!p) return null;
  const blockAt = q => { try { return bot.blockAt(point(q)); } catch { return null; } };
  const feet = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  const head = { x: feet.x, y: feet.y + 1, z: feet.z };
  if (x === feet.x && y === feet.y - 1 && z === feet.z) return 'unsafe_below';
  const falling = name => name && (FALLING.has(name) || name.endsWith('_concrete_powder'));
  if (x === feet.x && z === feet.z && y > head.y
      && falling(blockAt({ x, y: y + 1, z })?.name)) return 'falling_above';
  for (const [dx, dy, dz] of NEIGHBOURS) {
    const q = { x: x + dx, y: y + dy, z: z + dz };
    if ((q.x === feet.x && q.z === feet.z && (q.y === feet.y || q.y === head.y))) continue;
    const b = blockAt(q);
    if (!b) continue;
    if (b.name === 'lava') return 'liquid_adjacent';
    if (b.name === 'water' && (b.getProperties?.().level ?? 0) !== 0) return 'liquid_adjacent';
  }
  return null;
}

export async function run({ bot, clock = {} }, params, signal) {
  const target = point(params);
  if (bot.entity.position.distanceTo(target) > reach) throw codedError('out_of_reach', `Block is beyond dig reach (${reach} blocks)`);
  const block = bot.blockAt(target);
  if (!block || !bot.canDigBlock(block)) throw new Error('Target block is not diggable');
  const timers = resolveClock(clock);
  await waitForGround(bot, signal, timers);

  let lastError;
  for (let attempt = 1; attempt <= MAX_DIG_ATTEMPTS; attempt++) {
    checkSignal(signal);
    const current = bot.blockAt(target);
    if (!current || current.name !== block.name) return { ...params };
    if (!bot.canDigBlock(current)) throw new Error('Target block is not diggable');
    try {
      await digOnce(bot, current, signal, timers);
      return { ...params };
    } catch (error) {
      if (error?.code !== 'dig_stalled') throw error;
      lastError = error;
      await waitForGround(bot, signal, timers);
    }
  }
  throw lastError;
}
