// P0 probe simulator — offline, deterministic, zero network.
// World is a 64x10x64 grid (P3: enlarged from
// 24x24x10 so the P0r2 set can live in its own coordinate region around
// (40,3,40) without colliding with P0/P0r literals); entities live in an
// entity table; the bot is a plain object exposing just enough of the
// mineflayer surface for the REAL registry validate() (dig.unsafeReason,
// lookAt enderman check, protection.contains) and the REAL resolveStep
// ($owner / $self.below / $self.front / id bindings) to run unchanged.
//
// Primitive semantics are re-implemented per spec (BFS goTo, atomic
// craft/smelt, chest inventories) — the fake bot cannot drive real
// pathfinder/window flows, so registry.run() is wrapped to dispatch into the
// sim implementations below while has()/validate()/describe()/list() still
// come from createPrimitiveRegistry. The two PROPOSED query primitives
// (findEntity, blockAt) are added on top so validateDraft's registry.has()
// check accepts them.

import { createRequire } from 'node:module';
import { createPrimitiveRegistry } from '../../src/primitives/registry.js';
import { resolveStep } from '../../src/skills/bindings.js';
import { interpret } from '../../src/skills/interpreter.js';
import { ensureReach } from '../../src/skills/approach.js';
import { fuelNeeded, fuelValue, smeltOutput } from '../../src/decision/smelting.js';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3');
const mcData = require('minecraft-data')('1.20.4');

export const OWNER_UUID = 'aaaaaaaa-0000-4000-8000-0000000000aa';
export const BOT_UUID = 'bbbbbbbb-0000-4000-8000-0000000000bb';
export const WORLD = { x: 64, y: 10, z: 64 }; // P3: was 24x24x10 — P0r2 tasks anchor at (40,3,40)
export const STEP_BUDGET = 24; // spec: 技能 v2 taught 上限

const key = (x, y, z) => `${x},${y},${z}`;
const NON_SOLID = new Set(['air', 'cave_air', 'void_air', 'water', 'lava',
  'short_grass', 'tall_grass', 'dandelion', 'poppy', 'torch']);
const PASSABLE = new Set(['air', 'cave_air', 'void_air']);
const CONTAINERS = new Set(['chest', 'trapped_chest', 'barrel']);
const DROPS = { oak_log: 'oak_log', spruce_log: 'spruce_log', birch_log: 'birch_log',
  stone: 'cobblestone', iron_ore: 'raw_iron', coal_ore: 'coal', dirt: 'dirt',
  grass_block: 'dirt', sand: 'sand' };
// P0r: killed mobs leave their honest vanilla drop so kill→collect chains
// (tasks 35/44) can be measured. Map mirrors the block DROPS table above.
const MOB_DROPS = { zombie: 'rotten_flesh', skeleton: 'bone', spider: 'string',
  creeper: 'gunpowder', pig: 'porkchop', cow: 'beef', sheep: 'mutton',
  chicken: 'chicken' };
const FOODS = { bread: 5, apple: 4, cooked_beef: 8, cooked_porkchop: 8,
  cooked_mutton: 6, cooked_chicken: 6, baked_potato: 5, cookie: 2, rotten_flesh: 4 };
const RECIPES = {
  oak_planks: { gives: 4, needs: { oak_log: 1 }, table: false },
  stick: { gives: 4, needs: { oak_planks: 2 }, table: false },
  crafting_table: { gives: 1, needs: { oak_planks: 4 }, table: false },
  wooden_pickaxe: { gives: 1, needs: { oak_planks: 3, stick: 2 }, table: true },
  stone_pickaxe: { gives: 1, needs: { cobblestone: 3, stick: 2 }, table: true },
  white_bed: { gives: 1, needs: { oak_planks: 3, white_wool: 3 }, table: true },
  furnace: { gives: 1, needs: { cobblestone: 8 }, table: true },
};

const fail = (code, message) => { throw Object.assign(new Error(message ?? code), { code }); };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export function createSim() {
  const blocks = new Map(); // "x,y,z" -> block name
  const sim = {
    blocks,
    entities: new Map(), // uuid -> entity record
    containers: new Map(), // "x,y,z" -> Map(item -> count)
    given: [], // { itemName, count } tossed to the owner
    said: [], // chat messages sent via say
    looked: null, // last lookAt target
    slept: false,
    following: false,
    ownerUuid: OWNER_UUID,
    protection: null, // tasks may assign { contains({x,y,z}) }
    steps: 0,
    bot: null,
  };
  sim.bot = {
    entities: {},
    players: {},
    health: 20,
    food: 20,
    isSleeping: false,
    ownerUuid: OWNER_UUID,
    entity: {
      uuid: BOT_UUID,
      position: new Vec3(12, 1, 12),
      yaw: 0, // mineflayer convention: 0 faces -Z, pi/2 faces -X
      onGround: true,
      isValid: true,
    },
    heldItem: null,
    inventory: {
      items: () => [...sim.inventory.entries()].map(([name, count]) => ({ name, count })),
    },
    blockAt: (vec) => {
      const name = sim.blockAt(Math.floor(vec.x), Math.floor(vec.y), Math.floor(vec.z));
      if (name === null) return null;
      return { name, position: new Vec3(Math.floor(vec.x), Math.floor(vec.y), Math.floor(vec.z)),
        boundingBox: PASSABLE.has(name) ? 'empty' : 'block', getProperties: () => ({}) };
    },
  };
  sim.inventory = new Map(); // itemName -> count

  // --- world helpers used by tasks.setup -------------------------------------
  sim.setBlock = (x, y, z, name) => { blocks.set(key(x, y, z), name); };
  sim.blockAt = (x, y, z) => {
    if (x < 0 || y < 0 || z < 0 || x >= WORLD.x || y >= WORLD.y || z >= WORLD.z) return null;
    return blocks.get(key(x, y, z)) ?? 'air';
  };
  sim.flat = (floor = 'grass_block') => {
    sim.floorBlock = floor;
    for (let x = 0; x < WORLD.x; x++) for (let z = 0; z < WORLD.z; z++) sim.setBlock(x, 0, z, floor);
  };
  // P3: move the bot without pathing (task setup only — P0r2 anchors every
  // world at (40,3,40) instead of createSim's default (12,1,12)).
  sim.teleport = (x, y, z) => { sim.bot.entity.position = new Vec3(x, y, z); };
  sim.addEntity = ({ name, uuid, x, y, z, type = 'hostile', drop = null }) => {
    const entity = { uuid, name, type, position: new Vec3(x, y, z), isValid: true, height: 1.8 };
    if (drop) { entity.type = 'drop'; entity.drop = drop; }
    sim.entities.set(uuid, entity);
    sim.bot.entities[uuid] = entity;
    return entity;
  };
  sim.addOwner = (x, y, z) => sim.addEntity({ name: 'player', uuid: OWNER_UUID, x, y, z, type: 'player' });
  sim.addDrop = (x, y, z, itemName, count = 1) => sim.addEntity({
    name: 'item', uuid: `drop-${x}-${y}-${z}-${itemName}`, x, y, z, drop: { itemName, count } });
  sim.give = (itemName, count = 1) => sim.inventory.set(itemName, (sim.inventory.get(itemName) ?? 0) + count);
  sim.count = itemName => sim.inventory.get(itemName) ?? 0;
  sim.take = (itemName, count) => {
    const have = sim.count(itemName);
    if (have < count) fail('not_enough_items', `need ${count} ${itemName}, have ${have}`);
    sim.inventory.set(itemName, have - count);
  };
  sim.containerAt = (x, y, z) => {
    const k = key(x, y, z);
    if (!sim.containers.has(k)) sim.containers.set(k, new Map());
    return sim.containers.get(k);
  };
  sim.containerTotal = (x, y, z, itemName) => sim.containers.get(key(x, y, z))?.get(itemName) ?? 0;
  sim.owner = () => sim.entities.get(OWNER_UUID) ?? null;
  return sim;
}

// --- movement ---------------------------------------------------------------

const solid = (sim, x, y, z) => {
  const name = sim.blockAt(x, y, z);
  return name !== null && !NON_SOLID.has(name);
};
const passable = (sim, x, y, z) => {
  const name = sim.blockAt(x, y, z);
  return name !== null && PASSABLE.has(name);
};
const standable = (sim, x, y, z) => solid(sim, x, y - 1, z)
  && passable(sim, x, y, z) && passable(sim, x, y + 1, z);

// BFS over standable cells: step up 1, drop up to 3 (aligned with safe Movements).
export function findPath(sim, from, toCell, range) {
  const target = { x: toCell.x, y: toCell.y, z: toCell.z };
  const start = { x: Math.floor(from.x), y: Math.floor(from.y), z: Math.floor(from.z) };
  const seen = new Set([key(start.x, start.y, start.z)]);
  const queue = [start];
  let best = standable(sim, start.x, start.y, start.z) ? start : null;
  let bestDist = best ? dist(best, target) : Infinity;
  let bestDy = best ? Math.abs(best.y - target.y) : Infinity;
  while (queue.length) {
    const cell = queue.shift();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cell.x + dx, nz = cell.z + dz;
      const candidates = [];
      if (standable(sim, nx, cell.y, nz)) candidates.push({ x: nx, y: cell.y, z: nz });
      // step up one: headroom at current cell is required to climb
      if (standable(sim, nx, cell.y + 1, nz) && passable(sim, cell.x, cell.y + 2, cell.z)) {
        candidates.push({ x: nx, y: cell.y + 1, z: nz });
      }
      // drop down up to 3: first standable ledge below, through passable cells only
      for (let k = 1; k <= 3; k++) {
        const ny = cell.y - k;
        if (!passable(sim, nx, ny, nz)) break; // solid column, cannot fall further
        if (standable(sim, nx, ny, nz)) { candidates.push({ x: nx, y: ny, z: nz }); break; }
      }
      for (const next of candidates) {
        const k = key(next.x, next.y, next.z);
        if (seen.has(k)) continue;
        seen.add(k);
        const d = dist(next, target);
        const dy = Math.abs(next.y - target.y);
        // tie-break toward the target's own height so goTo(at:log) lands
        // beside the block, not on top of it (digging it from above would be
        // 'unsafe_below' under the real submission-time checks).
        if (d < bestDist || (d === bestDist && dy < bestDy)) { best = next; bestDist = d; bestDy = dy; }
        queue.push(next);
      }
    }
  }
  if (!best || bestDist > range) return null;
  return best;
}

function moveTo(sim, cell) {
  sim.bot.entity.position = new Vec3(cell.x, cell.y, cell.z);
}

function navWithin(sim, target, range, code = 'NoPath') {
  const cell = findPath(sim, sim.bot.entity.position, target, range);
  if (!cell) fail(code, `No path within ${range} of ${target.x},${target.y},${target.z}`);
  moveTo(sim, cell);
  return cell;
}

// --- primitive implementations (sim semantics per spec) ---------------------

const impls = {
  goTo(sim, { x, y, z, range = 1 }) {
    const cell = navWithin(sim, { x, y, z }, range);
    return { x: cell.x, y: cell.y, z: cell.z };
  },
  goToEntity(sim, { uuid, range = 2 }) {
    const entity = sim.entities.get(uuid) ?? [...sim.entities.values()]
      .find(e => e.uuid?.toLowerCase() === String(uuid).toLowerCase());
    if (!entity || entity.isValid === false) fail('target_not_found', `Entity not found: ${uuid}`);
    navWithin(sim, entity.position, range);
    const p = entity.position;
    return { x: p.x, y: p.y, z: p.z };
  },
  lookAt(sim, { x, y, z }) {
    const p = sim.bot.entity.position;
    sim.bot.entity.yaw = Math.atan2(-(x - p.x), -(z - p.z));
    sim.looked = { x, y, z };
    return null;
  },
  say(sim, { text }) {
    sim.said.push(text);
    return null;
  },
  findBlock(sim, { blockName, maxDistance = 32, x, y, z }) {
    const radius = Math.min(maxDistance, 16); // spec: 半径 16
    // P2 B: explicit x/y/z re-centers the search (all-or-none and the 32-block
    // ambit are enforced by the real checked() path in validate()).
    const from = x === undefined ? sim.bot.entity.position : { x, y, z };
    let best = null, bestD = Infinity;
    for (const [k, name] of sim.blocks) {
      if (name !== blockName) continue;
      const [x, y, z] = k.split(',').map(Number);
      if (dist({ x, y, z }, from) > radius) continue;
      if (sim.protection?.contains({ x, y, z })) continue;
      const d = dist({ x, y, z }, from);
      if (d < bestD) { best = { x, y, z, blockName: name }; bestD = d; }
    }
    return best;
  },
  findEntity(sim, { entityName, radius = 16, x, y, z }) {
    // P2 B: same search-center override as the real primitive.
    const from = x === undefined ? sim.bot.entity.position : { x, y, z };
    let best = null, bestD = Infinity;
    for (const e of sim.entities.values()) {
      if (e.isValid === false || e.type === 'drop' || e.uuid === BOT_UUID) continue;
      if (entityName !== 'player' && e.name !== entityName) continue;
      if (entityName === 'player' && e.type !== 'player') continue;
      const d = dist(e.position, from);
      if (d <= radius && d < bestD) { best = e; bestD = d; }
    }
    if (!best) return null;
    const p = best.position;
    return { x: p.x, y: p.y, z: p.z, entityName: best.name, uuid: best.uuid };
  },
  blockAt(sim, { x, y, z }) {
    const from = sim.bot.entity.position;
    if (dist({ x, y, z }, from) > 16) return null; // beyond sim sight range
    const name = sim.blockAt(x, y, z);
    if (name === null) return null;
    return { x, y, z, blockName: name };
  },
  dig(sim, { x, y, z }) {
    const p = sim.bot.entity.position;
    // real check: distance from the eye to the block <= 4.5
    if (dist({ x: p.x, y: p.y + 1.62, z: p.z }, { x: x + 0.5, y: y + 0.5, z: z + 0.5 }) > 4.5) {
      fail('out_of_reach', 'Block is beyond dig reach (4.5 blocks)');
    }
    if (sim.protection?.contains({ x, y, z })) fail('protected', 'Block is protected');
    const name = sim.blockAt(x, y, z);
    if (!name || PASSABLE.has(name)) fail('not_diggable', 'Target block is not diggable');
    sim.setBlock(x, y, z, 'air');
    const item = DROPS[name];
    if (item) sim.addDrop(x + 0.5, y + 0.5, z + 0.5, item, 1);
    return { x, y, z };
  },
  collectDrops(sim, { radius = 6 }) {
    const p = sim.bot.entity.position;
    const picked = {};
    for (const [uuid, e] of [...sim.entities]) {
      if (e.type !== 'drop' || e.isValid === false) continue;
      if (dist(e.position, p) > radius) continue;
      sim.give(e.drop.itemName, e.drop.count);
      picked[e.drop.itemName] = (picked[e.drop.itemName] ?? 0) + e.drop.count;
      e.isValid = false;
      sim.entities.delete(uuid);
      delete sim.bot.entities[uuid];
    }
    return { collected: Object.values(picked).reduce((a, b) => a + b, 0), items: picked };
  },
  countItem(sim, { itemName }) {
    return sim.count(itemName);
  },
  craft(sim, { itemName, count = 1, x, y, z }) {
    const recipe = RECIPES[itemName];
    if (!recipe) fail('no_recipe', `No sim recipe for ${itemName}`);
    if (recipe.table) {
      if (x !== undefined) {
        // `at` binds the table position — same contract as the real craft.
        if (sim.blockAt(x, y, z) !== 'crafting_table') {
          fail('no_table', 'No crafting table at the bound position');
        }
      } else {
        const p = sim.bot.entity.position;
        const near = [...sim.blocks.entries()].some(([k, name]) => {
          if (name !== 'crafting_table') return false;
          const [x, y, z] = k.split(',').map(Number);
          return dist({ x, y, z }, p) <= 4.5;
        });
        if (!near) fail('no_table', 'No crafting table within 4.5 blocks');
      }
    }
    const crafts = Math.ceil(count / recipe.gives);
    for (const [input, per] of Object.entries(recipe.needs)) {
      if (sim.count(input) < per * crafts) fail('missing_ingredients', `need ${per * crafts} ${input}`);
    }
    for (const [input, per] of Object.entries(recipe.needs)) sim.take(input, per * crafts);
    sim.give(itemName, crafts * recipe.gives);
    return { itemName, crafted: crafts * recipe.gives };
  },
  place(sim, { itemName, x, y, z }) {
    const p = sim.bot.entity.position;
    if (dist({ x: p.x, y: p.y + 1.62, z: p.z }, { x: x + 0.5, y: y + 0.5, z: z + 0.5 }) > 4.5) {
      fail('out_of_reach', 'Target is beyond place reach (4.5 blocks)');
    }
    if (!PASSABLE.has(sim.blockAt(x, y, z) ?? 'x')) fail('occupied', 'Target position is not empty');
    const hasSolidFace = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
      .some(([dx, dy, dz]) => solid(sim, x + dx, y + dy, z + dz));
    if (!hasSolidFace) fail('no_reference', 'No adjacent solid reference block');
    sim.take(itemName, 1);
    sim.setBlock(x, y, z, itemName);
    return { x, y, z };
  },
  follow(sim, { range = 2 }) {
    const owner = sim.owner();
    if (!owner) fail('owner_not_found', '找不到玩家');
    navWithin(sim, owner.position, range);
    sim.following = true;
    const p = owner.position;
    return { x: p.x, y: p.y, z: p.z };
  },
  equip(sim, { itemName, slot = 'hand' }) {
    if (sim.count(itemName) < 1) fail('missing_item', `Item not in inventory: ${itemName}`);
    if (slot === 'hand') sim.bot.heldItem = itemName;
    return { itemName, slot };
  },
  eat(sim, { itemName }) {
    if (sim.bot.food >= 20) fail('not_hungry', 'not_hungry');
    const pick = itemName ?? Object.keys(FOODS).find(name => sim.count(name) > 0);
    if (!pick || !FOODS[pick]) fail(itemName ? 'unsafe_food' : 'no_food', 'no edible food');
    if (sim.count(pick) < 1) fail('no_food', `no ${pick} in inventory`);
    const before = sim.bot.food;
    sim.take(pick, 1);
    sim.bot.food = Math.min(20, before + FOODS[pick]);
    return { itemName: pick, foodBefore: before, foodAfter: sim.bot.food };
  },
  attack(sim, { entityName }) {
    const p = sim.bot.entity.position;
    const target = [...sim.entities.values()]
      .filter(e => e.isValid !== false && e.type !== 'drop' && e.type !== 'player'
        && e.name === entityName && dist(e.position, p) <= 16)
      .sort((a, b) => dist(a.position, p) - dist(b.position, p))[0];
    if (!target) fail('target_not_found', `No ${entityName} nearby`);
    // The real primitive chases GoalFollow(2) inside its own run.
    navWithin(sim, target.position, 2);
    target.isValid = false;
    sim.entities.delete(target.uuid);
    delete sim.bot.entities[target.uuid];
    const loot = MOB_DROPS[target.name];
    if (loot) sim.addDrop(target.position.x, target.position.y, target.position.z, loot, 1);
    return { entityName, hits: 1, killed: true };
  },
  give(sim, { itemName, count = 1 }) {
    const owner = sim.owner();
    if (!owner) fail('owner_not_found', 'owner_not_visible');
    // The real primitive navigates GoalFollow(1.2) before its reach check.
    navWithin(sim, owner.position, 2.5);
    if (dist(owner.position, sim.bot.entity.position) > 2.5) {
      fail('owner_out_of_reach', 'Owner is beyond give reach (2.5 blocks)');
    }
    sim.take(itemName, count);
    sim.given.push({ itemName, count });
    return { itemName, given: count };
  },
  sleep(sim) {
    const p = sim.bot.entity.position;
    let bed = null;
    for (const [k, name] of sim.blocks) {
      if (!name.endsWith('_bed')) continue;
      const [x, y, z] = k.split(',').map(Number);
      if (dist({ x, y, z }, p) <= 16) { bed = { x, y, z }; break; }
    }
    if (!bed) fail('no_bed', 'no_bed');
    navWithin(sim, bed, 2);
    sim.bot.isSleeping = true;
    sim.slept = true;
    return { ...bed };
  },
  smelt(sim, { itemName, count = 1, fuel, x, y, z }) {
    const output = smeltOutput(itemName);
    if (!output) fail('not_smeltable', `${itemName} cannot be smelted`);
    const p = sim.bot.entity.position;
    // `at` binds the furnace position — same contract as the real smelt.
    const furnace = x !== undefined
      ? sim.blockAt(x, y, z) === 'furnace'
      : [...sim.blocks.entries()].some(([k, name]) => {
        if (name !== 'furnace') return false;
        const [x, y, z] = k.split(',').map(Number);
        return dist({ x, y, z }, p) <= 4.5;
      });
    if (!furnace) fail('no_furnace', x !== undefined ? 'No furnace at the bound position' : 'No furnace within 4.5 blocks');
    const fuelCount = fuelNeeded(fuel, count);
    if (!Number.isFinite(fuelCount) || fuelValue(fuel) <= 0) fail('bad_fuel', `${fuel} is not fuel`);
    if (sim.count(itemName) < count) fail('missing_ingredients', `need ${count} ${itemName}`);
    if (sim.count(fuel) < fuelCount) fail('missing_fuel', `need ${fuelCount} ${fuel}`);
    sim.take(itemName, count);
    sim.take(fuel, fuelCount);
    sim.give(output, count);
    return { itemName, output, count, fuel };
  },
  deposit(sim, { itemName, count }) {
    const p = sim.bot.entity.position;
    let chest = null, bestD = Infinity;
    for (const [k, name] of sim.blocks) {
      if (!CONTAINERS.has(name)) continue;
      const [x, y, z] = k.split(',').map(Number);
      const d = dist({ x, y, z }, p);
      if (d <= 16 && d < bestD) { chest = { x, y, z }; bestD = d; }
    }
    if (!chest) fail('no_container', 'No chest or barrel within 16 blocks');
    // The real primitive navigates GoalNear(2) inside its own run.
    navWithin(sim, chest, 2);
    const moved = Math.min(count, sim.count(itemName));
    if (moved <= 0) fail('missing_item', `no ${itemName} in inventory`);
    sim.take(itemName, moved);
    const box = sim.containerAt(chest.x, chest.y, chest.z);
    box.set(itemName, (box.get(itemName) ?? 0) + moved);
    return { itemName, moved, container: chest };
  },
  withdraw(sim, { itemName, count = 1 }) {
    const p = sim.bot.entity.position;
    let chest = null, bestD = Infinity;
    for (const [k, name] of sim.blocks) {
      if (!CONTAINERS.has(name)) continue;
      const [x, y, z] = k.split(',').map(Number);
      const d = dist({ x, y, z }, p);
      if (d <= 16 && d < bestD) { chest = { x, y, z }; bestD = d; }
    }
    if (!chest) fail('no_container', 'No chest or barrel within 16 blocks');
    // The real primitive navigates GoalNear(2) inside its own run.
    navWithin(sim, chest, 2);
    const box = sim.containerAt(chest.x, chest.y, chest.z);
    const moved = Math.min(count, box.get(itemName) ?? 0);
    if (moved <= 0) fail('not_in_container', `no ${itemName} in container`);
    box.set(itemName, box.get(itemName) - moved);
    sim.give(itemName, moved);
    return { itemName, moved, container: chest };
  },
  // --- P1 free query primitives (post-T29 the real registry lists them;
  // the interpreter drives healthBelow/foodBelow/hasEffect conditions
  // through `body`, so these need sim impls to stay a faithful mirror) ---
  pos(sim) {
    const p = sim.bot.entity.position;
    return { x: p.x, y: p.y, z: p.z };
  },
  inventory(sim) {
    return { slots: [...sim.inventory.entries()].map(([name, count]) => ({ name, count })), free: null };
  },
  heldItem(sim) {
    return sim.bot.heldItem ? { name: sim.bot.heldItem, count: 1 } : null;
  },
  body(sim) {
    return { health: sim.bot.health, food: sim.bot.food, oxygen: null,
      onGround: sim.bot.entity?.onGround ?? null, effects: [] };
  },
};

// --- proposed query primitives (P1 candidates, measured here) ----------------

const proposed = new Map([
  // Post-T29: the real registry grew its own free findEntity/blockAt (P1 §1);
  // these overrides stay so validation keeps the spec's 16-block sight radius
  // and null-on-miss semantics, and are marked free to match production.
  { name: 'findEntity', description: 'Find the nearest entity matching entityName within radius, or return null. Result has x,y,z + entityName + uuid. Optional integer x/y/z re-center the search within the 32-block ambit.',
    params: { entityName: { type: 'string', required: true, minLength: 1, catalog: 'entitiesByName' },
      radius: { type: 'number', exclusiveMin: 0, default: 16 },
      x: { type: 'number', integer: true }, y: { type: 'number', integer: true },
      z: { type: 'number', integer: true } }, defaultTimeoutMs: 5000, free: true },
  { name: 'blockAt', description: 'Return the block name at exact coordinates within 16, or null. Result has x,y,z + blockName.',
    params: { x: { type: 'number', required: true, integer: true },
      y: { type: 'number', required: true, integer: true },
      z: { type: 'number', required: true, integer: true } }, defaultTimeoutMs: 2000, free: true },
].map(m => [m.name, m]));

// Minimal mirror of registry.js validate() for the proposed primitives only.
function validateProposed(schema, input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('Invalid parameter params: expected an object'), { name: 'InvalidParamsError' });
  }
  for (const field of Object.keys(input)) {
    if (!Object.hasOwn(schema, field)) {
      throw Object.assign(new Error(`Invalid parameter ${field}: unknown field`), { name: 'InvalidParamsError' });
    }
  }
  const out = {};
  for (const [field, rule] of Object.entries(schema)) {
    const value = Object.hasOwn(input, field) ? input[field] : rule.default;
    if (value === undefined) {
      if (rule.required) throw Object.assign(new Error(`Invalid parameter ${field}: required`), { name: 'InvalidParamsError' });
      continue;
    }
    if (typeof value !== rule.type) throw Object.assign(new Error(`Invalid parameter ${field}: expected ${rule.type}`), { name: 'InvalidParamsError' });
    if (rule.integer && !Number.isSafeInteger(value)) throw Object.assign(new Error(`Invalid parameter ${field}: must be a safe integer`), { name: 'InvalidParamsError' });
    if (rule.exclusiveMin !== undefined && value <= rule.exclusiveMin) throw Object.assign(new Error(`Invalid parameter ${field}: must be > ${rule.exclusiveMin}`), { name: 'InvalidParamsError' });
    if (rule.catalog && !Object.hasOwn(mcData[rule.catalog] ?? {}, value)) throw Object.assign(new Error(`Invalid parameter ${field}: unknown Minecraft name`), { name: 'InvalidParamsError' });
    out[field] = value;
  }
  return out;
}

// --- probe context: sim + wrapped registry + skill executor ------------------

export function createProbeContext(sim) {
  // Real registry supplies has()/validate()/describe()/list() plus all
  // submission-time checks (protection, unsafe dig, smelt tables, attack
  // whitelist) against the fake bot.
  const base = createPrimitiveRegistry({ bot: sim.bot, mcData, ownerUuid: sim.ownerUuid,
    protection: sim.protection });
  const registry = {
    protection: sim.protection,
    has: name => base.has(name) || proposed.has(name),
    // Deduped: post-T29 the real registry already lists findEntity/blockAt.
    list: () => [...new Set([...base.list(), ...proposed.keys()])],
    validate(name, input, opts) {
      if (proposed.has(name)) {
        const params = validateProposed(proposed.get(name).params, input);
        // P2 B: the proposed findEntity bypasses the real checked(), so its
        // search-center rules are mirrored here — all-or-none coordinates and
        // the same out_of_ambit rejection (deferred exactly when format.js
        // marks a draft-probe's placeholder coordinates, same as the real
        // registry). (blockAt is a point query: its required coordinates stay
        // untouched, per spec.)
        if (name === 'findEntity') {
          const given = ['x', 'y', 'z'].filter(key => params[key] !== undefined);
          if (given.length > 0 && given.length < 3) {
            throw Object.assign(new Error('Invalid parameter params: x, y and z must be given together'),
              { name: 'InvalidParamsError', field: 'params' });
          }
          const origin = sim.bot.entity?.position;
          if (given.length === 3 && origin && !opts?.deferAmbit && dist(origin, params) > 32) {
            throw Object.assign(new Error(`${name} target is beyond the 32-block ambit`),
              { name: 'Error', code: 'out_of_ambit' });
          }
        }
        return params;
      }
      // P3: `at`-bound nodes and `$id.x`-style coordinate refs reach validate()
      // with { deferAmbit:true } from format.js — the real checked() skips the
      // placeholder-vs-origin distance check exactly like production.
      return base.validate(name, input, opts);
    },
    describe(name) {
      if (proposed.has(name)) return structuredClone(proposed.get(name));
      return base.describe(name);
    },
    // run() keeps the real checked() path via validate(), then dispatches to
    // the sim implementation instead of the real primitive code.
    async run(name, input = {}, options = {}) {
      void options;
      let params;
      try {
        params = registry.validate(name, input);
      } catch (error) {
        return { ok: false, error: { name: error?.name ?? 'Error', message: error?.message ?? String(error),
          ...(error?.code ? { code: error.code } : {}), ...(error?.field ? { field: error.field } : {}) } };
      }
      const impl = impls[name];
      if (!impl) return { ok: false, error: { name: 'Error', message: `no sim impl for ${name}`, code: 'unimplemented' } };
      try {
        const result = await impl(sim, params);
        return { ok: true, result, cancelled: false, timed_out: false };
      } catch (error) {
        return { ok: false, error: { name: error?.name ?? 'Error', message: error?.message ?? String(error),
          ...(error?.code ? { code: error.code } : {}) } };
      }
    },
  };

  // Real interpreter + real resolveStep bindings; arbiter-equivalent result
  // plumbing (id -> bindings, blockNames side-channel, first failure wins).
  // P3: `library` is a Map name->skill draft ({name,params,body,description})
  // so tasks with a seeded skill library can execute `call` nodes — the same
  // draft objects validateDraft's `skills` option checks the call graph
  // against. Empty by default (call then fails unknown_skill, as before).
  async function executeBody(draft, { stepBudget = STEP_BUDGET, library } = {}) {
    const trace = [];
    const results = [];
    let steps = 0;
    let runError = null;
    let crashed = null;
    try {
      await interpret({
        program: { body: draft.body, params: draft.params ?? {}, args: {} },
        library: library ?? new Map(),
        trace,
        isActive: () => runError === null,
        async runPrimitive(step, bindings) {
          if (runError) return null;
          steps++;
          if (steps > stepBudget) {
            runError = { code: 'budget_exceeded', message: `step budget ${stepBudget} exceeded` };
            throw Object.assign(new Error('budget_exceeded'), { code: 'budget_exceeded' });
          }
          let result;
          try {
            const resolved = resolveStep(step, bindings, { bot: sim.bot, ownerUuid: sim.ownerUuid });
            // Same auto-approach as the production arbiter: reach-declaring
            // primitives walk into range via an implicit goTo first.
            const approached = await ensureReach({
              primitive: resolved.primitive, params: resolved.params,
              origin: sim.bot.entity.position,
              run: (name, params) => registry.run(name, params),
            });
            if (approached && !approached.ok) result = approached;
            else result = await registry.run(resolved.primitive, resolved.params,
              { timeoutMs: resolved.timeoutMs });
          } catch (error) {
            result = { ok: false, error: { name: error?.name ?? 'Error', message: error?.message ?? String(error),
              ...(error?.code ? { code: error.code } : {}), ...(error?.blockName ? { blockName: error.blockName } : {}) } };
          }
          results.push(result);
          if (!result.ok) { runError = result.error; return null; }
          if (step.id !== undefined) {
            bindings.set(step.id, result.result);
            if (step.params?.blockName) bindings.blockNames.set(step.id, step.params.blockName);
          }
          return result.result;
        },
        // obtain delegates to the goal subsystem, which the probe does not
        // simulate — fail loudly so cells using it are visibly marked.
        async obtain() { throw Object.assign(new Error('obtain_unavailable'), { code: 'obtain_unavailable' }); },
      });
    } catch (error) {
      crashed = { name: error?.name ?? 'Error', message: error?.message ?? String(error),
        ...(error?.code ? { code: error.code } : {}) };
    }
    return {
      steps, results, trace,
      error: runError ?? crashed ?? null,
      // executed = the program ran its course without a primitive/harness failure
      executed: runError === null && crashed === null,
    };
  }

  return { sim, registry, executeBody };
}

// --- world summary for prompts ----------------------------------------------

const INTERESTING = new Set(['chest', 'trapped_chest', 'barrel', 'furnace', 'crafting_table',
  'iron_ore', 'coal_ore', 'oak_log', 'spruce_log', 'dirt', 'grass_block', 'stone',
  'sand', 'white_bed', 'oak_planks']);

export function summarize(sim) {
  const p = sim.bot.entity.position;
  const facing = ['north (-Z)', 'west (-X)', 'south (+Z)', 'east (+X)'][
    ((Math.round(sim.bot.entity.yaw / (Math.PI / 2)) % 4) + 4) % 4];
  const lines = [];
  lines.push(`Bot at (${p.x}, ${p.y}, ${p.z}) facing ${facing}; health=${sim.bot.health} food=${sim.bot.food}.`);
  const inv = [...sim.inventory.entries()].map(([n, c]) => `${n}x${c}`).join(', ');
  lines.push(`Inventory: ${inv || 'empty'}.`);
  const entities = [...sim.entities.values()].filter(e => e.isValid !== false && e.type !== 'drop')
    .map(e => `${e.name} at (${e.position.x}, ${e.position.y}, ${e.position.z}), ${dist(e.position, p).toFixed(1)} blocks away${e.type === 'player' ? ' (the owner)' : ''}`);
  if (entities.length) lines.push(`Entities: ${entities.join('; ')}.`);
  const drops = [...sim.entities.values()].filter(e => e.isValid !== false && e.type === 'drop')
    .map(e => `${e.drop.itemName}x${e.drop.count} at (${e.position.x}, ${e.position.y}, ${e.position.z})`);
  if (drops.length) lines.push(`Dropped items: ${drops.join('; ')}.`);
  const blocks = [];
  // P3: tasks may raise the floor level — sim.floorY (default 0) is the top
  // solid layer of the terrain (feet at floorY+1). Interior cells below it
  // are hidden the same way sub-floor cells always were.
  const floorY = sim.floorY ?? 0;
  const floorBlock = sim.floorBlock ?? 'grass_block';
  for (const [k, name] of sim.blocks) {
    const [x, y, z] = k.split(',').map(Number);
    if (y < floorY) continue; // terrain interior (e.g. the P0r2 mesa body)
    if (y === floorY && (name === floorBlock || !INTERESTING.has(name))) continue; // floor skin
    if (name === 'air' || PASSABLE.has(name)) continue;
    blocks.push(`${name} at (${x}, ${y}, ${z}), ${dist({ x, y, z }, p).toFixed(1)} blocks away`);
  }
  lines.push(blocks.length ? `Blocks of interest: ${blocks.join('; ')}.` : 'No blocks above the flat grass floor.');
  lines.push(`Ground: flat ${floorBlock} floor at y=${floorY}; the bot stands on top of it (feet at y=${floorY + 1}).`);
  return lines.join('\n');
}
