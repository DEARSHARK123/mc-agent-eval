export function decide(state, options = []) {
  const actions = [];
  let escalate = false;
  let ignoredChat = false;
  for (const event of state.events) {
    const type = event.type ?? event.kind;
    const payload = event.payload ?? event;
    if (type === 'chat') {
      if (payload.from_owner === true) actions.push({ type: 'handleOwnerChat', message: payload.message,
        ...(event.traceId ? { traceId: event.traceId } : {}) });
      else ignoredChat = true;
    }
    if (type === 'arbiter.done' && payload.status === 'failed') escalate = true;
  }
  if (actions.length === 0 && !escalate && !state.arbiter.busy
      && state.events.some(event => (event.type ?? event.kind) === 'heartbeat')) {
    actions.push({ type: 'idle' });
  }
  return {
    actions, escalate,
    reason: [
      ...(actions.some(action => action.type === 'handleOwnerChat') ? ['Handle owner chat'] : []),
      ...(ignoredChat ? ['Ignore non-owner chat: only the owner matters'] : []),
      ...(escalate ? ['Escalate failed intent'] : []),
      ...(actions.some(action => action.type === 'idle') ? ['Idle heartbeat'] : []),
    ].join('; ') || 'No action required',
  };
}
