import assert from 'node:assert/strict';

export function proactiveEnvironment(env, log = console.log) {
  if (env.E2E_PROACTIVE !== '1') { log('E2E PROACTIVE SKIP: set E2E_PROACTIVE=1'); return false; }
  return true;
}

const maxId = rows => rows.reduce((latest, row) => Math.max(latest, row.id ?? 0), 0);

export async function runProactiveScenario({ app, owner, command, delay, botName = 'Companion', ownerName = 'TestOwner', log = console.log }) {
  const bot = app.bot;
  const count = name => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
  const events = kind => app.eventlog.query({ kind, limit: Number.MAX_SAFE_INTEGER });
  const proactiveActions = () => events('proactive.action');
  const sayOf = (kind, after = 0) => events('say').find(row => row.id > after && row.payload?.kind === kind);
  const wait = async (label, predicate, ms = 20_000) => {
    const end = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() >= end) {
        for (const row of proactiveActions().slice(-8)) log(`E2E PROACTIVE trace ${JSON.stringify(row.payload)}`);
        for (const row of events('proactive.error').slice(-5)) log(`E2E PROACTIVE error ${JSON.stringify(row.payload)}`);
        throw new Error(`${label}: timed out`);
      }
      await delay(100);
    }
  };

  try {
    command(`gamemode survival ${ownerName}`);
    // Flat pad so both bots stand on deterministic ground for the whole run.
    const base = owner.entity.position.floored();
    command(`fill ${base.x - 6} ${base.y - 1} ${base.z - 6} ${base.x + 32} ${base.y - 1} ${base.z + 6} stone`);
    command(`fill ${base.x - 6} ${base.y} ${base.z - 6} ${base.x + 32} ${base.y + 4} ${base.z + 6} air`);
    // Wood fixture for the eventual wooden_pickaxe proposal/obtain. T25's
    // natural-log rule skips leafless logs, so the columns need a canopy.
    for (const [x, z] of [[28, -2], [29, 0], [28, 2]]) {
      command(`fill ${base.x + x - 1} ${base.y + 3} ${base.z + z - 1} ${base.x + x + 1} ${base.y + 5} ${base.z + z + 1} oak_leaves`);
      command(`fill ${base.x + x} ${base.y} ${base.z + z} ${base.x + x} ${base.y + 4} ${base.z + z} oak_log`);
    }
    command(`tp ${botName} ${base.x + 1} ${base.y} ${base.z}`);
    command(`tp ${ownerName} ${base.x + 3} ${base.y} ${base.z}`);
    await delay(2_000);

    // 1. Owner 15 blocks away -> stay_near brings Companion within 6.
    const sayBefore = maxId(events('say'));
    command(`tp ${ownerName} ${base.x + 18} ${base.y} ${base.z}`);
    await wait('stay_near', () => bot.entity.position.distanceTo(owner.entity.position) <= 6
      && proactiveActions().some(row => row.payload?.kind === 'stay_near'), 20_000);
    log('E2E PROACTIVE stay_near PASS');

    // 2. A drop 10 blocks past Companion on the far side from the owner gets collected.
    //    Companion is <=6 from the owner, so the drop is 4..10 blocks from Companion and ~10 from the owner.
    const dir = { x: bot.entity.position.x - owner.entity.position.x, z: bot.entity.position.z - owner.entity.position.z };
    const len = Math.hypot(dir.x, dir.z) || 1;
    const dropPos = owner.entity.position.offset(dir.x / len * 10, 0, dir.z / len * 10).floored();
    const cobbleBefore = count('cobblestone');
    command(`summon item ${dropPos.x + 0.5} ${dropPos.y + 0.5} ${dropPos.z + 0.5} {Item:{id:"minecraft:cobblestone",Count:5}}`);
    await wait('pickup', () => count('cobblestone') >= cobbleBefore + 5
      && proactiveActions().some(row => row.payload?.kind === 'pickup'), 20_000);
    log(`E2E PROACTIVE pickup PASS (drop at ${dropPos.x} ${dropPos.y} ${dropPos.z}, ${bot.entity.position.distanceTo(dropPos).toFixed(1)} blocks out)`);

    // 3. A drop at the owner's feet is left alone for 10 seconds.
    const feet = owner.entity.position.floored();
    const dirtBefore = count('dirt');
    command(`summon item ${feet.x + 0.5} ${feet.y + 0.5} ${feet.z + 0.5} {Item:{id:"minecraft:dirt",Count:3}}`);
    await delay(10_000);
    assert.equal(count('dirt'), dirtBefore, 'Companion picked up the drop at the owner feet');
    log('E2E PROACTIVE owner-drop skip PASS');

    // 4. /damage on the owner triggers an owner_hurt remark.
    const hurtEvents = [];
    bot.on('entityHurt', entity => hurtEvents.push(entity?.uuid ?? entity?.name ?? '?'));
    // Peaceful regen lifts 14 -> 15 before the next tick; freeze it so 6 damage stays <=14.
    command('gamerule naturalRegeneration false');
    command(`damage ${ownerName} 6`);
    await delay(500);
    const seenByCompanion = bot.players?.[ownerName]?.entity?.metadata?.[9];
    log(`E2E PROACTIVE diag owner.health=${owner.health} companion.metadata9=${JSON.stringify(seenByCompanion)} entityHurt=${hurtEvents.length}`);
    await wait('owner_hurt', () => proactiveActions().some(row => row.payload?.kind === 'remark' && row.payload?.reason === 'owner_hurt')
      && sayOf('proactive_remark', sayBefore), 10_000);
    command('gamerule naturalRegeneration true');
    log(`E2E PROACTIVE owner_hurt PASS (entityHurt events seen: ${hurtEvents.length})`);

    // 5. Crossing into night fires one reminder; a second wait stays silent.
    command('time set 13000');
    await wait('nightfall', () => proactiveActions().some(row => row.payload?.reason === 'nightfall')
      && events('say').filter(row => row.payload?.kind === 'proactive_remark').length >= 2, 10_000);
    const nightfallSays = events('say').filter(row => row.payload?.kind === 'proactive_remark').length;
    await delay(10_000);
    assert.equal(events('say').filter(row => row.payload?.kind === 'proactive_remark').length,
      nightfallSays, 'nightfall reminder repeated inside the same night');
    command('time set day');
    log('E2E PROACTIVE nightfall PASS');

    // 6. Twenty quiet seconds with an empty-ish inventory proposes wooden_pickaxe;
    //    answering 好 spends exactly one budget entry and lands the pickaxe.
    const quietEnd = Date.now() + 45_000;
    while (!sayOf('propose', sayBefore)) {
      if (Date.now() >= quietEnd) throw new Error('propose: timed out');
      await delay(200);
    }
    const proposal = proactiveActions().find(row => row.payload?.kind === 'propose');
    assert.equal(proposal?.payload?.item, 'wooden_pickaxe', `expected wooden_pickaxe, got ${proposal?.payload?.item}`);
    log(`E2E PROACTIVE propose PASS (${proposal.payload.item} x${proposal.payload.count})`);
    owner.chat('好');
    await wait('obtain wooden_pickaxe', () => count('wooden_pickaxe') >= 1, 300_000);
    const spends = events('budget.learning_spent');
    assert.equal(spends.length, 1, `expected exactly one budget spend, saw ${spends.length}`);
    assert.deepEqual(spends[0].payload, { kind: 'goal', item: 'wooden_pickaxe' });
    log('E2E PROACTIVE approve+budget PASS');

    // 7. Nothing outside the whitelist ever ran under a proactive: label.
    const accepts = events('arbiter.accept').filter(row => row.payload?.label?.startsWith('proactive:'));
    const proactiveTraces = new Set(accepts.map(row => row.trace_id));
    const starts = events('primitive.start').filter(row => proactiveTraces.has(row.trace_id));
    for (const row of starts) {
      assert.ok(['goToEntity', 'collectDrops'].includes(row.payload?.name),
        `proactive task ran forbidden primitive ${row.payload?.name}`);
    }
    log(`E2E PROACTIVE whitelist PASS (${starts.length} primitive starts, all allowed)`);
    log('E2E PROACTIVE PASS');
  } catch (error) {
    log(`E2E PROACTIVE FAIL: ${error.message}`);
    for (const row of events('arbiter.reject').slice(-5)) log(`E2E PROACTIVE reject ${JSON.stringify(row.payload)}`);
    throw error;
  }
}
