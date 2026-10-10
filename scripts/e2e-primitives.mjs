import assert from 'node:assert/strict';

export function primitivesEnvironment(env, log = console.log) {
  if (env.E2E_PRIMITIVES !== '1') {
    log('E2E PRIMITIVES SKIP: set E2E_PRIMITIVES=1 to enable isolated server fixtures');
    return false;
  }
  return true;
}

export async function runPrimitivesScenario({ app, owner, command, delay, botName = 'Companion', ownerName = 'TestOwner', log = console.log }) {
  const bot = app.bot;
  const count = (who, name) => who.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
  const wait = async (label, predicate) => {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(`${label}: fixture timed out`);
      await delay(100);
    }
  };
  const run = async (name, params = {}) => {
    const outcome = await app.registry.run(name, params);
    if (!outcome.ok) throw new Error(`${name}: ${outcome.error?.message ?? JSON.stringify(outcome)}`);
    log(`E2E PRIMITIVES ${name} PASS ${JSON.stringify(outcome.result)}`);
    return outcome.result;
  };
  try {
    command('difficulty peaceful');
    command(`gamemode survival ${botName}`);
    command(`give ${botName} wooden_sword 1`);
    await wait('wooden sword', () => count(bot, 'wooden_sword') >= 1);
    await run('equip', { itemName: 'wooden_sword' });
    command(`execute at ${botName} run summon cow ~2 ~ ~ {NoAI:1b}`);
    await wait('cow', () => Object.values(bot.entities).some(e => e.name === 'cow' && e.isValid !== false && e.position.distanceTo(bot.entity.position) <= 16));
    assert.equal((await run('attack', { entityName: 'cow' })).killed, true);
    // Peaceful difficulty refills hunger; briefly use normal with natural spawning disabled.
    command('difficulty normal');
    command(`give ${botName} bread 1`);
    command(`effect give ${botName} minecraft:hunger 5 255 true`);
    await wait('hunger and bread', () => bot.food <= 15 && count(bot, 'bread') >= 1);
    command(`effect clear ${botName} minecraft:hunger`);
    const eaten = await run('eat', { itemName: 'bread' });
    assert.ok(eaten.foodAfter > eaten.foodBefore);
    command('difficulty peaceful');
    command(`tp ${ownerName} ${botName}`);
    await wait('owner nearby', () => owner.entity.position.distanceTo(bot.entity.position) < 2);
    const before = count(owner, 'stick');
    command(`give ${botName} stick 5`);
    await wait('sticks', () => count(bot, 'stick') >= 5);
    await run('give', { itemName: 'stick', count: 5 });
    // The owner bot cannot walk; emulate a real player stepping onto the tossed stack after the pickup delay.
    await delay(2500);
    command(`execute as ${botName} at @s run tp ${ownerName} @e[type=minecraft:item,nbt={Item:{id:"minecraft:stick"}},limit=1,sort=nearest]`);
    await wait('owner pickup', () => count(owner, 'stick') === before + 5);
    command('time set night');
    const p = bot.entity.position.floored();
    command(`setblock ${p.x + 2} ${p.y - 1} ${p.z} stone`);
    command(`setblock ${p.x + 2} ${p.y - 1} ${p.z + 1} stone`);
    command(`setblock ${p.x + 2} ${p.y} ${p.z} red_bed[facing=south,part=foot]`);
    command(`setblock ${p.x + 2} ${p.y} ${p.z + 1} red_bed[facing=south,part=head]`);
    await wait('night and bed', () => !bot.time.isDay && bot.findBlock({ matching: b => b.name.endsWith('_bed'), maxDistance: 32 }));
    await run('sleep');
    assert.equal(bot.isSleeping, true);
    await run('countItem', { itemName: 'stick' });
    const wakeFailures = app.eventlog.query({ kind: 'primitive.wake_failed' });
    const wakeStart = Date.now();
    while (bot.isSleeping && Date.now() - wakeStart < 3000) await delay(50);
    log(`E2E PRIMITIVES DIAG isSleeping lag after primitive returned: ${Date.now() - wakeStart}ms, still=${bot.isSleeping} wakeFailures=${JSON.stringify(wakeFailures.map(r => r.payload))}`);
    assert.equal(bot.isSleeping, false);
    log('E2E PRIMITIVES PASS');
  } catch (error) {
    const seen = Object.values(bot.entities ?? {}).map(e => `${e.name}@${e.position ? Math.round(e.position.distanceTo(bot.entity.position)) : '?'}`).slice(0, 20);
    log(`E2E PRIMITIVES DIAG entities=${JSON.stringify(seen)} food=${bot.food} health=${bot.health} pos=${JSON.stringify(bot.entity.position.floored())}`);
    log(`E2E PRIMITIVES FAIL: ${error.message}`);
    throw error;
  }
}
