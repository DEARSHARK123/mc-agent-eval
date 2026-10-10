import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const { Vec3 } = require('vec3');
export const { goals } = require('mineflayer-pathfinder');

export const coordinates = {
  x: { type: 'number', required: true },
  y: { type: 'number', required: true },
  z: { type: 'number', required: true },
};
export const blockCoordinates = Object.fromEntries(
  Object.keys(coordinates).map(key => [key, { type: 'number', required: true, integer: true }])
);
export const itemName = { type: 'string', required: true, minLength: 1, catalog: 'itemsByName' };
export const point = ({ x, y, z }) => new Vec3(x, y, z);
export const positionResult = ({ x, y, z }) => ({ x, y, z });

export function checkSignal(signal) {
  signal.throwIfAborted();
}

export function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

// Race the library call against cancellation, and detach even if it never settles.
export function step(signal, action, stop = () => {}) {
  checkSignal(signal);
  let abort;
  return new Promise((resolve, reject) => {
    abort = () => {
      try { Promise.resolve(stop()).catch(() => {}); } catch {}
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    let operation;
    try { operation = action(); } catch (error) { operation = Promise.reject(error); }
    Promise.resolve(operation).then(resolve, reject);
  }).finally(() => signal.removeEventListener('abort', abort));
}

export function navigate(bot, goal, signal) {
  return step(signal, () => {
    // pathfinder.stop() only sets a flag consumed by the next setGoal; flush it so it cannot cancel this goal.
    bot.pathfinder.setGoal?.(null);
    return bot.pathfinder.goto(goal);
  }, () => bot.pathfinder.stop());
}

// Waits until window.slots / window.selectedItem reflect every click the bot sent.
// Servers stopped confirming individual clicks in 1.17+, so the only way to know a
// click landed is a full window resync: _syncWindow sends an impossible-state no-op
// and resolves on the server's window_items. One sync can still resolve on a resync
// that was already in flight for an earlier click (pickups clobber the shared
// stateId, so the server emits extra resyncs), leaving the local view one click
// behind. Two rounds guarantee the observed state includes at least the first
// no-op itself, i.e. every earlier click. Falls back to a short settle wait when
// _syncWindow is unavailable.
export function syncWindow(bot, window, signal, timeoutMs, code = 'window_desync') {
  if (typeof bot._syncWindow !== 'function') {
    return new Promise((resolve, reject) => {
      const onAbort = () => { cleanup(); reject(signal.reason); };
      const timer = setTimeout(() => { cleanup(); resolve(); }, 250);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  const syncOnce = () => new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => {
      cleanup();
      reject(codedError(code, `Window did not resynchronize within ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(bot._syncWindow(window)).then(
      () => { cleanup(); resolve(); },
      error => { cleanup(); reject(error); },
    );
  });
  return syncOnce().then(syncOnce);
}
