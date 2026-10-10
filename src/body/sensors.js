import { resolveClock } from '../clock.js';

const NEUTRAL = new Set(['enderman', 'zombified_piglin', 'piglin', 'wolf']);
const DISTURB_MS = 2_000;
const KNOCK_MS = 1_000;
const SWING_MS = 1_000;
// entity_velocity is notch velocity (1/8000 blocks per tick); a knockback is a
// sudden horizontal impulse the client never produces by walking.
const KNOCK_SPEED = 2 / 20; // blocks per tick threshold (2 m/s)

function sameUuid(value, expected) {
  return typeof value === 'string' && value.toLowerCase() === expected?.toLowerCase();
}

// Body perception: world/body signals become structured events and a small
// live state that reflexes and goals read (disturbed windows, who hit her).
export function createBodySensors({ bot, eventlog, ownerUuid, clock = {} } = {}) {
  const timers = resolveClock(clock);
  const now = timers.now;
  const emit = (kind, payload) => { try { eventlog?.append(`body.${kind}`, payload); } catch {} };
  const state = {
    lastHurt: null,        // { by, mob?, at }
    ownerSwingAt: -Infinity,
    disturbedUntil: -Infinity,
    lastFellAt: -Infinity,
    effects: new Set(),    // effect names currently on her (entityEffect only gives ids)
    itemsTaken: [],        // recent { where, item, count, at }
    disturbed: () => now() < state.disturbedUntil,
  };
  const ownerEntity = () => Object.values(bot.players ?? {})
    .find(player => sameUuid(player?.uuid, ownerUuid))?.entity ?? null;

  const disturb = () => { state.disturbedUntil = now() + DISTURB_MS; };

  const byOf = source => {
    if (!source) return { by: 'env' };
    if (sameUuid(source.uuid, ownerUuid)) return { by: 'owner' };
    if (source.type === 'player') return { by: 'player' };
    return { by: 'mob', mob: source.name };
  };

  const onHurt = (entity, source) => {
    if (entity !== bot.entity) return;
    const who = byOf(source);
    state.lastHurt = { ...who, at: now() };
    if (who.by === 'mob' && NEUTRAL.has(who.mob)) state.lastHurt.neutral = who.mob;
    emit('hurt', { ...who, health: bot.health });
    disturb();
  };
  const onVelocity = packet => {
    if (packet.entityId !== bot.entity?.id) return;
    const speed = Math.hypot(packet.velocity.x, packet.velocity.z);
    if (speed / 8000 <= KNOCK_SPEED) return;
    const recent = state.lastHurt && now() - state.lastHurt.at <= KNOCK_MS ? state.lastHurt : null;
    emit('knocked', { by: recent?.by ?? 'env', ...(recent?.mob ? { mob: recent.mob } : {}), speed: Math.round(speed * 20 / 8000 * 100) / 100 });
    disturb();
  };
  const onForcedMove = () => {
    emit('knocked', { by: 'env', forced: true });
    disturb();
  };
  const onSwingArm = entity => {
    const owner = ownerEntity();
    if (owner && entity === owner) state.ownerSwingAt = now();
  };
  // Her support cell is tracked while grounded; by the time a blockUpdate
  // arrives she may already be mid-fall, so match the last support too.
  let support = null;
  const onBlockUpdate = (oldBlock, newBlock) => {
    const p = bot.entity?.position;
    if (!p || !newBlock || !['air', 'cave_air', 'void_air'].includes(newBlock.name)) return;
    const feet = { x: Math.floor(p.x), y: Math.floor(p.y) - 1, z: Math.floor(p.z) };
    const q = newBlock.position;
    const hit = (c => c && q.x === c.x && q.y === c.y && q.z === c.z);
    if (!hit(feet) && !hit(support)) return;
    const owner = ownerEntity();
    const byOwner = owner?.position && owner.position.distanceTo(p) <= 6
      && now() - state.ownerSwingAt <= SWING_MS;
    emit('ground_lost', { by: byOwner ? 'owner' : 'unknown' });
    disturb();
  };
  // Fall tracking: record takeoff y while airborne, report the drop on landing.
  let fallingFrom = null;
  let healthAtTakeoff = null;
  const onPhysicsTick = () => {
    const entity = bot.entity;
    if (!entity) return;
    if (entity.onGround === false) {
      support = { x: Math.floor(entity.position.x), y: Math.floor(entity.position.y) - 1, z: Math.floor(entity.position.z) };
      if (fallingFrom === null || entity.position.y > fallingFrom) {
        if (fallingFrom === null) healthAtTakeoff = bot.health;
        fallingFrom = Math.max(fallingFrom ?? entity.position.y, entity.position.y);
      }
    } else {
      support = { x: Math.floor(entity.position.x), y: Math.floor(entity.position.y) - 1, z: Math.floor(entity.position.z) };
      if (fallingFrom !== null) {
        const distance = fallingFrom - entity.position.y;
        if (distance > 2) {
          emit('fell', { distance: Math.round(distance * 10) / 10, damaged: bot.health < (healthAtTakeoff ?? bot.health) });
          disturb();
        }
        fallingFrom = null;
        healthAtTakeoff = null;
      }
    }
  };
  const onEffect = (entity, effect) => {
    if (entity !== bot.entity) return;
    const name = snake(bot.registry?.effects?.[effect.id]?.name) ?? mcEffectName(effect.id);
    state.effects.add(name);
    emit('effect', { effect: name, amplifier: effect.amplifier });
  };
  const onEffectEnd = (entity, effect) => {
    if (entity !== bot.entity) return;
    const name = snake(bot.registry?.effects?.[effect.id]?.name) ?? mcEffectName(effect.id);
    state.effects.delete(name);
  };
  const KNOWN_EFFECTS = { 30: 'bad_omen', 33: 'raid_omen', 34: 'trial_omen' };
  const snake = n => n == null ? null : String(n).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  const mcEffectName = id => snake(KNOWN_EFFECTS[id] ?? `effect_${id}`);

  const noteTaken = ({ by = 'owner', where, item, count }) => {
    const row = { by, where, item, count, at: now() };
    state.itemsTaken.push(row);
    if (state.itemsTaken.length > 64) state.itemsTaken.shift();
    emit('items_taken', { by, where, item, count });
  };

  // Mineflayer only rewrites bot.vehicle/bot.entity.vehicle while she is IN
  // the new set_passengers list, so both stay stale after a detach. Patch
  // them from the packet that drops her, like its own emit('dismount').
  const onPassengers = packet => {
    if (packet.passengers?.includes(bot.entity?.id)) return;
    const vehicle = bot.vehicle;
    if (!vehicle || vehicle.id !== packet.entityId) return;
    bot.vehicle = null;
    if (bot.entity) bot.entity.vehicle = null;
    bot.emit?.('dismount', vehicle);
  };

  bot.on('entityHurt', onHurt);
  bot._client?.on('entity_velocity', onVelocity);
  bot._client?.on('set_passengers', onPassengers);
  bot.on('forcedMove', onForcedMove);
  bot.on('entitySwingArm', onSwingArm);
  bot.on('blockUpdate', onBlockUpdate);
  bot.on('physicsTick', onPhysicsTick);
  bot.on('entityEffect', onEffect);
  bot.on('entityEffectEnd', onEffectEnd);

  return {
    state, noteTaken,
    stop() {
      bot.off('entityHurt', onHurt);
      bot._client?.off('entity_velocity', onVelocity);
      bot._client?.off('set_passengers', onPassengers);
      bot.off('forcedMove', onForcedMove);
      bot.off('entitySwingArm', onSwingArm);
      bot.off('blockUpdate', onBlockUpdate);
      bot.off('physicsTick', onPhysicsTick);
      bot.off('entityEffect', onEffect);
      bot.off('entityEffectEnd', onEffectEnd);
    },
  };
}
