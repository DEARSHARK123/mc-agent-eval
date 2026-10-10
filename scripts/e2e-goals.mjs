import assert from 'node:assert/strict';

export function goalsEnvironment(env, log = console.log) {
  if (env.E2E_GOALS !== '1') { log('E2E GOALS SKIP: set E2E_GOALS=1'); return false; }
  return true;
}

const maxId = rows => rows.reduce((latest, row) => Math.max(latest, row.id ?? 0), 0);

function waitForSay(app, delay, kinds, timeoutMs = 300_000) {
  const before = maxId(app.eventlog.query({ kind: 'say' }));
  const deadline = Date.now() + timeoutMs;
  const poll = async () => {
    let hit;
    while (Date.now() < deadline && !hit) {
      hit = app.eventlog.query({ kind: 'say' }).find(row => row.id > before && kinds.includes(row.payload?.kind));
      if (!hit) await delay(100);
    }
    if (!hit) return null;
    const speechDeadline = Date.now() + 15_000;
    let text;
    while (Date.now() < speechDeadline && !text) {
      text = app.eventlog.query({ kind: 'speech' }).filter(row => row.trace_id === hit.trace_id).at(-1)?.payload?.text;
      if (!text) await delay(100);
    }
    return { kind: hit.payload.kind, text };
  };
  return poll();
}

export async function runGoalsScenario({ app, owner, command, delay, botName = 'Companion', ownerName = 'TestOwner', log = console.log }) {
  const count = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
  command('time set day'); command('gamerule doMobSpawning false'); command('difficulty peaceful');
  command(`gamemode survival ${botName}`); command(`clear ${botName}`);
  // T25 natural-log rule: bare columns are filtered out of findBlock, so the
  // fixture trees need leaves (fill/setblock leaves are persistent=false).
  for (const [x, z] of [[6, 0], [8, 2], [6, 4]]) {
    command(`execute at ${botName} run fill ~${x - 1} ~3 ~${z - 1} ~${x + 1} ~5 ~${z + 1} oak_leaves`);
    command(`execute at ${botName} run fill ~${x} ~ ~${z} ~${x} ~4 ~${z} oak_log`);
  }
  command(`execute at ${botName} run fill ~6 ~ ~-8 ~9 ~3 ~-5 stone`);
  command(`execute at ${botName} run fill ~6 ~ ~-4 ~8 ~ ~-4 coal_ore`);
  // Sheep offset west of the tree columns: one at ~(8,2) suffocates inside
  // the oak_log column there, leaving her a wool short of the bed.
  for (const [sx, sz] of [[4, 2], [5, 1], [5, 3]]) command(`execute at ${botName} run summon sheep ~${sx} ~ ~${sz} {Color:0,NoAI:1b}`);
  await delay(2000);
  let craftSeen = 0;
  const obtain = async (item, countWanted = 1, giveToOwner = false) => {
    const result = await app.goals.obtain({ item, count: countWanted, giveToOwner }).done;
    log(`E2E GOALS ${item} ${JSON.stringify(result)}`);
    const ends = app.eventlog.query({ kind: 'primitive.end' });
    const crafts = ends.slice(craftSeen).filter(row => row.payload?.name === 'craft')
      .map(row => `${row.payload?.result?.itemName ?? 'craft'}:${row.payload?.result?.attempts ?? 'fail'}`);
    craftSeen = ends.length;
    log(`E2E GOALS crafts ${item} [${crafts.join(',')}]`);
    if (result.status !== 'succeeded') {
      log(`E2E GOALS goal.end ${JSON.stringify(app.eventlog.query({ kind: 'goal.end' }).at(-1)?.payload)}`);
      for (const row of app.eventlog.query({ kind: 'primitive.end' }).filter(r => r.payload?.name !== 'place').slice(-14)) log(`E2E GOALS trace ${row.payload?.name} ok=${row.payload?.ok} ${JSON.stringify(row.payload?.result ?? row.payload?.error?.message ?? '').slice(0, 160)}`);
      log(`E2E GOALS inventory ${JSON.stringify(app.bot.inventory.items().map(i => `${i.name}x${i.count}`))}`);
      for (const row of app.eventlog.query({ kind: 'intent.step' }).slice(-6)) log(`E2E GOALS intent.step ${JSON.stringify(row.payload).slice(0, 300)}`);
      for (const row of app.eventlog.query({ kind: 'primitive.end' }).filter(r => r.payload?.ok === false).slice(-6)) log(`E2E GOALS primitive.fail ${JSON.stringify(row.payload).slice(0, 300)}`);
      throw new Error(`${item}: ${result.reason ?? result.status}`);
    }
    if (!giveToOwner) assert.ok(count(app.bot, item) >= countWanted);
    return result;
  };
  await obtain('wooden_pickaxe'); await obtain('stone_pickaxe');
  command(`tp ${ownerName} ${botName}`); await delay(500);
  // Loose plank drops from earlier goals would pad the owner's pickup count.
  command('kill @e[type=item]'); await delay(300);
  const before = count(owner, 'oak_planks');
  const planks = await obtain('oak_planks', 8, true);
  await delay(2500);
  command(`execute as ${botName} at @s run tp ${ownerName} @e[type=minecraft:item,nbt={Item:{id:"minecraft:oak_planks"}},limit=1,sort=nearest]`);
  const deadline = Date.now() + 15000;
  while (count(owner, 'oak_planks') < before + 8 && Date.now() < deadline) await delay(100);
  // Exactness lives in result.given: craft overflow can drop extra planks at
  // her feet and the owner sweeps those up alongside the tossed stack.
  assert.equal(planks.given, 8);
  assert.ok(count(owner, 'oak_planks') >= before + 8, `owner has ${count(owner, 'oak_planks') - before} of 8 given planks`);
  await obtain('white_bed');
  // T18b: iron pickaxe proves the collect-ore -> craft-furnace -> smelt -> craft chain.
  for (const [x, z] of [[-6, 0], [-8, 2], [-6, 4]]) {
    command(`execute at ${botName} run fill ~${x - 1} ~3 ~${z - 1} ~${x + 1} ~5 ~${z + 1} oak_leaves`);
    command(`execute at ${botName} run fill ~${x} ~ ~${z} ~${x} ~4 ~${z} oak_log`);
  }
  command(`execute at ${botName} run fill ~-6 ~ ~-3 ~-4 ~ ~-3 iron_ore`);
  await delay(2000);
  await obtain('iron_pickaxe');
  // T18b: chest store/fetch go through owner chat, not the planner.
  command(`execute at ${botName} run setblock ~2 ~ ~ chest`);
  command(`give ${botName} cobblestone 16`);
  await delay(1500);
  owner.chat('把圆石放进箱子');
  const stored = await waitForSay(app, delay, ['stored', 'store_failed'], 60_000);
  log(`E2E GOALS store ${JSON.stringify(stored)}`);
  assert.equal(stored?.kind, 'stored');
  assert.equal(count(app.bot, 'cobblestone'), 0);
  owner.chat('从箱子里拿 2 个圆石');
  const fetched = await waitForSay(app, delay, ['fetched', 'fetch_failed'], 60_000);
  log(`E2E GOALS fetch ${JSON.stringify(fetched)}`);
  assert.equal(fetched?.kind, 'fetched');
  assert.equal(count(app.bot, 'cobblestone'), 2);
  log('E2E GOALS PASS');
}

function selfLearnDiagnostics(app, log) {
  for (const row of app.eventlog.query({ kind: 'goal.end' }).slice(-3)) log(`E2E GOALS goal.end ${JSON.stringify(row.payload)}`);
  for (const row of app.eventlog.query({ kind: 'say' }).slice(-5)) log(`E2E GOALS say ${JSON.stringify(row.payload)}`);
  for (const row of app.eventlog.query({ kind: 'speech' }).slice(-5)) log(`E2E GOALS speech ${JSON.stringify(row.payload)}`);
  for (const row of app.eventlog.query({ kind: 'arbiter.accept' }).slice(-5)) log(`E2E GOALS accept ${JSON.stringify(row.payload)}`);
  for (const row of app.eventlog.query({ kind: 'primitive.end' }).filter(r => r.payload?.ok === false).slice(-5)) log(`E2E GOALS primitive.fail ${JSON.stringify(row.payload).slice(0, 300)}`);
  for (const row of app.eventlog.query({ kind: 'intent.end' }).slice(-2)) log(`E2E GOALS intent.end ${JSON.stringify(row.payload).slice(0, 500)}`);
  for (const row of app.eventlog.query({ kind: 'intent.step' }).slice(-25)) {
    const p = row.payload ?? {};
    log(`E2E GOALS intent.step ${JSON.stringify({ step: p.step, chosen: p.chosen, ok: p.ok, error: p.error_code, by: p.decided_by })}`);
  }
}

export async function runSelfLearningScenario({ app, owner, command, delay, restart, botName = 'Companion', log = console.log }) {
  const count = (bot, name) => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
  const waitSay = (kinds, timeoutMs = 300_000) => waitForSay(app, delay, kinds, timeoutMs);
  const fail = message => { selfLearnDiagnostics(app, log); throw new Error(`SELF-LEARN ${message}`); };

  owner.chat('做一把石镐');
  const first = await waitSay(['goal_done', 'goal_failed', 'goal_unable']);
  log(`E2E GOALS self.learn first ${JSON.stringify(first)}`);
  if (first?.kind !== 'goal_done') fail(`做一把石镐 did not finish: ${first?.kind} ${first?.text}`);
  const skill = app.library.get('make_stone_pickaxe');
  if (skill?.provenance.at(-1)?.route !== 'self') fail(`make_stone_pickaxe provenance wrong: ${JSON.stringify(skill?.provenance)}`);
  if (!app.eventlog.query({ kind: 'skills.self_learned' }).length) fail('skills.self_learned event missing');
  log('E2E GOALS self.learn stored make_stone_pickaxe route=self');

  app = await restart();
  await delay(2_000);
  command(`clear ${botName}`);
  for (const [x, z] of [[6, 0], [8, 2], [6, 4]]) {
    command(`execute at ${botName} run fill ~${x - 1} ~3 ~${z - 1} ~${x + 1} ~5 ~${z + 1} oak_leaves`);
    command(`execute at ${botName} run fill ~${x} ~ ~${z} ~${x} ~4 ~${z} oak_log`);
  }
  command(`execute at ${botName} run fill ~6 ~ ~-8 ~9 ~3 ~-5 stone`);
  await delay(2_000);
  const acceptsBefore = maxId(app.eventlog.query({ kind: 'arbiter.accept' }));
  owner.chat('做一把石镐');
  const second = await waitSay(['goal_done', 'goal_failed', 'goal_unable']);
  log(`E2E GOALS self.learn second ${JSON.stringify(second)}`);
  if (second?.kind !== 'goal_done') fail(`做一把石镐 after restart failed: ${second?.kind} ${second?.text}`);
  const labels = app.eventlog.query({ kind: 'arbiter.accept' })
    .filter(row => row.id > acceptsBefore).map(row => row.payload?.label);
  if (!labels.includes('make_stone_pickaxe')) fail(`learned skill not used after restart: ${labels.join(',')}`);
  if (labels.includes('obtain stone_pickaxe')) fail(`planner path ran after restart: ${labels.join(',')}`);
  if (!second.text?.includes('自己学会')) fail(`expected a self_learned fact, heard: ${second.text}`);
  if (count(app.bot, 'stone_pickaxe') < 1) fail('no stone_pickaxe in inventory after the learned run');
  log('E2E GOALS self.learn reused make_stone_pickaxe with self_learned fact');

  const acceptsNow = maxId(app.eventlog.query({ kind: 'arbiter.accept' }));
  const position = app.bot.entity.position.clone();
  owner.chat('做一个下界合金锭');
  const third = await waitSay(['goal_unable', 'goal_done', 'goal_failed'], 60_000);
  log(`E2E GOALS self.learn third ${JSON.stringify(third)}`);
  if (third?.kind !== 'goal_unable') fail(`做一个下界合金锭 expected goal_unable, got ${third?.kind} ${third?.text}`);
  if (!third.text?.includes('needs_nether_or_end')) fail(`expected needs_nether_or_end, heard: ${third.text}`);
  if (app.eventlog.query({ kind: 'arbiter.accept' }).some(row => row.id > acceptsNow)) fail('infeasible goal submitted a task');
  await delay(1_000);
  if (app.bot.entity.position.distanceTo(position) > 0.5) fail('companion moved for an infeasible goal');
  log('E2E GOALS SELF-LEARN PASS');
}
