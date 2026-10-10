export function isStopCommand(message) {
  if (typeof message !== 'string') return false;
  const normalized = message.trim().replace(/[。！？!?.,，]+$/u, '').trim();
  return /^(?:停|停止|停下|别跟了|不用跟了|别动|别动了|站住|等等)$/u.test(normalized);
}

export function cancelOwnerWork({ arbiter, agent }, traceId) {
  const current = arbiter.current?.();
  const taskCancelled = arbiter.cancel?.('owner') === true;
  const agentCancelled = agent?.cancel?.() === true;
  return { traceId, label: taskCancelled ? current?.label : null, taskCancelled, agentCancelled };
}

// Stop acknowledgement must not wait behind an agent that ignores cancellation.
export function dispatchOwnerChat(runtime, action, agent) {
  if (isStopCommand(action.message)) {
    const stopped = cancelOwnerWork({ arbiter: runtime.arbiter, agent }, action.traceId);
    return runtime.handler.handle(action.message, action.traceId, stopped);
  }
  return runtime.actionQueue = runtime.actionQueue.then(() =>
    runtime.handler.handle(action.message, action.traceId));
}
