export function errorPayload(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    ...(error?.code !== undefined ? { code: error.code } : {}),
    ...(error?.hits !== undefined ? { hits: error.hits } : {}),
    ...(error?.moved !== undefined ? { moved: error.moved } : {}),
  };
}

export function abortStatus(signal) {
  return signal?.reason === 'preempted' ? 'preempted' : 'cancelled';
}

export function firstError(outcome) {
  return outcome?.error ?? outcome?.results?.find(result => !result.ok)?.error;
}
