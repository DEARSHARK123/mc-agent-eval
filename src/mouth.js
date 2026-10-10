import { resolveClock } from './clock.js';

export function createMouth({ bot, eventlog, voice, clock = {}, minIntervalMs = 800, maxLength = 200 }) {
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0 ||
      !Number.isSafeInteger(maxLength) || maxLength < 1) throw new Error('Invalid mouth limits');
  const timers = resolveClock(clock);
  const now = timers.now;
  const schedule = timers.setTimeout;
  let lastSpoken = null;
  let queue = Promise.resolve();

  return {
    say(text, traceId, { kind } = {}) {
      const spoken = Array.from(String(text)).slice(0, maxLength).join('');
      const result = queue.then(async () => {
        while (lastSpoken !== null && now() - lastSpoken < minIntervalMs) {
          await new Promise(resolve => schedule(resolve, minIntervalMs - (now() - lastSpoken)));
        }
        lastSpoken = now();
        await bot.chat(spoken);
        eventlog.append('speech', { text: spoken }, traceId);
        if (voice) {
          void Promise.resolve().then(() => voice.say(spoken, traceId, { kind })).catch(() => {});
        }
        return spoken;
      });
      queue = result.catch(() => {});
      return result;
    },
  };
}
