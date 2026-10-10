import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { BLUEPRINTS, blueprintGeometry } from '../src/build/blueprints.js';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3');

export function buildEnvironment(env, log = console.log) {
  if (env.E2E_BUILD !== '1') { log('E2E BUILD SKIP: set E2E_BUILD=1'); return false; }
  return true;
}

const maxId = rows => rows.reduce((latest, row) => Math.max(latest, row.id ?? 0), 0);

export async function runBuildScenario({ app, owner, command, delay, server, botName = 'Companion', ownerName = 'TestOwner', log = console.log }) {
  const bot = app.bot;
  const hut = BLUEPRINTS.hut;
  const events = kind => app.eventlog.query({ kind, limit: Number.MAX_SAFE_INTEGER });
  const at = ({ x, y, z }) => bot.blockAt(new Vec3(x, y, z))?.name ?? 'unknown';
  const fills = [];
  server.stdout.on('data', chunk => {
    for (const line of String(chunk).split(/\r?\n/u)) {
      if (line.includes(`${botName} issued server command: /fill`)) fills.push(line);
    }
  });
  const count = name => bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0);
  const where = () => JSON.stringify(bot.entity.position);
  const fail = message => { throw new Error(`${message} (Companion at ${where()})`); };
  const waitForBuild = async (since, timeoutMs = 480_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = events('say').find(row => row.id > since && ['build_done', 'build_failed'].includes(row.payload?.kind));
      if (hit) return hit.payload.kind;
      await delay(200);
    }
    return fail('timed out waiting for build_done/build_failed');
  };
  const startsAfter = id => events('build.start').filter(row => row.id > id);
  const cellsOf = start => blueprintGeometry(hut, { origin: start.site, rotation: start.rotation }).cells;
  const inVolume = (start, pos) => pos.x >= start.site.x && pos.x < start.site.x + 5 && pos.y >= start.site.y
    && pos.y < start.site.y + 3 && pos.z >= start.site.z && pos.z < start.site.z + 5;
  const assertHut = (start, label) => {
    for (const cell of cellsOf(start)) {
      const name = at(cell);
      if (cell.role === 'door') assert.equal(name, 'air', `${label}: door cell ${JSON.stringify(cell)} is ${name}`);
      else assert.equal(name, 'oak_planks', `${label}: cell ${JSON.stringify(cell)} is ${name}`);
    }
  };
  const glassNear = start => {
    const found = [];
    for (let x = start.site.x - 2; x < start.site.x + 7; x++) for (let y = start.site.y - 1; y < start.site.y + 5; y++) {
      for (let z = start.site.z - 2; z < start.site.z + 7; z++) if (at({ x, y, z }) === 'light_blue_stained_glass') found.push({ x, y, z });
    }
    return found;
  };

  let step = 'setup';
  try {
    command(`gamemode survival ${ownerName}`);
    const base = bot.entity.position.floored();
    command(`fill ${base.x - 12} ${base.y - 1} ${base.z - 12} ${base.x + 12} ${base.y - 1} ${base.z + 12} grass_block`);
    command(`fill ${base.x - 12} ${base.y} ${base.z - 12} ${base.x + 12} ${base.y + 7} ${base.z + 12} air`);
    const grass = [[-2, -1], [-3, 0], [-1, -2], [-4, -1], [-2, -3], [-3, -3]].map(([dx, dz]) => ({ x: base.x + dx, y: base.y, z: base.z + dz }));
    for (const pos of grass) command(`setblock ${pos.x} ${pos.y} ${pos.z} short_grass`);
    const pillar = [0, 1, 2].map(dy => ({ x: base.x + 1, y: base.y + dy, z: base.z + 1 }));
    command(`fill ${base.x + 1} ${base.y} ${base.z + 1} ${base.x + 1} ${base.y + 2} ${base.z + 1} cobblestone`);
    const tree = { x: base.x - 10, z: base.z + 8 };
    command(`fill ${tree.x - 2} ${base.y + 3} ${tree.z - 2} ${tree.x + 2} ${base.y + 4} ${tree.z + 2} oak_leaves`);
    command(`fill ${tree.x} ${base.y} ${tree.z} ${tree.x} ${base.y + 4} ${tree.z} oak_log`);
    command(`give ${botName} oak_planks 40`);
    command(`tp ${ownerName} ${base.x + 9} ${base.y} ${base.z}`);
    await delay(2_500);
    assert.equal(count('oak_planks'), 40, 'fixture planks');
    assert.deepEqual(pillar.map(at), ['cobblestone', 'cobblestone', 'cobblestone'], 'fixture pillar');

    step = 'build with frame';
    const startBefore = maxId(events('build.start'));
    const sayBefore = maxId(events('say'));
    owner.chat('给我们搭个小屋');
    const first = await waitForBuild(sayBefore);
    const endRow = events('build.end').at(-1)?.payload;
    log(`E2E BUILD first say=${first} end=${JSON.stringify(endRow)} inventory.planks=${count('oak_planks')}`);
    if (first !== 'build_done') fail(`first build failed: ${JSON.stringify(endRow)}`);
    const start1 = startsAfter(startBefore).at(-1)?.payload ?? fail('no build.start event');
    log(`E2E BUILD site ${JSON.stringify(start1)}`);
    assertHut(start1, 'first hut');
    assert.deepEqual(glassNear(start1), [], 'frame glass left behind');
    assert.deepEqual(pillar.map(at), ['cobblestone', 'cobblestone', 'cobblestone'], 'pillar damaged');
    assert.equal(endRow.frame, true, 'first build should have used the frame');
    assert.ok(fills.length >= 1, 'no frame fill echoed by the server');
    const grassInside = grass.filter(pos => inVolume(start1, pos));
    for (const pos of grassInside) assert.notEqual(at(pos), 'short_grass', 'grass inside the hut volume survived');
    log(`E2E BUILD first PASS (fills=${fills.length}, grass inside=${grassInside.length})`);

    step = 'build without permission';
    const fillsBefore = fills.length;
    command(`deop ${botName}`);
    command(`give ${botName} oak_planks 55`);
    await delay(2_000);
    const startBefore2 = maxId(events('build.start'));
    const sayBefore2 = maxId(events('say'));
    owner.chat('再搭个房子');
    const second = await waitForBuild(sayBefore2);
    const endRow2 = events('build.end').at(-1)?.payload;
    log(`E2E BUILD second say=${second} end=${JSON.stringify(endRow2)}`);
    if (second !== 'build_done') fail(`second build failed: ${JSON.stringify(endRow2)}`);
    const start2 = startsAfter(startBefore2).at(-1)?.payload ?? fail('no second build.start event');
    log(`E2E BUILD site2 ${JSON.stringify(start2)}`);
    assert.equal(endRow2.frame, false, 'second build should have no frame');
    assertHut(start2, 'second hut');
    assertHut(start1, 'first hut after second build');
    const overlap = cellsOf(start2).some(cell => inVolume(start1, cell));
    assert.equal(overlap, false, 'second hut overlaps the first');
    assert.deepEqual(pillar.map(at), ['cobblestone', 'cobblestone', 'cobblestone'], 'pillar damaged by second build');
    assert.ok(fills.length - fillsBefore <= 1, `Companion kept sending fills without permission (${fills.length - fillsBefore})`);
    log(`E2E BUILD second PASS (denied fill attempts=${fills.length - fillsBefore})`);
    log('E2E BUILD PASS');
  } catch (error) {
    log(`E2E BUILD FAIL: ${step}: ${error.message}`);
    for (const row of events('build.start').slice(-2)) log(`E2E BUILD start ${JSON.stringify(row.payload)}`);
    for (const row of events('build.end').slice(-2)) log(`E2E BUILD end ${JSON.stringify(row.payload)}`);
    for (const row of events('primitive.end').slice(-8)) log(`E2E BUILD primitive.end ${JSON.stringify(row.payload).slice(0, 300)}`);
    throw error;
  }
}
