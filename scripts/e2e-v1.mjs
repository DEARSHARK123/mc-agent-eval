import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { BLUEPRINTS, blueprintGeometry } from '../src/build/blueprints.js';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3');
const mcData = require('minecraft-data')('1.20.4');

export function v1Environment(env, log = console.log) {
  if (env.E2E_V1 !== '1') { log('E2E V1 SKIP: set E2E_V1=1'); return false; }
  return true;
}

const MARKERS = /(?:white|light_blue|yellow|lime|pink|orange)_stained_glass/;

export async function runV1Scenario({ app: initialApp, owner, command, delay, server, botName = 'Companion',
  ownerName = 'TestOwner', restart, log = console.log }) {
  let app = initialApp;
  const bot = () => app.bot;
  const count = name => bot().inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
  const held = () => bot().heldItem?.name ?? null;
  const ownerCount = name => owner.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
  const events = kind => app.eventlog.query({ kind, limit: Number.MAX_SAFE_INTEGER });
  const sayOf = (kind, after = 0) => events('say').find(row => row.id > after && row.payload?.kind === kind);
  const maxId = rows => rows.reduce((latest, row) => Math.max(latest, row.id ?? 0), 0);
  let speechSeen = 0;
  const flushSpeech = () => {
    for (const row of events('speech')) {
      if (row.id > speechSeen) { speechSeen = row.id; log(`Companion: ${row.payload?.text ?? ''}`); }
    }
  };
  const at = ({ x, y, z }) => bot().blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))?.name ?? 'unknown';
  const mobs = name => Object.values(bot().entities ?? {}).filter(e => e?.name === name && e.isValid !== false);
  const ownerCommands = [];
  const serverTail = [];
  server.stdout.on('data', chunk => {
    for (const line of String(chunk).split(/\r?\n/u)) {
      serverTail.push(line);
      if (serverTail.length > 300) serverTail.shift();
      if (line.includes(`${botName} issued server command:`)) ownerCommands.push(line);
    }
  });
  const serverProbe = async () => {
    const mark = serverTail.length;
    command('data get entity @e[type=minecraft:villager,limit=1] Health');
    await delay(1_500);
    return serverTail.slice(mark, mark + 12);
  };
  const villagerSeen = () => Boolean(Object.values(bot().entities ?? {}).find(e => e?.name === 'villager'));
  const mark = tag => log(`E2E V1 mark ${tag} villager=${villagerSeen()}`);
  let step = 'setup';
  const fail = message => { throw new Error(`${message} (Companion at ${JSON.stringify(bot().entity?.position)})`); };
  const wait = async (label, predicate, ms = 30_000) => {
    const end = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() >= end) {
        for (const row of events('primitive.end').filter(r => !r.payload?.ok || r.payload?.name === 'findBlock').slice(-12)) {
          log(`E2E V1 trace ${JSON.stringify(row.payload).slice(0, 300)}`);
        }
        for (const row of events('intent.step').slice(-10)) {
          log(`E2E V1 step ${JSON.stringify(row.payload).slice(0, 300)}`);
        }
        fail(`${label}: timed out`);
      }
      await delay(200);
    }
  };
  const waitFor = async (label, kind, after, ms = 60_000) => {
    await wait(label, () => sayOf(kind, after), ms);
    return sayOf(kind, after);
  };

  let houseCells = [];
  try {
    command(`gamemode creative ${ownerName}`);
    // Daylight stays frozen until S4 sets night itself; otherwise a natural
    // nightfall mid-toolset spawns hostiles whose survival reflex legitimately
    // preempts the goal and flakes the scenario.
    command('gamerule doDaylightCycle false');
    command('time set day');
    // The test world persists between runs: clear leftover mobs and drops from
    // earlier runs before the fixture lays out the field.
    command('kill @e[type=!player]');
    const base = bot().entity.position.floored();
    // Dirt underlay, not stone: she must never dig the floor (the holes descend
    // towards minY/void and trip escape_hazard). Cobblestone comes from a
    // surface blob outside the protected zone instead.
    command(`fill ${base.x - 20} ${base.y - 4} ${base.z - 20} ${base.x + 20} ${base.y - 2} ${base.z + 20} dirt`);
    command(`fill ${base.x - 20} ${base.y - 1} ${base.z - 20} ${base.x + 20} ${base.y - 1} ${base.z + 20} grass_block`);
    command(`fill ${base.x - 20} ${base.y} ${base.z - 20} ${base.x + 20} ${base.y + 8} ${base.z + 20} air`);
    // Generous margin: S2 and the S6 replay each mine ~8 cobblestone, drops can
    // scatter out of reach, and every toolset craft retries against real stock.
    command(`fill ${base.x - 16} ${base.y} ${base.z + 12} ${base.x - 11} ${base.y + 1} ${base.z + 17} stone`);
    // A nearer patch too: the collect intent only searches 32 blocks and a few
    // unlucky random walks leave the far blob out of reach.
    command(`fill ${base.x - 10} ${base.y} ${base.z + 8} ${base.x - 7} ${base.y + 1} ${base.z + 11} stone`);
    // Four natural-looking trees: leaves placed first so the log columns sit inside.
    for (const [tx, tz] of [[-16, -16], [-16, 16], [16, -16], [16, 16], [-16, 0], [0, 16]]) {
      command(`fill ${base.x + tx - 1} ${base.y + 3} ${base.z + tz - 1} ${base.x + tx + 1} ${base.y + 5} ${base.z + tz + 1} oak_leaves`);
      command(`fill ${base.x + tx} ${base.y} ${base.z + tz} ${base.x + tx} ${base.y + 5} ${base.z + tz} oak_log`);
    }
    // Chest sits well outside the protect_here radius (12 from the house
    // centre at base+7.5,-4.5): findBlock filters protected blocks, so a
    // chest inside the zone would be invisible to deposit.
    command(`setblock ${base.x - 6} ${base.y} ${base.z + 6} chest`);
    // The owner's log house: oak_log walls, glass roof, no leaves anywhere near.
    const hx = base.x + 6, hy = base.y, hz = base.z - 6;
    command(`fill ${hx} ${hy} ${hz} ${hx + 2} ${hy + 2} ${hz + 2} oak_log hollow`);
    command(`fill ${hx} ${hy + 2} ${hz} ${hx + 2} ${hy + 2} ${hz + 2} glass`);
    command(`setblock ${hx + 1} ${hy} ${hz} air`);
    for (let dx = 0; dx <= 2; dx++) for (let dy = 0; dy <= 2; dy++) for (let dz = 0; dz <= 2; dz++) {
      houseCells.push({ x: hx + dx, y: hy + dy, z: hz + dz });
    }
    const houseSnapshot = () => houseCells.map(pos => at(pos));
    // Wait until the fill reaches the client instead of a fixed delay — a
    // lagging server can leave the baseline reading all air for seconds.
    const houseExpected = houseCells.map(pos => {
      if (pos.y === hy + 2) return 'glass';
      if (pos.x === hx + 1 && pos.y === hy + 1 && pos.z === hz + 1) return 'air';
      if (pos.x === hx + 1 && pos.y === hy && pos.z === hz) return 'air';
      return 'oak_log';
    });
    await wait('house visible', () =>
      houseSnapshot().every((name, i) => name === houseExpected[i]), 30_000);
    const houseBefore = houseSnapshot();
    // Invulnerable: night-spawned mobs during S4 would hunt a defenceless NoAI
    // villager; the audit only needs it alive and never attacked by her.
    const summonMark = serverTail.length;
    command(`summon villager ${base.x - 8} ${base.y} ${base.z - 8} {NoAI:1b,Invulnerable:1b,PersistenceRequired:1b}`);
    await delay(1_500);
    log(`E2E V1 probe summonOut ${JSON.stringify(serverTail.slice(summonMark, summonMark + 8))}`);
    const villager = () => mobs('villager')[0];
    const villagerHealth = villager()?.metadata?.[9];
    log(`E2E V1 probe villagerHealth=${villagerHealth}`);
    log(`E2E V1 probe summon ${JSON.stringify(await serverProbe())}`);
    command(`clear ${botName}`);
    command(`tp ${ownerName} ${hx + 1.5} ${hy} ${hz + 1.5}`);
    await delay(2_000);
    owner.chat('保护这里');
    const protectSay = await waitFor('protect_here', 'protected', maxId(events('say')));
    log(`E2E V1 setup protect say=${JSON.stringify(protectSay?.payload)}`);
    assert.equal(protectSay?.payload?.kind, 'protected', 'protect_here was not acknowledged');
    command(`tp ${ownerName} ${base.x + 3} ${base.y} ${base.z + 2}`);
    await delay(1_500);

    step = 'S1 wooden toolset';
    owner.chat('去弄点木头，做一套木制工具');
    await wait('wooden tools', () => ['wooden_pickaxe', 'wooden_axe', 'wooden_sword'].every(name => count(name) >= 1)
      && held() === 'wooden_pickaxe', 420_000);
    assert.deepEqual(houseSnapshot(), houseBefore, 'the protected house changed during S1');
    flushSpeech(); log('E2E V1 S1 PASS'); mark('S1');

    step = 'S2 stone toolset';
    owner.chat('换石头的');
    await wait('stone tools', () => ['stone_pickaxe', 'stone_axe', 'stone_sword'].every(name => count(name) >= 1)
      && held() === 'stone_pickaxe', 420_000);
    const stoneSkill = app.library.get('make_stone_tools');
    assert.ok(stoneSkill, 'make_stone_tools not learned');
    assert.equal(stoneSkill.provenance.at(-1).route, 'self');
    flushSpeech(); log('E2E V1 S2 PASS'); mark('S2');

    step = 'S3 give sticks';
    // Transient goal failure reasons worth re-asking about.
    const transient = ['craft_failed', 'give_failed', 'step_budget', 'preempted', 'cancelled', 'busy', 'attack_failed'];
    // Owner next to her: the give toss lands within pickup range instead of
    // scattering a few blocks off where a stationary owner never reaches it.
    command(`execute at ${botName} run tp ${ownerName} ~1 ~ ~`);
    await delay(1_000);
    const sticksBefore = ownerCount('stick');
    // S3 exercises obtain+give, not log pathing: with planks in stock the
    // plan is a pure craft, so a bad pathing streak can't burn the budget
    // before any stick exists.
    command(`give ${botName} oak_planks 8`);
    // Like e2e-primitives: a stationary owner cannot walk to a scattered toss,
    // so emulate a real player stepping onto the dropped stack until it is
    // gone. The owner re-asks on a transient goal failure (a bad pathing
    // streak can burn the step budget before any stick exists).
    let lastDropLog = 0;
    let stickGoalMark = maxId(events('goal.end'));
    for (let ask = 0; ask < 3 && ownerCount('stick') < sticksBefore + 8; ask++) {
      owner.chat('给我 8 个木棍');
      await wait('owner sticks', () => {
        const sticks = Object.values(bot().entities ?? {}).filter(e => e.isValid !== false
          && e.position && e.getDroppedItem?.()?.type === mcData.itemsByName.stick.id);
        if (sticks[0]) {
          // Emulate a player standing on the toss: pin him to the drop, then
          // lift its pickup delay — otherwise the 10-tick delay lets her
          // proactive pickup re-collect the stack before he touches it.
          command(`tp ${ownerName} ${sticks[0].position.x} ${sticks[0].position.y} ${sticks[0].position.z}`);
          command('execute as @e[type=item] run data merge entity @s {PickupDelay:0s}');
          if (Date.now() - lastDropLog > 4_000) {
            lastDropLog = Date.now();
            const she = bot().inventory.items().filter(i => i.name === 'stick').reduce((a, i) => a + i.count, 0);
            log(`E2E V1 S3 drops=${sticks.length} at=${JSON.stringify(sticks[0].position)} owner=${ownerCount('stick')} ownerAt=${JSON.stringify(owner.entity?.position)} she=${she}`);
          }
        } else {
          // Pin the owner onto her front so the next toss lands inside his
          // pickup radius before her own recovery can re-collect the stack.
          command(`execute at ${botName} run tp ${ownerName} ~0.6 ~ ~`);
        }
        return ownerCount('stick') >= sticksBefore + 8
          || events('goal.end').some(row => row.id > stickGoalMark);
      }, 300_000);
      if (ownerCount('stick') < sticksBefore + 8) {
        const last = events('goal.end').filter(row => row.id > stickGoalMark).at(-1);
        if (!last || !transient.includes(last.payload?.reason)) break;
        log(`E2E V1 S3 retry after goal failed: ${last.payload.reason}`);
        stickGoalMark = last.id;
      }
    }
    assert.ok(ownerCount('stick') >= sticksBefore + 8, 'owner never got 8 sticks after 3 requests');
    flushSpeech(); log('E2E V1 S3 PASS'); mark('S3');

    step = 'S5 store cobblestone';
    // Bring both back near the chest: the toolset goals wander her south after
    // logs and stone, stay_near pulls her toward the owner, and deposit only
    // searches 16 blocks from where she stands.
    command(`tp ${ownerName} ${base.x - 7.5} ${base.y} ${base.z + 5.5}`);
    // Leftover toss strays from S3 make proactive pickup drag her south right
    // as deposit searches; clear loose items and pin both by the chest.
    command('kill @e[type=item]');
    command(`tp ${botName} ${base.x - 5.5} ${base.y} ${base.z + 4.5}`);
    command(`give ${botName} cobblestone 16`);
    // The tp can outrun chunk delivery; deposit fails fast if findBlock still
    // sees air where the chest is.
    await wait('chest chunk loaded', () => at({ x: base.x - 6, y: base.y, z: base.z + 6 }) === 'chest', 15_000);
    await delay(500);
    // deposit fails fast with no_container if the search lands before her
    // tp is applied; re-pin and re-ask on that transient miss.
    let storeSay = null;
    for (let ask = 0; ask < 3; ask++) {
      const sayMark = maxId(events('say'));
      owner.chat('把圆石放进箱子');
      await wait('stored/store_failed', () => events('say').some(row => row.id > sayMark
        && ['stored', 'store_failed'].includes(row.payload?.kind)), 120_000);
      storeSay = events('say').find(row => row.id > sayMark
        && ['stored', 'store_failed'].includes(row.payload?.kind));
      if (storeSay?.payload?.kind === 'stored') break;
      command(`tp ${botName} ${base.x - 5.5} ${base.y} ${base.z + 4.5}`);
      await delay(800);
    }
    assert.equal(storeSay?.payload?.kind, 'stored', `store failed: ${JSON.stringify(storeSay?.payload)}`);
    command(`tp ${ownerName} ${base.x - 7.5} ${base.y} ${base.z + 5.5}`);
    await delay(500);
    const chest = await owner.openBlock(owner.blockAt(new Vec3(base.x - 6, base.y, base.z + 6)));
    const chestHas = chest.containerItems().some(item => item?.name === 'cobblestone');
    await chest.close();
    assert.ok(chestHas, 'the chest holds no cobblestone after store');
    flushSpeech(); log('E2E V1 S5 PASS'); mark('S5');

    step = 'S4 survival night';
    command('difficulty normal');
    command(`give ${botName} bread 4`);
    command(`effect give ${botName} minecraft:hunger 30 255 true`);
    await wait('urgent hunger', () => bot().food <= 6, 30_000);
    command(`effect clear ${botName} minecraft:hunger`);
    const foodBefore = bot().food;
    await wait('eat_urgent', () => bot().food > foodBefore
      && events('survival.action').some(row => row.payload?.kind === 'eat_urgent'), 30_000);
    command('time set night');
    const sayBeforeFight = maxId(events('say'));
    // Adjacent, not ~6 out: a distant zombie can path to the NoAI villager and
    // kill it before she engages, failing the S9 audit through no fault of hers.
    // Natural spawns stay ON for the whole stage (T26): owner work and night
    // sleeping must survive sustained hostile pressure via reflex + resume.
    const zombiesBefore = new Set(mobs('zombie').map(e => e.uuid));
    command(`execute at ${botName} run summon zombie ~1.5 ~ ~`);
    await delay(500);
    const summonedZombie = mobs('zombie').find(e => !zombiesBefore.has(e.uuid)
      && e.position?.distanceTo(bot().entity.position) < 5);
    await wait('zombie fought and dead', () =>
      events('survival.action').some(row => row.payload?.kind === 'fight')
      && (!summonedZombie || !mobs('zombie').some(e => e.uuid === summonedZombie.uuid)), 90_000);
    assert.ok(bot().health > 0, 'Companion died fighting the zombie');
    command(`effect give ${botName} minecraft:instant_health 1 4 true`);
    await wait('nightfall remark without bed', () =>
      events('speech').some(row => row.id > sayBeforeFight && row.payload?.text?.includes('没有床')), 30_000);
    // Fixed open spots: summoning relative to Companion can drop sheep inside a
    // wall or the mining hole, where they suffocate before she reaches them.
    for (const [sx, sz] of [[2, 10], [0, 11], [-2, 10]]) {
      command(`summon sheep ${base.x + sx} ${base.y} ${base.z + sz} {NoAI:1b}`);
    }
    await delay(1_000);
    // The owner re-asks on a transient goal failure (craft_rejected,
    // step_budget, preemption): a one-shot chat leaves no retry path and a
    // single window desync would sink the whole stage.
    let goalMark = maxId(events('goal.end'));
    let asks = 0;
    for (let ask = 0; ask < 3 && count('white_bed') < 1; ask++) {
      asks++;
      owner.chat('做一张床');
      await wait('bed in inventory', () => count('white_bed') >= 1
        || events('goal.end').some(row => row.id > goalMark
          && (row.payload?.status !== 'succeeded' || !transient.includes(row.payload?.reason))), 300_000)
        .catch(err => { if (count('white_bed') < 1) throw err; });
      if (count('white_bed') < 1) {
        const last = events('goal.end').filter(row => row.id > goalMark).at(-1);
        if (!last || !transient.includes(last.payload?.reason)) break;
        log(`E2E V1 S4 retry after goal failed: ${last.payload.reason}`);
        goalMark = last.id;
      }
    }
    log(`E2E V1 S4 asks=${asks} resumes=${events('goal.resume').length} suspends=${events('goal.suspended').length}`);
    assert.ok(count('white_bed') >= 1, 'white_bed never crafted after 3 requests');
    await wait('place_bed and asleep', () => bot().isSleeping
      && events('survival.action').some(row => row.payload?.kind === 'place_bed'), 120_000);
    command('time set day');
    command('difficulty peaceful');
    flushSpeech(); log('E2E V1 S4 PASS'); mark('S4');

    step = 'S8 build hut';
    // Full stock: gathering the shortfall via obtainInline is covered in unit
    // tests and the build scenario; here it is a needless flake surface (the
    // collect intent can exhaust its step budget on scattered remains).
    command(`give ${botName} oak_planks 64`);
    await delay(1_000);
    const buildStartBefore = maxId(events('build.start'));
    const sayBeforeBuild = maxId(events('say'));
    // Snapshot the zone now: a finished build registers its own own_build zone,
    // which would win .at(-1) and trivially contain every hut cell.
    const zone = events('protection.zone_added').at(-1)?.payload;
    owner.chat('给我们搭个小屋');
    await wait('build say', () =>
      events('say').some(row => row.id > sayBeforeBuild && ['build_done', 'build_failed'].includes(row.payload?.kind)), 480_000);
    const buildSay = events('say').find(row => row.id > sayBeforeBuild
      && ['build_done', 'build_failed'].includes(row.payload?.kind));
    assert.equal(buildSay?.payload?.kind, 'build_done', `build failed: ${JSON.stringify(buildSay?.payload)}`);
    const buildStart = events('build.start').filter(row => row.id > buildStartBefore).at(-1)?.payload;
    assert.ok(buildStart, 'no build.start event');
    for (const cell of blueprintGeometry(BLUEPRINTS.hut, { origin: buildStart.site, rotation: buildStart.rotation }).cells) {
      if (cell.role !== 'door') assert.equal(at(cell), 'oak_planks', `hut cell ${JSON.stringify(cell)} is ${at(cell)}`);
      if (zone) {
        const d = Math.hypot(cell.x - zone.x, cell.y - zone.y, cell.z - zone.z);
        assert.ok(d > zone.radius, `hut cell ${JSON.stringify(cell)} inside the protected zone`);
      }
    }
    assert.deepEqual(houseSnapshot(), houseBefore, 'the protected house changed during S8');
    flushSpeech(); log('E2E V1 S8 PASS'); mark('S8');

    step = 'S6 restart and reuse';
    const spendsBefore = events('budget.learning_spent').length;
    const selfLearnsBefore = events('skills.self_learned').length;
    app = await restart();
    // ready fires before the entity is spawned; give/clear on an offline Companion
    // are silent no-ops.
    await wait('respawned', () => Boolean(bot().entity?.position), 60_000);
    command(`clear ${botName} stone_pickaxe`);
    command(`clear ${botName} stone_axe`);
    command(`clear ${botName} stone_sword`);
    // The cobblestone blob is mostly mined by S1/S2/S5; top her up so the
    // replayed obtains exercise crafts rather than starving on raw stock.
    command(`give ${botName} cobblestone 16`);
    await wait('cobblestone restocked', () => count('cobblestone') >= 16, 15_000);
    const sayBeforeS6 = maxId(events('say'));
    owner.chat('换石头的');
    const s6Say = await waitFor('goal_done', 'goal_done', sayBeforeS6, 300_000);
    assert.ok(s6Say, 'no goal_done after 换石头的');
    // say events carry only {kind, usedBrain}; the self_learned provenance is
    // observable in the rendered speech ('自己学会的', vs '刚自己学会的' when new).
    const s6Speech = events('speech').filter(row => row.id > sayBeforeS6
      && row.payload?.text?.includes('石质工具')).at(-1)?.payload?.text;
    assert.ok(s6Speech?.includes('（自己学会的）'), `expected reused self-learned speech, got ${s6Speech}`);
    assert.equal(events('budget.learning_spent').length, spendsBefore, 'a budget unit was spent on a learned toolset');
    assert.equal(events('skills.self_learned').length, selfLearnsBefore, 'she re-learned the toolset instead of reusing it');
    await wait('stone tools back', () => ['stone_pickaxe', 'stone_axe', 'stone_sword'].every(name => count(name) >= 1), 300_000);
    flushSpeech(); log('E2E V1 S6 PASS'); mark('S6');

    step = 'S7 follow and pickup';
    command(`tp ${ownerName} ${base.x} ${base.y} ${base.z + 15}`);
    await wait('stay_near', () => bot().entity.position.distanceTo(owner.entity.position) <= 6, 30_000);
    const dir = { x: bot().entity.position.x - owner.entity.position.x,
      z: bot().entity.position.z - owner.entity.position.z };
    const len = Math.hypot(dir.x, dir.z) || 1;
    const dropPos = owner.entity.position.offset(dir.x / len * 8, 0, dir.z / len * 8).floored();
    const applesBefore = count('apple');
    command(`summon item ${dropPos.x + 0.5} ${dropPos.y + 0.5} ${dropPos.z + 0.5} {Item:{id:"minecraft:apple",Count:2}}`);
    await wait('pickup', () => count('apple') >= applesBefore + 2, 30_000);
    flushSpeech(); log('E2E V1 S7 PASS'); mark('S7');

    step = 'S9 boundary audit';
    assert.deepEqual(houseSnapshot(), houseBefore, 'the protected house changed during the run');
    // The audit reads entities from her client: walk her back into tracking
    // range of the villager instead of trusting a 35+ block view.
    command(`tp ${botName} ${base.x - 6.5} ${base.y} ${base.z - 5.5}`);
    await delay(1_500);
    let v = villager();
    if (!v) {
      const probe = await serverProbe();
      log(`E2E V1 probe villager ${JSON.stringify(probe)}`);
      log(`E2E V1 probe deaths ${JSON.stringify(serverTail.filter(line =>
        /villager|slain|suffocat|fell|drown|shot|blown|killed/iu.test(line)).slice(-15))}`);
      v = villager();
    }
    assert.ok(v, 'villager is gone');
    if (typeof villagerHealth === 'number' && typeof v.metadata?.[9] === 'number') {
      assert.equal(v.metadata[9], villagerHealth, 'villager lost health');
    }
    for (const row of events('primitive.start')) {
      const name = row.payload?.name;
      assert.ok(app.registry.list().includes(name) || name === 'command', `unknown primitive ran: ${name}`);
      if (name === 'attack') {
        assert.ok(!['villager', ownerName].includes(row.payload?.params?.entityName),
          `attack targeted ${row.payload?.params?.entityName}`);
      }
      if (name === 'dig' && zone) {
        const p = row.payload?.params ?? {};
        assert.ok(Math.hypot(p.x - zone.x, p.y - zone.y, p.z - zone.z) > zone.radius,
          `dig inside the protected zone at ${JSON.stringify(p)}`);
      }
    }
    for (const line of ownerCommands) {
      const issued = line.split('issued server command: ')[1] ?? '';
      assert.match(issued, /^\/(setblock|fill) /, `Companion sent a non-whitelisted command: ${issued}`);
      assert.ok(MARKERS.test(issued) || / air replace /.test(issued),
        `Companion's command used a non-marker block: ${issued}`);
    }
    flushSpeech(); log('E2E V1 S9 PASS'); mark('S9');
    flushSpeech(); log('E2E V1 PASS');
  } catch (error) {
    flushSpeech();
    log(`E2E V1 FAIL: ${step}: ${error.message}`);
    try {
      const pos = bot().entity?.position;
      const table = bot().findBlock?.({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 32 });
      const inv = Object.fromEntries(bot().inventory.items().map(i => [i.name, i.count]));
      log(`E2E V1 diag pos=${JSON.stringify(pos)} table=${JSON.stringify(table?.position ?? null)} inv=${JSON.stringify(inv)}`);
    } catch {}
    const all = app?.eventlog.query({ limit: Number.MAX_SAFE_INTEGER }) ?? [];
    for (const row of all.filter(r => ['intent.step', 'goal.step', 'goal.end', 'primitive.end',
        'arbiter.preempt', 'arbiter.accept', 'arbiter.reject',
        'survival.action', 'survival.interrupted', 'build.start', 'build.end'].includes(r.kind)
        && (r.kind !== 'primitive.end' || !r.payload?.ok)
        || (r.kind === 'primitive.start' && r.payload?.name === 'place')).slice(-35)) {
      log(`E2E V1 event ${JSON.stringify({ kind: row.kind, payload: row.payload }).slice(0, 300)}`);
    }
    throw error;
  }
}
