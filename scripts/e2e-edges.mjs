import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { runSkill } from '../src/skills/runner.js';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3');
const mcData = require('minecraft-data')('1.20.4');

export function edgesEnvironment(env, log = console.log) {
  if (env.E2E_EDGES !== '1') { log('E2E EDGES SKIP: set E2E_EDGES=1'); return false; }
  return true;
}

// Ten independent body-edge sub-scenarios (T27 §7). Each resets the field
// around her so a failure in one does not poison the next.
export async function runEdgesScenario({ app, owner, command, delay, server, botName = 'Companion',
  ownerName = 'TestOwner', log = console.log }) {
  const bot = () => app.bot;
  const p = () => bot().entity.position;
  const f = () => p().floored();
  const events = kind => app.eventlog.query({ kind, limit: Number.MAX_SAFE_INTEGER });
  const body = kind => events(`body.${kind}`);
  const primitives = () => events('primitive.end');
  const ownerEntity = () => Object.values(bot().entities ?? {})
    .find(e => e?.username === ownerName || e?.uuid === owner.players?.[ownerName]?.uuid);
  const at = q => bot().blockAt(new Vec3(Math.floor(q.x), Math.floor(q.y), Math.floor(q.z)))?.name;
  const wait = async (label, predicate, ms = 30_000) => {
    const end = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() >= end) {
        for (const row of events('body.hurt').slice(-3)) log(`E2E DBG body.hurt ${JSON.stringify(row.payload)}`);
        for (const row of events('body.ground_lost').slice(-3)) log(`E2E DBG body.ground_lost ${JSON.stringify(row.payload)}`);
        for (const row of events('primitive.end').slice(-8)) log(`E2E DBG pend ${JSON.stringify(row.payload).slice(0, 220)}`);
        for (const row of events('survival.action').slice(-8)) log(`E2E DBG sact ${JSON.stringify(row.payload).slice(0, 160)}`);
        for (const row of events('survival.error').slice(-8)) log(`E2E DBG serr ${JSON.stringify(row.payload).slice(0, 200)}`);

        for (const row of events('arbiter.reject').slice(-8)) log(`E2E DBG arej ${JSON.stringify(row.payload).slice(0, 160)}`);
        for (const row of events('arbiter.accept').slice(-8)) log(`E2E DBG aacc ${JSON.stringify(row.payload).slice(0, 160)}`);
        for (const row of events('body.effect').slice(-6)) log(`E2E DBG beff ${JSON.stringify(row.payload)}`);
        for (const row of events('body.items_taken').slice(-8)) log(`E2E DBG taken ${JSON.stringify(row.payload)}`);
        for (const row of events('body.fell').slice(-3)) log(`E2E DBG body.fell ${JSON.stringify(row.payload)}`);
        throw new Error(`${label}: timed out (Companion at ${JSON.stringify(p())})`);
      }
      await delay(150);
    }
  };
  const stage = tag => log(`E2E EDGES ${tag} at ${JSON.stringify(p())}`);
  const ownerTp = q => command(`tp ${ownerName} ${q.x + 0.5} ${q.y} ${q.z + 0.5}`);
  const tp = q => command(`tp ${botName} ${q.x + 0.5} ${q.y} ${q.z + 0.5}`);
  const flatten = (cx, r = 6) => {
    const c = f();
    command(`fill ${c.x - r} ${c.y - 1} ${c.z - r} ${c.x + r} ${c.y - 1} ${c.z + r} grass_block`);
    command(`fill ${c.x - r} ${c.y} ${c.z - r} ${c.x + r} ${c.y + 6} ${c.z + r} air`);
  };

  command(`gamemode creative ${ownerName}`);
  command('difficulty peaceful');
  command(`clear ${botName}`);

  // S1: the owner digs the block under her mid-goTo; she lands in the pit,
  // logs ground_lost by owner, and climbs back out with a fresh walk.
  stage('S1');
  {
    flatten();
    const c = f();
    command(`fill ${c.x + 2} ${c.y - 3} ${c.z - 1} ${c.x + 3} ${c.y - 3} ${c.z + 1} stone`);
    command(`fill ${c.x + 2} ${c.y - 2} ${c.z - 1} ${c.x + 3} ${c.y - 1} ${c.z + 1} air`);
    // A step lets her pathfinder walk out; the pit is still a two-block fall.
    command(`setblock ${c.x + 3} ${c.y - 2} ${c.z + 1} dirt`);
    command(`setblock ${c.x + 2} ${c.y - 1} ${c.z} dirt`);
    command(`give ${botName} dirt 8`);
    ownerTp({ x: c.x + 4, y: c.y, z: c.z });
    command(`tp ${botName} ${c.x + 2.5} ${c.y} ${c.z + 0.5}`);
    await delay(500);
    const under = new Vec3(c.x + 2, c.y - 1, c.z);
    let dug = false;
    try {
      await owner.dig(owner.blockAt(under));
      dug = true;
    } catch { command(`setblock ${under.x} ${under.y} ${under.z} air`); }
    await delay(400);
    const lost = () => body('ground_lost').at(-1)?.payload;
    await wait('S1 ground_lost', () => lost()?.by === 'owner' || lost()?.by === 'unknown', 15_000);
    if (dug && lost().by !== 'owner') log(`E2E EDGES S1 note: ground_lost attributed ${lost().by}`);
    assert.ok(p().y < c.y, 'she actually fell into the pit');
    // Give the void escape reflex the first shot at climbing out; manual
    // goTos race it for the pathfinder and starve it into GoalChanged loops.
    for (let i = 0; i < 8 && p().y < c.y - 0.5; i++) await delay(1_000);
    for (let i = 0; i < 4 && p().y < c.y - 0.5; i++) {
      const r = await app.registry.run('goTo', { x: c.x - 3, y: c.y, z: c.z, range: 1 }).catch(e => e);
      if (r?.ok === false || r?.name) log(`E2E DBG S1 climb ${JSON.stringify(r?.error ?? r)}`);
      await delay(1_000);
    }
    assert.ok(p().y >= c.y - 0.5, 'she exits the pit');
  }

  // S2: the owner hits her; hurt is attributed, never retaliated.
  stage('S2');
  {
    flatten();
    const mark = body('hurt').length;
    ownerTp(f().offset(2, 0, 0));
    await delay(500);
    const ownerBot = owner.players?.[botName]?.entity
      ?? Object.values(owner.entities ?? {}).find(e => e?.name === botName || e?.username === botName);
    try { await owner.attack(ownerBot); } catch {}
    await wait('S2 hurt', () => body('hurt').slice(mark).some(e => e.payload?.by === 'owner'), 15_000);
    const attacked = primitives().filter(r => r.payload?.name === 'attack'
      && [ownerName, 'player'].includes(r.payload?.params?.entityName));
    assert.equal(attacked.length, 0, 'no retaliation against the owner');
  }

  // S3: sand dropped on her head — suffocation reflex digs her out.
  stage('S3');
  {
    flatten();
    const c = f();
    const head = { x: c.x, y: c.y + 1, z: c.z };
    command(`setblock ${head.x} ${head.y + 1} ${head.z} sand`);
    await wait('S3 escaped sand', () => !['sand'].includes(at(head)) && !['sand'].includes(at({ ...head, y: head.y + 1 })), 30_000);
  }

  // S4: a fence box only gets the spoken trapped fact; a dirt box gets dug out.
  stage('S4');
  {
    flatten();
    const c = f();
    // Undiggable floor and apron: with dirt under her the pathfinder simply
    // tunnels under the fence and the box was never artificial.
    command(`fill ${c.x - 2} ${c.y - 1} ${c.z - 2} ${c.x + 4} ${c.y - 1} ${c.z + 2} stone_bricks`);
    command(`fill ${c.x - 1} ${c.y} ${c.z - 1} ${c.x + 1} ${c.y + 2} ${c.z + 1} oak_fence`);
    command(`fill ${c.x} ${c.y} ${c.z} ${c.x} ${c.y + 2} ${c.z} air`);
    // Wait for the box to actually reach her client before she walks,
    // otherwise she slips through the still-open gap.
    const wallDone = () => [[-1, 0], [1, 0], [0, -1], [0, 1]]
      .every(([dx, dz]) => at({ x: c.x + dx, y: c.y, z: c.z + dz }) === 'oak_fence');
    await wait('S4 walls up', wallDone, 15_000);
    await wait('S4 interior air', () => at(c) === 'air' && at({ ...c, y: c.y + 1 }) === 'air', 15_000);
    command(`tp ${botName} ${c.x + 0.5} ${c.y} ${c.z + 0.5}`);
    await wait('S4 inside box', () => {
      const q = p().floored();
      return q.x === c.x && q.y === c.y && q.z === c.z && at(c) === 'air';
    }, 10_000);
    // follow stays pending (it re-goals the pathfinder forever), so a
    // stationary owner outside the box keeps `moving` true for the watchdog;
    // goto() itself resolves on stray goal_reached and cannot do this.
    ownerTp({ x: c.x + 4, y: c.y, z: c.z });
    const keepWalking = app.registry.run('follow', { range: 1 }).catch(() => null);
    // Fills reach her client late — if she slipped out or got tp'd into a
    // wall, keep re-seating her at the interior until the eval fires.
    const inside = () => {
      const q = p().floored();
      return q.x === c.x && q.y === c.y && q.z === c.z;
    };
    const reseat = setInterval(() => {
      if (!inside() && !body('trapped').length) {
        command(`tp ${botName} ${c.x + 0.5} ${c.y} ${c.z + 0.5}`);
      }
    }, 800);
    try {
      await wait('S4 trapped say', () => body('trapped').length > 0
        || primitives().some(r => r.payload?.name === 'say'
          && r.payload?.params?.text?.includes('围')), 90_000).catch(() => null);
    } finally { clearInterval(reseat); }
    assert.ok(body('trapped').some(e => e.payload?.kind === 'artificial')
      || primitives().some(r => r.payload?.name === 'say' && r.payload?.params?.text?.includes('围')),
      'artificial enclosure reported');
    for (let x = -1; x <= 1; x += 2) for (let z = -1; z <= 1; z++) {
      assert.equal(at({ x: c.x + x, y: c.y, z: c.z + z }), 'oak_fence', `fence ${x},${z} must stand`);
    }
    // Now swap to dirt: the same enclosure becomes diggable.
    command(`fill ${c.x - 1} ${c.y} ${c.z - 1} ${c.x + 1} ${c.y + 2} ${c.z + 1} dirt`);
    command(`fill ${c.x} ${c.y} ${c.z} ${c.x} ${c.y + 2} ${c.z} air`);
    await wait('S4 dirt walls', () => [[-1, 0], [1, 0], [0, -1], [0, 1]]
      .every(([dx, dz]) => at({ x: c.x + dx, y: c.y, z: c.z + dz }) === 'dirt'), 15_000);
    await wait('S4 interior air 2', () => at(c) === 'air' && at({ ...c, y: c.y + 1 }) === 'air', 15_000);
    command(`tp ${botName} ${c.x + 0.5} ${c.y} ${c.z + 0.5}`);
    await delay(300);
    // The same follow keeps `moving` true; the trap eval digs her way out.
    const out = () => Math.abs(p().x - c.x) >= 2 || Math.abs(p().z - c.z) >= 2;
    await wait('S4 freed', () => out() || body('freed').length > 0, 60_000);
    assert.ok(body('freed').length > 0 || out());
    // Park the owner out of view so the 10-minute follow ends before S5.
    command(`tp ${ownerName} ${c.x + 200.5} ${c.y} ${c.z + 200.5}`);
    await keepWalking;
  }

  // S5: a stone block next to lava is rejected before bot.dig; a clean one digs.
  stage('S5');
  {
    flatten();
    const c = f();
    command(`setblock ${c.x + 2} ${c.y} ${c.z} stone`);
    command(`setblock ${c.x + 2} ${c.y} ${c.z + 1} lava`);
    await delay(300);
    assert.throws(
      () => app.registry.validate('dig', { x: c.x + 2, y: c.y, z: c.z }),
      /liquid_adjacent/);
    command(`setblock ${c.x + 2} ${c.y} ${c.z + 1} stone`);
    await delay(300);
    const dug = await app.registry.run('dig', { x: c.x + 2, y: c.y, z: c.z });
    assert.ok(dug.ok !== false, 'clean stone digs');
  }

  // S6: the owner takes furnace output mid-smelt; taken is reported honestly.
  stage('S6');
  {
    flatten();
    const c = f();
    // A hopper under the furnace sucks the output slot on real inventory
    // transactions — visible to her window via set_slot — unlike /item replace
    // (silent) or a second viewer (desyncs her window).
    command(`setblock ${c.x + 1} ${c.y - 1} ${c.z} hopper`);
    command(`setblock ${c.x + 1} ${c.y} ${c.z} furnace`);
    command(`give ${botName} raw_iron 5`);
    command(`give ${botName} coal 1`);
    ownerTp({ x: c.x + 1, y: c.y, z: c.z + 1 });
    await delay(400);
    log(`E2E DBG inv ${bot().inventory.items().map(i => `${i.name}x${i.count}`).join(',')}`);
    const rawSlots = [];
    const onWin = (...args) => { const p = args; if (rawSlots.length < 60) rawSlots.push([p[0]?.name, p[1]?.name]); };
    bot().on('setSlot:1', onWin);
    const smelt = app.registry.run('smelt', { itemName: 'raw_iron', count: 5, fuel: 'coal' });
    const result = await smelt;
    bot().off('setSlot:1', onWin);
    await delay(400);
    if (result.ok === false) {
      log(`E2E DBG smelt err ${JSON.stringify(result.error ?? result)}`);
      log(`E2E DBG slots ${JSON.stringify(rawSlots.slice(0, 40))}`);
      log(`E2E DBG inv2 ${bot().inventory.items().map(i => `${i.name}x${i.count}`).join(',')}`);
    }
    assert.ok(result.ok !== false, 'smelt finished');
    assert.ok((result.result?.taken ?? 0) >= 1, `hopper stole output (taken=${result.result?.taken})`);
    assert.ok(body('items_taken').some(e => e.payload?.where === 'furnace' && e.payload?.item === 'iron_ingot'));
  }

  // S7: the owner grabs her drops first; a giveToOwner goal still counts them.
  stage('S7');
  {
    flatten();
    const c = f();
    command(`clear ${botName} dirt`);
    await wait('S7 dirt cleared', () => !bot().inventory.items().some(i => i.name === 'dirt'), 5_000);
    // Loose drops ahead of her so the goal's first step is collectDrops —
    // the steal only counts while that primitive's listener is attached.
    // Three drops for a two-dirt goal: any split of steals and pickups still
    // reaches the count, and at least one steal lands in her listener window.
    command(`summon item ${c.x + 4.5} ${c.y} ${c.z + 0.5} {Item:{id:"minecraft:dirt",Count:1b},PickupDelay:0s}`);
    command(`summon item ${c.x + 6.5} ${c.y} ${c.z + 0.5} {Item:{id:"minecraft:dirt",Count:1b},PickupDelay:0s}`);
    command(`summon item ${c.x + 8.5} ${c.y} ${c.z + 0.5} {Item:{id:"minecraft:dirt",Count:1b},PickupDelay:0s}`);
    ownerTp({ x: c.x + 12, y: c.y, z: c.z });
    const goal = app.goals.obtain({ item: 'dirt', count: 2, giveToOwner: true });
    // The owner snipes dirt drops only while her collectDrops primitive is
    // running — earlier pickups land before its listener attaches.
    const collecting = () => {
      const s = events('primitive.start').filter(e => e.payload?.name === 'collectDrops').at(-1);
      const d = events('primitive.end').filter(e => e.payload?.name === 'collectDrops').at(-1);
      return Boolean(s && (!d || d.id < s.id));
    };
    let stolen = 0;
    const pin = setInterval(() => {
      if (stolen >= 2 || !collecting()) return;
      for (const e of Object.values(owner.entities ?? {})) {
        try {
          const item = e?.getDroppedItem?.();
          // He snipes the drop she is walking to — guaranteed tracked by her
          // collectDrops run, so the pickup lands inside its listener window.
          if (item?.name === 'dirt' && e.position.distanceTo(bot().entity.position) < 5) {
            command(`data merge entity ${e.uuid} {PickupDelay:0s}`);
            command(`tp ${ownerName} ${e.position.x} ${e.position.y} ${e.position.z}`);
            stolen++;
          }
        } catch {}
      }
    }, 100);
    const result = await goal.done;
    clearInterval(pin);
    assert.equal(result.status, 'succeeded', JSON.stringify(result));
    assert.ok(body('items_taken').some(e => e.payload?.where === 'drops' && e.payload?.item === 'dirt'));
  }

  // S8: a boat floating over magma — she dismounts rather than ride it out.
  stage('S8');
  {
    flatten();
    const c = f();
    command(`setblock ${c.x + 2} ${c.y - 2} ${c.z} magma_block`);
    command(`setblock ${c.x + 2} ${c.y - 1} ${c.z} water`);
    command(`summon boat ${c.x + 2.5} ${c.y} ${c.z + 0.5}`);
    await delay(600);
    // Vanilla /ride exists since 1.19.4; if Purpur ever lacks it the probe
    // prints the server error and we skip rather than fake it.
    const probe = `ride ${botName} mount @e[type=boat,limit=1,sort=nearest]`;
    command(probe);
    // bot.vehicle goes stale on detach (mineflayer only updates when she is
    // IN the new passenger list) — track the real attachment from packets.
    let ridingId = null;
    const sp = p => {
      ridingId = p.passengers.includes(bot().entity.id) ? p.entityId : ridingId === p.entityId ? null : ridingId;
    };
    bot()._client.on('set_passengers', sp);
    try {
      await wait('S8 mounted', () => ridingId !== null, 5_000);
    } catch {}
    const riding = () => ridingId !== null;
    if (!riding()) {
      log('E2E EDGES S8 SKIP: /ride unavailable on this server');
    } else {
      await wait('S8 dismounted', () => ridingId === null, 20_000);
    }
    bot()._client.off('set_passengers', sp);
  }

  // S9: a NoAI enderman is never attacked; bad_omen + milk gets drunk.
  stage('S9');
  {
    flatten();
    const c = f();
    // Peaceful difficulty removes the enderman on summon; keep natural
    // spawning off and only lift the difficulty for this check.
    command('difficulty normal');
    command('gamerule doMobSpawning false');
    command(`execute at ${botName} run summon minecraft:enderman ~ ~ ~ {NoAI:1b,PersistenceRequired:1b}`);
    await delay(1_500);
    // attack('enderman') is rejected at submission — she never targets it.
    let rejected = null;
    try { await app.registry.run('attack', { entityName: 'enderman' }); } catch (e) { rejected = e; }
    assert.match(String(rejected?.message ?? ''), /not allowed/i);
    // The server logs "Summoned new Enderman" but the entity is removed within
    // ~1 s on this Purpur build (data get finds none) — never reaches either
    // client. The safety check below only needs the submission rejection.
    const endermanAlive = Object.values(bot().entities ?? {}).some(e => e?.name === 'enderman');
    if (!endermanAlive) log('E2E EDGES S9 note: enderman spawn did not persist on the server');
    command(`effect give ${botName} bad_omen 60`);
    command(`give ${botName} milk_bucket 1`);
    const badId = mcData.effectsByName?.BadOmen?.id ?? 30;
    await wait('S9 bad_omen applied', () => bot().entity?.effects?.[badId], 10_000);
    await wait('S9 milk drunk', () => !bot().entity?.effects?.[badId]
      && !bot().inventory.items().some(i => i.name === 'milk_bucket')
      && bot().inventory.items().some(i => i.name === 'bucket'), 30_000);
    command(`kill @e[type=enderman]`);
    command('difficulty peaceful');
  }

  // S10: a plank wall between her and the target — she goes around or gives up,
  // never chews through it.
  stage('S10');
  {
    flatten(10);
    const c = f();
    command(`fill ${c.x + 3} ${c.y} ${c.z - 3} ${c.x + 3} ${c.y + 2} ${c.z + 3} oak_planks`);
    const wall = [];
    for (let y = 0; y <= 2; y++) for (let z = -3; z <= 3; z++) wall.push({ x: c.x + 3, y: c.y + y, z: c.z + z });
    const walk = await app.registry.run('goTo', { x: c.x + 6, y: c.y, z: c.z, range: 1 });
    for (const q of wall) if (at(q) !== 'oak_planks') log(`E2E DBG wall ${JSON.stringify(q)} is ${at(q)}`);
    assert.ok(wall.every(q => at(q) === 'oak_planks'), 'plank wall intact');
    if (walk.ok) {
      assert.ok(p().distanceTo(new Vec3(c.x + 6.5, c.y, c.z + 0.5)) < 3, 'routed around');
      log('E2E EDGES S10 routed around the wall');
    } else {
      log('E2E EDGES S10 no path — wall respected');
    }
  }

  // S11: >32 blocks from the world origin a draft's `at` binding and `$id.x`
  // coordinate refs still learn (deferAmbit — placeholders cannot be judged
  // statically), while literal coordinates still hit the ambit check. The
  // learned skill then executes for real at the far position: findBlock binds
  // a genuine coordinate and goTo/dig run against it.
  stage('S11');
  {
    const teacher = owner.players?.[ownerName]?.uuid ?? 'e2e-owner';
    command(`tp ${botName} 64.5 -60 0.5`);
    await delay(800);
    flatten(8);
    const c = f();
    assert.ok(Math.hypot(p().x, p().z) > 32, `bot ${JSON.stringify(p())} must sit >32 blocks from the origin`);
    command(`setblock ${c.x + 4} ${c.y} ${c.z} coarse_dirt`);
    await wait('S11 marker placed', () => at({ x: c.x + 4, y: c.y, z: c.z }) === 'coarse_dirt', 10_000);

    assert.throws(
      () => app.library.learn({ name: 'edge_dig_literal', body: [{ primitive: 'dig', params: { x: 0, y: -60, z: 0 } }] },
        { teacherUuid: teacher, context: 'e2e-edges' }),
      /ambit/,
      'literal far coordinates still fail the draft-time ambit check');

    const learned = app.library.learn({
      name: 'edge_dig_marked',
      description: 'find the marked block and dig it',
      params: {},
      body: [
        { primitive: 'findBlock', params: { blockName: 'coarse_dirt', maxDistance: 16 }, id: 'b' },
        { primitive: 'goTo', params: { x: '$b.x', y: '$b.y', z: '$b.z', range: 1.5 } },
        { primitive: 'dig', params: {}, at: '$b' },
      ],
    }, { teacherUuid: teacher, context: 'e2e-edges' });
    assert.ok(learned?.skill?.name === 'edge_dig_marked', 'at-bound draft learns >32 blocks from the origin');

    const result = await runSkill({ library: app.library, arbiter: app.arbiter, name: 'edge_dig_marked', source: 'owner' });
    if (result.ok === false || at({ x: c.x + 4, y: c.y, z: c.z }) === 'coarse_dirt') {
      for (const row of events('primitive.end').slice(-6)) log(`E2E DBG S11 pend ${JSON.stringify(row.payload).slice(0, 220)}`);
      for (const row of events('survival.action').slice(-6)) log(`E2E DBG S11 sact ${JSON.stringify(row.payload).slice(0, 160)}`);
      log(`E2E DBG S11 pos ${JSON.stringify(p())} marker=${at({ x: c.x + 4, y: c.y, z: c.z })}`);
    }
    assert.ok(result.ok !== false, `learned skill executes: ${JSON.stringify(result?.outcome ?? result)}`);
    await wait('S11 marker dug', () => at({ x: c.x + 4, y: c.y, z: c.z }) !== 'coarse_dirt', 10_000);
  }

  log('E2E EDGES PASS');
}
