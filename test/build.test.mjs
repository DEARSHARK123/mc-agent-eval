import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { BLUEPRINTS, blueprintCells, blueprintGeometry, buildOrder, buildSegments, findBlueprint, frameBoxes, volumeBox } from '../src/build/blueprints.js';
import { PLANT_NAMES, findSite } from '../src/build/site.js';
import { createBuilder } from '../src/build/builder.js';
import { createArbiter } from '../src/arbiter.js';

const mcData = createRequire(import.meta.url)('minecraft-data')('1.20.4');
const hut = BLUEPRINTS.hut;
const key = ({ x, y, z }) => `${x},${y},${z}`;
const boxCells = ({ from, to }) => {
  const out = [];
  for (let x = from.x; x <= to.x; x++) for (let y = from.y; y <= to.y; y++) for (let z = from.z; z <= to.z; z++) out.push({ x, y, z });
  return out;
};

test('hut has 55 solid cells, 2 door cells, aliases and frozen data', () => {
  const cells = blueprintCells(hut, { origin: { x: 0, y: 0, z: 0 }, rotation: 0 });
  assert.equal(cells.filter(c => c.role !== 'door').length, 55);
  assert.equal(cells.filter(c => c.role === 'door').length, 2);
  assert.equal(cells.filter(c => c.role === 'roof').length, 25);
  assert.equal(cells.filter(c => c.role === 'wall').length, 30);
  for (const alias of ['小屋', '房子', '小房子', '屋子', '木屋', '小木屋']) assert.equal(findBlueprint(alias), hut);
  assert.equal(findBlueprint('城堡'), null);
  assert.ok(Object.isFrozen(BLUEPRINTS) && Object.isFrozen(hut) && Object.isFrozen(hut.size));
  assert.deepEqual(hut.size, { x: 5, y: 3, z: 5 });
});

test('every rotation stays in 5x3x5, puts the door in front and orders cells so each is supported', () => {
  const origin = { x: 10, y: 4, z: -7 };
  const fronts = new Set();
  for (const rotation of [0, 1, 2, 3]) {
    const { cells, frontCell, center } = blueprintGeometry(hut, { origin, rotation });
    for (const c of cells) {
      assert.ok(c.x >= 10 && c.x < 15 && c.y >= 4 && c.y < 7 && c.z >= -7 && c.z < -2, `rotation ${rotation} ${key(c)}`);
    }
    assert.deepEqual(center, { x: 12, y: 4, z: -5 });
    const doors = cells.filter(c => c.role === 'door');
    assert.deepEqual(doors.map(d => d.y).sort(), [4, 5]);
    assert.equal(doors[0].x, doors[1].x); assert.equal(doors[0].z, doors[1].z);
    assert.equal(Math.abs(frontCell.x - doors[0].x) + Math.abs(frontCell.z - doors[0].z), 1, 'front is adjacent to the door');
    assert.ok(frontCell.x < 10 || frontCell.x > 14 || frontCell.z < -7 || frontCell.z > -3, 'front is outside the footprint');
    assert.equal(frontCell.y, 4);
    fronts.add(`${frontCell.x - center.x},${frontCell.z - center.z}`);
    const placed = new Set();
    for (const c of buildOrder(cells)) {
      assert.notEqual(c.role, 'door');
      const supported = c.y === 4 || [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
        .some(([dx, dy, dz]) => placed.has(key({ x: c.x + dx, y: c.y + dy, z: c.z + dz })));
      assert.ok(supported, `rotation ${rotation} cell ${key(c)} has no support when placed`);
      placed.add(key(c));
    }
    assert.equal(placed.size, 55);
  }
  assert.equal(fronts.size, 4);
});

test('frame boxes and segments never touch the door and respect command limits', () => {
  for (const rotation of [0, 1, 2, 3]) {
    const cells = blueprintCells(hut, { origin: { x: 0, y: 0, z: 0 }, rotation });
    const solid = new Set(cells.filter(c => c.role !== 'door').map(key));
    const boxes = frameBoxes(cells);
    assert.ok(boxes.length <= 6);
    const covered = new Set();
    for (const box of boxes) {
      const inside = boxCells(box);
      assert.ok(inside.length <= 512);
      for (const c of inside) { assert.ok(solid.has(key(c)), `frame box cell ${key(c)} is not solid`); covered.add(key(c)); }
    }
    assert.equal(covered.size, 55);
    const segments = buildSegments(cells);
    assert.ok(segments.length <= 15);
    assert.equal(segments.flatMap(s => s.cells).length, 55);
    for (const segment of segments) for (const c of boxCells(segment.box)) assert.ok(solid.has(key(c)));
    const whole = volumeBox(cells);
    assert.equal(boxCells(whole).length, 75);
    assert.ok(boxes.length + segments.length + 1 <= 22);
  }
});

function flatWorld(overrides = new Map()) {
  return (x, y, z) => {
    const name = overrides.get(key({ x, y, z })) ?? (y < 0 ? 'grass_block' : 'air');
    return { name, boundingBox: name === 'air' || PLANT_NAMES.includes(name) || name === 'water' ? 'empty' : 'block' };
  };
}
const ORIGIN = { x: 0, y: 0, z: 0 };
const volumeHas = (site, pos) => pos.x >= site.origin.x && pos.x < site.origin.x + 5 && pos.y >= site.origin.y
  && pos.y < site.origin.y + 3 && pos.z >= site.origin.z && pos.z < site.origin.z + 5;

test('flat ground picks the nearest site and plants do not disqualify it', () => {
  const site = findSite({ blueprint: hut, origin: ORIGIN, blockAt: flatWorld() });
  assert.deepEqual(site, { ok: true, origin: { x: -2, y: 0, z: -2 }, rotation: 0, resumed: false });
  const grassy = findSite({ blueprint: hut, origin: ORIGIN, blockAt: flatWorld(new Map([['0,0,0', 'short_grass'], ['1,1,1', 'dead_bush']])) });
  assert.deepEqual(grassy.origin, { x: -2, y: 0, z: -2 });
});

test('foreign blocks inside the volume skip the position', () => {
  for (const name of ['oak_planks', 'chest', 'water', 'lava', 'diamond_ore']) {
    const site = findSite({ blueprint: hut, origin: ORIGIN, blockAt: flatWorld(new Map([['0,1,0', name]])) });
    assert.equal(site.ok, true, name);
    assert.equal(volumeHas(site, { x: 0, y: 1, z: 0 }), false, `${name} must stay outside the volume`);
  }
});

test('floating sites, owner-occupied sites and unreachable doors are skipped', () => {
  const hole = findSite({ blueprint: hut, origin: ORIGIN, blockAt: flatWorld(new Map([['0,-1,0', 'air']])) });
  assert.equal(volumeHas(hole, { x: 0, y: 0, z: 0 }) && hole.origin.y === 0, false);
  const owner = { x: 0.5, y: 0, z: 0.5 };
  const occupied = findSite({ blueprint: hut, origin: ORIGIN, blockAt: flatWorld(), owner });
  assert.equal(occupied.ok, true);
  assert.equal(volumeHas(occupied, { x: 0, y: 0, z: 0 }) && occupied.origin.y === 0, false);
  const walled = new Map();
  for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) for (let y = 0; y <= 6; y++) walled.set(key({ x, y, z }), 'stone');
  assert.deepEqual(findSite({ blueprint: hut, origin: ORIGIN, blockAt: flatWorld(walled), radius: 3 }), { ok: false, reason: 'no_site' });
});

test('the door faces the owner', () => {
  const expected = [[{ x: 0.5, y: 0, z: -12 }, 0], [{ x: 12, y: 0, z: 0.5 }, 1], [{ x: 0.5, y: 0, z: 12 }, 2], [{ x: -12, y: 0, z: 0.5 }, 3]];
  for (const [owner, rotation] of expected) {
    assert.equal(findSite({ blueprint: hut, origin: ORIGIN, blockAt: flatWorld(), owner }).rotation, rotation);
  }
  assert.equal(findSite({ blueprint: hut, origin: ORIGIN, blockAt: flatWorld() }).rotation, 0);
});

test('a remembered site wins and may contain planks and frame glass', () => {
  const remembered = { origin: { x: 6, y: 0, z: 6 }, rotation: 1 };
  const world = new Map([['7,0,7', 'oak_planks'], ['8,2,8', 'light_blue_stained_glass']]);
  const site = findSite({ blueprint: hut, origin: ORIGIN, blockAt: flatWorld(world), remembered });
  assert.deepEqual(site, { ok: true, origin: remembered.origin, rotation: 1, resumed: true });
  const fresh = findSite({ blueprint: hut, origin: ORIGIN, blockAt: flatWorld(new Map([['7,0,7', 'oak_planks']])) });
  assert.equal(fresh.resumed, false);
  const spoiled = findSite({ blueprint: hut, origin: ORIGIN, blockAt: flatWorld(new Map([['7,0,7', 'chest']])), remembered });
  assert.equal(spoiled.resumed, false);
  const planksSite = findSite({ blueprint: hut, origin: ORIGIN, blockAt: flatWorld(new Map([['0,0,0', 'oak_planks']])) });
  assert.equal(volumeHas(planksSite, { x: 0, y: 0, z: 0 }), false, 'fresh sites never absorb foreign planks');
});

function fakeWorld({ stock = { oak_planks: 60 }, command = true, permission = true, blocks = new Map(), failCell = null, onPlace = null,
  goals = null, commandHook = null } = {}) {
  const world = new Map(blocks);
  const calls = [];
  const inventory = { ...stock };
  const bot = { entity: { position: new Vec3(0.5, 0, 0.5) }, inventory: { items: () => Object.entries(inventory)
    .filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })) } };
  const read = (x, y, z) => world.get(key({ x, y, z })) ?? (y < 0 ? 'grass_block' : 'air');
  bot.blockAt = pos => { const name = read(pos.x, pos.y, pos.z); return { name, boundingBox: name === 'air' || PLANT_NAMES.includes(name) ? 'empty' : 'block', position: pos }; };
  const solid = (x, y, z) => bot.blockAt(new Vec3(x, y, z)).boundingBox === 'block';
  const registry = {
    has: name => name !== 'command' || command,
    run: async (name, params, options = {}) => {
      if (options.signal?.aborted) return { ok: false, cancelled: true };
      const entry = { name, params: { ...params }, plantBefore: name === 'dig' ? read(params.x, params.y, params.z) : undefined };
      calls.push(entry);
      if (name === 'goTo') bot.entity.position = new Vec3(params.x + 0.5, params.y, params.z + 0.5);
      if (name === 'dig') world.set(key(params), 'air');
      if (name === 'place') {
        if (failCell && key(params) === failCell) return { ok: false, error: { message: 'no reference' } };
        if (read(params.x, params.y, params.z) !== 'air') return { ok: false, error: { message: 'not empty' } };
        if (!(inventory[params.itemName] > 0)) return { ok: false, error: { message: 'no item' } };
        const touching = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
          .some(([dx, dy, dz]) => solid(params.x + dx, params.y + dy, params.z + dz));
        if (!touching) return { ok: false, error: { message: 'no reference' } };
        inventory[params.itemName]--;
        world.set(key(params), params.itemName);
        onPlace?.(calls.filter(c => c.name === 'place' && !c.failed).length);
      }
      if (name === 'command') {
        if (!permission) return { ok: false, error: { code: 'no_permission' } };
        const override = commandHook?.(params, calls.filter(c => c.name === 'command').length);
        if (override) return override;
        for (const cell of boxCells({ from: params.from, to: params.to })) {
          if (params.kind === 'fill' && read(cell.x, cell.y, cell.z) === 'air') world.set(key(cell), params.marker);
          if (params.kind === 'clear' && read(cell.x, cell.y, cell.z) === params.marker) world.set(key(cell), 'air');
        }
      }
      return { ok: true, result: {} };
    },
  };
  const events = [];
  const eventlog = { append: (kind, payload) => events.push({ kind, payload }) };
  const arbiter = createArbiter({ registry, eventlog });
  const goalsFake = goals ?? { preferredLog: () => 'oak_log', obtainInline: async ({ item, count }) => { inventory[item] = Math.max(inventory[item] ?? 0, count) + 1; return { status: 'succeeded' }; } };
  const builder = createBuilder({ registry, arbiter, bot, mcData, goals: goalsFake, eventlog });
  return { builder, arbiter, calls, world, inventory, events, bot, read };
}

test('a full build only touches blueprint cells and uses clear-before-place frames', async () => {
  const grass = new Map([['0,0,0', 'short_grass'], ['-1,0,1', 'fern'], ['9,0,9', 'short_grass']]);
  const w = fakeWorld({ blocks: new Map([...grass, ['12,0,12', 'cobblestone']]) });
  const result = await w.builder.build({ blueprint: 'hut', traceId: 't' }).done;
  assert.equal(result.status, 'succeeded', JSON.stringify(result));
  assert.equal(result.placed, 55);
  assert.equal(result.frame, true);
  assert.equal(result.material, 'oak_planks');
  const origin = result.site.origin;
  const geometry = blueprintGeometry(hut, { origin, rotation: result.site.rotation });
  const solid = new Set(geometry.cells.filter(c => c.role !== 'door').map(key));
  const doors = geometry.cells.filter(c => c.role === 'door').map(key);
  const inside = c => volumeHas({ origin }, c);
  for (const c of w.calls.filter(call => call.name === 'place')) assert.ok(solid.has(key(c.params)), `place outside blueprint ${key(c.params)}`);
  const digs = w.calls.filter(call => call.name === 'dig');
  assert.ok(digs.length >= 1);
  for (const d of digs) { assert.ok(inside(d.params)); assert.ok(PLANT_NAMES.includes(d.plantBefore), d.plantBefore); }
  const commands = w.calls.filter(call => call.name === 'command');
  for (const [index, c] of commands.entries()) {
    assert.ok(['fill', 'clear'].includes(c.params.kind));
    assert.equal(c.params.marker, 'light_blue_stained_glass');
    for (const cell of boxCells(c.params)) {
      assert.ok(inside(cell));
      if (index < commands.length - 1) assert.ok(!doors.includes(key(cell)), 'only the final whole-volume clear may span the door');
    }
  }
  assert.deepEqual(commands.slice(0, 6).map(c => c.params.kind), Array(6).fill('fill'));
  assert.equal(commands.filter(c => c.params.kind === 'fill').length, 6);
  assert.equal(commands.filter(c => c.params.kind === 'clear').length, 16);
  assert.ok(commands.length <= 22);
  const lastCommand = commands.at(-1).params;
  assert.equal(boxCells(lastCommand).length, 75);
  assert.equal(lastCommand.kind, 'clear');
  let clearBox = null;
  for (const call of w.calls) {
    if (call.name === 'command' && call.params.kind === 'clear') clearBox = call.params;
    if (call.name === 'place') assert.ok(boxCells(clearBox).some(c => key(c) === key(call.params)), 'each segment is cleared right before its blocks');
  }
  assert.equal(w.read(12, 0, 12), 'cobblestone');
  assert.equal(w.read(9, 0, 9), 'short_grass');
  for (const cell of boxCells(volumeBox(geometry.cells))) assert.notEqual(w.read(cell.x, cell.y, cell.z), 'light_blue_stained_glass');
  assert.deepEqual(w.calls.at(-1).params.x === geometry.frontCell.x && w.calls.at(-1).params.z === geometry.frontCell.z, true);
  assert.equal(w.events.find(e => e.kind === 'build.start').payload.resumed, false);
  assert.equal(w.events.filter(e => e.kind === 'build.end').length, 1);
});

test('a registry without command builds without any command', async () => {
  const w = fakeWorld({ command: false });
  const result = await w.builder.build({ blueprint: 'hut' }).done;
  assert.equal(result.status, 'succeeded');
  assert.equal(result.frame, false);
  assert.equal(result.placed, 55);
  assert.equal(w.calls.filter(c => c.name === 'command').length, 0);
});

test('no_permission stops the frame after one attempt and the hut still gets built', async () => {
  const w = fakeWorld({ permission: false });
  const result = await w.builder.build({ blueprint: 'hut' }).done;
  assert.equal(result.status, 'succeeded');
  assert.equal(result.frame, false);
  assert.equal(w.calls.filter(c => c.name === 'command').length, 1);
});

test('missing planks call obtainInline with the total, and a failure places nothing', async () => {
  const requests = [];
  const goals = { preferredLog: () => 'oak_log', obtainInline: async request => { requests.push(request); return { status: 'succeeded' }; } };
  const w = fakeWorld({ stock: { oak_planks: 40 }, goals });
  w.inventory.oak_planks = 40;
  goals.obtainInline = async request => { requests.push(request); w.inventory.oak_planks = 56; return { status: 'succeeded' }; };
  const inspected = w.builder.inspect({ blueprint: 'hut' });
  assert.equal(inspected.need, 55);
  assert.equal(inspected.have, 40);
  assert.equal(inspected.material, 'oak_planks');
  const result = await w.builder.build({ blueprint: 'hut', traceId: 'x' }).done;
  assert.equal(result.status, 'succeeded');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].item, 'oak_planks');
  assert.equal(requests[0].count, 55);

  const failing = fakeWorld({ stock: { oak_planks: 10 }, goals: { preferredLog: () => 'oak_log',
    obtainInline: async () => ({ status: 'failed', reason: 'no_logs' }) } });
  const failed = await failing.builder.build({ blueprint: 'hut' }).done;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.reason, 'materials_failed');
  assert.equal(failed.detail, 'no_logs');
  assert.equal(failing.calls.filter(c => c.name === 'place' || c.name === 'command').length, 0);
});

test('with no planks the material comes from the preferred log', () => {
  const w = fakeWorld({ stock: {}, goals: { preferredLog: () => 'birch_log', obtainInline: async () => ({ status: 'succeeded' }) } });
  assert.equal(w.builder.inspect({ blueprint: 'hut' }).material, 'birch_planks');
  const most = fakeWorld({ stock: { oak_planks: 3, spruce_planks: 20 } });
  assert.equal(most.builder.inspect({ blueprint: 'hut' }).material, 'spruce_planks');
});

test('a cancelled build keeps its frame and a second build resumes at the same site', async () => {
  let w;
  let cancelled = false;
  w = fakeWorld({ onPlace: placed => { if (placed === 20 && !cancelled) { cancelled = true; w.arbiter.cancel('owner'); } } });
  const first = await w.builder.build({ blueprint: 'hut' }).done;
  assert.equal(first.status, 'cancelled');
  assert.ok(first.placed >= 20 && first.placed < 55);
  const lastCommand = w.calls.filter(c => c.name === 'command').at(-1).params;
  assert.notEqual(boxCells(lastCommand).length, 75, 'no cleanup clear after a cancel');
  const glass = [...w.world.values()].filter(name => name === 'light_blue_stained_glass').length;
  assert.ok(glass > 0, 'the frame stays');
  w.calls.length = 0;
  const inspected = w.builder.inspect({ blueprint: 'hut' });
  assert.equal(inspected.site.resumed, true);
  assert.deepEqual(inspected.site.origin, first.site.origin);
  const second = await w.builder.build({ blueprint: 'hut' }).done;
  assert.equal(second.status, 'succeeded');
  assert.equal(second.placed, 55);
  assert.equal(w.events.filter(e => e.kind === 'build.start').at(-1).payload.resumed, true);
  assert.equal(w.calls.filter(c => c.name === 'place').length, 55 - first.placed, 'placed cells are skipped on resume');
  assert.equal([...w.world.values()].filter(name => name === 'light_blue_stained_glass').length, 0);
});

test('an unplaceable cell fails with blocked after a retry and still cleans up the frame', async () => {
  const w = fakeWorld({ failCell: '2,0,-2' });
  const result = await w.builder.build({ blueprint: 'hut' }).done;
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'blocked');
  assert.equal(result.detail, 1);
  assert.equal(result.placed, 54);
  assert.equal(w.calls.filter(c => c.name === 'place' && key(c.params) === '2,0,-2').length, 2);
  const lastCommand = w.calls.filter(c => c.name === 'command').at(-1).params;
  assert.equal(boxCells(lastCommand).length, 75);
  assert.equal([...w.world.values()].filter(name => name === 'light_blue_stained_glass').length, 0);
});

test('builder reports no_site and unknown blueprints without moving', async () => {
  const stone = new Map();
  for (let x = -16; x <= 16; x++) for (let z = -16; z <= 16; z++) for (let y = 0; y <= 6; y++) stone.set(key({ x, y, z }), 'stone');
  const w = fakeWorld({ blocks: stone });
  assert.deepEqual(w.builder.inspect({ blueprint: 'hut' }), { ok: false, reason: 'no_site' });
  const result = await w.builder.build({ blueprint: 'hut' }).done;
  assert.equal(result.reason, 'no_site');
  assert.equal(w.calls.length, 0);
  assert.equal(w.builder.inspect({ blueprint: 'castle' }).reason, 'unknown_blueprint');
});

test('running out of planks mid-build fails materials_failed', async () => {
  const w = fakeWorld({ stock: { oak_planks: 30 }, goals: { preferredLog: () => 'oak_log', obtainInline: async () => ({ status: 'succeeded' }) } });
  const result = await w.builder.build({ blueprint: 'hut' }).done;
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'materials_failed');
  assert.equal(result.detail, 'out_of_material');
  assert.equal(result.placed, 30);
});

const glassCount = w => [...w.world.values()].filter(name => name === 'light_blue_stained_glass').length;

test('a segment clear failing mid-build still gets the final whole-volume clear', async () => {
  let clears = 0;
  const w = fakeWorld({ commandHook: params => {
    if (params.kind === 'clear' && boxCells(params).length < 75 && ++clears === 3) return { ok: false, error: { code: 'rate_limited' } };
    return null;
  } });
  const result = await w.builder.build({ blueprint: 'hut' }).done;
  assert.equal(result.frame, false);
  const last = w.calls.filter(c => c.name === 'command').at(-1).params;
  assert.equal(last.kind, 'clear');
  assert.equal(boxCells(last).length, 75);
  assert.equal(glassCount(w), 0);
});

test('a resumed site whose frame fill is refused still attempts the final whole-volume clear', async () => {
  let cancelled = false;
  let w;
  w = fakeWorld({ onPlace: placed => { if (placed === 20 && !cancelled) { cancelled = true; w.arbiter.cancel('owner'); } },
    commandHook: params => (w.denyFill && params.kind === 'fill' ? { ok: false, error: { code: 'no_permission' } } : null) });
  assert.equal((await w.builder.build({ blueprint: 'hut' }).done).status, 'cancelled');
  assert.ok(glassCount(w) > 0);
  w.denyFill = true;
  w.calls.length = 0;
  const result = await w.builder.build({ blueprint: 'hut' }).done;
  assert.equal(w.events.filter(e => e.kind === 'build.start').at(-1).payload.resumed, true);
  assert.equal(result.frame, false);
  const commands = w.calls.filter(c => c.name === 'command');
  assert.equal(commands[0].params.kind, 'fill');
  const last = commands.at(-1).params;
  assert.equal(last.kind, 'clear');
  assert.equal(boxCells(last).length, 75);
  assert.equal(glassCount(w), 0);
});
