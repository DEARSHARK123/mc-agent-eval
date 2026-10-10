export function createIdentity(ownerUuid) {
  const owner = ownerUuid.toLowerCase();
  return {
    isOwner(entityOrPlayer) {
      return typeof entityOrPlayer?.uuid === 'string'
        && entityOrPlayer.uuid.toLowerCase() === owner;
    },
  };
}
