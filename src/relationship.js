import { buildPersona } from './persona.js';

export function createRelationship({ eventlog, brain, ownerUuid }) {
  const uuid = ownerUuid.toLowerCase();
  let playerName = null;
  let stored = eventlog.query({ kind: 'relationship.nickname', limit: Number.MAX_SAFE_INTEGER })
    .filter(event => event.payload?.ownerUuid?.toLowerCase() === uuid).at(-1)?.payload ?? null;
  let pending = null;
  const failedNames = new Set();
  const matches = () => stored?.playerName === playerName && Boolean(stored?.nickname);
  const nickname = () => matches() ? stored.nickname : playerName;

  function ensureNickname(signal) {
    if (pending) return pending;
    if (!playerName || !brain?.enabled || matches() || failedNames.has(playerName)) {
      return Promise.resolve(nickname());
    }
    pending = Promise.resolve().then(async () => {
      // Capture each name so a rename during generation never attaches its result to the new name.
      while (playerName && brain.enabled && !matches() && !failedNames.has(playerName)) {
        const name = playerName;
        try {
          const generated = await brain.nickname({ persona: buildPersona({ playerName: name }),
            playerName: name, memory: stored ? { previousNickname: stored } : {}, signal });
          if (typeof generated !== 'string' || !generated.trim()) {
            failedNames.add(name);
          } else {
            const payload = { ownerUuid: uuid, playerName: name, nickname: generated, source: 'brain' };
            eventlog.append('relationship.nickname', payload);
            stored = payload;
          }
        } catch (error) {
          failedNames.add(name);
          throw error;
        }
      }
      return nickname();
    }).finally(() => { pending = null; });
    return pending;
  }

  return {
    ownerName: () => playerName,
    setOwnerName(name) { playerName = typeof name === 'string' && name.trim() ? name.trim() : null; },
    nickname,
    ensureNickname,
  };
}
