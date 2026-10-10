import { Vec3 } from 'vec3';
import { decide } from './decide.js';
import { allowed } from '../primitives/attack.js';
import { selectFood } from '../primitives/eat.js';
import { PLANT_NAMES } from '../build/site.js';
import { naturalBlockName } from '../body/movements.js';
import { unsafeReason } from '../primitives/dig.js';
import { factLine } from '../persona.js';
import { resolveClock } from '../clock.js';

const MOVE_PRIMITIVES = new Set(['goTo', 'goToEntity', 'follow', 'collectDrops']);
const NEUTRAL_ATTACKERS = new Set(['enderman', 'zombified_piglin', 'piglin', 'wolf']);
const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

const BED_DIRECTIONS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

function weaponTier(items, mcData) {
  for (const kind of ['sword', 'axe']) {
    for (const material of ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']) {
      if (items.some(item => item.type === mcData.itemsByName[`${material}_${kind}`]?.id)) return material;
    }
  }
  return null;
}

function nearbyHostiles(bot, position, mcData, ownerUuid) {
  return Object.values(bot.entities ?? {})
    .filter(entity => entity.position && entity.isValid !== false && entity.type !== 'player'
      && (!ownerUuid || entity.uuid?.toLowerCase() !== ownerUuid.toLowerCase())
      && allowed(entity.name, mcData)
      && mcData.entitiesByName[entity.name]?.type === 'hostile'
      && position.distanceTo(entity.position) <= 16)
    .map(entity => {
      let sight = true;
      try {
        const seen = bot.blockAt?.(entity.position);
        if (seen && bot.canSeeBlock) sight = bot.canSeeBlock(seen);
      } catch {}
      return {
        name: entity.name, distance: position.distanceTo(entity.position),
        dx: entity.position.x - position.x, dz: entity.position.z - position.z,
        position: entity.position,
        hasLineOfSight: sight,
      };
    })
    .sort((a, b) => a.distance - b.distance);
}

export function createSurvival({ bot, registry, arbiter, eventlog, mcData, ownerUuid, config, clock = {}, protection = null, body = null, stance = null }) {
  const plants = new Set(PLANT_NAMES.filter(name => !mcData || Object.hasOwn(mcData.blocksByName, name)));
  const zones = () => protection?.zones?.() ?? [];
  const insideZone = (pos, zone) => (pos.x - zone.x) ** 2 + (pos.y - zone.y) ** 2 + (pos.z - zone.z) ** 2 <= zone.radius ** 2;
  // A cell is off-limits inside any protection zone; in hut mode own_build
  // zones (her own builds) are allowed so she can place a bed indoors.
  const protectedAt = (pos, allowOwn) => {
    const list = zones();
    if (!list.length) return !!protection?.contains?.(pos);
    return list.some(zone => (!allowOwn || zone.reason !== 'own_build') && insideZone(pos, zone));
  };
  const bedFoot = (p, hut = null) => {
    const base = p.floored();
    const open = pos => {
      const b = block(pos);
      return b && (['air', 'cave_air', 'void_air'].includes(b.name) || plants.has(b.name));
    };
    const floorOf = pos => block(pos.offset(0, -1, 0))?.boundingBox === 'block';
    for (const [dx, dz] of BED_DIRECTIONS) {
      const foot = base.offset(dx, 0, dz);
      const head = foot.offset(dx, 0, dz);
      if (open(foot) && open(head) && floorOf(foot) && floorOf(head)
          && (hut ? insideZone({ x: foot.x, y: foot.y, z: foot.z }, hut) && insideZone({ x: head.x, y: head.y, z: head.z }, hut) : true)
          && !protectedAt({ x: foot.x, y: foot.y, z: foot.z }, !!hut)
          && !protectedAt({ x: head.x, y: head.y, z: head.z }, !!hut)) {
        return { x: foot.x, y: foot.y, z: foot.z, direction: { dx, dz } };
      }
    }
    return null;
  };
  // Hostiles within the Minecraft sleep-blocking box of a spot: 8 horizontal, 5 vertical.
  const nearSpot = (pos, h = 8, v = 5) => pos && Object.values(bot.entities ?? {})
    .filter(entity => entity.position && entity.isValid !== false && entity.type !== 'player'
      && (!ownerUuid || entity.uuid?.toLowerCase() !== ownerUuid.toLowerCase())
      && allowed(entity.name, mcData) && mcData.entitiesByName[entity.name]?.type === 'hostile')
    .filter(entity => {
      const dx = entity.position.x - pos.x, dy = entity.position.y - pos.y, dz = entity.position.z - pos.z;
      return Math.hypot(dx, dz) <= h && Math.abs(dy) <= v;
    }).length;
  const timers = resolveClock(clock);
  const now = timers.now;
  const schedule = timers.setInterval;
  const clear = timers.clearInterval;
  let stopped = false;
  let lastAction = null;
  let health = bot.health;
  let hurtAt = -Infinity;
  let jumpTask = null;
  // Trapped watchdog + freed reporting; the say side is throttled to one per
  // 60 s so a fenced-in bot doesn't spam chat.
  let movingSince = null;
  let movingFrom = null;
  let trapped = null;
  let lastTrapSayAt = -Infinity;
  let lastSnapshot = null;
  const openSpot = (p, radius) => {
    let best = null;
    for (let x = -radius; x <= radius; x++) {
      for (let z = -radius; z <= radius; z++) {
        for (let y = -2; y <= 2; y++) {
          const q = p.floored().offset(x, y, z);
          if (Math.hypot(x, y, z) > radius) continue;
          if (block(q.offset(0, -1, 0))?.boundingBox !== 'block') continue;
          if (!air(block(q)) || !air(block(q.offset(0, 1, 0)))) continue;
          const d = p.distanceTo(q);
          if (!best || d < best.d) best = { q: q.offset(0.5, 0, 0.5), d };
        }
      }
    }
    return best?.q ?? null;
  };
  // Walkability flood fill out to `radius` cells; returns false when every
  // escape direction is walled, and which cells form the wall.
  const enclosure = (p, radius = 6) => {
    const seen = new Set();
    const queue = [p.floored()];
    const key = c => `${c.x},${c.y},${c.z}`;
    const blockers = new Map();
    const open = c => { const b = block(c); return b && (AIR_NAMES.has(b.name) || plants.has(b.name) || b.boundingBox === 'empty'); };
    const standable = c => open(c) && open(c.offset(0, 1, 0)) && block(c.offset(0, -1, 0))?.boundingBox === 'block';
    seen.add(key(queue[0]));
    let reachedEdge = !standable(queue[0]);
    while (queue.length && seen.size < 4096) {
      const c = queue.shift();
      if (Math.abs(c.x - p.x) >= radius || Math.abs(c.z - p.z) >= radius) { reachedEdge = true; continue; }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (const dy of [-1, 0, 1]) {
          const n = c.offset(dx, dy, dz);
          const k = key(n);
          if (seen.has(k)) continue;
          seen.add(k);
          if (standable(n)) { queue.push(n); continue; }
          if (!dy || dy === 1) {
            for (const wy of [dy, dy + 1]) {
              const w = c.offset(dx, wy, dz);
              const wb = block(w);
              if (wb && !AIR_NAMES.has(wb.name) && !plants.has(wb.name) && wb.boundingBox === 'block') {
                blockers.set(key(w), { x: w.x, y: w.y, z: w.z, name: wb.name });
              }
            }
          }
        }
      }
    }
    return { open: reachedEdge, blockers: [...blockers.values()] };
  };
  const log = (kind, payload) => { try { eventlog.append(kind, payload); } catch {} };
  const restore = () => {
    if (jumpTask !== null) {
      bot.setControlState('jump', false);
      jumpTask = null;
    }
  };
  const block = p => bot.blockAt?.(p);
  const air = b => b && ['air', 'cave_air', 'void_air'].includes(b.name);
  function safePoint(p, owner, reason) {
    const candidates = [];
    for (let x = -6; x <= 6; x++) {
      for (let z = -6; z <= 6; z++) {
        for (let y = -2; y <= 3; y++) {
          if (Math.hypot(x, y, z) > 6) continue;
          const q = p.floored().offset(x, y, z);
          const floor = block(q.offset(0, -1, 0));
          if (floor?.boundingBox !== 'block' || !air(block(q)) || !air(block(q.offset(0, 1, 0)))
            || ['lava', 'fire', 'soul_fire'].includes(floor.name)) continue;
          const water = [[1, 0], [-1, 0], [0, 1], [0, -1]]
            .some(([dx, dz]) => [0, -1].some(dy => block(q.offset(dx, dy, dz))?.name === 'water'));
          // A void escape must climb: her own pit cell resolves instantly
          // and the reflex loops forever without gaining height.
          if (reason === 'void' && q.y <= Math.floor(p.y)) continue;
          candidates.push({ q: q.offset(0.5, 0, 0.5), water, d: p.distanceTo(q) });
        }
      }
    }
    candidates.sort((a, b) => Number(b.water) - Number(a.water) || a.d - b.d);
    if (candidates.length) return candidates[0].q;
    if (owner) return owner.position;
    const angle = Math.random() * Math.PI * 2;
    return p.offset(Math.cos(angle) * 6, 0, Math.sin(angle) * 6);
  }
  function tick() {
    if (stopped || !bot.entity?.position) return;
    try {
      const p = bot.entity.position;
      const at = now();
      const current = arbiter.current();
      if (bot.health < health) hurtAt = at;
      health = bot.health;
      const owner = Object.values(bot.players ?? {})
        .find(e => ownerUuid && e.uuid?.toLowerCase() === ownerUuid.toLowerCase())?.entity;
      const blocks = [block(p), block(p.offset(0, -1, 0))];
      const hostiles = nearbyHostiles(bot, p, mcData, ownerUuid);
      const bed = bot.findBlock?.({ matching: b => b.name.endsWith('_bed'), maxDistance: 32 });
      // Her own hut nearby: place the bed inside it (sleep is blocked only by
      // hostiles near the bed, so a sheltered spot works under spawns).
      const hut = zones().find(zone => zone.reason === 'own_build'
        && (zone.x - p.x) ** 2 + (zone.y - p.y) ** 2 + (zone.z - p.z) ** 2 <= 32 ** 2) ?? null;
      const bedSpot = bedFoot(hut ? new Vec3(hut.x, hut.y, hut.z) : p, hut);
      if (bed) for (const e of hostiles) {
        const dx = e.position.x - bed.position.x, dy = e.position.y - bed.position.y, dz = e.position.z - bed.position.z;
        e.nearBed = Math.hypot(dx, dz) <= 8 && Math.abs(dy) <= 5;
      }
      // T28: the active stance rewrites a few parameters and may add
      // retreat/patrol targets. Everything here is advisory — decide() keeps
      // the hard reflexes first either way.
      const activeStance = stance?.current?.() ?? null;
      let stanceInfo = null;
      if (activeStance) {
        const params = activeStance.params ?? {};
        stanceInfo = { name: activeStance.name };
        if (Number.isFinite(params.fightRadius)) stanceInfo.fightRadius = params.fightRadius;
        const anchorOf = which => which === 'owner' ? (owner?.position ?? null)
          : which === 'hut' ? (hut ? { x: hut.x, y: hut.y, z: hut.z } : null)
          : which === 'bed' ? (bed?.position ?? null) : null;
        if (activeStance.name === 'retreat_to_shelter') {
          const target = anchorOf(params.target) ?? anchorOf('hut') ?? anchorOf('bed') ?? anchorOf('owner');
          if (target) {
            stanceInfo.retreatTo = { x: target.x, y: target.y, z: target.z };
            stanceInfo.retreatDistance = p.distanceTo(target);
          }
        }
        if (activeStance.name === 'guard_night') {
          stanceInfo.skipSleep = true;
          const anchor = anchorOf('bed') ?? anchorOf('owner') ?? anchorOf('hut');
          if (anchor) {
            stanceInfo.patrolAnchor = { x: anchor.x, y: anchor.y, z: anchor.z };
            stanceInfo.patrolRadius = Number.isFinite(params.patrolRadius) ? params.patrolRadius : 6;
            stanceInfo.patrolDistance = p.distanceTo(anchor);
          }
        }
      }
      const weapon = weaponTier(bot.inventory?.items() ?? [], mcData);
      let hasFood = false;
      try { hasFood = !!selectFood(bot, mcData); } catch {}
      const oxygen = bot.oxygenLevel ?? 20;
      if (oxygen >= 15) restore();
      const headBlock = block(p.floored().offset(0, 1, 0));
      const envHurtRecent = body?.state?.lastHurt?.by === 'env' && at - body.state.lastHurt.at <= 1_000;
      const suffocating = headBlock?.boundingBox === 'block'
        || (envHurtRecent && headBlock && !AIR_NAMES.has(headBlock.name) && headBlock.boundingBox !== 'empty');
      const effectId = name => {
        const want = name.replace(/_/g, '').toLowerCase();
        const entry = Object.entries(mcData.effectsByName ?? {}).find(([n]) => n.replace(/_/g, '').toLowerCase() === want)?.[1];
        return entry?.id;
      };
      const hasEffect = name => {
        const id = effectId(name);
        return (id !== undefined && !!bot.entity?.effects?.[id]) || body?.state?.effects?.has?.(name) === true;
      };
      const hasMilk = (bot.inventory?.items() ?? []).some(item => item.name === 'milk_bucket');
      const neutral = body?.state?.lastHurt?.neutral && at - body.state.lastHurt.at <= 2_000
        ? Object.values(bot.entities ?? {}).find(e => e.name === body.state.lastHurt.neutral
            && e.position && e.isValid !== false && p.distanceTo(e.position) <= 16)
        : null;
      // set_passengers only updates bot.vehicle while she is IN the new
      // passenger list, so it stays stale after a detach — bot.entity.vehicle
      // (maintained from the passenger side) is the source of truth.
      const vehicle = bot.entity?.vehicle ?? bot.vehicle ?? null;
      let vehicleUnsafe = false;
      if (vehicle?.position) {
        const vp = vehicle.position;
        const dangerous = ['bubble_column', 'magma_block', 'lava'];
        outer: for (let dx = -3; dx <= 3; dx++) {
          for (let dz = -3; dz <= 3; dz++) {
            for (let dy = -2; dy <= 1; dy++) {
              if (dangerous.includes(block(vp.floored().offset(dx, dy, dz))?.name)) { vehicleUnsafe = true; break outer; }
            }
          }
        }
        vehicleUnsafe = vehicleUnsafe || headBlock?.name === 'water'
          || (!!current && ['owner', 'plan'].includes(current.source));
      }
      // Trapped watchdog: a movement primitive in flight for 20 s with <1 block
      // of progress, or a goTo that ended noPath, means she is walled in.
      let trap = null;
      // query() is ORDER BY id ASC LIMIT n — without a window it returns the
      // oldest rows, so a busy session leaves lastMove/lastEnd permanently stale.
      const starts = eventlog?.query?.({ kind: 'primitive.start', since: at - 120_000, limit: 10_000 }) ?? [];
      const ends = eventlog?.query?.({ kind: 'primitive.end', since: at - 120_000, limit: 10_000 }) ?? [];
      const lastEnd = ends.at(-1);
      // A movement primitive is in flight while its trace has no end — later
      // unrelated ends (say/dig or another move) must not clear it.
      const endedTraces = new Set(ends.map(row => row.trace_id));
      const lastMove = [...starts].reverse().find(row => MOVE_PRIMITIVES.has(row.payload?.name)
        && !endedTraces.has(row.trace_id));
      const moving = Boolean(lastMove);
      const goToNoPath = lastEnd?.payload?.name === 'goTo' && !lastEnd.payload?.ok
        && ['NoPath', 'PathStopped', 'Timeout', 'GoalChanged'].includes(lastEnd.payload?.error?.name)
        && (!moving || lastEnd.id >= (lastMove?.id ?? 0));
      if (moving) {
        if (movingSince === null) { movingSince = at; movingFrom = p.clone(); }
      } else { movingSince = null; movingFrom = null; }
      const stuck = (moving && at - movingSince >= 20_000 && p.distanceTo(movingFrom) < 1)
        || (goToNoPath && lastEnd.id > (trapped?.markedId ?? 0))
        // A trap dig that finished without freeing her starts the next one;
        // one wall column is two cells (feet + head).
        || (trapped?.kind === 'natural' && lastEnd?.payload?.name === 'dig'
          && lastEnd.id > (trapped?.markedId ?? 0) && !enclosure(p).open);
      if (stuck) {
        const zone = enclosure(p);
        const sq = p.floored();
        if (!zone.open) {
          const digTargets = zone.blockers
            .filter(w => naturalBlockName(w.name) && !protection?.contains?.(w) && !unsafeReason(bot, w))
            .sort((a, b) => p.distanceTo(a) - p.distanceTo(b));
          if (digTargets.length) {
            trap = { kind: 'natural', dig: digTargets[0] };
          } else {
            trap = { kind: 'artificial' };
            log('body.trapped', { kind: 'artificial', blocks: zone.blockers.length });
            if (at - lastTrapSayAt >= 60_000) {
              lastTrapSayAt = at;
              trap.text = factLine({ kind: 'trapped' });
            }
          }
          trapped = { at: p.clone(), kind: trap.kind, markedId: lastEnd?.id ?? 0 };
        } else {
          movingSince = at; movingFrom = p.clone();
        }
      }
      if (trapped && (p.distanceTo(trapped.at) >= 3 || enclosure(p).open)) {
        log('body.freed', { kind: trapped.kind });
        lastAction = { kind: 'freed', at };
        trapped = null;
      }
      const snapshot = {
        now: at, health: bot.health, food: bot.food, oxygen,
        isSleeping: !!bot.isSleeping,
        onFire: typeof bot.entity.metadata?.[0] === 'number'
          ? !!(bot.entity.metadata[0] & 1)
          : blocks.some(b => ['fire', 'soul_fire'].includes(b?.name)),
        inLava: blocks.some(b => b?.name === 'lava'),
        inWater: blocks.some(b => b?.name === 'water'),
        yPosition: p.y, minY: bot.game?.minY ?? -64,
        timeOfDay: bot.time?.timeOfDay,
        isNight: bot.time?.isDay === false || bot.thunderState > 0,
        hostiles, hurtRecently: at - hurtAt <= 3000, weapon, hasFood,
        bedNearby: !!bed,
        bedPosition: bed?.position ?? null,
        hostilesNearBed: bed ? nearSpot(bed.position) : 0,
        bedItem: (bot.inventory?.items() ?? []).find(item => item?.name?.endsWith('_bed'))?.name ?? null,
        bedSpot,
        hostilesNearSpot: bedSpot ? nearSpot(bedSpot) : 0,
        hut: hut ? { x: hut.x, y: hut.y, z: hut.z } : null,
        ownerDistance: owner ? p.distanceTo(owner.position) : null,
        ownerDirection: owner ? { dx: owner.position.x - p.x, dy: owner.position.y - p.y, dz: owner.position.z - p.z } : null,
        arbiter: { busy: !!current && current.source !== 'idle', source: current?.source,
          label: current?.label ?? null, active: current !== null },
        lastAction,
        suffocating, vehicleUnsafe, badOmen: hasEffect('bad_omen'), hasMilk,
        neutralThreat: neutral ? { name: neutral.name, dx: neutral.position.x - p.x, dz: neutral.position.z - p.z } : null,
        trap,
        // T28 extras, consumed by the stance engine's trigger/prompt layer.
        position: { x: p.x, y: p.y, z: p.z },
        ownerPosition: owner?.position ? { x: owner.position.x, y: owner.position.y, z: owner.position.z } : null,
        ownerHealth: (() => { const v = owner?.metadata?.[9]; return Number.isFinite(v) ? v : null; })(),
        thundering: (bot.thunderState ?? 0) > 0,
        stance: stanceInfo,
      };
      lastSnapshot = snapshot;
      // fleeHealth may only become more conservative than the configured
      // default: clamp the stance value into [default, 12].
      const stanceFlee = activeStance?.params?.fleeHealth;
      const effectiveConfig = Number.isFinite(stanceFlee)
        ? { ...config, fleeHealth: Math.min(12, Math.max(config.fleeHealth ?? 0, stanceFlee)) }
        : config;
      const action = decide(snapshot, effectiveConfig);
      if (!action) return;
      if (action.kind === 'vehicle_dismount') {
        log('survival.action', { kind: 'vehicle_dismount', reason: 'vehicle', label: 'survival:vehicle_dismount', decidedAt: at });
        // bot.dismount() sends steer flags 0x02 (jump) which a boat ignores;
        // the dismount bit is 0x01 — burst it for a second since a single
        // packet may be dropped, with a sneak pulse as a second signal.
        const steer = () => { try { bot._client?.write('steer_vehicle', { sideways: 0, forward: 0, jump: 0x01 }); } catch {} };
        steer();
        for (let i = 1; i <= 10; i++) timers.setTimeout(steer, i * 100);
        try {
          bot.setControlState('sneak', true);
          timers.setTimeout(() => { try { bot.setControlState('sneak', false); } catch {} }, 300);
        } catch {}
        lastAction = { kind: 'vehicle_dismount', reason: 'vehicle', at };
        return;
      }
      let steps = action.steps;
      if (action.kind === 'escape_hazard') {
        const q = safePoint(p, owner, action.reason);
        steps = [{ primitive: 'goTo', params: { x: q.x, y: q.y, z: q.z } }];
      } else if (action.kind === 'suffocating') {
        const spot = openSpot(p, 3);
        if (spot) {
          steps = [{ primitive: 'goTo', params: { x: spot.x, y: spot.y, z: spot.z, range: 1 } }];
        } else if (headBlock && naturalBlockName(headBlock.name)
            && !protection?.contains?.(headBlock.position) && !unsafeReason(bot, headBlock.position)) {
          steps = [{ primitive: 'dig', params: { x: headBlock.position.x, y: headBlock.position.y, z: headBlock.position.z } }];
        } else {
          log('body.trapped', { kind: 'artificial', blocks: 1 });
          if (at - lastTrapSayAt < 60_000) return;
          lastTrapSayAt = at;
          steps = [{ primitive: 'say', params: { text: factLine({ kind: 'trapped' }) } }];
        }
      } else if (action.kind === 'bad_omen' && action.reason === 'no_milk') {
        steps = [{ primitive: 'say', params: { text: factLine({ kind: 'bad_omen' }) } }];
      } else if (action.kind === 'flee') {
        steps = steps.map(s => ({ ...s, params: { x: p.x + s.params.x, y: p.y + s.params.y, z: p.z + s.params.z } }));
      }
      for (const step of steps) registry.validate?.(step.primitive, step.params);
      const source = ['escape_hazard', 'flee', 'fight', 'eat_urgent', 'suffocating', 'trapped'].includes(action.kind)
        ? 'reflex' : ['sleep', 'place_bed'].includes(action.kind) ? 'plan' : 'idle';
      const label = `survival:${action.kind}`;
      const result = arbiter.submit({ source, label, steps });
      if (!result.accepted) return;
      if (current) log('survival.interrupted', { label: current.label, source: current.source });
      lastAction = {
        kind: action.kind, reason: action.reason, at,
        distance: hostiles[0]?.distance, target: action.steps?.[0]?.params?.entityName,
      };
      log('survival.action', { kind: action.kind, reason: action.reason, label, decidedAt: at });
      if (action.reason === 'drowning') {
        restore();
        jumpTask = result;
        bot.setControlState('jump', true);
        Promise.resolve(result.done).finally(() => { if (jumpTask === result) restore(); });
      }
    } catch (error) {
      log('survival.error', { name: error.name });
    }
  }
  const onHealth = () => {
    if (bot.health < health) tick();
    else health = bot.health;
  };
  bot.on('health', onHealth);
  const timer = schedule(tick, config.tickMs ?? 250);
  return Object.freeze({
    tick,
    // The latest assembled snapshot — the stance engine's getSnapshot source.
    snapshot: () => lastSnapshot,
    stop() {
      if (stopped) return;
      stopped = true;
      clear(timer);
      bot.off('health', onHealth);
      restore();
    },
  });
}
