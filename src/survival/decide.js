/** Deterministic rules: coordinates for flee are relative to the body. */
export function decide(s, c) {
  const hostiles = (s.hostiles ?? []).filter(e => e.distance <= 16);
  const close = hostiles.filter(e => e.distance <= 8);
  const last = s.lastAction;
  const cooling = (kind, ms, reason, distance, target) => last?.kind === kind &&
    s.now - last.at < ms && (!reason || last.reason === reason) &&
    (!target || last.target === target) && !(distance < last.distance);
  const action = (kind, reason, primitive, params = {}) => ({ kind, reason, steps: [{ primitive, params }] });

  // Registry wakes the bot before the next primitive; sleeping never submits work.
  if (s.isSleeping) return null;
  const hazard = s.inLava ? 'lava' : s.onFire && !s.inWater ? 'fire' :
    s.inWater && s.oxygen <= 6 ? 'drowning' : s.yPosition <= s.minY + 2 ? 'void' : null;
  if (hazard && !(s.arbiter?.busy && s.arbiter.source === 'reflex' &&
      !['lava', 'drowning'].includes(hazard))) {
    // Without a cooldown each tick preempts the still-running escape goTo and
    // she never moves; same-hazard re-decides wait a beat, new hazards fire.
    if (cooling('escape_hazard', 1200, hazard)) return null;
    return { kind: 'escape_hazard', reason: hazard, steps: null };
  }
  // Suffocation ranks just below drowning/lava: her head is inside a solid
  // block, or she is taking source-less damage with her head buried.
  if (s.suffocating) {
    if (cooling('suffocating', 2000)) return null;
    return { kind: 'suffocating', reason: 'head_blocked', steps: null };
  }
  // A vehicle in trouble (drag bubbles, magma, lava, or work waiting while she
  // is stuck riding) gets one dismount; hazard rules take over after.
  if (s.vehicleUnsafe) {
    if (cooling('vehicle_dismount', 2000)) return null;
    return { kind: 'vehicle_dismount', reason: 'vehicle', steps: null };
  }
  // The trapped watchdog flagged her enclosure: natural walls get dug through,
  // artificial walls only get the spoken fact (never demolish them).
  if (s.trap) {
    if (cooling('trapped', 3000, s.trap.kind)) return null;
    if (s.trap.kind === 'natural') {
      const { x, y, z } = s.trap.dig;
      return { kind: 'trapped', reason: 'natural', steps: [{ primitive: 'dig', params: { x, y, z } }] };
    }
    if (!s.trap.text) return null;
    return { kind: 'trapped', reason: 'artificial', steps: [{ primitive: 'say', params: { text: s.trap.text } }] };
  }
  if (s.arbiter?.busy && s.arbiter.source === 'reflex') return null;

  const creeper = hostiles.find(e => e.name === 'creeper' && e.distance <= 7);
  const reason = s.neutralThreat ? 'neutral' : creeper ? 'creeper' : s.health <= c.fleeHealth && close.length ? 'low_health' :
    close.length >= 3 ? 'outnumbered' : !s.weapon && s.health < 14 &&
      close.some(e => !['zombie', 'skeleton', 'spider'].includes(e.name)) ? 'unarmed' : null;
  if (reason) {
    if (cooling('flee', 1500, reason, Math.min(...close.map(e => e.distance)))) return null;
    let dx = close.reduce((sum, e) => sum - e.dx, 0);
    let dz = close.reduce((sum, e) => sum - e.dz, 0);
    // Symmetric threats must still produce a usable, deterministic escape direction.
    if (!dx && !dz) { dx = -(close[0]?.dx || 1); dz = -(close[0]?.dz || 0); }
    const length = Math.hypot(dx, dz);
    const owner = s.ownerDirection;
    const towardsOwner = s.ownerDistance != null && owner && dx * owner.dx + dz * owner.dz > 0;
    const away = reason === 'neutral' && s.neutralThreat
      ? { x: s.neutralThreat.dx / Math.hypot(s.neutralThreat.dx, s.neutralThreat.dz, 1e-9) * -12, y: 0, z: s.neutralThreat.dz / Math.hypot(s.neutralThreat.dx, s.neutralThreat.dz, 1e-9) * -12 }
      : null;
    return action('flee', reason, 'goTo', away ?? (towardsOwner ?
      { x: owner.dx, y: owner.dy ?? 0, z: owner.dz } : { x: dx / length * 12, y: 0, z: dz / length * 12 }));
  }

  // Fight targets: hostiles on her (<=8), plus at night near a placed bed any
  // hostile within the sleep-blocking radius of the bed itself (8h/5v) up to
  // 12 blocks from her — she clears the bed area instead of waiting forever.
  // T28: a stance's fightRadius replaces both lists wholesale — never flee
  // predicates (the `close` list above is untouched).
  const stanceRadius = Number.isFinite(s.stance?.fightRadius) ? s.stance.fightRadius : null;
  const threats = stanceRadius === null ? close.filter(e => e.name !== 'creeper')
    : hostiles.filter(e => e.name !== 'creeper' && e.distance <= stanceRadius);
  if (s.isNight && s.bedNearby && stanceRadius === null) {
    threats.push(...hostiles.filter(e => e.name !== 'creeper' && e.nearBed && e.distance > 8 && e.distance <= 12));
  }
  const target = threats.sort((a, b) => a.distance - b.distance)[0];
  if (target && (s.weapon || s.health >= 14)) {
    return cooling('fight', 1000, null, undefined, target.name) ? null :
      action('fight', 'hostile', 'attack', { entityName: target.name, maxHits: 20 });
  }
  if (s.food <= c.foodUrgent && s.hasFood) {
    return cooling('eat_urgent', 3000) ? null : action('eat_urgent', 'hungry', 'eat');
  }
  // A retreat_to_shelter stance pulls her to the target first; normal T26
  // rules (sleep/guard) resume once she is there. Idle-source, and gated on
  // the arbiter being fully free — it must not preempt even an idle task.
  if (s.stance?.retreatTo && s.stance.retreatDistance > 3 && !s.arbiter?.active) {
    if (cooling('retreat', 8000)) return null;
    const { x, y, z } = s.stance.retreatTo;
    return { kind: 'retreat', reason: s.stance.name, steps: [{ primitive: 'goTo', params: { x, y, z, range: 2 } }] };
  }
  // guard_night skips sleeping entirely; she patrols near the anchor instead.
  const sleepAllowed = s.stance?.skipSleep !== true;
  // No bed in reach but one in the pack: face the head cell and place it first,
  // so the next tick's bedNearby branch can submit the sleep itself.
  if (sleepAllowed && s.isNight && !s.bedNearby && s.bedItem && s.bedSpot && !close.length
      && !s.hostilesNearSpot && !s.arbiter?.busy && s.health > 6) {
    if (cooling('place_bed', 10000)) return null;
    const { x, y, z } = s.bedSpot;
    const d = s.bedSpot.direction ?? { dx: 0, dz: 0 };
    // With her own hut zone nearby the spot is inside it; walk in first.
    return { kind: 'place_bed', reason: 'night', steps: [
      ...(s.hut ? [{ primitive: 'goTo', params: { x: s.hut.x, y: s.hut.y, z: s.hut.z, range: 1 } }] : []),
      { primitive: 'lookAt', params: { x: x + d.dx + 0.5, y: y + 0.5, z: z + d.dz + 0.5 } },
      { primitive: 'place', params: { itemName: s.bedItem, x, y, z } }] };
  }
  if (sleepAllowed && s.isNight && s.bedNearby && !close.length && !s.hostilesNearBed && !s.arbiter?.busy && s.health > 6) {
    // A just-finished fight may have interrupted a sleep attempt; give the
    // reflexes 3 s to settle before lying down again (10 s otherwise).
    if (last?.kind === 'fight' && s.now - last.at < 3000) return null;
    return cooling('sleep', 10000) ? null : action('sleep', 'night', 'sleep');
  }
  // guard_night patrol: walk back inside patrolRadius of the anchor (bed,
  // owner, or hut — resolved in index.js). Idle-source like retreat.
  if (s.stance?.patrolAnchor && s.stance.patrolDistance > s.stance.patrolRadius && !s.arbiter?.active) {
    if (cooling('patrol', 8000)) return null;
    const { x, y, z } = s.stance.patrolAnchor;
    const range = Math.max(1, Math.min(3, Math.floor(s.stance.patrolRadius) - 1));
    return { kind: 'patrol', reason: 'guard_night', steps: [{ primitive: 'goTo', params: { x, y, z, range } }] };
  }
  // Bad omen: drink milk if carried; otherwise state the fact once per minute
  // (T28 decides what it means; T27 only keeps her honest).
  if (s.badOmen && !s.arbiter?.busy) {
    if (s.hasMilk) {
      if (!cooling('bad_omen', 10000)) return action('bad_omen', 'drink_milk', 'eat', { itemName: 'milk_bucket' });
    } else if (!cooling('bad_omen', 60000, 'no_milk')) {
      return { kind: 'bad_omen', reason: 'no_milk', steps: null };
    }
  }
  if (s.food <= c.foodComfort && s.hasFood && !s.arbiter?.busy) {
    return cooling('eat_comfort', 3000) ? null : action('eat_comfort', 'comfort', 'eat');
  }
  return null;
}
