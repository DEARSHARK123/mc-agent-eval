import { goals, navigate, step, checkSignal, positionResult } from './helpers.js';
export const name = 'sleep';
export const description = 'Walk to the nearest bed and sleep at night or during a thunderstorm.';
export const params = {};
export const defaultTimeoutMs = 30000;
export async function run({ bot }, params, signal) {
  if (bot.time.isDay && !(bot.isRaining && bot.thunderState > 0)) throw new Error('not_night');
  const bed = bot.findBlock({ matching: block => block.name.endsWith('_bed'), maxDistance: 32 });
  if (!bed) throw new Error('no_bed');
  await navigate(bot, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), signal);
  checkSignal(signal);
  const wake = () => { if (bot.isSleeping) return bot.wake(); };
  await step(signal, async () => {
    await bot.sleep(bed);
    if (signal.aborted) { try { await wake(); } catch {} }
  }, wake);
  checkSignal(signal);
  return positionResult(bed.position);
}
