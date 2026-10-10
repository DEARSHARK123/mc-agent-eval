import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3');

export function stanceEnvironment(env, log = console.log) {
  if (env.E2E_STANCE !== '1') { log('E2E STANCE SKIP: set E2E_STANCE=1'); return false; }
  return true;
}

// Three independent stance sub-scenarios (T28 §7). Runs without a brain, so
// every decision lands on the deterministic default table — assertions check
// the default output, not a model's pick.
export async function runStanceScenario({ app, owner, command, delay, server, botName = 'Companion',
  ownerName = 'TestOwner', log = console.log }) {
  const bot = () => app.bot;
  const p = () => bot().entity.position;
  const f = () => p().floored();
  const events = kind => app.eventlog.query({ kind, limit: Number.MAX_SAFE_INTEGER });
  const sets = () => events('stance.set');
  const wait = async (label, predicate, ms = 30_000) => {
    const end = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() >= end) {
        for (const row of events('stance.set').slice(-6)) log(`E2E DBG stance.set ${JSON.stringify(row.payload)}`);
        for (const row of events('stance.expired').slice(-4)) log(`E2E DBG stance.expired ${JSON.stringify(row.payload)}`);
        for (const row of events('stance.deviation').slice(-4)) log(`E2E DBG stance.deviation ${JSON.stringify(row.payload)}`);
        for (const row of events('stance.error').slice(-4)) log(`E2E DBG stance.error ${JSON.stringify(row.payload)}`);
        for (const row of events('survival.action').slice(-8)) log(`E2E DBG sact ${JSON.stringify(row.payload).slice(0, 200)}`);
        for (const row of events('body.hurt').slice(-4)) log(`E2E DBG hurt ${JSON.stringify(row.payload)}`);
        for (const row of events('body.ground_lost').slice(-4)) log(`E2E DBG lost ${JSON.stringify(row.payload)}`);
        for (const row of events('body.items_taken').slice(-6)) log(`E2E DBG taken ${JSON.stringify(row.payload)}`);
        for (const row of events('chat').slice(-6)) log(`E2E DBG chat ${JSON.stringify(row.payload)}`);
        for (const row of events('primitive.end').slice(-6)) log(`E2E DBG pend ${JSON.stringify(row.payload).slice(0, 200)}`);
        throw new Error(`${label}: timed out (Companion at ${JSON.stringify(p())})`);
      }
      await delay(150);
    }
  };
  const stage = tag => log(`E2E STANCE ${tag} at ${JSON.stringify(p())}`);
  const ownerTp = q => command(`tp ${ownerName} ${q.x + 0.5} ${q.y} ${q.z + 0.5}`);
  const tp = q => command(`tp ${botName} ${q.x + 0.5} ${q.y} ${q.z + 0.5}`);
  const flatten = (r = 8) => {
    const c = f();
    command(`fill ${c.x - r} ${c.y - 1} ${c.z - r} ${c.x + r} ${c.y - 1} ${c.z + r} grass_block`);
    command(`fill ${c.x - r} ${c.y} ${c.z - r} ${c.x + r} ${c.y + 6} ${c.z + r} air`);
  };

  command(`gamemode creative ${ownerName}`);
  command('difficulty peaceful');
  command('gamerule doMobSpawning false');
  command(`clear ${botName}`);

  // A) night_pressure: a zombie parked inside the bed's sleep-blocking box but
  // beyond her 12-block engage range keeps her awake. ~90 s later the trigger
  // fires; with no hut the default is stay_with_owner. Clear it and she sleeps.
  stage('A night_pressure');
  {
    flatten(10);
    const c = f();
    command(`give ${botName} iron_sword 1`);
    command(`setblock ${c.x + 6} ${c.y} ${c.z} red_bed[facing=east,part=foot]`);
    command(`setblock ${c.x + 7} ${c.y} ${c.z} red_bed[facing=east,part=head]`);
    // The zombie must be visible to her client before night falls — otherwise
    // the first night tick submits sleep in the spawn-packet gap.
    command('difficulty normal');
    command(`summon zombie ${c.x + 13.5} ${c.y} ${c.z + 0.5} {NoAI:1b,PersistenceRequired:1b}`);
    await wait('A zombie visible',
      () => Object.values(bot().entities ?? {}).some(e => e?.name === 'zombie'), 10_000);
    await delay(500);
    command('time set night');
    await wait('A stance.set night_pressure',
      () => sets().some(row => row.payload?.trigger === 'night_pressure'), 130_000);
    const set = sets().filter(row => row.payload?.trigger === 'night_pressure').at(-1);
    assert.equal(set.payload.name, 'stay_with_owner', 'no hut -> default table keeps her with him');
    command(`kill @e[type=zombie,distance=..40]`);
    await wait('A sleeps after the guard is gone',
      () => bot().isSleeping === true || events('survival.action').some(row => row.payload?.kind === 'sleep'), 45_000);
    command('time set day');
    command('difficulty peaceful');
  }

  // B) owner_tease: he digs the ground under her twice and hits her — the
  // deterministic default answers resume; she must never retaliate.
  stage('B owner_tease');
  {
    flatten(8);
    const c = f();
    const mark = sets().length;
    // A three-deep dirt column under her cell: two digs, two ground_lost.
    command(`fill ${c.x + 2} ${c.y - 4} ${c.z} ${c.x + 2} ${c.y - 1} ${c.z} dirt`);
    ownerTp({ x: c.x + 4, y: c.y, z: c.z });
    tp({ x: c.x + 2, y: c.y, z: c.z });
    await delay(600);
    for (let i = 0; i < 2; i++) {
      const under = p().floored().offset(0, -1, 0);
      try { await owner.dig(owner.blockAt(under)); }
      catch { command(`setblock ${under.x} ${under.y} ${under.z} air`); }
      await delay(700);
    }
    const ownerBot = owner.players?.[botName]?.entity
      ?? Object.values(owner.entities ?? {}).find(e => e?.name === botName || e?.username === botName);
    try { await owner.attack(ownerBot); } catch {}
    await wait('B stance.set owner_tease',
      () => sets().slice(mark).some(row => row.payload?.trigger === 'owner_tease'), 20_000);
    const set = sets().slice(mark).find(row => row.payload?.trigger === 'owner_tease');
    assert.equal(set.payload.name, 'resume', 'default table only states facts');
    await wait('B stance line spoken',
      () => events('say').some(row => row.payload?.kind === 'stance'), 15_000);
    const attacked = events('primitive.end').filter(row => row.payload?.name === 'attack'
      && [ownerName, 'player'].includes(row.payload?.params?.entityName));
    assert.equal(attacked.length, 0, 'she never retaliates');
  }

  // C) items_taken: a hopper steals the furnace output twice. Default table:
  // first a redo (no stored goal -> honest no-op), then ask_owner; his reply is logged.
  stage('C items_taken');
  {
    // Fresh ground: stage B left her in the dug-out column. +2 y drops her
    // onto the flat-world surface instead of into it.
    const here = f();
    tp({ x: here.x - 12, y: here.y + 2, z: here.z });
    await delay(800);
    flatten(8);
    const c = f();
    command(`setblock ${c.x + 1} ${c.y - 1} ${c.z} hopper`);
    command(`setblock ${c.x + 1} ${c.y} ${c.z} furnace`);
    command(`give ${botName} raw_iron 3`);
    command(`give ${botName} coal 1`);
    const furnaceAt = new Vec3(c.x + 1, c.y, c.z);
    // smelt searches her loaded chunks — wait until the furnace is real to her.
    const furnaceVisible = () => wait('C furnace visible',
      () => bot().blockAt?.(furnaceAt)?.name === 'furnace', 10_000);
    const count = name => bot().inventory.items().filter(i => i.name === name)
      .reduce((n, i) => n + i.count, 0);
    await furnaceVisible();
    // The gives ride async packets too; smelt stalls on an empty fuel slot.
    await wait('C stock loaded', () => count('raw_iron') >= 3 && count('coal') >= 1, 10_000);
    // The window sync can eat the fuel placement on a busy server (seen once
    // on this Purpur build) — retry a stalled/desynced smelt once.
    const smelt = async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        // A retry after a partial run uses whatever raw_iron is left — a
        // single cook is enough to keep the take-fires coming.
        const want = attempt === 1 ? 3 : Math.min(3, count('raw_iron'));
        if (want < 1) return { ok: false, error: { message: 'no raw_iron left' } };
        const result = await app.registry.run('smelt', { itemName: 'raw_iron', count: want, fuel: 'coal' })
          .then(r => r).catch(error => ({ ok: false, error: { message: error?.message ?? String(error) } }));
        if (result?.ok !== false) return result;
        log(`E2E STANCE C smelt attempt ${attempt} failed: ${JSON.stringify(result?.error ?? result)}`);
        if (!['smelt_stalled', 'container_desync'].includes(result?.error?.code)
            && !/smelt_stalled|desync/i.test(result?.error?.message ?? '')) return result;
        await delay(500);
      }
      return { ok: false, error: { message: 'smelt failed twice' } };
    };
    const mark = sets().length;
    const takenMark = events('body.items_taken').length;
    const run = smelt();
    // Take #1 fires the default redo; take #2 (same smelt run, ~10 s later and
    // past the lowered cooldown) fires ask_owner.
    await wait('C stance.set redo',
      () => sets().slice(mark).some(row => row.payload?.trigger === 'items_taken'), 90_000);
    const firstSet = sets().slice(mark).find(row => row.payload?.trigger === 'items_taken');
    assert.equal(firstSet.payload.name, 'redo', 'first take defaults to redo');
    await wait('C stance.set ask_owner',
      () => sets().slice(mark).some(row => row.payload?.trigger === 'items_taken'
        && row.payload?.name === 'ask_owner'), 90_000);
    // Her question only listens for waitSec — answer straight away.
    owner.chat('没关系，是我拿的');
    await wait('C stance.owner_replied',
      () => events('stance.owner_replied').length >= 1, 30_000);
    const smeltResult = await run;
    log(`E2E STANCE C smelt ${JSON.stringify(smeltResult?.result ?? smeltResult?.error ?? smeltResult)}`);
    assert.ok(smeltResult?.ok !== false, `smelt ran: ${JSON.stringify(smeltResult?.error ?? '')}`);
    assert.ok(events('body.items_taken').length - takenMark >= 2, 'the hopper stole twice');
    command(`setblock ${c.x + 1} ${c.y} ${c.z} air`);
    command(`setblock ${c.x + 1} ${c.y - 1} ${c.z} stone`);
  }

  command('time set day');
  command('difficulty peaceful');
  command(`clear ${botName}`);
  flatten(8);
  log('E2E STANCE PASS');
}
