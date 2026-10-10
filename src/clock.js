export function resolveClock(clock = {}) {
  const source = typeof clock === 'function' ? {} : clock;
  return Object.freeze({
    now: typeof clock === 'function' ? clock : () => (clock.now ?? Date.now).call(clock),
    setTimeout: (...args) => (source.setTimeout ?? setTimeout).call(source, ...args),
    clearTimeout: (...args) => (source.clearTimeout ?? clearTimeout).call(source, ...args),
    setInterval: (...args) => (source.setInterval ?? setInterval).call(source, ...args),
    clearInterval: (...args) => (source.clearInterval ?? clearInterval).call(source, ...args),
  });
}
