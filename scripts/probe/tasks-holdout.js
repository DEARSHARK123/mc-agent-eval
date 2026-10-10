// P0r holdout task set — 30 tasks (ids 21–50).
// Same task shape as tasks.js: { id, level, title, description, setup(sim),
// success(sim), candidates(sim), reference }. Helpers are copied locally so
// this file is drop-in independent of the base set.
//
// Deliberate differences from the old 16-task surface (spec hard constraints):
//   - L1 has true in-place tasks (place $self.front / eat / equip / say / lookAt
//     behind / collectDrops) — not the old "findBlock→goTo→act" straight chain.
//   - Entity targets resolve through findEntity + $id.uuid (goToEntity has no
//     'at' — the trap is writing at:"$p" or params {uuid:'$p.entityName'}).
//   - Offset targets: at:"$s.above" (T34), at:"$g.below" (T36), at:"$m.below" (T45).
//   - Double-approach chains (T40/T47), order-sensitive withdraw→eat (T31),
//     nested if with pure-say branches (T50), body predicates on both sides
//     of the branch (T42 then / T46 else).
//
// Documented deviation (spec §T45): the literal design "repeat 3 {place dirt at
// $self.front → goTo $self.front}" cannot execute in this sim — goTo with `at`
// is pinned to range=1 and the bot's own cell is already within range of the
// front cell, so after placing dirt there the goTo never moves and the next
// place fails 'occupied'. The task keeps the same measurement target (repeat +
// offset-at binding + per-iteration re-find) via three floating iron_ore
// markers: place dirt into the air cell directly below each marker.

const DONE = { key: 'done', description: '完成：宣告任务已完成或原地待命', done: true };
const withDone = list => [...list, DONE];

const airAt = (sim, x, y, z) => sim.blockAt(x, y, z) === 'air';
const frontCell = sim => {
  const p = sim.bot.entity.position;
  const facing = ((Math.round(sim.bot.entity.yaw / (Math.PI / 2)) % 4) + 4) % 4;
  const [dx, dz] = [[0, -1], [-1, 0], [0, 1], [1, 0]][facing];
  return { x: Math.floor(p.x) + dx, y: Math.floor(p.y), z: Math.floor(p.z) + dz };
};
const blocksOf = (sim, name) => [...sim.blocks.entries()]
  .filter(([, n]) => n === name)
  .map(([k]) => k.split(',').map(Number));
const near = (sim, x, y, z, r = 4.5) => {
  const p = sim.bot.entity.position;
  return Math.hypot(p.x - x, p.y - y, p.z - z) <= r;
};
const distToBot = (sim, x, y, z) => {
  const p = sim.bot.entity.position;
  return Math.hypot(p.x - x, p.y - y, p.z - z);
};
const ownerPos = sim => {
  const owner = sim.owner();
  return owner ? { x: owner.position.x, y: owner.position.y, z: owner.position.z } : null;
};
const entitiesNamed = (sim, name) => [...sim.entities.values()]
  .filter(e => e.name === name && e.isValid !== false);
const nearestOf = (sim, list) => list
  .slice()
  .sort((a, b) => distToBot(sim, a.x ?? a[0], a.y ?? a[1], a.z ?? a[2])
    - distToBot(sim, b.x ?? b[0], b.y ?? b[1], b.z ?? b[2]))[0];
const yawDiff = (a, b) => {
  let d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
};
const saidHas = (sim, text) => sim.said.some(t => t.includes(text));
const givenTotal = (sim, itemName) => sim.given
  .filter(g => g.itemName === itemName).reduce((a, g) => a + g.count, 0);
const aliveCount = (sim, name) => entitiesNamed(sim, name).length;

export const TASKS = [
  // ---------------- L1 — 校准档：单原语或最小组合，多为原地任务 ----------------
  {
    id: 21, level: 'L1', title: '把手里的 dirt 放到面前一格',
    description: '把背包里的 dirt 放到 bot 正前方那一格（$self.front；bot 面朝 -Z，即 (12,1,11)）。',
    setup(sim) { sim.flat(); sim.give('dirt', 3); },
    success: sim => sim.blockAt(12, 1, 11) === 'dirt',
    candidates: sim => {
      const f = frontCell(sim);
      return withDone([
        ...(airAt(sim, f.x, f.y, f.z) && sim.count('dirt') >= 1
          ? [{ key: 'place_front', description: `在面前 (${f.x},${f.y},${f.z}) 放 dirt`, primitive: 'place', params: { itemName: 'dirt', x: f.x, y: f.y, z: f.z } }]
          : []),
        { key: 'place_below', description: '在脚底下 (12,0,12) 放 dirt', primitive: 'place', params: { itemName: 'dirt', x: 12, y: 0, z: 12 } },
        { key: 'dig_front', description: `挖面前 (${f.x},${f.y},${f.z})`, primitive: 'dig', params: { x: f.x, y: f.y, z: f.z } },
        { key: 'count', description: '数 dirt 数量', primitive: 'countItem', params: { itemName: 'dirt' } },
        { key: 'say', description: '说一句"放好了"', primitive: 'say', params: { text: '放好了' } },
      ]);
    },
    reference: [{ primitive: 'place', params: { itemName: 'dirt' }, at: '$self.front' }],
  },
  {
    id: 22, level: 'L1', title: '吃一个 apple',
    description: 'bot 饿了（food=10），背包里有 apple，吃一个。',
    setup(sim) { sim.flat(); sim.give('apple', 2); sim.bot.food = 10; },
    success: sim => sim.bot.food > 10 && sim.count('apple') < 2,
    candidates: () => withDone([
      { key: 'eat_apple', description: '吃一个 apple', primitive: 'eat', params: { itemName: 'apple' } },
      { key: 'eat_bread', description: '吃一个 bread', primitive: 'eat', params: { itemName: 'bread' } },
      { key: 'count', description: '数 apple 数量', primitive: 'countItem', params: { itemName: 'apple' } },
      { key: 'say', description: '说一句"我饿了"', primitive: 'say', params: { text: '我饿了' } },
    ]),
    reference: [{ primitive: 'eat', params: { itemName: 'apple' } }],
  },
  {
    id: 23, level: 'L1', title: '装备 wooden_pickaxe',
    description: '把背包里的 wooden_pickaxe 装备到手上（背包里还有一把 stone_pickaxe，别拿错）。',
    setup(sim) { sim.flat(); sim.give('wooden_pickaxe', 1); sim.give('stone_pickaxe', 1); },
    success: sim => sim.bot.heldItem === 'wooden_pickaxe',
    candidates: () => withDone([
      { key: 'equip_wood', description: '装备 wooden_pickaxe', primitive: 'equip', params: { itemName: 'wooden_pickaxe' } },
      { key: 'equip_stone', description: '装备 stone_pickaxe', primitive: 'equip', params: { itemName: 'stone_pickaxe' } },
      { key: 'count', description: '数 wooden_pickaxe 数量', primitive: 'countItem', params: { itemName: 'wooden_pickaxe' } },
      { key: 'say', description: '说一句"装备好了"', primitive: 'say', params: { text: '装备好了' } },
    ]),
    reference: [{ primitive: 'equip', params: { itemName: 'wooden_pickaxe' } }],
  },
  {
    id: 24, level: 'L1', title: '说一句"我到了"',
    description: '用 say 说一句"我到了"（原话，不要改写）。',
    setup(sim) { sim.flat(); },
    success: sim => saidHas(sim, '我到了'),
    candidates: () => withDone([
      { key: 'say_ok', description: '说"我到了"', primitive: 'say', params: { text: '我到了' } },
      { key: 'say_hello', description: '说"大家好"', primitive: 'say', params: { text: '大家好' } },
      { key: 'goto', description: '走到 (14,1,14)', primitive: 'goTo', params: { x: 14, y: 1, z: 14, range: 1 } },
      { key: 'look', description: '看向 (12,4,16)', primitive: 'lookAt', params: { x: 12, y: 4, z: 16 } },
    ]),
    reference: [{ primitive: 'say', params: { text: '我到了' } }],
  },
  {
    id: 25, level: 'L1', title: '跟随 owner',
    description: 'owner 在 (16,1,16)。跟随他，保持 2 格以内（follow，range 2）。',
    setup(sim) { sim.flat(); sim.addOwner(16, 1, 16); },
    success: sim => {
      const o = ownerPos(sim);
      return o ? distToBot(sim, o.x, o.y, o.z) <= 3 : false;
    },
    candidates: sim => {
      const o = ownerPos(sim) ?? { x: 16, y: 1, z: 16 };
      return withDone([
        { key: 'follow', description: '跟随 owner（range 2）', primitive: 'follow', params: { range: 2 } },
        ...(near(sim, o.x, o.y, o.z, 2.5) ? [] : [{ key: 'goto_owner', description: `走到 owner (${o.x},${o.y},${o.z})`, primitive: 'goTo', params: { ...o, range: 1 } }]),
        { key: 'find_player', description: '找附近的 player', primitive: 'findEntity', params: { entityName: 'player', radius: 8 } },
        { key: 'goto_far', description: '走反方向到 (4,1,4)', primitive: 'goTo', params: { x: 4, y: 1, z: 4, range: 1 } },
        { key: 'say', description: '喊一声"来了"', primitive: 'say', params: { text: '来了' } },
      ]);
    },
    reference: [{ primitive: 'follow', params: { range: 2 } }],
  },
  {
    id: 26, level: 'L1', title: '走到 (18,1,18)',
    description: '走到坐标 (18,1,18)。',
    setup(sim) { sim.flat(); },
    success: sim => distToBot(sim, 18, 1, 18) <= 1.6,
    candidates: sim => withDone([
      ...(near(sim, 18, 1, 18, 1.6) ? [] : [{ key: 'goto_target', description: '走到 (18,1,18)', primitive: 'goTo', params: { x: 18, y: 1, z: 18, range: 1 } }]),
      { key: 'goto_wrong', description: '走到 (18,1,8)', primitive: 'goTo', params: { x: 18, y: 1, z: 8, range: 1 } },
      { key: 'look', description: '看向 (18,1,18)', primitive: 'lookAt', params: { x: 18, y: 1, z: 18 } },
      { key: 'say', description: '说一句"到了"', primitive: 'say', params: { text: '到了' } },
    ]),
    reference: [{ primitive: 'goTo', params: { x: 18, y: 1, z: 18, range: 1 } }],
  },
  {
    id: 27, level: 'L1', title: '给 owner 3 个 coal',
    description: 'owner 就在旁边 (13,1,13)。给他 3 个 coal（背包里有 5 个）。',
    setup(sim) { sim.flat(); sim.addOwner(13, 1, 13); sim.give('coal', 5); },
    success: sim => givenTotal(sim, 'coal') >= 3,
    candidates: () => withDone([
      { key: 'give_3', description: '给 owner 3 个 coal', primitive: 'give', params: { itemName: 'coal', count: 3 } },
      { key: 'give_1', description: '给 owner 1 个 coal', primitive: 'give', params: { itemName: 'coal', count: 1 } },
      { key: 'give_apple', description: '给 owner 1 个 apple', primitive: 'give', params: { itemName: 'apple', count: 1 } },
      { key: 'count', description: '数 coal 数量', primitive: 'countItem', params: { itemName: 'coal' } },
      { key: 'say', description: '说一句"给你"', primitive: 'say', params: { text: '给你' } },
    ]),
    reference: [{ primitive: 'give', params: { itemName: 'coal', count: 3 } }],
  },
  {
    id: 28, level: 'L1', title: '合成 oak_planks',
    description: '用背包里的 oak_log 合成 oak_planks（2x2 配方，不需要工作台；要 4 个）。',
    setup(sim) { sim.flat(); sim.give('oak_log', 2); },
    success: sim => sim.count('oak_planks') >= 4,
    candidates: () => withDone([
      { key: 'craft_planks', description: '合成 oak_planks ×4', primitive: 'craft', params: { itemName: 'oak_planks', count: 4, useTable: false } },
      { key: 'craft_stick', description: '合成 stick', primitive: 'craft', params: { itemName: 'stick', count: 4 } },
      { key: 'place_log', description: '把 oak_log 放在面前', primitive: 'place', params: { itemName: 'oak_log', x: 12, y: 1, z: 11 } },
      { key: 'count', description: '数 oak_log 数量', primitive: 'countItem', params: { itemName: 'oak_log' } },
    ]),
    reference: [{ primitive: 'craft', params: { itemName: 'oak_planks', count: 4, useTable: false } }],
  },
  {
    id: 29, level: 'L1', title: '看向身后的 (12,4,16)',
    description: 'bot 面朝 -Z，转身看向 (12,4,16)（在身后 +Z 方向）。',
    setup(sim) { sim.flat(); },
    success: sim => {
      const p = sim.bot.entity.position;
      const want = Math.atan2(-(12 - p.x), -(16 - p.z));
      return yawDiff(sim.bot.entity.yaw, want) < 0.15;
    },
    candidates: () => withDone([
      { key: 'look_back', description: '看向 (12,4,16)', primitive: 'lookAt', params: { x: 12, y: 4, z: 16 } },
      { key: 'look_front', description: '看向 (12,4,8)', primitive: 'lookAt', params: { x: 12, y: 4, z: 8 } },
      { key: 'goto', description: '走到 (15,1,15)', primitive: 'goTo', params: { x: 15, y: 1, z: 15, range: 1 } },
      { key: 'say', description: '说一句"在看"', primitive: 'say', params: { text: '在看' } },
    ]),
    reference: [{ primitive: 'lookAt', params: { x: 12, y: 4, z: 16 } }],
  },
  {
    id: 30, level: 'L1', title: '捡起面前的掉落物',
    description: '(14,1,12) 有一个 dirt 掉落物，把它捡起来。',
    setup(sim) { sim.flat(); sim.addDrop(14, 1, 12, 'dirt', 1); },
    success: sim => sim.count('dirt') >= 1,
    candidates: sim => {
      const dropAlive = [...sim.entities.values()].some(e => e.type === 'drop' && e.isValid !== false);
      return withDone([
        { key: 'collect_6', description: '捡起 6 格内掉落物', primitive: 'collectDrops', params: { radius: 6 } },
        ...(dropAlive && !near(sim, 14, 1, 12, 1.6) ? [{ key: 'goto_drop', description: '走到掉落物 (14,1,12)', primitive: 'goTo', params: { x: 14, y: 1, z: 12, range: 1 } }] : []),
        { key: 'collect_1', description: '只捡 1 格内的掉落物', primitive: 'collectDrops', params: { radius: 1 } },
        { key: 'dig_front', description: '挖正前方的方块', primitive: 'dig', params: { x: 12, y: 1, z: 11 } },
        { key: 'say', description: '说一句"捡到了"', primitive: 'say', params: { text: '捡到了' } },
      ]);
    },
    reference: [{ primitive: 'collectDrops', params: { radius: 6 } }],
  },

  // ---------------- L2 — 绑定链档：查询→接近→动作，含实体目标与偏移 at ----------------
  {
    id: 31, level: 'L2', title: '从箱子取 2 个 apple 吃掉',
    description: '附近有一个 chest（里面 apple×3）。走过去取出 2 个 apple，然后吃掉一个（bot 饿了 food=10）。先取后吃，顺序不能反。',
    setup(sim) {
      sim.flat(); sim.setBlock(9, 1, 9, 'chest');
      sim.containerAt(9, 1, 9).set('apple', 3);
      sim.bot.food = 10;
    },
    success: sim => sim.bot.food > 10 && sim.containerTotal(9, 1, 9, 'apple') <= 1,
    candidates: sim => withDone([
      { key: 'find_chest', description: '找最近的 chest', primitive: 'findBlock', params: { blockName: 'chest' } },
      ...(near(sim, 9, 1, 9, 2.5) ? [] : [{ key: 'goto_chest', description: '走到箱子 (9,1,9)', primitive: 'goTo', params: { x: 9, y: 1, z: 9, range: 1 } }]),
      ...(sim.containerTotal(9, 1, 9, 'apple') >= 2 ? [{ key: 'withdraw_2', description: '取出 2 个 apple', primitive: 'withdraw', params: { itemName: 'apple', count: 2 } }] : []),
      ...(sim.containerTotal(9, 1, 9, 'apple') >= 1 ? [{ key: 'withdraw_1', description: '取出 1 个 apple', primitive: 'withdraw', params: { itemName: 'apple', count: 1 } }] : []),
      ...(sim.count('apple') >= 1 ? [{ key: 'eat', description: '吃一个 apple', primitive: 'eat', params: { itemName: 'apple' } }]
        : [{ key: 'eat', description: '吃一个 apple（背包里还没有）', primitive: 'eat', params: { itemName: 'apple' } }]),
      { key: 'deposit', description: '把 apple 存进箱子', primitive: 'deposit', params: { itemName: 'apple', count: 1 } },
      { key: 'say', description: '说一句"吃苹果"', primitive: 'say', params: { text: '吃苹果' } },
    ]),
    reference: [
      { primitive: 'findBlock', params: { blockName: 'chest' }, id: 'box' },
      { primitive: 'goTo', params: {}, at: 'box' },
      { primitive: 'withdraw', params: { itemName: 'apple', count: 2 } },
      { primitive: 'eat', params: { itemName: 'apple' } },
    ],
  },
  {
    id: 32, level: 'L2', title: '找到 pig 走到身边杀掉',
    description: '附近有一只 pig。找到它、走到它身边，然后 attack 杀掉。',
    setup(sim) {
      sim.flat();
      sim.addEntity({ name: 'pig', uuid: 'dddddddd-0000-4000-8000-0000000000d1', x: 18, y: 1, z: 15, type: 'animal' });
    },
    success: sim => aliveCount(sim, 'pig') === 0,
    candidates: sim => {
      const pig = nearestOf(sim, entitiesNamed(sim, 'pig'));
      return withDone([
        ...(pig ? [{ key: 'find_pig', description: '找最近的 pig', primitive: 'findEntity', params: { entityName: 'pig' } }] : []),
        ...(pig && !near(sim, pig.position.x, pig.position.y, pig.position.z, 3.5)
          ? [{ key: 'goto_pig', description: `走到 pig (${pig.position.x},${pig.position.y},${pig.position.z})`, primitive: 'goToEntity', params: { uuid: pig.uuid, range: 2 } }]
          : []),
        ...(pig ? [{ key: 'attack', description: '攻击 pig', primitive: 'attack', params: { entityName: 'pig' } }] : []),
        { key: 'attack_zombie', description: '攻击 zombie', primitive: 'attack', params: { entityName: 'zombie' } },
        { key: 'collect', description: '捡起周围掉落物', primitive: 'collectDrops', params: { radius: 6 } },
        { key: 'say', description: '说一句"别跑"', primitive: 'say', params: { text: '别跑' } },
      ]);
    },
    reference: [
      { primitive: 'findEntity', params: { entityName: 'pig' }, id: 'p' },
      { primitive: 'goToEntity', params: { uuid: '$p.uuid' } },
      { primitive: 'attack', params: { entityName: 'pig' } },
    ],
  },
  {
    id: 33, level: 'L2', title: '用 oak_planks 当燃料烧 2 个 charcoal',
    description: '附近有一座 furnace (8,1,8)。走过去，用 oak_planks 当燃料把 2 个 oak_log 烧成 charcoal（背包里 oak_log×4、oak_planks×4，没有 coal）。',
    setup(sim) {
      sim.flat(); sim.setBlock(8, 1, 8, 'furnace');
      sim.give('oak_log', 4); sim.give('oak_planks', 4);
    },
    success: sim => sim.count('charcoal') >= 2,
    candidates: sim => withDone([
      { key: 'find_furnace', description: '找最近的 furnace', primitive: 'findBlock', params: { blockName: 'furnace' } },
      ...(near(sim, 8, 1, 8, 2.5) ? [] : [{ key: 'goto_furnace', description: '走到熔炉 (8,1,8)', primitive: 'goTo', params: { x: 8, y: 1, z: 8, range: 1 } }]),
      { key: 'smelt_planks', description: '用 oak_planks 烧 2 个 oak_log', primitive: 'smelt', params: { itemName: 'oak_log', count: 2, fuel: 'oak_planks' } },
      { key: 'smelt_coal', description: '用 coal 烧 2 个 oak_log', primitive: 'smelt', params: { itemName: 'oak_log', count: 2, fuel: 'coal' } },
      { key: 'count', description: '数 charcoal 数量', primitive: 'countItem', params: { itemName: 'charcoal' } },
      { key: 'say', description: '说一句"开烧"', primitive: 'say', params: { text: '开烧' } },
    ]),
    reference: [
      { primitive: 'findBlock', params: { blockName: 'furnace' }, id: 'f' },
      { primitive: 'goTo', params: {}, at: 'f' },
      { primitive: 'smelt', params: { itemName: 'oak_log', count: 2, fuel: 'oak_planks' } },
    ],
  },
  {
    id: 34, level: 'L2', title: '在 stone 上面放 torch',
    description: '找到 (16,1,10) 的 stone，走过去，把 torch 放在它正上方那一格（不要放在 stone 本身那格）。背包里 torch×2。',
    setup(sim) {
      sim.flat(); sim.setBlock(16, 1, 10, 'stone'); sim.give('torch', 2);
    },
    success: sim => sim.blockAt(16, 2, 10) === 'torch',
    candidates: sim => withDone([
      ...(sim.blockAt(16, 1, 10) === 'stone' ? [{ key: 'find_stone', description: '找最近的 stone', primitive: 'findBlock', params: { blockName: 'stone' } }] : []),
      ...(near(sim, 16, 1, 10, 3.5) ? [] : [{ key: 'goto_stone', description: '走到 stone (16,1,10)', primitive: 'goTo', params: { x: 16, y: 1, z: 10, range: 1 } }]),
      ...(airAt(sim, 16, 2, 10) && sim.count('torch') >= 1 ? [{ key: 'place_above', description: '在 (16,2,10) 放 torch（stone 上方）', primitive: 'place', params: { itemName: 'torch', x: 16, y: 2, z: 10 } }] : []),
      { key: 'place_on_stone', description: '把 torch 放在 (16,1,10) stone 那一格', primitive: 'place', params: { itemName: 'torch', x: 16, y: 1, z: 10 } },
      ...(sim.blockAt(16, 1, 10) === 'stone' ? [{ key: 'dig_stone', description: '挖掉 stone (16,1,10)', primitive: 'dig', params: { x: 16, y: 1, z: 10 } }] : []),
      { key: 'say', description: '说一句"插火把"', primitive: 'say', params: { text: '插火把' } },
    ]),
    reference: [
      { primitive: 'findBlock', params: { blockName: 'stone' }, id: 's' },
      { primitive: 'goTo', params: {}, at: 's' },
      { primitive: 'place', params: { itemName: 'torch' }, at: '$s.above' },
    ],
  },
  {
    id: 35, level: 'L2', title: '杀掉 zombie 捡起掉落物',
    description: '附近有一只 zombie。找到它、杀掉它，然后把掉落物捡回背包。',
    setup(sim) {
      sim.flat();
      sim.addEntity({ name: 'zombie', uuid: 'eeeeeeee-0000-4000-8000-0000000000e1', x: 17, y: 1, z: 10 });
    },
    success: sim => aliveCount(sim, 'zombie') === 0 && sim.count('rotten_flesh') >= 1,
    candidates: sim => {
      const z = nearestOf(sim, entitiesNamed(sim, 'zombie'));
      return withDone([
        ...(z ? [{ key: 'find_zombie', description: '找最近的 zombie', primitive: 'findEntity', params: { entityName: 'zombie' } }] : []),
        ...(z && !near(sim, z.position.x, z.position.y, z.position.z, 3.5)
          ? [{ key: 'goto_zombie', description: `走到 zombie (${z.position.x},${z.position.y},${z.position.z})`, primitive: 'goToEntity', params: { uuid: z.uuid, range: 2 } }]
          : []),
        ...(z ? [{ key: 'attack', description: '攻击 zombie', primitive: 'attack', params: { entityName: 'zombie' } }] : []),
        { key: 'attack_cow', description: '攻击 cow', primitive: 'attack', params: { entityName: 'cow' } },
        { key: 'collect', description: '捡起周围掉落物', primitive: 'collectDrops', params: { radius: 6 } },
        { key: 'say', description: '说一句"打完了"', primitive: 'say', params: { text: '打完了' } },
      ]);
    },
    reference: [
      { primitive: 'findEntity', params: { entityName: 'zombie' }, id: 'z' },
      { primitive: 'goToEntity', params: { uuid: '$z.uuid' } },
      { primitive: 'attack', params: { entityName: 'zombie' } },
      { primitive: 'collectDrops', params: {} },
    ],
  },
  {
    id: 36, level: 'L2', title: '挖掉 grass_block 下面那格 dirt',
    description: '场景是 dirt 平地（y=0），(15,1,15) 有一格 grass_block。找到它，走过去，挖掉它正下方那一格 dirt（不是挖草方块本身，也不是挖自己脚下）。',
    setup(sim) {
      sim.flat('dirt'); sim.setBlock(15, 1, 15, 'grass_block');
    },
    success: sim => airAt(sim, 15, 0, 15),
    candidates: sim => {
      const g = sim.blockAt(15, 1, 15) === 'grass_block';
      const p = sim.bot.entity.position;
      const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
      return withDone([
        ...(g ? [{ key: 'find_grass', description: '找最近的 grass_block', primitive: 'findBlock', params: { blockName: 'grass_block' } }] : []),
        ...(near(sim, 15, 1, 15, 3) ? [] : [{ key: 'goto_grass', description: '走到草方块 (15,1,15)', primitive: 'goTo', params: { x: 15, y: 1, z: 15, range: 1 } }]),
        ...(!airAt(sim, 15, 0, 15) ? [{ key: 'dig_below', description: '挖 (15,0,15) 草方块下面的 dirt', primitive: 'dig', params: { x: 15, y: 0, z: 15 } }] : []),
        ...(g ? [{ key: 'dig_grass', description: '挖 grass_block (15,1,15) 本身', primitive: 'dig', params: { x: 15, y: 1, z: 15 } }] : []),
        { key: 'dig_self_below', description: `挖自己脚下 (${bx},${by - 1},${bz})`, primitive: 'dig', params: { x: bx, y: by - 1, z: bz } },
        { key: 'collect', description: '捡起周围掉落物', primitive: 'collectDrops', params: { radius: 6 } },
      ]);
    },
    reference: [
      { primitive: 'findBlock', params: { blockName: 'grass_block' }, id: 'g' },
      { primitive: 'goTo', params: {}, at: 'g' },
      { primitive: 'dig', params: {}, at: '$g.below' },
    ],
  },
  {
    id: 37, level: 'L2', title: '存 3 个 oak_log 进箱子再说"放好了"',
    description: '找到 chest (8,1,10)，走过去，存入 3 个 oak_log，然后说一句"放好了"（背包里 oak_log×5）。',
    setup(sim) {
      sim.flat(); sim.setBlock(8, 1, 10, 'chest'); sim.give('oak_log', 5);
    },
    success: sim => sim.containerTotal(8, 1, 10, 'oak_log') >= 3 && saidHas(sim, '放好了'),
    candidates: sim => withDone([
      { key: 'find_chest', description: '找最近的 chest', primitive: 'findBlock', params: { blockName: 'chest' } },
      ...(near(sim, 8, 1, 10, 2.5) ? [] : [{ key: 'goto_chest', description: '走到箱子 (8,1,10)', primitive: 'goTo', params: { x: 8, y: 1, z: 10, range: 1 } }]),
      ...(sim.count('oak_log') >= 3 ? [{ key: 'deposit_3', description: '存入 3 个 oak_log', primitive: 'deposit', params: { itemName: 'oak_log', count: 3 } }] : []),
      ...(sim.count('oak_log') >= 5 ? [{ key: 'deposit_5', description: '存入全部 5 个 oak_log', primitive: 'deposit', params: { itemName: 'oak_log', count: 5 } }] : []),
      { key: 'withdraw', description: '从箱子取 1 个 oak_log', primitive: 'withdraw', params: { itemName: 'oak_log', count: 1 } },
      { key: 'say_done', description: '说一句"放好了"', primitive: 'say', params: { text: '放好了' } },
      { key: 'say_lost', description: '说一句"没找到"', primitive: 'say', params: { text: '没找到' } },
    ]),
    reference: [
      { primitive: 'findBlock', params: { blockName: 'chest' }, id: 'c' },
      { primitive: 'goTo', params: {}, at: 'c' },
      { primitive: 'deposit', params: { itemName: 'oak_log', count: 3 } },
      { primitive: 'say', params: { text: '放好了' } },
    ],
  },
  {
    id: 38, level: 'L2', title: '在工作台旁合成 stone_pickaxe',
    description: '找到 crafting_table (9,1,9)，走过去，合成 1 把 stone_pickaxe（需要贴着工作台；背包里 cobblestone×6、stick×4）。',
    setup(sim) {
      sim.flat(); sim.setBlock(9, 1, 9, 'crafting_table');
      sim.give('cobblestone', 6); sim.give('stick', 4);
    },
    success: sim => sim.count('stone_pickaxe') >= 1,
    candidates: sim => withDone([
      { key: 'find_table', description: '找最近的 crafting_table', primitive: 'findBlock', params: { blockName: 'crafting_table' } },
      ...(near(sim, 9, 1, 9, 3) ? [] : [{ key: 'goto_table', description: '走到工作台 (9,1,9)', primitive: 'goTo', params: { x: 9, y: 1, z: 9, range: 1 } }]),
      { key: 'craft_stone', description: '合成 stone_pickaxe', primitive: 'craft', params: { itemName: 'stone_pickaxe', count: 1, useTable: true } },
      { key: 'craft_wood', description: '合成 wooden_pickaxe', primitive: 'craft', params: { itemName: 'wooden_pickaxe', count: 1, useTable: true } },
      { key: 'craft_stick', description: '合成 stick', primitive: 'craft', params: { itemName: 'stick', count: 4 } },
      { key: 'count', description: '数 cobblestone 数量', primitive: 'countItem', params: { itemName: 'cobblestone' } },
    ]),
    reference: [
      { primitive: 'findBlock', params: { blockName: 'crafting_table' }, id: 't' },
      { primitive: 'goTo', params: {}, at: 't' },
      { primitive: 'craft', params: { itemName: 'stone_pickaxe', count: 1, useTable: true } },
    ],
  },
  {
    id: 39, level: 'L2', title: '找到 bed 走过去睡觉',
    description: '附近有一张 white_bed (16,1,8)。找到它、走到旁边，然后 sleep。',
    setup(sim) {
      sim.flat(); sim.setBlock(16, 1, 8, 'white_bed');
    },
    success: sim => sim.slept === true,
    candidates: sim => withDone([
      { key: 'find_bed', description: '找最近的 white_bed', primitive: 'findBlock', params: { blockName: 'white_bed' } },
      ...(near(sim, 16, 1, 8, 3) ? [] : [{ key: 'goto_bed', description: '走到床 (16,1,8)', primitive: 'goTo', params: { x: 16, y: 1, z: 8, range: 1 } }]),
      { key: 'sleep', description: '睡觉', primitive: 'sleep', params: {} },
      { key: 'dig_bed', description: '挖掉床 (16,1,8)', primitive: 'dig', params: { x: 16, y: 1, z: 8 } },
      { key: 'say', description: '说一句"晚安"', primitive: 'say', params: { text: '晚安' } },
    ]),
    reference: [
      { primitive: 'findBlock', params: { blockName: 'white_bed' }, id: 'b' },
      { primitive: 'goTo', params: {}, at: 'b' },
      { primitive: 'sleep', params: {} },
    ],
  },
  {
    id: 40, level: 'L2', title: '取箱子里的铁锭带给远处的 owner',
    description: 'chest 在 (7,1,9)（里面 iron_ingot×4），owner 在很远的 (19,1,18)。走到箱子取 2 个 iron_ingot，再走到 owner 身边交给他——要分别接近两个目标。',
    setup(sim) {
      sim.flat(); sim.setBlock(7, 1, 9, 'chest');
      sim.containerAt(7, 1, 9).set('iron_ingot', 4);
      sim.addOwner(19, 1, 18);
    },
    success: sim => givenTotal(sim, 'iron_ingot') >= 2,
    candidates: sim => {
      const o = ownerPos(sim) ?? { x: 19, y: 1, z: 18 };
      return withDone([
        { key: 'find_chest', description: '找最近的 chest', primitive: 'findBlock', params: { blockName: 'chest' } },
        ...(near(sim, 7, 1, 9, 2.5) ? [] : [{ key: 'goto_chest', description: '走到箱子 (7,1,9)', primitive: 'goTo', params: { x: 7, y: 1, z: 9, range: 1 } }]),
        ...(sim.containerTotal(7, 1, 9, 'iron_ingot') >= 2 ? [{ key: 'withdraw_2', description: '取出 2 个 iron_ingot', primitive: 'withdraw', params: { itemName: 'iron_ingot', count: 2 } }] : []),
        ...(sim.containerTotal(7, 1, 9, 'iron_ingot') >= 1 ? [{ key: 'withdraw_1', description: '取出 1 个 iron_ingot', primitive: 'withdraw', params: { itemName: 'iron_ingot', count: 1 } }] : []),
        ...(near(sim, o.x, o.y, o.z, 3) ? [] : [{ key: 'goto_owner', description: `走到 owner (${o.x},${o.y},${o.z})`, primitive: 'goTo', params: { ...o, range: 1 } }]),
        ...(sim.count('iron_ingot') >= 2 ? [{ key: 'give_2', description: '给 owner 2 个 iron_ingot', primitive: 'give', params: { itemName: 'iron_ingot', count: 2 } }] : []),
        { key: 'say', description: '喊一声"来了"', primitive: 'say', params: { text: '来了' } },
      ]);
    },
    reference: [
      { primitive: 'findBlock', params: { blockName: 'chest' }, id: 'c' },
      { primitive: 'goTo', params: {}, at: 'c' },
      { primitive: 'withdraw', params: { itemName: 'iron_ingot', count: 2 } },
      { primitive: 'goTo', params: {}, at: '$owner' },
      { primitive: 'give', params: { itemName: 'iron_ingot', count: 2 } },
    ],
  },

  // ---------------- L3 — 控制流档：repeat / if / 嵌套 ----------------
  {
    id: 41, level: 'L3', title: '收集 3 个 cobblestone 再合成 stone_pickaxe',
    description: '附近散落着 3 块 stone。逐个找到、走过去挖掉、捡起 cobblestone，凑够 3 个后到 crafting_table (8,1,8) 旁合成 1 把 stone_pickaxe（背包里 stick×4）。',
    setup(sim) {
      sim.flat();
      sim.setBlock(15, 1, 10, 'stone'); sim.setBlock(17, 1, 14, 'stone'); sim.setBlock(9, 1, 15, 'stone');
      sim.setBlock(8, 1, 8, 'crafting_table');
      sim.give('stick', 4);
    },
    success: sim => sim.count('stone_pickaxe') >= 1,
    candidates: sim => {
      const s = nearestOf(sim, blocksOf(sim, 'stone').map(([x, y, z]) => ({ x, y, z })));
      const table = sim.blockAt(8, 1, 8) === 'crafting_table';
      return withDone([
        ...(s ? [{ key: 'find_stone', description: '找最近的 stone', primitive: 'findBlock', params: { blockName: 'stone' } }] : []),
        ...(s && !near(sim, s.x, s.y, s.z, 2.5) ? [{ key: 'goto_stone', description: `走到石头 (${s.x},${s.y},${s.z})`, primitive: 'goTo', params: { x: s.x, y: s.y, z: s.z, range: 1 } }] : []),
        ...(s ? [{ key: 'dig_stone', description: `挖 (${s.x},${s.y},${s.z})`, primitive: 'dig', params: { x: s.x, y: s.y, z: s.z } }] : []),
        { key: 'collect', description: '捡起周围掉落物', primitive: 'collectDrops', params: { radius: 6 } },
        ...(table ? [{ key: 'find_table', description: '找最近的 crafting_table', primitive: 'findBlock', params: { blockName: 'crafting_table' } }] : []),
        ...(table && !near(sim, 8, 1, 8, 3) ? [{ key: 'goto_table', description: '走到工作台 (8,1,8)', primitive: 'goTo', params: { x: 8, y: 1, z: 8, range: 1 } }] : []),
        { key: 'craft', description: '合成 stone_pickaxe', primitive: 'craft', params: { itemName: 'stone_pickaxe', count: 1, useTable: true } },
      ]);
    },
    reference: [
      { repeat: 3, body: [
        { primitive: 'findBlock', params: { blockName: 'stone' }, id: 's' },
        { primitive: 'goTo', params: {}, at: 's' },
        { primitive: 'dig', params: {}, at: 's' },
        { primitive: 'collectDrops', params: {} },
      ] },
      { primitive: 'findBlock', params: { blockName: 'crafting_table' }, id: 't' },
      { primitive: 'goTo', params: {}, at: 't' },
      { primitive: 'craft', params: { itemName: 'stone_pickaxe', count: 1, useTable: true } },
    ],
  },
  {
    id: 42, level: 'L3', title: '饿了就吃 bread，否则挖 2 个 dirt',
    description: '如果饿了（food < 10）就吃一个 bread；否则挖 2 个 dirt。当前 food=5，背包里 bread×2，场上有 dirt 块 (14,1,11)、(15,1,13)。',
    setup(sim) {
      sim.flat(); sim.bot.food = 5; sim.give('bread', 2);
      sim.setBlock(14, 1, 11, 'dirt'); sim.setBlock(15, 1, 13, 'dirt');
    },
    success: sim => sim.bot.food > 5 && sim.count('bread') < 2,
    candidates: sim => withDone([
      ...(sim.count('bread') >= 1 ? [{ key: 'eat', description: '吃一个 bread', primitive: 'eat', params: { itemName: 'bread' } }] : []),
      { key: 'find_dirt', description: '找最近的 dirt', primitive: 'findBlock', params: { blockName: 'dirt' } },
      ...(!near(sim, 14, 1, 11, 2.5) && sim.blockAt(14, 1, 11) === 'dirt' ? [{ key: 'goto_dirt', description: '走到 dirt (14,1,11)', primitive: 'goTo', params: { x: 14, y: 1, z: 11, range: 1 } }] : []),
      ...(sim.blockAt(14, 1, 11) === 'dirt' ? [{ key: 'dig_dirt', description: '挖 (14,1,11)', primitive: 'dig', params: { x: 14, y: 1, z: 11 } }] : []),
      { key: 'count', description: '数 bread 数量', primitive: 'countItem', params: { itemName: 'bread' } },
      { key: 'say', description: '说一句"饿了"', primitive: 'say', params: { text: '饿了' } },
    ]),
    reference: [
      { if: { foodBelow: 10 }, then: [
        { primitive: 'eat', params: { itemName: 'bread' } },
      ], else: [
        { repeat: 2, body: [
          { primitive: 'findBlock', params: { blockName: 'dirt' }, id: 'd' },
          { primitive: 'goTo', params: {}, at: 'd' },
          { primitive: 'dig', params: {}, at: 'd' },
        ] },
      ] },
    ],
  },
  {
    id: 43, level: 'L3', title: '有煤就烧铁存进箱子，否则说"没煤"',
    description: '如果背包里有 coal，就到 furnace (9,1,8) 旁用 coal 把 2 个 raw_iron 烧成 iron_ingot，再存进最近的 chest (15,1,9)；如果没有 coal，就说一句"没煤"。（背包里有 coal×2、raw_iron×3）',
    setup(sim) {
      sim.flat();
      sim.setBlock(9, 1, 8, 'furnace'); sim.setBlock(15, 1, 9, 'chest');
      sim.give('coal', 2); sim.give('raw_iron', 3);
    },
    success: sim => sim.containerTotal(15, 1, 9, 'iron_ingot') >= 2,
    candidates: sim => withDone([
      { key: 'find_furnace', description: '找最近的 furnace', primitive: 'findBlock', params: { blockName: 'furnace' } },
      ...(near(sim, 9, 1, 8, 2.5) ? [] : [{ key: 'goto_furnace', description: '走到熔炉 (9,1,8)', primitive: 'goTo', params: { x: 9, y: 1, z: 8, range: 1 } }]),
      ...(sim.count('coal') >= 1 && sim.count('raw_iron') >= 2
        ? [{ key: 'smelt', description: '用 coal 烧 2 个 raw_iron', primitive: 'smelt', params: { itemName: 'raw_iron', count: 2, fuel: 'coal' } }]
        : []),
      { key: 'find_chest', description: '找最近的 chest', primitive: 'findBlock', params: { blockName: 'chest' } },
      ...(near(sim, 15, 1, 9, 2.5) ? [] : [{ key: 'goto_chest', description: '走到箱子 (15,1,9)', primitive: 'goTo', params: { x: 15, y: 1, z: 9, range: 1 } }]),
      ...(sim.count('iron_ingot') >= 1 ? [{ key: 'deposit', description: '存入 2 个 iron_ingot', primitive: 'deposit', params: { itemName: 'iron_ingot', count: 2 } }] : []),
      { key: 'say_no_coal', description: '说一句"没煤"', primitive: 'say', params: { text: '没煤' } },
    ]),
    reference: [
      { if: { hasItem: 'coal', atLeast: 1 }, then: [
        { primitive: 'findBlock', params: { blockName: 'furnace' }, id: 'f' },
        { primitive: 'goTo', params: {}, at: 'f' },
        { primitive: 'smelt', params: { itemName: 'raw_iron', count: 2, fuel: 'coal' } },
        { primitive: 'findBlock', params: { blockName: 'chest' }, id: 'c' },
        { primitive: 'goTo', params: {}, at: 'c' },
        { primitive: 'deposit', params: { itemName: 'iron_ingot', count: 2 } },
      ], else: [
        { primitive: 'say', params: { text: '没煤' } },
      ] },
    ],
  },
  {
    id: 44, level: 'L3', title: '清掉 2 只 zombie 并捡掉落物',
    description: '附近有 2 只 zombie（不同位置）。逐个找到、走到身边杀掉，并捡起每只的掉落物。',
    setup(sim) {
      sim.flat();
      sim.addEntity({ name: 'zombie', uuid: 'eeeeeeee-0000-4000-8000-0000000000e1', x: 16, y: 1, z: 9 });
      sim.addEntity({ name: 'zombie', uuid: 'eeeeeeee-0000-4000-8000-0000000000e2', x: 8, y: 1, z: 16 });
    },
    success: sim => aliveCount(sim, 'zombie') === 0 && sim.count('rotten_flesh') >= 2,
    candidates: sim => {
      const z = nearestOf(sim, entitiesNamed(sim, 'zombie'));
      return withDone([
        ...(z ? [{ key: 'find_zombie', description: '找最近的 zombie', primitive: 'findEntity', params: { entityName: 'zombie' } }] : []),
        ...(z && !near(sim, z.position.x, z.position.y, z.position.z, 3.5)
          ? [{ key: 'goto_zombie', description: `走到最近的 zombie (${z.position.x},${z.position.y},${z.position.z})`, primitive: 'goToEntity', params: { uuid: z.uuid, range: 2 } }]
          : []),
        ...(z ? [{ key: 'attack', description: '攻击 zombie', primitive: 'attack', params: { entityName: 'zombie' } }] : []),
        { key: 'collect', description: '捡起周围掉落物', primitive: 'collectDrops', params: { radius: 6 } },
        { key: 'attack_pig', description: '攻击 pig', primitive: 'attack', params: { entityName: 'pig' } },
        { key: 'say', description: '说一句"安全了"', primitive: 'say', params: { text: '安全了' } },
      ]);
    },
    reference: [{ repeat: 2, body: [
      { primitive: 'findEntity', params: { entityName: 'zombie' }, id: 'z' },
      { primitive: 'goToEntity', params: { uuid: '$z.uuid' } },
      { primitive: 'attack', params: { entityName: 'zombie' } },
      { primitive: 'collectDrops', params: {} },
    ] }],
  },
  {
    id: 45, level: 'L3', title: '朝面前方向铺一条 3 格泥土路',
    description: 'bot 面前 -Z 方向有三个悬浮的 iron_ore 标记：(12,2,11)、(12,2,10)、(12,2,9)。对每个标记：把 dirt 放进它正下方那一格（y=1），铺好后把这个标记挖掉——逐个处理，铺出一条 3 格泥土路面。背包里 dirt×4。（注意：dirt 放在标记"下面"那格，不是标记所在格）',
    setup(sim) {
      sim.flat();
      sim.setBlock(12, 2, 11, 'iron_ore'); sim.setBlock(12, 2, 10, 'iron_ore'); sim.setBlock(12, 2, 9, 'iron_ore');
      sim.give('dirt', 4);
    },
    success: sim => [11, 10, 9].every(z => sim.blockAt(12, 1, z) === 'dirt'),
    candidates: sim => {
      const markers = blocksOf(sim, 'iron_ore').map(([x, y, z]) => ({ x, y, z }));
      const pending = markers.filter(m => airAt(sim, m.x, m.y - 1, m.z));
      const filled = markers.filter(m => sim.blockAt(m.x, m.y - 1, m.z) === 'dirt');
      const mp = nearestOf(sim, pending);
      const md = nearestOf(sim, filled);
      const roadCell = [[12, 1, 11], [12, 1, 10], [12, 1, 9]].find(([x, y, z]) => airAt(sim, x, y, z));
      return withDone([
        ...(markers.length ? [{ key: 'find_marker', description: '找最近的 iron_ore 标记', primitive: 'findBlock', params: { blockName: 'iron_ore' } }] : []),
        ...(mp && sim.count('dirt') >= 1 ? [{ key: 'place_below', description: `在标记下方 (${mp.x},${mp.y - 1},${mp.z}) 放 dirt`, primitive: 'place', params: { itemName: 'dirt', x: mp.x, y: mp.y - 1, z: mp.z } }] : []),
        ...(roadCell && !mp && sim.count('dirt') >= 1 ? [{ key: 'place_road', description: `在 (${roadCell[0]},${roadCell[1]},${roadCell[2]}) 放 dirt`, primitive: 'place', params: { itemName: 'dirt', x: roadCell[0], y: roadCell[1], z: roadCell[2] } }] : []),
        ...(mp ? [{ key: 'place_at_marker', description: `把 dirt 放在标记格 (${mp.x},${mp.y},${mp.z})`, primitive: 'place', params: { itemName: 'dirt', x: mp.x, y: mp.y, z: mp.z } }] : []),
        ...(md ? [{ key: 'dig_filled', description: `挖掉已铺好的标记 (${md.x},${md.y},${md.z})`, primitive: 'dig', params: { x: md.x, y: md.y, z: md.z } }] : []),
        ...(mp ? [{ key: 'dig_pending', description: `挖掉还没铺的标记 (${mp.x},${mp.y},${mp.z})`, primitive: 'dig', params: { x: mp.x, y: mp.y, z: mp.z } }] : []),
        { key: 'say', description: '说一句"铺路中"', primitive: 'say', params: { text: '铺路中' } },
      ]);
    },
    // spec 里 repeat{place@$self.front → goTo@$self.front} 在 sim 下不可执行：
    // goTo+at 锁 range=1，目标格被 dirt 占据后 BFS 原地不动，下一轮 place
    // 就 'occupied'。等价考法：repeat { findBlock marker → place @ $m.below →
    // dig @m }——挖出标记让"最近的标记"逐轮前移，同样测 repeat + 偏移 at
    // 绑定 + 逐次重查，且 at:'$m'（放进标记格）仍是必踩的坑。
    reference: [{ repeat: 3, body: [
      { primitive: 'findBlock', params: { blockName: 'iron_ore' }, id: 'm' },
      { primitive: 'place', params: { itemName: 'dirt' }, at: '$m.below' },
      { primitive: 'dig', params: {}, at: 'm' },
    ] }],
  },
  {
    id: 46, level: 'L3', title: '不饿就挖 2 个 stone，否则吃 2 个 bread',
    description: '如果不饿（food ≥ 10）就挖 2 个 stone 捡回 cobblestone；饿了（food < 10）就吃 2 个 bread。当前 food=15，背包里 bread×2，场上 stone (15,1,10)、(9,1,15)。',
    setup(sim) {
      sim.flat(); sim.bot.food = 15; sim.give('bread', 2);
      sim.setBlock(15, 1, 10, 'stone'); sim.setBlock(9, 1, 15, 'stone');
    },
    success: sim => sim.count('cobblestone') >= 2,
    candidates: sim => {
      const s = nearestOf(sim, blocksOf(sim, 'stone').map(([x, y, z]) => ({ x, y, z })));
      return withDone([
        ...(sim.count('bread') >= 1 ? [{ key: 'eat', description: '吃一个 bread', primitive: 'eat', params: { itemName: 'bread' } }] : []),
        ...(s ? [{ key: 'find_stone', description: '找最近的 stone', primitive: 'findBlock', params: { blockName: 'stone' } }] : []),
        ...(s && !near(sim, s.x, s.y, s.z, 2.5) ? [{ key: 'goto_stone', description: `走到石头 (${s.x},${s.y},${s.z})`, primitive: 'goTo', params: { x: s.x, y: s.y, z: s.z, range: 1 } }] : []),
        ...(s ? [{ key: 'dig_stone', description: `挖 (${s.x},${s.y},${s.z})`, primitive: 'dig', params: { x: s.x, y: s.y, z: s.z } }] : []),
        { key: 'collect', description: '捡起周围掉落物', primitive: 'collectDrops', params: { radius: 6 } },
        { key: 'count', description: '数 cobblestone 数量', primitive: 'countItem', params: { itemName: 'cobblestone' } },
      ]);
    },
    // 身体谓词走 else：food=15 → foodBelow:10 不成立 → 执行挖石头分支。
    reference: [
      { if: { foodBelow: 10 }, then: [
        { primitive: 'eat', params: { itemName: 'bread' } },
        { primitive: 'eat', params: { itemName: 'bread' } },
      ], else: [
        { repeat: 2, body: [
          { primitive: 'findBlock', params: { blockName: 'stone' }, id: 's' },
          { primitive: 'goTo', params: {}, at: 's' },
          { primitive: 'dig', params: {}, at: 's' },
          { primitive: 'collectDrops', params: {} },
        ] },
      ] },
    ],
  },
  {
    id: 47, level: 'L3', title: '重复两次：从 chest 取 coal 送给远处的 owner',
    description: '重复 2 次：走到 chest (8,1,10)（里面 coal×3）取 1 个 coal，再走到远处的 owner (19,1,18) 身边给他。',
    setup(sim) {
      sim.flat(); sim.setBlock(8, 1, 10, 'chest');
      sim.containerAt(8, 1, 10).set('coal', 3);
      sim.addOwner(19, 1, 18);
    },
    success: sim => givenTotal(sim, 'coal') >= 2,
    candidates: sim => {
      const o = ownerPos(sim) ?? { x: 19, y: 1, z: 18 };
      return withDone([
        { key: 'find_chest', description: '找最近的 chest', primitive: 'findBlock', params: { blockName: 'chest' } },
        ...(near(sim, 8, 1, 10, 2.5) ? [] : [{ key: 'goto_chest', description: '走到箱子 (8,1,10)', primitive: 'goTo', params: { x: 8, y: 1, z: 10, range: 1 } }]),
        ...(sim.containerTotal(8, 1, 10, 'coal') >= 1 ? [{ key: 'withdraw_1', description: '取出 1 个 coal', primitive: 'withdraw', params: { itemName: 'coal', count: 1 } }] : []),
        ...(near(sim, o.x, o.y, o.z, 3) ? [] : [{ key: 'goto_owner', description: `走到 owner (${o.x},${o.y},${o.z})`, primitive: 'goTo', params: { ...o, range: 1 } }]),
        ...(sim.count('coal') >= 1 ? [{ key: 'give_1', description: '给 owner 1 个 coal', primitive: 'give', params: { itemName: 'coal', count: 1 } }] : []),
        { key: 'give_2', description: '给 owner 2 个 coal', primitive: 'give', params: { itemName: 'coal', count: 2 } },
        { key: 'say', description: '喊一声"来了"', primitive: 'say', params: { text: '来了' } },
      ]);
    },
    reference: [{ repeat: 2, body: [
      { primitive: 'findBlock', params: { blockName: 'chest' }, id: 'c' },
      { primitive: 'goTo', params: {}, at: 'c' },
      { primitive: 'withdraw', params: { itemName: 'coal', count: 1 } },
      { primitive: 'goTo', params: {}, at: '$owner' },
      { primitive: 'give', params: { itemName: 'coal', count: 1 } },
    ] }],
  },
  {
    id: 48, level: 'L3', title: '找到箱子就取 2 个铁锭交给 owner，没有就说"没有箱子"',
    description: '找找附近有没有 chest：找到了就走过去取 2 个 iron_ingot，再走到 owner (18,1,16) 身边交给他；没有找到就说一句"没有箱子"。（场上有一个 chest (9,1,9)，里面 iron_ingot×3）',
    setup(sim) {
      sim.flat(); sim.setBlock(9, 1, 9, 'chest');
      sim.containerAt(9, 1, 9).set('iron_ingot', 3);
      sim.addOwner(18, 1, 16);
    },
    success: sim => givenTotal(sim, 'iron_ingot') >= 2,
    candidates: sim => {
      const o = ownerPos(sim) ?? { x: 18, y: 1, z: 16 };
      return withDone([
        { key: 'find_chest', description: '找最近的 chest', primitive: 'findBlock', params: { blockName: 'chest' } },
        ...(near(sim, 9, 1, 9, 2.5) ? [] : [{ key: 'goto_chest', description: '走到箱子 (9,1,9)', primitive: 'goTo', params: { x: 9, y: 1, z: 9, range: 1 } }]),
        ...(sim.containerTotal(9, 1, 9, 'iron_ingot') >= 2 ? [{ key: 'withdraw_2', description: '取出 2 个 iron_ingot', primitive: 'withdraw', params: { itemName: 'iron_ingot', count: 2 } }] : []),
        ...(near(sim, o.x, o.y, o.z, 3) ? [] : [{ key: 'goto_owner', description: `走到 owner (${o.x},${o.y},${o.z})`, primitive: 'goTo', params: { ...o, range: 1 } }]),
        ...(sim.count('iron_ingot') >= 2 ? [{ key: 'give_2', description: '给 owner 2 个 iron_ingot', primitive: 'give', params: { itemName: 'iron_ingot', count: 2 } }] : []),
        { key: 'say_none', description: '说一句"没有箱子"', primitive: 'say', params: { text: '没有箱子' } },
        { key: 'say_here', description: '说一句"给你"', primitive: 'say', params: { text: '给你' } },
      ]);
    },
    reference: [
      { primitive: 'findBlock', params: { blockName: 'chest' }, id: 'c' },
      { if: { found: 'c' }, then: [
        { primitive: 'goTo', params: {}, at: 'c' },
        { primitive: 'withdraw', params: { itemName: 'iron_ingot', count: 2 } },
        { primitive: 'goTo', params: {}, at: '$owner' },
        { primitive: 'give', params: { itemName: 'iron_ingot', count: 2 } },
      ], else: [
        { primitive: 'say', params: { text: '没有箱子' } },
      ] },
    ],
  },
  {
    id: 49, level: 'L3', title: '收集 3 个 dirt',
    description: '附近散落着 3 块 dirt。逐个找到、走过去挖掉、捡起来，凑够 3 个 dirt。',
    setup(sim) {
      sim.flat();
      sim.setBlock(15, 1, 10, 'dirt'); sim.setBlock(9, 1, 15, 'dirt'); sim.setBlock(17, 1, 14, 'dirt');
    },
    success: sim => sim.count('dirt') >= 3,
    candidates: sim => {
      const d = nearestOf(sim, blocksOf(sim, 'dirt').map(([x, y, z]) => ({ x, y, z })));
      const f = frontCell(sim);
      return withDone([
        ...(d ? [{ key: 'find_dirt', description: '找最近的 dirt', primitive: 'findBlock', params: { blockName: 'dirt' } }] : []),
        ...(d && !near(sim, d.x, d.y, d.z, 2.5) ? [{ key: 'goto_dirt', description: `走到 dirt (${d.x},${d.y},${d.z})`, primitive: 'goTo', params: { x: d.x, y: d.y, z: d.z, range: 1 } }] : []),
        ...(d ? [{ key: 'dig_dirt', description: `挖 (${d.x},${d.y},${d.z})`, primitive: 'dig', params: { x: d.x, y: d.y, z: d.z } }] : []),
        { key: 'collect', description: '捡起周围掉落物', primitive: 'collectDrops', params: { radius: 6 } },
        { key: 'dig_front', description: `挖正前方 (${f.x},${f.y},${f.z})`, primitive: 'dig', params: { x: f.x, y: f.y, z: f.z } },
        { key: 'count', description: '数 dirt 数量', primitive: 'countItem', params: { itemName: 'dirt' } },
      ]);
    },
    reference: [{ repeat: 3, body: [
      { primitive: 'findBlock', params: { blockName: 'dirt' }, id: 'd' },
      { primitive: 'goTo', params: {}, at: 'd' },
      { primitive: 'dig', params: {}, at: 'd' },
      { primitive: 'collectDrops', params: {} },
    ] }],
  },
  {
    id: 50, level: 'L3', title: '双层判断：有铁吗？有煤吗？',
    description: '先看背包里有没有 raw_iron：有的话再看有没有 coal——都有就到 furnace (9,1,8) 旁烧 2 个 raw_iron 并说一句"烧好了"；没 coal 就说"没煤"。连 raw_iron 都没有就说"没铁"。（当前有 raw_iron×3，没有 coal）',
    setup(sim) {
      sim.flat(); sim.setBlock(9, 1, 8, 'furnace'); sim.give('raw_iron', 3);
    },
    success: sim => saidHas(sim, '没煤'),
    candidates: sim => withDone([
      { key: 'find_furnace', description: '找最近的 furnace', primitive: 'findBlock', params: { blockName: 'furnace' } },
      ...(near(sim, 9, 1, 8, 2.5) ? [] : [{ key: 'goto_furnace', description: '走到熔炉 (9,1,8)', primitive: 'goTo', params: { x: 9, y: 1, z: 8, range: 1 } }]),
      { key: 'smelt', description: '用 coal 烧 2 个 raw_iron', primitive: 'smelt', params: { itemName: 'raw_iron', count: 2, fuel: 'coal' } },
      { key: 'count_coal', description: '数 coal 数量', primitive: 'countItem', params: { itemName: 'coal' } },
      { key: 'say_no_coal', description: '说一句"没煤"', primitive: 'say', params: { text: '没煤' } },
      { key: 'say_no_iron', description: '说一句"没铁"', primitive: 'say', params: { text: '没铁' } },
      { key: 'say_done', description: '说一句"烧好了"', primitive: 'say', params: { text: '烧好了' } },
    ]),
    reference: [
      { if: { hasItem: 'raw_iron', atLeast: 1 }, then: [
        { if: { hasItem: 'coal', atLeast: 1 }, then: [
          { primitive: 'findBlock', params: { blockName: 'furnace' }, id: 'f' },
          { primitive: 'goTo', params: {}, at: 'f' },
          { primitive: 'smelt', params: { itemName: 'raw_iron', count: 2, fuel: 'coal' } },
          { primitive: 'say', params: { text: '烧好了' } },
        ], else: [
          { primitive: 'say', params: { text: '没煤' } },
        ] },
      ], else: [
        { primitive: 'say', params: { text: '没铁' } },
      ] },
    ],
  },
];
