export function createLookAtOwner(bot, isOwner) {
  let lastTick;
  return function lookAtOwner(tick) {
    if (tick === lastTick) return;
    lastTick = tick;
    if (!bot.entity?.position) return;

    // Player-list UUIDs identify owners; an attached entity establishes visibility.
    const player = Object.values(bot.players ?? {}).find(isOwner);
    const owner = player?.entity ?? Object.values(bot.entities ?? {}).find(isOwner);
    if (!owner?.position || owner.isValid === false) return;
    const position = bot.entity.position;
    const distance = Math.hypot(
      owner.position.x - position.x,
      owner.position.y - position.y,
      owner.position.z - position.z,
    );
    if (distance > 8) return;
    return bot.lookAt(owner.position.offset(0, owner.height ?? 1.62, 0));
  };
}
