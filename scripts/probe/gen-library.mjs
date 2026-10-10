// Task-template library for generated probe holdout sets (rules 一.7–一.10).
//
// 一.8 任务生成器取代手工设计: templates × parameters. gen.mjs owns the seed,
// the level quotas and the id space; this library owns per-kind `sample(rnd,
// world)` (parameter draw) and `make(spec)` (task materialization). The
// emitted tasks file stores fully resolved specs, so a drawn set stays
// auditable and replayable even if a template later changes.
//
// Parameter axes required by 一.8:
//   * 坐标覆盖远离原点 — anchors are drawn at distance ≥45 from (0,0)
//   * 物品/方块/实体 — closed pools of real 1.20.4 catalog names
//   * 地形 — mesa / basin / terrace archetypes with varying floor level
//   * 种子 — everything downstream of a single mulberry32 seed
//
// Post-approach-step world (PR #40/#41): dig/place/craft/smelt approach their
// resolved target on their own, so reference bodies never spell "走过去" for
// them; give/attack/deposit/withdraw navigate inside their own run. Candidates
// for paradigm B reflect that — a bare `dig` option works from across the map.

const DONE = { key: 'done', description: '完成：宣告任务已完成或原地待命', done: true };
const withDone = list => [...list, DONE];

// ---- closed vocabularies (all real 1.20.4 names) ---------------------------

export const POOLS = {
  gear: ['iron_sword', 'wooden_sword', 'stone_pickaxe', 'iron_pickaxe', 'bow', 'shield'],
  items: ['coal', 'bread', 'apple', 'iron_ingot', 'stick', 'arrow', 'wheat', 'egg',
    'bone', 'feather', 'leather', 'gold_ingot', 'oak_planks', 'cobblestone'],
  placeables: ['torch', 'lantern'],
  markers: ['sandstone', 'gravel'],      // diggable, no drops → clean marker tasks
  ores: ['coal_ore', 'iron_ore', 'stone', 'oak_log', 'dirt', 'sand'], // DROPS keys only
  containers: ['chest', 'barrel'],
  beds: ['white_bed', 'red_bed', 'light_blue_bed'],
  hostile: ['zombie', 'spider', 'skeleton', 'creeper', 'witch'],
  passive: ['villager', 'cow', 'sheep', 'chicken', 'pig'],
  floors: ['grass_block', 'dirt', 'sand'],
  terrains: ['mesa', 'basin', 'terrace'],
};

const DROP_OF = { oak_log: 'oak_log', spruce_log: 'spruce_log', birch_log: 'birch_log',
  stone: 'cobblestone', iron_ore: 'raw_iron', coal_ore: 'coal', dirt: 'dirt',
  grass_block: 'dirt', sand: 'sand' };

// ---- shared task-body helpers (same conventions as tasks-holdout2.js) -------

const airAt = (sim, x, y, z) => sim.blockAt(x, y, z) === 'air';
const frontCell = sim => {
  const p = sim.bot.entity.position;
  const facing = ((Math.round(sim.bot.entity.yaw / (Math.PI / 2)) % 4) + 4) % 4;
  const [dx, dz] = [[0, -1], [-1, 0], [0, 1], [1, 0]][facing];
  return { x: Math.floor(p.x) + dx, y: Math.floor(p.y), z: Math.floor(p.z) + dz };
};
const near = (sim, x, y, z, r = 4.5) => {
  const p = sim.bot.entity.position;
  return Math.hypot(p.x - x, p.y - y, p.z - z) <= r;
};
const distToBot = (sim, x, y, z) => {
  const p = sim.bot.entity.position;
  return Math.hypot(p.x - x, p.y - y, p.z - z);
};
const entitiesNamed = (sim, name) => [...sim.entities.values()]
  .filter(e => e.name === name && e.isValid !== false);
const entityAt = (sim, name) => entitiesNamed(sim, name)[0];
const aliveCount = (sim, name) => entitiesNamed(sim, name).length;
const saidHas = (sim, text) => sim.said.some(t => t.includes(text));
const givenTotal = (sim, itemName) => sim.given
  .filter(g => g.itemName === itemName).reduce((a, g) => a + g.count, 0);
const blocksOf = (sim, name) => [...sim.blocks.entries()]
  .filter(([, n]) => n === name).map(([k]) => k.split(',').map(Number));
const yawDiff = (a, b) => {
  let d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
};

// ---- terrain archetypes -----------------------------------------------------
// `world` = { terrain, ax, az, fy, floor, half }. fy is the top solid layer
// (sim.floorY); the bot stands at feet y = fy+1. Task objects live at feet
// level. Every archetype builds a slab of half-width `half` centred on the
// anchor inside the 64³ world; anchors are drawn so √(ax²+az²) ≥ 45 (远离原点
// axis). Task objects keep |offset| ≤ half−2 so the approach column — always
// on her side, i.e. toward the anchor — lands on walkable ground.

const TERRAIN = {
  // Raised slab: stone body under a skin — flat walking, edges drop to void.
  mesa(sim, { ax, az, fy, floor, half }) {
    for (let x = ax - half; x <= ax + half; x++) for (let z = az - half; z <= az + half; z++) {
      for (let y = 0; y < fy; y++) sim.setBlock(x, y, z, 'stone');
      sim.setBlock(x, fy, z, floor);
    }
  },
  // Sunken pan: same slab plus a one-block stone rim walling the bot in.
  basin(sim, { ax, az, fy, floor, half }) {
    TERRAIN.mesa(sim, { ax, az, fy, floor, half });
    for (let x = ax - half; x <= ax + half; x++) for (let z = az - half; z <= az + half; z++) {
      if (Math.max(Math.abs(x - ax), Math.abs(z - az)) === half) sim.setBlock(x, fy + 1, z, 'stone');
    }
  },
  // Raised rampart: a two-column ridge on the east edge — level variety without
  // burying task cells (objects stay ≤ half−2, the ridge lives at half−1..half).
  terrace(sim, { ax, az, fy, floor, half }) {
    TERRAIN.mesa(sim, { ax, az, fy, floor, half });
    for (const x of [ax + half - 1, ax + half]) for (let z = az - half; z <= az + half; z++) {
      sim.setBlock(x, fy + 1, z, 'stone');
    }
  },
};

// A dig target must not collide with terrain: the floor skin shares its name
// with the floor block and the slab body is always stone — finding "the floor"
// instead of the marker was T98/T103's failure mode.
const diggables = w => POOLS.ores.filter(o => o !== w.floor && o !== 'stone');
const markersFor = w => POOLS.markers.filter(m => m !== w.floor);
const EDGE = w => (w.half ?? 13) - 2; // keep clear of the rim / drop-off

function setupWorld(sim, world) {
  TERRAIN[world.terrain](sim, world);
  sim.floorY = world.fy;
  sim.floorBlock = world.floor;
  sim.teleport(world.ax, world.fy + 1, world.az);
}

// ---- L1 templates -----------------------------------------------------------
// Single primitive or minimal composition, mostly in-place.

const L1 = {
  equip: {
    sample(rnd, w) {
      const [item, decoy] = rnd.pick2(POOLS.gear);
      return { item, decoy };
    },
    make(s) {
      return {
        id: s.id, level: 'L1', title: `装备 ${s.item}`,
        description: `背包里有 ${s.item}×1 和 ${s.decoy}×1，把 ${s.item} 装备到手上（别拿错）。`,
        setup(sim) { setupWorld(sim, s.world); sim.give(s.item, 1); sim.give(s.decoy, 1); },
        success: sim => sim.bot.heldItem === s.item,
        candidates: () => withDone([
          { key: 'equip_right', description: `装备 ${s.item}`, primitive: 'equip', params: { itemName: s.item } },
          { key: 'equip_wrong', description: `装备 ${s.decoy}`, primitive: 'equip', params: { itemName: s.decoy } },
          { key: 'count', description: `数 ${s.item} 数量`, primitive: 'countItem', params: { itemName: s.item } },
          { key: 'say', description: '说一句"装备好了"', primitive: 'say', params: { text: '装备好了' } },
        ]),
        reference: [{ primitive: 'equip', params: { itemName: s.item } }],
      };
    },
  },

  place_self: {
    sample(rnd) {
      return { item: rnd.pick(POOLS.placeables), where: rnd.pick(['$self', '$self.front']) };
    },
    make(s) {
      const cellText = s.where === '$self' ? '脚下这一格' : '面前那一格';
      const cellOf = sim => s.where === '$self'
        ? { x: Math.floor(sim.bot.entity.position.x), y: Math.floor(sim.bot.entity.position.y), z: Math.floor(sim.bot.entity.position.z) }
        : frontCell(sim);
      return {
        id: s.id, level: 'L1', title: `在${cellText}放 ${s.item}`,
        description: `把背包里的 ${s.item} 放一个在你${cellText}（背包里 ${s.item}×2）。`,
        setup(sim) { setupWorld(sim, s.world); sim.give(s.item, 2); },
        success(sim) { const c = cellOf(sim); return sim.blockAt(c.x, c.y, c.z) === s.item; },
        candidates(sim) {
          const p = sim.bot.entity.position;
          const c = cellOf(sim), f = frontCell(sim);
          return withDone([
            { key: 'place_self', description: `在 (${c.x},${c.y},${c.z}) 放 ${s.item}`, primitive: 'place', params: { itemName: s.item, x: c.x, y: c.y, z: c.z } },
            { key: 'place_front', description: `在 (${f.x},${f.y},${f.z}) 放 ${s.item}`, primitive: 'place', params: { itemName: s.item, x: f.x, y: f.y, z: f.z } },
            { key: 'place_below', description: `在 (${Math.floor(p.x)},${Math.floor(p.y) - 1},${Math.floor(p.z)}) 放 ${s.item}`, primitive: 'place', params: { itemName: s.item, x: Math.floor(p.x), y: Math.floor(p.y) - 1, z: Math.floor(p.z) } },
            { key: 'count', description: `数 ${s.item} 数量`, primitive: 'countItem', params: { itemName: s.item } },
          ]);
        },
        reference: [{ primitive: 'place', params: { itemName: s.item }, at: s.where }],
      };
    },
  },

  say_owner: {
    sample(rnd, w) {
      const phrases = [['你好', '你好 $owner'], ['早上好', '早上好 $owner'], ['我来了', '我来了，$owner']];
      const [short, full] = rnd.pick(phrases);
      return { phrase: short, text: full, owner: { x: w.ax + 2, y: w.fy + 1, z: w.az + 2 } };
    },
    make(s) {
      return {
        id: s.id, level: 'L1', title: '跟 owner 打招呼',
        description: `owner 在 (${s.owner.x},${s.owner.y},${s.owner.z})。用 say 对他说"${s.text}"（照原样写 $owner，执行时会替换成玩家名）。`,
        setup(sim) { setupWorld(sim, s.world); sim.addOwner(s.owner.x, s.owner.y, s.owner.z); },
        success: sim => sim.said.some(t => t.includes(s.phrase) && t.includes('player')),
        candidates: () => withDone([
          { key: 'say_full', description: `说"${s.text.replace('$owner', 'player')}"`, primitive: 'say', params: { text: s.text.replace('$owner', 'player') } },
          { key: 'say_short', description: `说"${s.phrase}"`, primitive: 'say', params: { text: s.phrase } },
          { key: 'say_raw', description: `说"$owner ${s.phrase}"`, primitive: 'say', params: { text: `$owner ${s.phrase}` } },
          { key: 'goto', description: `走到 (${s.owner.x},${s.owner.y},${s.owner.z})`, primitive: 'goTo', params: { ...s.owner, range: 1 } },
        ]),
        reference: [{ primitive: 'say', params: { text: s.text } }],
      };
    },
  },

  count_say: {
    sample(rnd) { return { item: rnd.pick(POOLS.items), n: rnd.int(3, 8) }; },
    make(s) {
      return {
        id: s.id, level: 'L1', title: `数 ${s.item} 报数`,
        description: `数一数背包里 ${s.item} 的数量，用 say 把结果报出来（背包里 ${s.item}×${s.n}）。`,
        setup(sim) { setupWorld(sim, s.world); sim.give(s.item, s.n); },
        success: sim => saidHas(sim, String(s.n)),
        candidates: () => withDone([
          { key: 'count', description: `数 ${s.item} 数量`, primitive: 'countItem', params: { itemName: s.item } },
          { key: 'say_right', description: `说"${s.n}"`, primitive: 'say', params: { text: String(s.n) } },
          { key: 'say_wrong', description: `说"${s.n + 1}"`, primitive: 'say', params: { text: String(s.n + 1) } },
          { key: 'say_vague', description: '说"有一些"', primitive: 'say', params: { text: '有一些' } },
        ]),
        reference: [
          { primitive: 'countItem', params: { itemName: s.item }, id: 'c' },
          { primitive: 'say', params: { text: `${s.item} 有 $c.count 个` } },
        ],
      };
    },
  },

  goto: {
    sample(rnd, w) {
      return { x: w.ax + rnd.pick([-1, 1]) * rnd.int(3, 5), y: w.fy + 1, z: w.az + rnd.pick([-1, 1]) * rnd.int(3, 5) };
    },
    make(s) {
      return {
        id: s.id, level: 'L1', title: `走到 (${s.x},${s.y},${s.z})`,
        description: `走到坐标 (${s.x},${s.y},${s.z})。`,
        setup(sim) { setupWorld(sim, s.world); },
        success: sim => distToBot(sim, s.x, s.y, s.z) <= 1.6,
        candidates: sim => withDone([
          ...(near(sim, s.x, s.y, s.z, 1.6) ? [] : [{ key: 'goto_right', description: `走到 (${s.x},${s.y},${s.z})`, primitive: 'goTo', params: { x: s.x, y: s.y, z: s.z, range: 1 } }]),
          { key: 'goto_wrong', description: `走到 (${s.z},${s.y},${s.x})`, primitive: 'goTo', params: { x: s.z, y: s.y, z: s.x, range: 1 } },
          { key: 'look', description: `看向 (${s.x},${s.y},${s.z})`, primitive: 'lookAt', params: { x: s.x, y: s.y, z: s.z } },
          { key: 'say', description: '说一句"到了"', primitive: 'say', params: { text: '到了' } },
        ]),
        reference: [{ primitive: 'goTo', params: { x: s.x, y: s.y, z: s.z, range: 1 } }],
      };
    },
  },

  attack_one: {
    sample(rnd, w) {
      const [mob, decoy] = rnd.pick2(POOLS.hostile);
      const d = rnd.int(4, 6);
      const sign = rnd.pick([-1, 1]);
      return { mob, decoy, at: { x: w.ax + sign * d, y: w.fy + 1, z: w.az } };
    },
    make(s) {
      return {
        id: s.id, level: 'L1', title: `打掉旁边的 ${s.mob}`,
        description: `附近有一只 ${s.mob}。攻击它。`,
        setup(sim) {
          setupWorld(sim, s.world);
          sim.addEntity({ name: s.mob, uuid: `eeeeeeee-0000-4000-8000-${String(s.id).padStart(12, '0')}`, ...s.at });
        },
        success: sim => aliveCount(sim, s.mob) === 0,
        candidates: () => withDone([
          { key: 'attack', description: `攻击 ${s.mob}`, primitive: 'attack', params: { entityName: s.mob } },
          { key: 'attack_wrong', description: `攻击 ${s.decoy}`, primitive: 'attack', params: { entityName: s.decoy } },
          { key: 'goto', description: `走到 (${s.at.x},${s.at.y},${s.at.z})`, primitive: 'goTo', params: { ...s.at, range: 1 } },
          { key: 'say', description: '说一句"开打"', primitive: 'say', params: { text: '开打' } },
        ]),
        reference: [{ primitive: 'attack', params: { entityName: s.mob } }],
      };
    },
  },

  look_at: {
    sample(rnd, w) {
      return { x: w.ax + rnd.pick([-1, 1]) * rnd.int(2, 4), y: w.fy + 4, z: w.az + rnd.pick([-1, 1]) * rnd.int(2, 4) };
    },
    make(s) {
      return {
        id: s.id, level: 'L1', title: `看向 (${s.x},${s.y},${s.z})`,
        description: `抬头看向坐标 (${s.x},${s.y},${s.z})。`,
        setup(sim) { setupWorld(sim, s.world); },
        success: sim => {
          const p = sim.bot.entity.position;
          const want = Math.atan2(-(s.x - p.x), -(s.z - p.z));
          return yawDiff(sim.bot.entity.yaw, want) < 0.15
            && sim.looked?.x === s.x && sim.looked?.y === s.y && sim.looked?.z === s.z;
        },
        candidates: () => withDone([
          { key: 'look_right', description: `看向 (${s.x},${s.y},${s.z})`, primitive: 'lookAt', params: { x: s.x, y: s.y, z: s.z } },
          { key: 'look_low', description: `看向 (${s.x},${s.y - 4},${s.z})`, primitive: 'lookAt', params: { x: s.x, y: s.y - 4, z: s.z } },
          { key: 'look_wrong', description: `看向 (${s.z},${s.y},${s.x})`, primitive: 'lookAt', params: { x: s.z, y: s.y, z: s.x } },
          { key: 'say', description: '说一句"在看"', primitive: 'say', params: { text: '在看' } },
        ]),
        reference: [{ primitive: 'lookAt', params: { x: s.x, y: s.y, z: s.z } }],
      };
    },
  },

  sleep: {
    sample(rnd, w) {
      return { bed: rnd.pick(POOLS.beds), at: { x: w.ax + 2, y: w.fy + 1, z: w.az + 2 } };
    },
    make(s) {
      return {
        id: s.id, level: 'L1', title: '上床睡觉',
        description: `夜里了，附近有一张 ${s.bed}（3 格内）。去睡觉。`,
        setup(sim) { setupWorld(sim, s.world); sim.setBlock(s.at.x, s.at.y, s.at.z, s.bed); },
        success: sim => sim.slept === true,
        candidates: () => withDone([
          { key: 'sleep', description: '睡觉', primitive: 'sleep', params: {} },
          { key: 'find_bed', description: `找最近的 ${s.bed}`, primitive: 'findBlock', params: { blockName: s.bed } },
          { key: 'dig_bed', description: `挖掉床 (${s.at.x},${s.at.y},${s.at.z})`, primitive: 'dig', params: { ...s.at } },
          { key: 'say', description: '说一句"晚安"', primitive: 'say', params: { text: '晚安' } },
        ]),
        reference: [{ primitive: 'sleep', params: {} }],
      };
    },
  },

  withdraw: {
    sample(rnd, w) {
      const have = rnd.int(4, 8);
      return { container: rnd.pick(POOLS.containers), item: rnd.pick(POOLS.items),
        have, take: rnd.int(1, have - 1),
        at: { x: w.ax + 2, y: w.fy + 1, z: w.az + 1 } };
    },
    make(s) {
      const cn = s.container === 'chest' ? '箱子' : '木桶';
      return {
        id: s.id, level: 'L1', title: `从旁边的${cn}取 ${s.take} 个 ${s.item}`,
        description: `旁边 (${s.at.x},${s.at.y},${s.at.z}) 有个 ${s.container}，里面有 ${s.item}×${s.have}。从里面取 ${s.take} 个 ${s.item} 到背包。`,
        setup(sim) {
          setupWorld(sim, s.world);
          sim.setBlock(s.at.x, s.at.y, s.at.z, s.container);
          sim.containerAt(s.at.x, s.at.y, s.at.z).set(s.item, s.have);
        },
        success: sim => sim.count(s.item) >= s.take,
        candidates: () => withDone([
          { key: 'withdraw_right', description: `取出 ${s.take} 个 ${s.item}`, primitive: 'withdraw', params: { itemName: s.item, count: s.take } },
          { key: 'withdraw_all', description: `取出全部 ${s.have} 个 ${s.item}`, primitive: 'withdraw', params: { itemName: s.item, count: s.have } },
          { key: 'withdraw_one', description: `取出 1 个 ${s.item}`, primitive: 'withdraw', params: { itemName: s.item, count: 1 } },
          { key: 'goto', description: `走到 ${s.container} 旁边 (${s.at.x},${s.at.y},${s.at.z})`, primitive: 'goTo', params: { ...s.at, range: 1 } },
          { key: 'count', description: `数 ${s.item} 数量`, primitive: 'countItem', params: { itemName: s.item } },
        ]),
        reference: [{ primitive: 'withdraw', params: { itemName: s.item, count: s.take } }],
      };
    },
  },

  collect: {
    sample(rnd, w) {
      return { item: rnd.pick(POOLS.items), at: { x: w.ax, y: w.fy + 1, z: w.az - 2 } };
    },
    make(s) {
      return {
        id: s.id, level: 'L1', title: `捡起面前的 ${s.item} 掉落物`,
        description: `面前 (${s.at.x},${s.at.y},${s.at.z}) 有一个 ${s.item} 掉落物，把它捡回背包。`,
        setup(sim) { setupWorld(sim, s.world); sim.addDrop(s.at.x, s.at.y, s.at.z, s.item, 1); },
        success: sim => sim.count(s.item) >= 1,
        candidates: sim => {
          const dropAlive = [...sim.entities.values()].some(e => e.type === 'drop' && e.isValid !== false);
          return withDone([
            { key: 'collect_6', description: '捡起 6 格内掉落物', primitive: 'collectDrops', params: { radius: 6 } },
            ...(dropAlive && !near(sim, s.at.x, s.at.y, s.at.z, 1.6)
              ? [{ key: 'goto_drop', description: `走到掉落物 (${s.at.x},${s.at.y},${s.at.z})`, primitive: 'goTo', params: { ...s.at, range: 1 } }] : []),
            { key: 'collect_1', description: '只捡 1 格内的掉落物', primitive: 'collectDrops', params: { radius: 1 } },
            { key: 'say', description: '说一句"捡到了"', primitive: 'say', params: { text: '捡到了' } },
          ]);
        },
        reference: [{ primitive: 'collectDrops', params: { radius: 6 } }],
      };
    },
  },

  follow: {
    sample(rnd, w) { return { owner: { x: w.ax + 3, y: w.fy + 1, z: w.az + 2 } }; },
    make(s) {
      return {
        id: s.id, level: 'L1', title: '跟上 owner',
        description: `owner 在 (${s.owner.x},${s.owner.y},${s.owner.z})。跟住他。`,
        setup(sim) { setupWorld(sim, s.world); sim.addOwner(s.owner.x, s.owner.y, s.owner.z); },
        success: sim => sim.following === true,
        candidates: () => withDone([
          { key: 'follow', description: '跟随 owner', primitive: 'follow', params: {} },
          { key: 'goto', description: `走到 (${s.owner.x},${s.owner.y},${s.owner.z})`, primitive: 'goTo', params: { ...s.owner, range: 1 } },
          { key: 'say', description: '说一句"来了"', primitive: 'say', params: { text: '来了' } },
        ]),
        reference: [{ primitive: 'follow', params: {} }],
      };
    },
  },
};

// ---- L2 templates -----------------------------------------------------------
// Binding chains: find* → act, field decompositions, at-centers, repeat/if.

const L2 = {
  visit_say: {
    sample(rnd, w) {
      const d = rnd.int(5, 6);
      const sign = rnd.pick([-1, 1]);
      return { mob: rnd.pick(POOLS.passive), at: { x: w.ax + sign * d, y: w.fy + 1, z: w.az + sign * rnd.int(2, 4) } };
    },
    make(s) {
      return {
        id: s.id, level: 'L2', title: `找到 ${s.mob} 走过去说到`,
        description: `附近有一只 ${s.mob}。找到它、走到它身边，然后说一句"到了"。`,
        setup(sim) {
          setupWorld(sim, s.world);
          sim.addEntity({ name: s.mob, uuid: `fafafafa-0000-4000-8000-${String(s.id).padStart(12, '0')}`, ...s.at });
        },
        success(sim) {
          const v = entityAt(sim, s.mob);
          return saidHas(sim, '到了') && v ? distToBot(sim, v.position.x, v.position.y, v.position.z) <= 3.5 : false;
        },
        candidates(sim) {
          const v = entityAt(sim, s.mob);
          return withDone([
            ...(v ? [{ key: 'find', description: `找最近的 ${s.mob}`, primitive: 'findEntity', params: { entityName: s.mob } }] : []),
            ...(v && !near(sim, v.position.x, v.position.y, v.position.z, 2.5)
              ? [{ key: 'goto', description: `走到 ${s.mob} (${v.position.x},${v.position.y},${v.position.z})`, primitive: 'goToEntity', params: { uuid: v.uuid, range: 2 } }] : []),
            { key: 'say_arrived', description: '说"到了"', primitive: 'say', params: { text: '到了' } },
            { key: 'attack', description: `攻击 ${s.mob}`, primitive: 'attack', params: { entityName: s.mob } },
            { key: 'say_lost', description: '说"没找到"', primitive: 'say', params: { text: '没找到' } },
          ]);
        },
        reference: [
          { primitive: 'findEntity', params: { entityName: s.mob }, id: 'e' },
          { primitive: 'goToEntity', params: { uuid: '$e.uuid' } },
          { primitive: 'say', params: { text: '到了' } },
        ],
      };
    },
  },

  dig_marked: {
    sample(rnd, w) {
      const d = rnd.int(6, Math.min(9, EDGE(w)));
      const sign = rnd.pick([-1, 1]);
      return { ore: rnd.pick(diggables(w)), at: { x: w.ax + sign * d, y: w.fy + 1, z: w.az + sign * rnd.int(1, 3) } };
    },
    make(s) {
      return {
        id: s.id, level: 'L2', title: `找到 ${s.ore} 挖掉并捡起`,
        description: `这块地附近有一块 ${s.ore}。找到它、挖掉，再把掉落物捡起来。`,
        setup(sim) { setupWorld(sim, s.world); sim.setBlock(s.at.x, s.at.y, s.at.z, s.ore); },
        success: sim => sim.blockAt(s.at.x, s.at.y, s.at.z) === 'air' && sim.count(DROP_OF[s.ore]) >= 1,
        candidates: sim => {
          const gone = sim.blockAt(s.at.x, s.at.y, s.at.z) === 'air';
          return withDone([
            ...(!gone ? [{ key: 'find', description: `找最近的 ${s.ore}`, primitive: 'findBlock', params: { blockName: s.ore } }] : []),
            ...(!gone ? [{ key: 'dig', description: `挖掉 (${s.at.x},${s.at.y},${s.at.z})`, primitive: 'dig', params: { ...s.at } }] : []),
            { key: 'collect', description: '捡起附近掉落物', primitive: 'collectDrops', params: { radius: 6 } },
            { key: 'count', description: `数 ${DROP_OF[s.ore]} 数量`, primitive: 'countItem', params: { itemName: DROP_OF[s.ore] } },
          ]);
        },
        reference: [
          { primitive: 'findBlock', params: { blockName: s.ore }, id: 'b' },
          { primitive: 'dig', params: {}, at: '$b' },
          { primitive: 'collectDrops', params: { radius: 6 } },
        ],
      };
    },
  },

  fetch_give: {
    sample(rnd, w) {
      const n = rnd.int(2, 4);
      return { container: rnd.pick(POOLS.containers), item: rnd.pick(POOLS.items), n,
        chest: { x: w.ax - 4, y: w.fy + 1, z: w.az + 4 },
        owner: { x: w.ax + 4, y: w.fy + 1, z: w.az - 4 } };
    },
    make(s) {
      const cn = s.container === 'chest' ? '箱子' : '木桶';
      return {
        id: s.id, level: 'L2', title: `从${cn}取 ${s.n} 个 ${s.item} 给 owner`,
        description: `(${s.chest.x},${s.chest.y},${s.chest.z}) 的 ${s.container} 里有 ${s.item}。取 ${s.n} 个，送到 owner 手里（owner 在 (${s.owner.x},${s.owner.y},${s.owner.z})）。`,
        setup(sim) {
          setupWorld(sim, s.world);
          sim.setBlock(s.chest.x, s.chest.y, s.chest.z, s.container);
          sim.containerAt(s.chest.x, s.chest.y, s.chest.z).set(s.item, s.n + 2);
          sim.addOwner(s.owner.x, s.owner.y, s.owner.z);
        },
        success: sim => givenTotal(sim, s.item) >= s.n,
        candidates: sim => withDone([
          ...(sim.containerTotal(s.chest.x, s.chest.y, s.chest.z, s.item) > 0
            ? [{ key: 'withdraw', description: `取出 ${s.n} 个 ${s.item}`, primitive: 'withdraw', params: { itemName: s.item, count: s.n } }] : []),
          ...(sim.count(s.item) >= s.n
            ? [{ key: 'give', description: `给 owner ${s.n} 个 ${s.item}`, primitive: 'give', params: { itemName: s.item, count: s.n } }] : []),
          { key: 'find', description: `找最近的 ${s.container}`, primitive: 'findBlock', params: { blockName: s.container } },
          { key: 'count', description: `数 ${s.item} 数量`, primitive: 'countItem', params: { itemName: s.item } },
        ]),
        reference: [
          { primitive: 'withdraw', params: { itemName: s.item, count: s.n } },
          { primitive: 'give', params: { itemName: s.item, count: s.n } },
        ],
      };
    },
  },

  decompose_say: {
    sample(rnd, w) {
      return { mob: rnd.pick(POOLS.passive), at: { x: w.ax + rnd.int(4, 6), y: w.fy + 1, z: w.az - rnd.int(2, 5) } };
    },
    make(s) {
      return {
        id: s.id, level: 'L2', title: `报出 ${s.mob} 的坐标`,
        description: `附近有一只 ${s.mob}。找到它，用 say 报出它的位置，格式"目标在 (x, y, z)"（用绑定结果的坐标字段，别自己编数字）。`,
        setup(sim) {
          setupWorld(sim, s.world);
          sim.addEntity({ name: s.mob, uuid: `dadadada-0000-4000-8000-${String(s.id).padStart(12, '0')}`, ...s.at });
        },
        success: sim => sim.said.some(t => t.includes(`(${s.at.x}`) && t.includes(`${s.at.y}`) && t.includes(`${s.at.z})`)),
        candidates: () => withDone([
          { key: 'find', description: `找最近的 ${s.mob}`, primitive: 'findEntity', params: { entityName: s.mob } },
          { key: 'say_right', description: `说"目标在 (${s.at.x}, ${s.at.y}, ${s.at.z})"`, primitive: 'say', params: { text: `目标在 (${s.at.x}, ${s.at.y}, ${s.at.z})` } },
          { key: 'say_wrong', description: `说"目标在 (${s.at.z}, ${s.at.y}, ${s.at.x})"`, primitive: 'say', params: { text: `目标在 (${s.at.z}, ${s.at.y}, ${s.at.x})` } },
          { key: 'say_vague', description: '说"在附近"', primitive: 'say', params: { text: '在附近' } },
        ]),
        reference: [
          { primitive: 'findEntity', params: { entityName: s.mob }, id: 'e' },
          { primitive: 'say', params: { text: '目标在 ($e.x, $e.y, $e.z)' } },
        ],
      };
    },
  },

  recenter_find: {
    sample(rnd, w) {
      // The ore sits outside the bot's 16-block findBlock horizon (√(12²+12²)
      // ≈17) but ~4 from the entity — reachable only by re-centring the search
      // on the bound entity. Both stay inside the slab (half=13) so the
      // her-side approach column is walkable.
      const sign = rnd.pick([-1, 1]);
      const eAt = { x: w.ax + sign * 10, y: w.fy + 1, z: w.az + sign * 9 };
      const bAt = { x: w.ax + sign * 12, y: w.fy + 1, z: w.az + sign * 12 };
      return { mob: rnd.pick(POOLS.passive), ore: rnd.pick(diggables(w)), eAt, bAt };
    },
    make(s) {
      return {
        id: s.id, level: 'L2', title: `在 ${s.mob} 附近找 ${s.ore} 挖掉`,
        description: `远处有一只 ${s.mob}，它旁边有一块 ${s.ore}（从这里直接搜搜不到，得以它为圆心找）。找到 ${s.mob}，在它附近找到那块 ${s.ore}，挖掉。`,
        setup(sim) {
          setupWorld(sim, s.world);
          sim.addEntity({ name: s.mob, uuid: `cacacaca-0000-4000-8000-${String(s.id).padStart(12, '0')}`, ...s.eAt });
          sim.setBlock(s.bAt.x, s.bAt.y, s.bAt.z, s.ore);
        },
        success: sim => sim.blockAt(s.bAt.x, s.bAt.y, s.bAt.z) === 'air',
        candidates: sim => {
          const gone = sim.blockAt(s.bAt.x, s.bAt.y, s.bAt.z) === 'air';
          return withDone([
            { key: 'find_mob', description: `找最近的 ${s.mob}`, primitive: 'findEntity', params: { entityName: s.mob } },
            ...(!gone ? [{ key: 'find_ore', description: `找最近的 ${s.ore}`, primitive: 'findBlock', params: { blockName: s.ore } }] : []),
            ...(!gone ? [{ key: 'dig', description: `挖掉 (${s.bAt.x},${s.bAt.y},${s.bAt.z})`, primitive: 'dig', params: { ...s.bAt } }] : []),
            { key: 'say', description: '说"找到了"', primitive: 'say', params: { text: '找到了' } },
          ]);
        },
        reference: [
          { primitive: 'findEntity', params: { entityName: s.mob }, id: 'e' },
          { primitive: 'findBlock', params: { blockName: s.ore }, id: 'b', at: '$e' },
          { primitive: 'dig', params: {}, at: '$b' },
        ],
      };
    },
  },

  repeat_dig: {
    sample(rnd, w) {
      const marker = rnd.pick(markersFor(w));
      const seen = new Set();
      const ats = [];
      while (ats.length < 3) {
        const x = w.ax + rnd.pick([-1, 1]) * rnd.int(3, 6);
        const z = w.az + rnd.pick([-1, 1]) * rnd.int(3, 6);
        if (seen.has(`${x},${z}`)) continue;
        seen.add(`${x},${z}`);
        ats.push({ x, y: w.fy + 1, z });
      }
      return { marker, ats };
    },
    make(s) {
      return {
        id: s.id, level: 'L2', title: `把 3 块 ${s.marker} 都挖掉`,
        description: `地上散着 3 块 ${s.marker}。把每一块都找到并挖掉（写循环，别复制三遍）。`,
        setup(sim) {
          setupWorld(sim, s.world);
          for (const a of s.ats) sim.setBlock(a.x, a.y, a.z, s.marker);
        },
        success: sim => s.ats.every(a => sim.blockAt(a.x, a.y, a.z) === 'air'),
        candidates: sim => {
          const left = s.ats.filter(a => sim.blockAt(a.x, a.y, a.z) === s.marker);
          return withDone([
            ...(left.length ? [{ key: 'find', description: `找最近的 ${s.marker}`, primitive: 'findBlock', params: { blockName: s.marker } }] : []),
            ...left.map((a, i) => ({ key: `dig_${i}`, description: `挖掉 (${a.x},${a.y},${a.z})`, primitive: 'dig', params: { ...a } })),
            { key: 'say', description: '说"挖完了"', primitive: 'say', params: { text: '挖完了' } },
          ]);
        },
        reference: [
          { repeat: 3, body: [
            { primitive: 'findBlock', params: { blockName: s.marker }, id: 'm' },
            { primitive: 'dig', params: {}, at: '$m' },
          ] },
        ],
      };
    },
  },

  if_stock: {
    sample(rnd, w) {
      const k = rnd.int(4, 6);
      const enough = rnd.bool();
      return { item: rnd.pick(POOLS.items), k, actual: enough ? k + rnd.int(0, 3) : rnd.int(1, k - 1),
        container: rnd.pick(POOLS.containers), chest: { x: w.ax + 3, y: w.fy + 1, z: w.az + 3 } };
    },
    make(s) {
      return {
        id: s.id, level: 'L2', title: `${s.item} 够不够`,
        description: `背包里有 ${s.item}。如果数量达到 ${s.k} 个就说"够了"，否则说"不够"。`,
        setup(sim) { setupWorld(sim, s.world); sim.give(s.item, s.actual); },
        success: sim => s.actual >= s.k
          ? saidHas(sim, '够了') && !saidHas(sim, '不够')
          : saidHas(sim, '不够') && !saidHas(sim, '够了'),
        candidates: () => withDone([
          { key: 'count', description: `数 ${s.item} 数量`, primitive: 'countItem', params: { itemName: s.item } },
          { key: 'say_enough', description: '说"够了"', primitive: 'say', params: { text: '够了' } },
          { key: 'say_short', description: '说"不够"', primitive: 'say', params: { text: '不够' } },
          { key: 'withdraw', description: `取 2 个 ${s.item}`, primitive: 'withdraw', params: { itemName: s.item, count: 2 } },
        ]),
        reference: [
          { if: { hasItem: s.item, atLeast: s.k },
            then: [{ primitive: 'say', params: { text: '够了' } }],
            else: [{ primitive: 'say', params: { text: '不够' } }] },
        ],
      };
    },
  },

  place_two: {
    sample(rnd, w) {
      const a = { x: w.ax + rnd.pick([-1, 1]) * rnd.int(3, 5), y: w.fy + 1, z: w.az + rnd.pick([-1, 1]) * rnd.int(3, 5) };
      let b;
      do {
        b = { x: w.ax + rnd.pick([-1, 1]) * rnd.int(3, 5), y: w.fy + 1, z: w.az + rnd.pick([-1, 1]) * rnd.int(3, 5) };
      } while (Math.max(Math.abs(b.x - a.x), Math.abs(b.z - a.z)) < 3);
      return { item: rnd.pick(POOLS.placeables), a, b };
    },
    make(s) {
      return {
        id: s.id, level: 'L2', title: `在两处各放一个 ${s.item}`,
        description: `背包里有 ${s.item}×2。在 (${s.a.x},${s.a.y},${s.a.z}) 和 (${s.b.x},${s.b.y},${s.b.z}) 各放一个。`,
        setup(sim) { setupWorld(sim, s.world); sim.give(s.item, 2); },
        success: sim => sim.blockAt(s.a.x, s.a.y, s.a.z) === s.item && sim.blockAt(s.b.x, s.b.y, s.b.z) === s.item,
        candidates: sim => withDone([
          ...(airAt(sim, s.a.x, s.a.y, s.a.z) && sim.count(s.item) >= 1
            ? [{ key: 'place_a', description: `在 (${s.a.x},${s.a.y},${s.a.z}) 放 ${s.item}`, primitive: 'place', params: { itemName: s.item, ...s.a } }] : []),
          ...(airAt(sim, s.b.x, s.b.y, s.b.z) && sim.count(s.item) >= 1
            ? [{ key: 'place_b', description: `在 (${s.b.x},${s.b.y},${s.b.z}) 放 ${s.item}`, primitive: 'place', params: { itemName: s.item, ...s.b } }] : []),
          ...(sim.count(s.item) === 0 && sim.blockAt(s.a.x, s.a.y, s.a.z) !== 'air'
            ? [{ key: 'dig_a', description: `挖掉 (${s.a.x},${s.a.y},${s.a.z})`, primitive: 'dig', params: { ...s.a } }] : []),
        ]),
        reference: [
          { primitive: 'place', params: { itemName: s.item, x: s.a.x, y: s.a.y, z: s.a.z } },
          { primitive: 'place', params: { itemName: s.item, x: s.b.x, y: s.b.y, z: s.b.z } },
        ],
      };
    },
  },

  equip_and_go: {
    sample(rnd, w) {
      const sign = rnd.pick([-1, 1]);
      return { gear: rnd.pick(POOLS.gear.filter(g => g.includes('sword') || g.includes('pickaxe'))),
        mob: rnd.pick(POOLS.hostile), at: { x: w.ax + sign * rnd.int(5, 7), y: w.fy + 1, z: w.az } };
    },
    make(s) {
      return {
        id: s.id, level: 'L2', title: `装备 ${s.gear} 去打 ${s.mob}`,
        description: `背包里有一件 ${s.gear}。先装备它，找到附近的 ${s.mob} 走过去，然后攻击它。`,
        setup(sim) {
          setupWorld(sim, s.world);
          sim.give(s.gear, 1);
          sim.addEntity({ name: s.mob, uuid: `babababa-0000-4000-8000-${String(s.id).padStart(12, '0')}`, ...s.at });
        },
        success: sim => aliveCount(sim, s.mob) === 0,
        candidates: sim => {
          const m = entityAt(sim, s.mob);
          return withDone([
            { key: 'equip', description: `装备 ${s.gear}`, primitive: 'equip', params: { itemName: s.gear } },
            ...(m ? [{ key: 'find', description: `找最近的 ${s.mob}`, primitive: 'findEntity', params: { entityName: s.mob } }] : []),
            ...(m && !near(sim, m.position.x, m.position.y, m.position.z, 2.5)
              ? [{ key: 'goto', description: `走到 ${s.mob} 旁`, primitive: 'goToEntity', params: { uuid: m.uuid, range: 2 } }] : []),
            { key: 'attack', description: `攻击 ${s.mob}`, primitive: 'attack', params: { entityName: s.mob } },
          ]);
        },
        reference: [
          { primitive: 'equip', params: { itemName: s.gear } },
          { primitive: 'findEntity', params: { entityName: s.mob }, id: 'e' },
          { primitive: 'goToEntity', params: { uuid: '$e.uuid' } },
          { primitive: 'attack', params: { entityName: s.mob } },
        ],
      };
    },
  },

  place_above: {
    sample(rnd, w) {
      return { marker: rnd.pick(markersFor(w)), item: rnd.pick(POOLS.placeables),
        at: { x: w.ax + rnd.pick([-1, 1]) * rnd.int(3, 5), y: w.fy + 1, z: w.az + rnd.pick([-1, 1]) * rnd.int(3, 5) } };
    },
    make(s) {
      return {
        id: s.id, level: 'L2', title: `在 ${s.marker} 上方放 ${s.item}`,
        description: `地上有一块 ${s.marker}。找到它，在它正上方那一格放一个 ${s.item}（背包里有）。`,
        setup(sim) {
          setupWorld(sim, s.world);
          sim.setBlock(s.at.x, s.at.y, s.at.z, s.marker);
          sim.give(s.item, 1);
        },
        success: sim => sim.blockAt(s.at.x, s.at.y + 1, s.at.z) === s.item,
        candidates: sim => withDone([
          ...(sim.blockAt(s.at.x, s.at.y, s.at.z) !== 'air'
            ? [{ key: 'find', description: `找最近的 ${s.marker}`, primitive: 'findBlock', params: { blockName: s.marker } }] : []),
          ...(sim.blockAt(s.at.x, s.at.y + 1, s.at.z) === 'air' && sim.count(s.item) >= 1
            ? [{ key: 'place_above', description: `在 (${s.at.x},${s.at.y + 1},${s.at.z}) 放 ${s.item}`, primitive: 'place', params: { itemName: s.item, x: s.at.x, y: s.at.y + 1, z: s.at.z } }] : []),
          { key: 'place_at', description: `在 (${s.at.x},${s.at.y},${s.at.z}) 放 ${s.item}`, primitive: 'place', params: { itemName: s.item, ...s.at } },
        ]),
        reference: [
          { primitive: 'findBlock', params: { blockName: s.marker }, id: 'm' },
          { primitive: 'place', params: { itemName: s.item }, at: '$m.above' },
        ],
      };
    },
  },

  deposit_stock: {
    sample(rnd, w) {
      const n = rnd.int(3, 6);
      return { item: rnd.pick(POOLS.items), n, container: rnd.pick(POOLS.containers),
        chest: { x: w.ax + rnd.pick([-1, 1]) * rnd.int(6, 8), y: w.fy + 1, z: w.az + rnd.pick([-1, 1]) * rnd.int(6, 8) } };
    },
    make(s) {
      const cn = s.container === 'chest' ? '箱子' : '木桶';
      return {
        id: s.id, level: 'L2', title: `把 ${s.n} 个 ${s.item} 存进${cn}`,
        description: `背包里有 ${s.item}×${s.n + 2}。把 ${s.n} 个 ${s.item} 存进附近的 ${s.container}（在 (${s.chest.x},${s.chest.y},${s.chest.z})，有点远）。`,
        setup(sim) {
          setupWorld(sim, s.world);
          sim.give(s.item, s.n + 2);
          sim.setBlock(s.chest.x, s.chest.y, s.chest.z, s.container);
        },
        success: sim => sim.containerTotal(s.chest.x, s.chest.y, s.chest.z, s.item) >= s.n,
        candidates: sim => withDone([
          ...(sim.count(s.item) >= s.n
            ? [{ key: 'deposit', description: `存 ${s.n} 个 ${s.item}`, primitive: 'deposit', params: { itemName: s.item, count: s.n } }] : []),
          { key: 'find', description: `找最近的 ${s.container}`, primitive: 'findBlock', params: { blockName: s.container } },
          { key: 'goto', description: `走到 (${s.chest.x},${s.chest.y},${s.chest.z})`, primitive: 'goTo', params: { ...s.chest, range: 1 } },
          { key: 'count', description: `数 ${s.item} 数量`, primitive: 'countItem', params: { itemName: s.item } },
        ]),
        reference: [{ primitive: 'deposit', params: { itemName: s.item, count: s.n } }],
      };
    },
  },
};

// ---- L3 templates -----------------------------------------------------------
// Seeded-skill reuse. Every task carries `skills:` (signature-only in the A
// prompt) and `aOnly` (the B picker sees no skills). References prefer `call`
// where the seeded signature fits honestly.

const skillFetch = container => ({
  name: `fetch_from_${container}`,
  description: `找到最近的 ${container}，走过去取出指定物品`,
  params: { item: { type: 'item', required: true }, count: { type: 'count', required: true } },
  body: [
    { primitive: 'findBlock', params: { blockName: container }, id: 'c' },
    { primitive: 'goTo', params: {}, at: 'c' },
    { primitive: 'withdraw', params: { itemName: '$item', count: '$count' } },
  ],
});
const skillKill = mob => ({
  name: `kill_${mob}`,
  description: `找到最近的 ${mob}，走过去杀掉（无参数）`,
  params: {},
  body: [
    { primitive: 'findEntity', params: { entityName: mob }, id: 'e' },
    { primitive: 'goToEntity', params: { uuid: '$e.uuid' } },
    { primitive: 'attack', params: { entityName: mob } },
  ],
});
const SKILL_PLACE_SELF = {
  name: 'place_self_here', description: '在自己脚下这一格放一个指定物品',
  params: { item: { type: 'item', required: true } },
  body: [{ primitive: 'place', params: { itemName: '$item' }, at: '$self' }],
};
const SKILL_DIG_NAMED = {
  name: 'dig_named', description: '找到最近的一种指定方块并挖掉（按名字，不带位置）',
  params: { target: { type: 'block', required: true } },
  body: [
    { primitive: 'findBlock', params: { blockName: '$target' }, id: 'b' },
    { primitive: 'dig', params: {}, at: '$b' },
  ],
};
const SKILL_SAY_COUNT = {
  name: 'say_count', description: '数一下指定物品的数量，说"X 有 N 个"',
  params: { item: { type: 'item', required: true } },
  body: [
    { primitive: 'countItem', params: { itemName: '$item' }, id: 'n' },
    { primitive: 'say', params: { text: '$item 有 $n.count 个' } },
  ],
};
const skillBring = container => ({
  name: `bring_from_${container}`,
  description: `从最近的 ${container} 取出指定物品，送到 owner 手里`,
  params: { item: { type: 'item', required: true }, count: { type: 'count', required: true } },
  body: [
    { primitive: 'findBlock', params: { blockName: container }, id: 'c' },
    { primitive: 'goTo', params: {}, at: 'c' },
    { primitive: 'withdraw', params: { itemName: '$item', count: '$count' } },
    { primitive: 'goTo', params: {}, at: '$owner' },
    { primitive: 'give', params: { itemName: '$item', count: '$count' } },
  ],
});
// Signature trap: call args cannot carry $id references and no honest literal
// denotes a furnace — this skill can never be fed a truthful furnaceId.
const SKILL_SMELT_AT = {
  name: 'smelt_at', description: '到编号为 furnaceId 的熔炉，用 coal 烧 2 个 raw_iron',
  params: { furnaceId: { type: 'number', required: true } },
  body: [
    { primitive: 'goTo', params: { x: '$furnaceId', y: 3, z: '$furnaceId' } },
    { primitive: 'smelt', params: { itemName: 'raw_iron', count: 2, fuel: 'coal' } },
  ],
};

const L3 = {
  call_fetch: {
    sample(rnd, w) {
      const [right, decoy] = rnd.pick2(POOLS.containers);
      return { container: right, decoyContainer: decoy, item: rnd.pick(POOLS.items), n: rnd.int(2, 4),
        chest: { x: w.ax - 3, y: w.fy + 1, z: w.az + 4 }, decoy: { x: w.ax + 4, y: w.fy + 1, z: w.az - 3 } };
    },
    make(s) {
      return {
        id: s.id, level: 'L3', aOnly: true,
        title: `从 ${s.container} 取 ${s.n} 个 ${s.item}`,
        description: `(${s.chest.x},${s.chest.y},${s.chest.z}) 的 ${s.container} 里有 ${s.item}。取 ${s.n} 个到背包。`,
        skills: [skillFetch(s.container), skillFetch(s.decoyContainer)],
        setup(sim) {
          setupWorld(sim, s.world);
          sim.setBlock(s.chest.x, s.chest.y, s.chest.z, s.container);
          sim.containerAt(s.chest.x, s.chest.y, s.chest.z).set(s.item, s.n + 2);
          sim.setBlock(s.decoy.x, s.decoy.y, s.decoy.z, s.decoyContainer); // empty decoy
        },
        success: sim => sim.count(s.item) >= s.n,
        candidates: () => [],
        reference: [{ call: `fetch_from_${s.container}`, args: { item: s.item, count: s.n } }],
      };
    },
  },

  call_kill: {
    sample(rnd, w) {
      const [mob, decoy] = rnd.pick2(POOLS.hostile);
      return { mob, decoy,
        at: { x: w.ax + 5, y: w.fy + 1, z: w.az }, dAt: { x: w.ax - 5, y: w.fy + 1, z: w.az + 2 } };
    },
    make(s) {
      return {
        id: s.id, level: 'L3', aOnly: true,
        title: `杀掉 ${s.mob}（别碰 ${s.decoy}）`,
        description: `附近有一只 ${s.mob} 和一只 ${s.decoy}。杀掉 ${s.mob}，${s.decoy} 要活着。`,
        skills: [skillKill(s.mob), skillKill(s.decoy)],
        setup(sim) {
          setupWorld(sim, s.world);
          sim.addEntity({ name: s.mob, uuid: `abababab-0000-4000-8000-${String(s.id).padStart(12, '0')}`, ...s.at });
          sim.addEntity({ name: s.decoy, uuid: `cdcdcdcd-0000-4000-8000-${String(s.id).padStart(12, '0')}`, ...s.dAt });
        },
        success: sim => aliveCount(sim, s.mob) === 0 && aliveCount(sim, s.decoy) === 1,
        candidates: () => [],
        reference: [{ call: `kill_${s.mob}` }],
      };
    },
  },

  call_trap: {
    sample(rnd, w) {
      return { furnace: { x: w.ax + 4, y: w.fy + 1, z: w.az + 4 } };
    },
    make(s) {
      return {
        id: s.id, level: 'L3', aOnly: true,
        title: '用熔炉烧 2 个 raw_iron',
        description: `(${s.furnace.x},${s.furnace.y},${s.furnace.z}) 有一座熔炉，背包里有 raw_iron×3 和 coal×2。烧出 2 个铁锭。`,
        skills: [SKILL_SMELT_AT],
        setup(sim) {
          setupWorld(sim, s.world);
          sim.setBlock(s.furnace.x, s.furnace.y, s.furnace.z, 'furnace');
          sim.give('raw_iron', 3); sim.give('coal', 2);
        },
        success: sim => sim.count('iron_ingot') >= 2,
        candidates: () => [],
        reference: [
          { primitive: 'findBlock', params: { blockName: 'furnace' }, id: 'f' },
          { primitive: 'smelt', params: { itemName: 'raw_iron', count: 2, fuel: 'coal' }, at: '$f' },
        ],
      };
    },
  },

  call_repeat: {
    sample(rnd, w) {
      const marker = rnd.pick(markersFor(w));
      const seen = new Set();
      const ats = [];
      while (ats.length < 3) {
        const x = w.ax + rnd.pick([-1, 1]) * rnd.int(3, 6);
        const z = w.az + rnd.pick([-1, 1]) * rnd.int(3, 6);
        if (seen.has(`${x},${z}`)) continue;
        seen.add(`${x},${z}`);
        ats.push({ x, y: w.fy + 1, z });
      }
      return { marker, ats, item: rnd.pick(POOLS.placeables) };
    },
    make(s) {
      return {
        id: s.id, level: 'L3', aOnly: true,
        title: `在每块 ${s.marker} 旁放 ${s.item}`,
        description: `地上有 3 块 ${s.marker}，背包里有 ${s.item}×3。走到每块旁边各放一个 ${s.item}（写循环）。`,
        skills: [SKILL_PLACE_SELF],
        setup(sim) {
          setupWorld(sim, s.world);
          for (const a of s.ats) sim.setBlock(a.x, a.y, a.z, s.marker);
          sim.give(s.item, 3);
        },
        success: sim => blocksOf(sim, s.item).length >= 3,
        candidates: () => [],
        reference: [
          { repeat: 3, body: [
            { primitive: 'findBlock', params: { blockName: s.marker }, id: 'm' },
            { primitive: 'goTo', params: {}, at: '$m' },
            { call: 'place_self_here', args: { item: s.item } },
          ] },
        ],
      };
    },
  },

  call_compose: {
    sample(rnd, w) {
      const [mob] = rnd.pick2(POOLS.hostile);
      return { mob, item: rnd.pick(POOLS.placeables), at: { x: w.ax + 5, y: w.fy + 1, z: w.az - 2 } };
    },
    make(s) {
      return {
        id: s.id, level: 'L3', aOnly: true,
        title: `杀掉 ${s.mob} 并在脚下放 ${s.item}`,
        description: `附近有一只 ${s.mob}，背包里有 ${s.item}。杀掉它，然后在自己脚下放一个 ${s.item}。`,
        skills: [skillKill(s.mob), SKILL_PLACE_SELF],
        setup(sim) {
          setupWorld(sim, s.world);
          sim.addEntity({ name: s.mob, uuid: `efefefef-0000-4000-8000-${String(s.id).padStart(12, '0')}`, ...s.at });
          sim.give(s.item, 1);
        },
        success: sim => aliveCount(sim, s.mob) === 0 && blocksOf(sim, s.item).length >= 1,
        candidates: () => [],
        reference: [
          { call: `kill_${s.mob}` },
          { call: 'place_self_here', args: { item: s.item } },
        ],
      };
    },
  },

  call_args: {
    sample(rnd) { return { item: rnd.pick(POOLS.items), n: rnd.int(3, 8) }; },
    make(s) {
      return {
        id: s.id, level: 'L3', aOnly: true,
        title: `报出 ${s.item} 的数量`,
        description: `背包里有 ${s.item}。报一下它的数量。`,
        skills: [SKILL_SAY_COUNT],
        setup(sim) { setupWorld(sim, s.world); sim.give(s.item, s.n); },
        success: sim => saidHas(sim, String(s.n)),
        candidates: () => [],
        reference: [{ call: 'say_count', args: { item: s.item } }],
      };
    },
  },

  call_nomatch: {
    sample(rnd, w) {
      const [mob] = rnd.pick2(POOLS.hostile);
      return { mob, item: rnd.pick(POOLS.placeables) };
    },
    make(s) {
      // Seeded skills don't fit the task — the honest solve is primitives.
      return {
        id: s.id, level: 'L3', aOnly: true,
        title: `在脚下放 ${s.item}`,
        description: `背包里有 ${s.item}。在你脚下这一格放一个。`,
        skills: [skillKill(s.mob), skillFetch('chest')],
        setup(sim) { setupWorld(sim, s.world); sim.give(s.item, 1); },
        success(sim) {
          const p = sim.bot.entity.position;
          return sim.blockAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === s.item;
        },
        candidates: () => [],
        reference: [{ primitive: 'place', params: { itemName: s.item }, at: '$self' }],
      };
    },
  },

  call_dig: {
    sample(rnd, w) {
      const sign = rnd.pick([-1, 1]);
      return { ore: rnd.pick(diggables(w)), at: { x: w.ax + sign * rnd.int(6, 8), y: w.fy + 1, z: w.az + sign * 2 } };
    },
    make(s) {
      return {
        id: s.id, level: 'L3', aOnly: true,
        title: `挖掉附近的 ${s.ore}`,
        description: `附近有一块 ${s.ore}。挖掉它。`,
        skills: [SKILL_DIG_NAMED],
        setup(sim) { setupWorld(sim, s.world); sim.setBlock(s.at.x, s.at.y, s.at.z, s.ore); },
        success: sim => sim.blockAt(s.at.x, s.at.y, s.at.z) === 'air',
        candidates: () => [],
        reference: [{ call: 'dig_named', args: { target: s.ore } }],
      };
    },
  },

  call_bring: {
    sample(rnd, w) {
      const n = rnd.int(2, 4);
      return { container: rnd.pick(POOLS.containers), item: rnd.pick(POOLS.items), n,
        chest: { x: w.ax - 5, y: w.fy + 1, z: w.az + 5 }, owner: { x: w.ax + 5, y: w.fy + 1, z: w.az - 5 } };
    },
    make(s) {
      return {
        id: s.id, level: 'L3', aOnly: true,
        title: `把 ${s.container} 里的 ${s.item} 带 ${s.n} 个给 owner`,
        description: `(${s.chest.x},${s.chest.y},${s.chest.z}) 的 ${s.container} 里有 ${s.item}。取 ${s.n} 个送到 owner 手里（owner 在 (${s.owner.x},${s.owner.y},${s.owner.z})）。`,
        skills: [skillBring(s.container)],
        setup(sim) {
          setupWorld(sim, s.world);
          sim.setBlock(s.chest.x, s.chest.y, s.chest.z, s.container);
          sim.containerAt(s.chest.x, s.chest.y, s.chest.z).set(s.item, s.n + 2);
          sim.addOwner(s.owner.x, s.owner.y, s.owner.z);
        },
        success: sim => givenTotal(sim, s.item) >= s.n,
        candidates: () => [],
        reference: [{ call: `bring_from_${s.container}`, args: { item: s.item, count: s.n } }],
      };
    },
  },

  call_if: {
    sample(rnd) {
      const item = rnd.pick(POOLS.placeables);
      return { item, have: rnd.bool() ? rnd.int(1, 3) : 0 };
    },
    make(s) {
      return {
        id: s.id, level: 'L3', aOnly: true,
        title: `有 ${s.item} 就放脚下，没有就说没有`,
        description: `如果背包里有 ${s.item}，就在脚下放一个；没有就说一句"没有"。`,
        skills: [SKILL_PLACE_SELF],
        setup(sim) { setupWorld(sim, s.world); if (s.have > 0) sim.give(s.item, s.have); },
        success(sim) {
          const p = sim.bot.entity.position;
          const placed = sim.blockAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === s.item;
          return s.have > 0 ? placed : saidHas(sim, '没有');
        },
        candidates: () => [],
        reference: [
          { if: { hasItem: s.item, atLeast: 1 },
            then: [{ call: 'place_self_here', args: { item: s.item } }],
            else: [{ primitive: 'say', params: { text: '没有' } }] },
        ],
      };
    },
  },
};

// ---- public surface ----------------------------------------------------------

const TEMPLATES = { ...L1, ...L2, ...L3 };
const LEVEL_OF = new Map([
  ...Object.keys(L1).map(k => [k, 'L1']),
  ...Object.keys(L2).map(k => [k, 'L2']),
  ...Object.keys(L3).map(k => [k, 'L3']),
]);

export const kindsOf = level => [...LEVEL_OF.entries()].filter(([, l]) => l === level).map(([k]) => k);
export const sampleFor = (kind, rnd, world) => TEMPLATES[kind].sample(rnd, world);

export function build(kind, spec) {
  const template = TEMPLATES[kind];
  if (!template) throw new Error(`unknown task kind: ${kind}`);
  const task = template.make(spec);
  task.kind = kind;
  return task;
}
