// P0r2 reuse holdout task set — 30 tasks (ids 51–80).
// Same shape as tasks-holdout.js ({id, level, title, description, setup(sim),
// success(sim), candidates(sim), reference}) plus two new optional fields:
//   skills: [<draft>] — learned-skill library for this task. The draft objects
//     ({name, description, params, body}) are passed to validateDraft({skills})
//     for call-graph validation, seed the interpreter `library` Map so `call`
//     actually executes, and are listed in the paradigm-A prompt as a
//     signature-only catalog (no bodies — used_call measures whether the
//     model CHOOSES reuse, not whether it can copy an implementation).
//   aOnly: true — paradigm B is skipped. Its option picker only sees
//     primitives, so `call` is unmeasurable there; candidates() returns [].
//
// World cut vs P0r (spec hard constraint): every setup builds the "坡地"
// world — a raised mesa over x,z∈[34..48] (y=1 stone body + y=2 grass skin,
// feet Y=3) with a sunken shelf (feet Y=2) and a piled knoll (feet Y=4) at
// the corners, bot anchored at (40,3,40). Outside the mesa is void. No P0r
// surface patterns: L2 mains are entity chains, two-container literal chains,
// $id.x/y/z decomposition and find* at-centers; L1 is mostly true in-place.
//
// Documented deviations from the spec (each keeps the measured construct):
//   * T52 — "在脚下 $self.below 放 torch" cannot execute: $self.below is the
//     solid ground cell itself, so place there always fails 'occupied'. The
//     real-game act "put a torch at your feet" targets the cell you stand
//     IN, so the task uses at:"$self"; the .below offset is still exercised
//     by T65 (at:"$b.below") and $self.front by T70.
//   * T58 — the sim has no day/night; "夜里" is flavor text. sleep only
//     checks for a bed in range, same as the real primitive.
//   * T76 — DSL skill params only type block|item|count|number|quantity, so
//     `kill_near(name)` cannot declare an entity-name arg. Seeded
//     kill_near/kill_far are parameterless and hard-code 'spider' (the only
//     hostile in that world); the catalog signature shows `call kill_near():`.
//   * T78 — "走一步" is inexpressible: goTo+at pins range=1 and the bot is
//     already within range of $self.front, so it never moves (the same
//     impossibility P0r T45 documented). Equivalent: a sandstone marker
//     chain — repeat{ findBlock → goTo → call place_torch_here → dig marker }
//     — still measures repeat+call composition and per-iteration re-find.
//   * T79 — the spec wants a signature that can't bind: `call` args cannot
//     carry $id references (validateDraft rejects them outright) and no
//     number in the task denotes the furnace, so smelt_at(furnaceId:number)
//     has no honest binding. Its body consumes the param as an x/z coordinate
//     pair, so a guessed literal fails too (a coincidental x=z guess near the
//     furnace is accepted — a fabricated-arg success is still signal).
//     The reference solves the task with primitives, as the spec intends.
//   * T75 — spec's "2 iron" reads as iron_ingot.
//
// Sim-level note: at-bound nodes here always validate through the {0,0,0}
// sentinel path — see sim.js's registry.validate wrapper for why that stays
// in-ambit in this coordinate region.

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
const entity = (sim, name) => nearestOf(sim, entitiesNamed(sim, name));

// The P0r2 slope world (spec §切割): a mesa whose top skin is y=2 so the
// bot's main layer is feet-Y=3, plus a carved shelf (feet Y=2) and a piled
// knoll (feet Y=4) on the corners — both clear of every task coordinate.
// sim.floorY/floorBlock feed summarize()'s ground lines (added for this set).
const mesa = sim => {
  sim.floorBlock = 'grass_block';
  sim.floorY = 2;
  for (let x = 34; x <= 48; x++) for (let z = 34; z <= 48; z++) {
    sim.setBlock(x, 1, z, 'stone');
    sim.setBlock(x, 2, z, 'grass_block');
  }
  for (const [x, z] of [[34, 46], [35, 46], [34, 47], [35, 47]]) sim.setBlock(x, 2, z, 'air'); // sunken shelf, feet Y=2
  for (const [x, z] of [[47, 34], [48, 34], [47, 35], [48, 35]]) sim.setBlock(x, 3, z, 'grass_block'); // knoll, feet Y=4
  sim.teleport(40, 3, 40);
};

// ---- seeded skill drafts (T75–T80) -----------------------------------------

const FETCH_X = {
  name: 'fetch_x', description: '找到最近的箱子，走过去取出指定物品',
  params: { item: { type: 'item', required: true }, count: { type: 'count', required: true } },
  body: [
    { primitive: 'findBlock', params: { blockName: 'chest' }, id: 'c' },
    { primitive: 'goTo', params: {}, at: 'c' },
    { primitive: 'withdraw', params: { itemName: '$item', count: '$count' } },
  ],
};
const KILL_NEAR = {
  name: 'kill_near', description: '找到最近的 spider，走过去杀掉',
  params: {},
  body: [
    { primitive: 'findEntity', params: { entityName: 'spider' }, id: 'e' },
    { primitive: 'goToEntity', params: { uuid: '$e.uuid' } },
    { primitive: 'attack', params: { entityName: 'spider' } },
  ],
};
const KILL_FAR = {
  name: 'kill_far', description: '搜索 64 格半径内的 spider 并走过去杀掉（给远处目标用的）',
  params: {},
  body: [
    { primitive: 'findEntity', params: { entityName: 'spider', radius: 64 }, id: 'e' },
    { primitive: 'goToEntity', params: { uuid: '$e.uuid' } },
    { primitive: 'attack', params: { entityName: 'spider' } },
  ],
};
const FETCH_Y = {
  name: 'fetch_y', description: '找到最近的 barrel，走过去取出指定物品',
  params: { item: { type: 'item', required: true }, count: { type: 'count', required: true } },
  body: [
    { primitive: 'findBlock', params: { blockName: 'barrel' }, id: 'b' },
    { primitive: 'goTo', params: {}, at: 'b' },
    { primitive: 'withdraw', params: { itemName: '$item', count: '$count' } },
  ],
};
const BRING = {
  name: 'bring', description: '从最近的箱子取出指定物品，送到 owner 手里',
  params: { item: { type: 'item', required: true }, count: { type: 'count', required: true } },
  body: [
    { primitive: 'findBlock', params: { blockName: 'chest' }, id: 'c' },
    { primitive: 'goTo', params: {}, at: 'c' },
    { primitive: 'withdraw', params: { itemName: '$item', count: '$count' } },
    { primitive: 'goTo', params: {}, at: '$owner' },
    { primitive: 'give', params: { itemName: '$item', count: '$count' } },
  ],
};
const BRING_ALL = {
  name: 'bring_all', description: '把箱子里所有的 coal 都搬给 owner（无参数）',
  params: {},
  body: [
    { primitive: 'findBlock', params: { blockName: 'chest' }, id: 'c' },
    { primitive: 'goTo', params: {}, at: 'c' },
    { primitive: 'withdraw', params: { itemName: 'coal', count: 64 } },
    { primitive: 'goTo', params: {}, at: '$owner' },
    { primitive: 'give', params: { itemName: 'coal', count: 64 } },
  ],
};
const PLACE_TORCH_HERE = {
  name: 'place_torch_here', description: '在脚下这一格放一根 torch',
  params: {},
  body: [
    { primitive: 'place', params: { itemName: 'torch' }, at: '$self' },
  ],
};
const SMELT_AT = {
  name: 'smelt_at', description: '到编号为 furnaceId 的熔炉，用 coal 烧 2 个 raw_iron',
  params: { furnaceId: { type: 'number', required: true } },
  body: [
    { primitive: 'goTo', params: { x: '$furnaceId', y: 3, z: '$furnaceId' } },
    { primitive: 'smelt', params: { itemName: 'raw_iron', count: 2, fuel: 'coal' } },
  ],
};
const COUNT_AND_SAY = {
  name: 'count_and_say', description: '数一下指定物品的数量并说"X 有 N 个"',
  params: { item: { type: 'item', required: true } },
  body: [
    { primitive: 'countItem', params: { itemName: '$item' }, id: 'n' },
    { primitive: 'say', params: { text: '$item 有 $n.count 个' } },
  ],
};

export const TASKS = [
  // ---------------- L1 (51–60) — 校准档：单原语或最小组合，多为原地 ----------------
  {
    id: 51, level: 'L1', title: '装备 iron_sword',
    description: '背包里有一把 iron_sword 和一把 wooden_sword，把 iron_sword 装备到手上（别拿错）。',
    setup(sim) { mesa(sim); sim.give('iron_sword', 1); sim.give('wooden_sword', 1); },
    success: sim => sim.bot.heldItem === 'iron_sword',
    candidates: () => withDone([
      { key: 'equip_iron', description: '装备 iron_sword', primitive: 'equip', params: { itemName: 'iron_sword' } },
      { key: 'equip_wood', description: '装备 wooden_sword', primitive: 'equip', params: { itemName: 'wooden_sword' } },
      { key: 'count', description: '数 iron_sword 数量', primitive: 'countItem', params: { itemName: 'iron_sword' } },
      { key: 'say', description: '说一句"装备好了"', primitive: 'say', params: { text: '装备好了' } },
    ]),
    reference: [{ primitive: 'equip', params: { itemName: 'iron_sword' } }],
  },
  {
    id: 52, level: 'L1', title: '在脚下放一根火把',
    description: '把背包里的 torch 放一根在 bot 脚下那一格（bot 自己站着的格子）。背包里 torch×2。',
    setup(sim) { mesa(sim); sim.give('torch', 2); },
    success: sim => {
      const p = sim.bot.entity.position;
      return sim.blockAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === 'torch';
    },
    candidates: sim => {
      const p = sim.bot.entity.position;
      const f = frontCell(sim);
      const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
      return withDone([
        ...(airAt(sim, bx, by, bz) && sim.count('torch') >= 1
          ? [{ key: 'place_self', description: `在脚下 (${bx},${by},${bz}) 放 torch`, primitive: 'place', params: { itemName: 'torch', x: bx, y: by, z: bz } }]
          : []),
        ...(airAt(sim, f.x, f.y, f.z) && sim.count('torch') >= 1
          ? [{ key: 'place_front', description: `在面前 (${f.x},${f.y},${f.z}) 放 torch`, primitive: 'place', params: { itemName: 'torch', ...f } }]
          : []),
        { key: 'place_below', description: `在脚下方块 (${bx},${by - 1},${bz}) 放 torch`, primitive: 'place', params: { itemName: 'torch', x: bx, y: by - 1, z: bz } },
        { key: 'count', description: '数 torch 数量', primitive: 'countItem', params: { itemName: 'torch' } },
      ]);
    },
    reference: [{ primitive: 'place', params: { itemName: 'torch' }, at: '$self' }],
  },
  {
    id: 53, level: 'L1', title: '跟 owner 打招呼',
    description: 'owner 在 (43,3,43)。用 say 对他说一句"你好 $owner"（照原样写 $owner，执行时会替换成玩家名）。',
    setup(sim) { mesa(sim); sim.addOwner(43, 3, 43); },
    success: sim => sim.said.some(t => t.includes('你好') && t.includes('player')),
    candidates: () => withDone([
      { key: 'say_hello', description: '说"你好 $owner"', primitive: 'say', params: { text: '你好 player' } },
      { key: 'say_hi', description: '说"你好"', primitive: 'say', params: { text: '你好' } },
      { key: 'say_literal', description: '说"$owner 你好"', primitive: 'say', params: { text: '$owner 你好' } },
      { key: 'goto', description: '走到 (44,3,44)', primitive: 'goTo', params: { x: 44, y: 3, z: 44, range: 1 } },
    ]),
    reference: [{ primitive: 'say', params: { text: '你好 $owner' } }],
  },
  {
    id: 54, level: 'L1', title: '数煤报数',
    description: '数一数背包里 coal 的数量，用 say 把结果报出来（背包里 coal×5）。',
    setup(sim) { mesa(sim); sim.give('coal', 5); },
    success: sim => saidHas(sim, '5'),
    candidates: () => withDone([
      { key: 'count', description: '数 coal 数量', primitive: 'countItem', params: { itemName: 'coal' } },
      { key: 'say_5', description: '说"5"', primitive: 'say', params: { text: '5' } },
      { key: 'say_3', description: '说"3"', primitive: 'say', params: { text: '3' } },
      { key: 'say_have', description: '说"有一些"', primitive: 'say', params: { text: '有一些' } },
    ]),
    reference: [
      { primitive: 'countItem', params: { itemName: 'coal' }, id: 'c' },
      { primitive: 'say', params: { text: '$c.count' } },
    ],
  },
  {
    id: 55, level: 'L1', title: '走到 (46,3,38)',
    description: '走到坐标 (46,3,38)。',
    setup(sim) { mesa(sim); },
    success: sim => distToBot(sim, 46, 3, 38) <= 1.6,
    candidates: sim => withDone([
      ...(near(sim, 46, 3, 38, 1.6) ? [] : [{ key: 'goto_target', description: '走到 (46,3,38)', primitive: 'goTo', params: { x: 46, y: 3, z: 38, range: 1 } }]),
      { key: 'goto_wrong', description: '走到 (38,3,46)', primitive: 'goTo', params: { x: 38, y: 3, z: 46, range: 1 } },
      { key: 'look', description: '看向 (46,3,38)', primitive: 'lookAt', params: { x: 46, y: 3, z: 38 } },
      { key: 'say', description: '说一句"到了"', primitive: 'say', params: { text: '到了' } },
    ]),
    reference: [{ primitive: 'goTo', params: { x: 46, y: 3, z: 38, range: 1 } }],
  },
  {
    id: 56, level: 'L1', title: '打掉旁边的 skeleton',
    description: '附近 4 格内有一只 skeleton。攻击它。',
    setup(sim) {
      mesa(sim);
      sim.addEntity({ name: 'skeleton', uuid: 'eeeeeeee-0000-4000-8000-0000000000e1', x: 44, y: 3, z: 40 });
    },
    success: sim => aliveCount(sim, 'skeleton') === 0,
    candidates: () => withDone([
      { key: 'attack', description: '攻击 skeleton', primitive: 'attack', params: { entityName: 'skeleton' } },
      { key: 'attack_zombie', description: '攻击 zombie', primitive: 'attack', params: { entityName: 'zombie' } },
      { key: 'goto', description: '走到 (44,3,44)', primitive: 'goTo', params: { x: 44, y: 3, z: 44, range: 1 } },
      { key: 'say', description: '说一句"开打"', primitive: 'say', params: { text: '开打' } },
    ]),
    reference: [{ primitive: 'attack', params: { entityName: 'skeleton' } }],
  },
  {
    id: 57, level: 'L1', title: '看向高处的 (38,6,36)',
    description: '抬头看向坐标 (38,6,36)（在左前方高处）。',
    setup(sim) { mesa(sim); },
    success: sim => {
      const p = sim.bot.entity.position;
      const want = Math.atan2(-(38 - p.x), -(36 - p.z));
      return yawDiff(sim.bot.entity.yaw, want) < 0.15
        && sim.looked?.x === 38 && sim.looked?.y === 6 && sim.looked?.z === 36;
    },
    candidates: () => withDone([
      { key: 'look_target', description: '看向 (38,6,36)', primitive: 'lookAt', params: { x: 38, y: 6, z: 36 } },
      { key: 'look_low', description: '看向 (38,1,36)', primitive: 'lookAt', params: { x: 38, y: 1, z: 36 } },
      { key: 'look_wrong', description: '看向 (46,6,44)', primitive: 'lookAt', params: { x: 46, y: 6, z: 44 } },
      { key: 'say', description: '说一句"在看"', primitive: 'say', params: { text: '在看' } },
    ]),
    reference: [{ primitive: 'lookAt', params: { x: 38, y: 6, z: 36 } }],
  },
  {
    id: 58, level: 'L1', title: '上床睡觉',
    description: '夜里了，附近有一张 white_bed（3 格内）。去睡觉。',
    setup(sim) { mesa(sim); sim.setBlock(42, 3, 42, 'white_bed'); },
    success: sim => sim.slept === true,
    candidates: () => withDone([
      { key: 'sleep', description: '睡觉', primitive: 'sleep', params: {} },
      { key: 'find_bed', description: '找最近的 white_bed', primitive: 'findBlock', params: { blockName: 'white_bed' } },
      { key: 'dig_bed', description: '挖掉床 (42,3,42)', primitive: 'dig', params: { x: 42, y: 3, z: 42 } },
      { key: 'say', description: '说一句"晚安"', primitive: 'say', params: { text: '晚安' } },
    ]),
    reference: [{ primitive: 'sleep', params: {} }],
  },
  {
    id: 59, level: 'L1', title: '从旁边的 barrel 取 3 个 bread',
    description: '旁边 (42,3,41) 有个 barrel，里面有 bread×4——距离够近，不用走过去。从里面取 3 个 bread 到背包。',
    setup(sim) {
      mesa(sim); sim.setBlock(42, 3, 41, 'barrel');
      sim.containerAt(42, 3, 41).set('bread', 4);
    },
    success: sim => sim.count('bread') >= 3,
    candidates: () => withDone([
      { key: 'withdraw_3', description: '取出 3 个 bread', primitive: 'withdraw', params: { itemName: 'bread', count: 3 } },
      { key: 'withdraw_4', description: '取出全部 4 个 bread', primitive: 'withdraw', params: { itemName: 'bread', count: 4 } },
      { key: 'withdraw_1', description: '取出 1 个 bread', primitive: 'withdraw', params: { itemName: 'bread', count: 1 } },
      { key: 'goto_barrel', description: '走到 barrel 旁边 (42,3,41)', primitive: 'goTo', params: { x: 42, y: 3, z: 41, range: 1 } },
      { key: 'count', description: '数 bread 数量', primitive: 'countItem', params: { itemName: 'bread' } },
    ]),
    reference: [{ primitive: 'withdraw', params: { itemName: 'bread', count: 3 } }],
  },
  {
    id: 60, level: 'L1', title: '捡起面前的 iron_ingot 掉落物',
    description: '面前 (40,3,39) 有一个 iron_ingot 掉落物，把它捡回背包。',
    setup(sim) { mesa(sim); sim.addDrop(40, 3, 39, 'iron_ingot', 1); },
    success: sim => sim.count('iron_ingot') >= 1,
    candidates: sim => {
      const dropAlive = [...sim.entities.values()].some(e => e.type === 'drop' && e.isValid !== false);
      return withDone([
        { key: 'collect_6', description: '捡起 6 格内掉落物', primitive: 'collectDrops', params: { radius: 6 } },
        ...(dropAlive && !near(sim, 40, 3, 39, 1.6) ? [{ key: 'goto_drop', description: '走到掉落物 (40,3,39)', primitive: 'goTo', params: { x: 40, y: 3, z: 39, range: 1 } }] : []),
        { key: 'collect_1', description: '只捡 1 格内的掉落物', primitive: 'collectDrops', params: { radius: 1 } },
        { key: 'say', description: '说一句"捡到了"', primitive: 'say', params: { text: '捡到了' } },
      ]);
    },
    reference: [{ primitive: 'collectDrops', params: { radius: 6 } }],
  },

  // ---------------- L2 (61–70) — 绑定链档：实体链/容器链/拆参/at 中心 ----------------
  {
    id: 61, level: 'L2', title: '找到 villager 走过去说到',
    description: '附近有一只 villager。找到它、走到它身边，然后说一句"到了"。',
    setup(sim) {
      mesa(sim);
      sim.addEntity({ name: 'villager', uuid: 'fafafafa-0000-4000-8000-0000000000a1', x: 44, y: 3, z: 45, type: 'animal' });
    },
    success: sim => {
      const v = entitiesNamed(sim, 'villager')[0];
      return saidHas(sim, '到了') && v ? distToBot(sim, v.position.x, v.position.y, v.position.z) <= 3.5 : false;
    },
    candidates: sim => {
      const v = entity(sim, 'villager');
      return withDone([
        ...(v ? [{ key: 'find_villager', description: '找最近的 villager', primitive: 'findEntity', params: { entityName: 'villager' } }] : []),
        ...(v && !near(sim, v.position.x, v.position.y, v.position.z, 2.5)
          ? [{ key: 'goto_villager', description: `走到 villager (${v.position.x},${v.position.y},${v.position.z})`, primitive: 'goToEntity', params: { uuid: v.uuid, range: 2 } }]
          : []),
        { key: 'say_arrived', description: '说"到了"', primitive: 'say', params: { text: '到了' } },
        { key: 'attack', description: '攻击 villager', primitive: 'attack', params: { entityName: 'villager' } },
        { key: 'say_lost', description: '说"没找到"', primitive: 'say', params: { text: '没找到' } },
      ]);
    },
    reference: [
      { primitive: 'findEntity', params: { entityName: 'villager' }, id: 'v' },
      { primitive: 'goToEntity', params: { uuid: '$v.uuid' } },
      { primitive: 'say', params: { text: '到了' } },
    ],
  },
  {
    id: 62, level: 'L2', title: '两个箱子之间搬小麦',
    description: '(36,3,44) 的 chest 里有 wheat×6。从里面取 4 个 wheat，再走到 (42,3,41) 的第二个 chest，存 2 个 wheat 进去。',
    setup(sim) {
      mesa(sim);
      sim.setBlock(36, 3, 44, 'chest'); sim.containerAt(36, 3, 44).set('wheat', 6);
      sim.setBlock(42, 3, 41, 'chest');
    },
    success: sim => sim.containerTotal(42, 3, 41, 'wheat') >= 2 && sim.containerTotal(36, 3, 44, 'wheat') <= 2,
    candidates: sim => withDone([
      ...(near(sim, 36, 3, 44, 2.5) ? [] : [{ key: 'goto_chest1', description: '走到第一个箱子 (36,3,44)', primitive: 'goTo', params: { x: 36, y: 3, z: 44, range: 1 } }]),
      ...(near(sim, 36, 3, 44, 4.5) && sim.containerTotal(36, 3, 44, 'wheat') >= 4
        ? [{ key: 'withdraw_4', description: '取出 4 个 wheat', primitive: 'withdraw', params: { itemName: 'wheat', count: 4 } }] : []),
      ...(near(sim, 36, 3, 44, 4.5) && sim.containerTotal(36, 3, 44, 'wheat') >= 2
        ? [{ key: 'withdraw_2', description: '取出 2 个 wheat', primitive: 'withdraw', params: { itemName: 'wheat', count: 2 } }] : []),
      ...(near(sim, 42, 3, 41, 2.5) ? [] : [{ key: 'goto_chest2', description: '走到第二个箱子 (42,3,41)', primitive: 'goTo', params: { x: 42, y: 3, z: 41, range: 1 } }]),
      ...(near(sim, 42, 3, 41, 4.5) && sim.count('wheat') >= 2
        ? [{ key: 'deposit_2', description: '存入 2 个 wheat', primitive: 'deposit', params: { itemName: 'wheat', count: 2 } }] : []),
      { key: 'say', description: '说一句"搬完了"', primitive: 'say', params: { text: '搬完了' } },
    ]),
    reference: [
      { primitive: 'goTo', params: { x: 36, y: 3, z: 44, range: 1 } },
      { primitive: 'withdraw', params: { itemName: 'wheat', count: 4 } },
      { primitive: 'goTo', params: { x: 42, y: 3, z: 41, range: 1 } },
      { primitive: 'deposit', params: { itemName: 'wheat', count: 2 } },
    ],
  },
  {
    id: 63, level: 'L2', title: '杀 creeper 捡掉落物',
    description: '附近有一只 creeper。找到它、走到身边杀掉，然后把掉落物捡回背包。',
    setup(sim) {
      mesa(sim);
      sim.addEntity({ name: 'creeper', uuid: 'eeeeeeee-0000-4000-8000-000000000063', x: 45, y: 3, z: 37 });
    },
    success: sim => aliveCount(sim, 'creeper') === 0 && sim.count('gunpowder') >= 1,
    candidates: sim => {
      const c = entity(sim, 'creeper');
      return withDone([
        ...(c ? [{ key: 'find_creeper', description: '找最近的 creeper', primitive: 'findEntity', params: { entityName: 'creeper' } }] : []),
        ...(c && !near(sim, c.position.x, c.position.y, c.position.z, 3.5)
          ? [{ key: 'goto_creeper', description: `走到 creeper (${c.position.x},${c.position.y},${c.position.z})`, primitive: 'goToEntity', params: { uuid: c.uuid, range: 2 } }]
          : []),
        ...(c ? [{ key: 'attack', description: '攻击 creeper', primitive: 'attack', params: { entityName: 'creeper' } }] : []),
        { key: 'attack_zombie', description: '攻击 zombie', primitive: 'attack', params: { entityName: 'zombie' } },
        { key: 'collect', description: '捡起周围掉落物', primitive: 'collectDrops', params: { radius: 6 } },
        { key: 'say', description: '说一句"解决了"', primitive: 'say', params: { text: '解决了' } },
      ]);
    },
    reference: [
      { primitive: 'findEntity', params: { entityName: 'creeper' }, id: 'e' },
      { primitive: 'goToEntity', params: { uuid: '$e.uuid' } },
      { primitive: 'attack', params: { entityName: 'creeper' } },
      { primitive: 'collectDrops', params: {} },
    ],
  },
  {
    id: 64, level: 'L2', title: '定点搜 stone 挖掉',
    description: '场上有两块 stone：一块在 (44,3,36)，更近的一块在 (37,3,39)。用 findBlock 的搜索中心（x/y/z 参数）把搜索钉在 (44,3,36) 附近找到那块，走过去挖掉它——别动另一块。',
    setup(sim) {
      mesa(sim);
      sim.setBlock(44, 3, 36, 'stone'); sim.setBlock(37, 3, 39, 'stone');
    },
    success: sim => airAt(sim, 44, 3, 36) && sim.blockAt(37, 3, 39) === 'stone',
    candidates: sim => {
      const target = sim.blockAt(44, 3, 36) === 'stone';
      const decoy = sim.blockAt(37, 3, 39) === 'stone';
      return withDone([
        ...(target ? [{ key: 'find_centered', description: '以 (44,3,36) 为中心找 stone', primitive: 'findBlock', params: { blockName: 'stone', x: 44, y: 3, z: 36 } }] : []),
        ...(target || decoy ? [{ key: 'find_near', description: '直接找最近的 stone', primitive: 'findBlock', params: { blockName: 'stone' } }] : []),
        ...(target && !near(sim, 44, 3, 36, 2.5) ? [{ key: 'goto_target', description: '走到 (44,3,36) 的 stone', primitive: 'goTo', params: { x: 44, y: 3, z: 36, range: 1 } }] : []),
        ...(target ? [{ key: 'dig_target', description: '挖 (44,3,36)', primitive: 'dig', params: { x: 44, y: 3, z: 36 } }] : []),
        ...(decoy ? [{ key: 'dig_decoy', description: '挖 (37,3,39)', primitive: 'dig', params: { x: 37, y: 3, z: 39 } }] : []),
        { key: 'say', description: '说一句"在挖"', primitive: 'say', params: { text: '在挖' } },
      ]);
    },
    reference: [
      { primitive: 'findBlock', params: { blockName: 'stone', x: 44, y: 3, z: 36 }, id: 's' },
      { primitive: 'goTo', params: {}, at: 's' },
      { primitive: 'dig', params: {}, at: 's' },
    ],
  },
  {
    id: 65, level: 'L2', title: '查沙子挖下面一格',
    description: '(40,2,41) 应该是一格 sand——先用 blockAt 确认它，然后挖掉它正下方那一格（不是挖 sand 本身）。',
    setup(sim) {
      mesa(sim);
      sim.setBlock(40, 2, 41, 'sand'); sim.setBlock(40, 1, 41, 'coal_ore');
    },
    success: sim => airAt(sim, 40, 1, 41) && sim.blockAt(40, 2, 41) === 'sand',
    candidates: () => withDone([
      { key: 'check', description: '查 (40,2,41) 是什么方块', primitive: 'blockAt', params: { x: 40, y: 2, z: 41 } },
      { key: 'dig_below', description: '挖沙子正下方 (40,1,41)', primitive: 'dig', params: { x: 40, y: 1, z: 41 } },
      { key: 'dig_sand', description: '挖沙子本身 (40,2,41)', primitive: 'dig', params: { x: 40, y: 2, z: 41 } },
      { key: 'goto', description: '走到 (41,3,40)', primitive: 'goTo', params: { x: 41, y: 3, z: 40, range: 1 } },
      { key: 'say', description: '说一句"开挖"', primitive: 'say', params: { text: '开挖' } },
    ]),
    reference: [
      { primitive: 'blockAt', params: { x: 40, y: 2, z: 41 }, id: 'b' },
      { primitive: 'dig', params: {}, at: '$b.below' },
    ],
  },
  {
    id: 66, level: 'L2', title: '拆开坐标找熔炉烧铁',
    description: '找到 furnace，把它结果的 x、y、z 三个字段分别填进 goTo 的 x/y/z 参数走过去，然后用 coal 烧 2 个 raw_iron。背包里 coal×2、raw_iron×3。',
    setup(sim) {
      mesa(sim); sim.setBlock(43, 3, 45, 'furnace');
      sim.give('coal', 2); sim.give('raw_iron', 3);
    },
    success: sim => sim.count('iron_ingot') >= 2,
    candidates: sim => withDone([
      { key: 'find_furnace', description: '找最近的 furnace', primitive: 'findBlock', params: { blockName: 'furnace' } },
      ...(near(sim, 43, 3, 45, 2.5) ? [] : [{ key: 'goto_furnace', description: '走到熔炉 (43,3,45)', primitive: 'goTo', params: { x: 43, y: 3, z: 45, range: 1 } }]),
      ...(sim.count('coal') >= 1 && sim.count('raw_iron') >= 2
        ? [{ key: 'smelt', description: '用 coal 烧 2 个 raw_iron', primitive: 'smelt', params: { itemName: 'raw_iron', count: 2, fuel: 'coal' } }] : []),
      { key: 'count', description: '数 raw_iron 数量', primitive: 'countItem', params: { itemName: 'raw_iron' } },
      { key: 'say', description: '说一句"开烧"', primitive: 'say', params: { text: '开烧' } },
    ]),
    reference: [
      { primitive: 'findBlock', params: { blockName: 'furnace' }, id: 'f' },
      { primitive: 'goTo', params: { x: '$f.x', y: '$f.y', z: '$f.z' } },
      { primitive: 'smelt', params: { itemName: 'raw_iron', count: 2, fuel: 'coal' } },
    ],
  },
  {
    id: 67, level: 'L2', title: '给 owner 送 3 个 carrot',
    description: 'owner 在 (46,3,46)。走过去给他 3 个 carrot（背包有 carrot×5）。',
    setup(sim) { mesa(sim); sim.addOwner(46, 3, 46); sim.give('carrot', 5); },
    success: sim => givenTotal(sim, 'carrot') >= 3,
    candidates: sim => {
      const o = ownerPos(sim) ?? { x: 46, y: 3, z: 46 };
      return withDone([
        ...(near(sim, o.x, o.y, o.z, 3) ? [] : [{ key: 'goto_owner', description: `走到 owner (${o.x},${o.y},${o.z})`, primitive: 'goTo', params: { ...o, range: 1 } }]),
        ...(sim.count('carrot') >= 3 ? [{ key: 'give_3', description: '给 owner 3 个 carrot', primitive: 'give', params: { itemName: 'carrot', count: 3 } }] : []),
        ...(sim.count('carrot') >= 2 ? [{ key: 'give_2', description: '给 owner 2 个 carrot', primitive: 'give', params: { itemName: 'carrot', count: 2 } }] : []),
        { key: 'say', description: '喊一声"来了"', primitive: 'say', params: { text: '来了' } },
      ]);
    },
    reference: [
      { primitive: 'goTo', params: {}, at: '$owner' },
      { primitive: 'give', params: { itemName: 'carrot', count: 3 } },
    ],
  },
  {
    id: 68, level: 'L2', title: '杀 zombie 捡腐肉报数',
    description: '附近有一只 zombie。杀掉它、捡起 rotten_flesh，数一下数量，用 say 把数量报出来。',
    setup(sim) {
      mesa(sim);
      sim.addEntity({ name: 'zombie', uuid: 'eeeeeeee-0000-4000-8000-000000000068', x: 44, y: 3, z: 37 });
    },
    success: sim => aliveCount(sim, 'zombie') === 0 && sim.count('rotten_flesh') >= 1 && saidHas(sim, '1'),
    candidates: sim => {
      const z = entity(sim, 'zombie');
      return withDone([
        ...(z ? [{ key: 'find_zombie', description: '找最近的 zombie', primitive: 'findEntity', params: { entityName: 'zombie' } }] : []),
        ...(z && !near(sim, z.position.x, z.position.y, z.position.z, 3.5)
          ? [{ key: 'goto_zombie', description: `走到 zombie (${z.position.x},${z.position.y},${z.position.z})`, primitive: 'goToEntity', params: { uuid: z.uuid, range: 2 } }]
          : []),
        ...(z ? [{ key: 'attack', description: '攻击 zombie', primitive: 'attack', params: { entityName: 'zombie' } }] : []),
        { key: 'collect', description: '捡起周围掉落物', primitive: 'collectDrops', params: { radius: 6 } },
        ...(sim.count('rotten_flesh') >= 1 ? [{ key: 'count', description: '数 rotten_flesh 数量', primitive: 'countItem', params: { itemName: 'rotten_flesh' } }] : []),
        { key: 'say_1', description: '说"1"', primitive: 'say', params: { text: '1' } },
        { key: 'say_0', description: '说"0"', primitive: 'say', params: { text: '0' } },
      ]);
    },
    reference: [
      { primitive: 'findEntity', params: { entityName: 'zombie' }, id: 'z' },
      { primitive: 'goToEntity', params: { uuid: '$z.uuid' } },
      { primitive: 'attack', params: { entityName: 'zombie' } },
      { primitive: 'collectDrops', params: {} },
      { primitive: 'countItem', params: { itemName: 'rotten_flesh' }, id: 'n' },
      { primitive: 'say', params: { text: '捡了 $n.count 个' } },
    ],
  },
  {
    id: 69, level: 'L2', title: '取煤送给远处的 owner',
    description: '(36,3,40) 的 chest 里有 coal×6。走过去取 4 个 coal，再走到 owner (45,3,45) 身边给他。',
    setup(sim) {
      mesa(sim); sim.setBlock(36, 3, 40, 'chest');
      sim.containerAt(36, 3, 40).set('coal', 6);
      sim.addOwner(45, 3, 45);
    },
    success: sim => givenTotal(sim, 'coal') >= 4,
    candidates: sim => {
      const o = ownerPos(sim) ?? { x: 45, y: 3, z: 45 };
      return withDone([
        ...(near(sim, 36, 3, 40, 2.5) ? [] : [{ key: 'goto_chest', description: '走到箱子 (36,3,40)', primitive: 'goTo', params: { x: 36, y: 3, z: 40, range: 1 } }]),
        ...(near(sim, 36, 3, 40, 4.5) && sim.containerTotal(36, 3, 40, 'coal') >= 4
          ? [{ key: 'withdraw_4', description: '取出 4 个 coal', primitive: 'withdraw', params: { itemName: 'coal', count: 4 } }] : []),
        ...(near(sim, 36, 3, 40, 4.5) && sim.containerTotal(36, 3, 40, 'coal') >= 2
          ? [{ key: 'withdraw_2', description: '取出 2 个 coal', primitive: 'withdraw', params: { itemName: 'coal', count: 2 } }] : []),
        ...(near(sim, o.x, o.y, o.z, 3) ? [] : [{ key: 'goto_owner', description: `走到 owner (${o.x},${o.y},${o.z})`, primitive: 'goTo', params: { ...o, range: 1 } }]),
        ...(sim.count('coal') >= 4 ? [{ key: 'give_4', description: '给 owner 4 个 coal', primitive: 'give', params: { itemName: 'coal', count: 4 } }] : []),
        ...(sim.count('coal') >= 2 ? [{ key: 'give_2', description: '给 owner 2 个 coal', primitive: 'give', params: { itemName: 'coal', count: 2 } }] : []),
        { key: 'say', description: '喊一声"来了"', primitive: 'say', params: { text: '来了' } },
      ]);
    },
    reference: [
      { primitive: 'goTo', params: { x: 36, y: 3, z: 40, range: 1 } },
      { primitive: 'withdraw', params: { itemName: 'coal', count: 4 } },
      { primitive: 'goTo', params: {}, at: '$owner' },
      { primitive: 'give', params: { itemName: 'coal', count: 4 } },
    ],
  },
  {
    id: 70, level: 'L2', title: '找箱子取火把插面前',
    description: '用 findBlock 以自己脚下为搜索中心找最近的 chest（里面 torch×4），走过去取 2 个 torch，然后把一根放到自己正前方那一格。',
    setup(sim) {
      mesa(sim); sim.setBlock(37, 3, 38, 'chest');
      sim.containerAt(37, 3, 38).set('torch', 4);
      // Decor stone at the chest's south neighbour: without it the goTo
      // approach lands at (37,3,39) where $self.front resolves onto the
      // chest itself (place → 'occupied'). This shapes the landing to a
      // side whose front cell is air.
      sim.setBlock(37, 3, 39, 'stone');
    },
    success: sim => {
      const f = frontCell(sim);
      return sim.blockAt(f.x, f.y, f.z) === 'torch' && sim.count('torch') >= 1;
    },
    candidates: sim => {
      const f = frontCell(sim);
      return withDone([
        { key: 'find_chest', description: '以脚下为中心找 chest', primitive: 'findBlock', params: { blockName: 'chest' } },
        ...(near(sim, 37, 3, 38, 2.5) ? [] : [{ key: 'goto_chest', description: '走到箱子 (37,3,38)', primitive: 'goTo', params: { x: 37, y: 3, z: 38, range: 1 } }]),
        ...(near(sim, 37, 3, 38, 4.5) && sim.containerTotal(37, 3, 38, 'torch') >= 2
          ? [{ key: 'withdraw_2', description: '取出 2 个 torch', primitive: 'withdraw', params: { itemName: 'torch', count: 2 } }] : []),
        ...(airAt(sim, f.x, f.y, f.z) && sim.count('torch') >= 1
          ? [{ key: 'place_front', description: `在面前 (${f.x},${f.y},${f.z}) 放 torch`, primitive: 'place', params: { itemName: 'torch', ...f } }] : []),
        { key: 'say', description: '说一句"插火把"', primitive: 'say', params: { text: '插火把' } },
      ]);
    },
    reference: [
      { primitive: 'findBlock', params: { blockName: 'chest' }, at: '$self', id: 'c' },
      { primitive: 'goTo', params: {}, at: '$c' },
      { primitive: 'withdraw', params: { itemName: 'torch', count: 2 } },
      { primitive: 'place', params: { itemName: 'torch' }, at: '$self.front' },
    ],
  },

  // ---------------- L3 (71–74) — 无库任务：repeat / if，换表面 ----------------
  {
    id: 71, level: 'L3', title: '清掉 3 只 spider 并捡掉落',
    description: '附近散着 3 只 spider。逐个找到、走到身边杀掉，并捡起每只的掉落物。',
    setup(sim) {
      mesa(sim);
      sim.addEntity({ name: 'spider', uuid: 'eeeeeeee-0000-4000-8000-000000000071', x: 44, y: 3, z: 36 });
      sim.addEntity({ name: 'spider', uuid: 'eeeeeeee-0000-4000-8000-000000000072', x: 36, y: 3, z: 44 });
      sim.addEntity({ name: 'spider', uuid: 'eeeeeeee-0000-4000-8000-000000000073', x: 45, y: 3, z: 45 });
    },
    success: sim => aliveCount(sim, 'spider') === 0 && sim.count('string') >= 3,
    candidates: sim => {
      const s = entity(sim, 'spider');
      return withDone([
        ...(s ? [{ key: 'find_spider', description: '找最近的 spider', primitive: 'findEntity', params: { entityName: 'spider' } }] : []),
        ...(s && !near(sim, s.position.x, s.position.y, s.position.z, 3.5)
          ? [{ key: 'goto_spider', description: `走到最近的 spider (${s.position.x},${s.position.y},${s.position.z})`, primitive: 'goToEntity', params: { uuid: s.uuid, range: 2 } }]
          : []),
        ...(s ? [{ key: 'attack', description: '攻击 spider', primitive: 'attack', params: { entityName: 'spider' } }] : []),
        { key: 'collect', description: '捡起周围掉落物', primitive: 'collectDrops', params: { radius: 6 } },
        { key: 'attack_zombie', description: '攻击 zombie', primitive: 'attack', params: { entityName: 'zombie' } },
        { key: 'say', description: '说一句"清完了"', primitive: 'say', params: { text: '清完了' } },
      ]);
    },
    reference: [{ repeat: 3, body: [
      { primitive: 'findEntity', params: { entityName: 'spider' }, id: 's' },
      { primitive: 'goToEntity', params: { uuid: '$s.uuid' } },
      { primitive: 'attack', params: { entityName: 'spider' } },
      { primitive: 'collectDrops', params: {} },
    ] }],
  },
  {
    id: 72, level: 'L3', title: '不饿就挖 3 块 dirt 装箱',
    description: '如果饿了（food<12）就吃 2 个 bread；否则挖 3 块 dirt 捡起来，存进最近的 chest。当前 food=15（不饿），背包里 bread×2，场上有 dirt (43,3,37)、(37,3,43)、(44,3,44)，chest 在 (36,3,36)。',
    setup(sim) {
      mesa(sim); sim.bot.food = 15; sim.give('bread', 2);
      sim.setBlock(43, 3, 37, 'dirt'); sim.setBlock(37, 3, 43, 'dirt'); sim.setBlock(44, 3, 44, 'dirt');
      sim.setBlock(36, 3, 36, 'chest');
    },
    success: sim => sim.containerTotal(36, 3, 36, 'dirt') >= 3,
    candidates: sim => {
      const d = nearestOf(sim, blocksOf(sim, 'dirt').map(([x, y, z]) => ({ x, y, z })));
      return withDone([
        ...(sim.count('bread') >= 1 ? [{ key: 'eat', description: '吃一个 bread', primitive: 'eat', params: { itemName: 'bread' } }] : []),
        ...(d ? [{ key: 'find_dirt', description: '找最近的 dirt', primitive: 'findBlock', params: { blockName: 'dirt' } }] : []),
        ...(d && !near(sim, d.x, d.y, d.z, 2.5) ? [{ key: 'goto_dirt', description: `走到 dirt (${d.x},${d.y},${d.z})`, primitive: 'goTo', params: { ...d, range: 1 } }] : []),
        ...(d ? [{ key: 'dig_dirt', description: `挖 (${d.x},${d.y},${d.z})`, primitive: 'dig', params: { ...d } }] : []),
        { key: 'collect', description: '捡起周围掉落物', primitive: 'collectDrops', params: { radius: 6 } },
        { key: 'find_chest', description: '找最近的 chest', primitive: 'findBlock', params: { blockName: 'chest' } },
        ...(near(sim, 36, 3, 36, 2.5) ? [] : [{ key: 'goto_chest', description: '走到箱子 (36,3,36)', primitive: 'goTo', params: { x: 36, y: 3, z: 36, range: 1 } }]),
        ...(sim.count('dirt') >= 3 ? [{ key: 'deposit', description: '存入 3 个 dirt', primitive: 'deposit', params: { itemName: 'dirt', count: 3 } }] : []),
      ]);
    },
    reference: [
      { if: { foodBelow: 12 }, then: [
        { primitive: 'eat', params: { itemName: 'bread' } },
        { primitive: 'eat', params: { itemName: 'bread' } },
      ], else: [
        { repeat: 3, body: [
          { primitive: 'findBlock', params: { blockName: 'dirt' }, id: 'd' },
          { primitive: 'goTo', params: {}, at: 'd' },
          { primitive: 'dig', params: {}, at: 'd' },
          { primitive: 'collectDrops', params: {} },
        ] },
        { primitive: 'findBlock', params: { blockName: 'chest' }, id: 'c' },
        { primitive: 'goTo', params: {}, at: 'c' },
        { primitive: 'deposit', params: { itemName: 'dirt', count: 3 } },
      ] },
    ],
  },
  {
    id: 73, level: 'L3', title: '两趟把 diamond 送给 owner',
    description: '重复 2 次：走到 chest (37,3,45)（里面 diamond×3）取 1 个 diamond，再走到 owner (44,3,37) 身边给他。',
    setup(sim) {
      mesa(sim); sim.setBlock(37, 3, 45, 'chest');
      sim.containerAt(37, 3, 45).set('diamond', 3);
      sim.addOwner(44, 3, 37);
    },
    success: sim => givenTotal(sim, 'diamond') >= 2,
    candidates: sim => {
      const o = ownerPos(sim) ?? { x: 44, y: 3, z: 37 };
      return withDone([
        ...(near(sim, 37, 3, 45, 2.5) ? [] : [{ key: 'goto_chest', description: '走到箱子 (37,3,45)', primitive: 'goTo', params: { x: 37, y: 3, z: 45, range: 1 } }]),
        ...(near(sim, 37, 3, 45, 4.5) && sim.containerTotal(37, 3, 45, 'diamond') >= 1
          ? [{ key: 'withdraw_1', description: '取出 1 个 diamond', primitive: 'withdraw', params: { itemName: 'diamond', count: 1 } }] : []),
        ...(near(sim, o.x, o.y, o.z, 3) ? [] : [{ key: 'goto_owner', description: `走到 owner (${o.x},${o.y},${o.z})`, primitive: 'goTo', params: { ...o, range: 1 } }]),
        ...(sim.count('diamond') >= 1 ? [{ key: 'give_1', description: '给 owner 1 个 diamond', primitive: 'give', params: { itemName: 'diamond', count: 1 } }] : []),
        { key: 'say', description: '喊一声"来了"', primitive: 'say', params: { text: '来了' } },
      ]);
    },
    reference: [{ repeat: 2, body: [
      { primitive: 'goTo', params: { x: 37, y: 3, z: 45, range: 1 } },
      { primitive: 'withdraw', params: { itemName: 'diamond', count: 1 } },
      { primitive: 'goTo', params: {}, at: '$owner' },
      { primitive: 'give', params: { itemName: 'diamond', count: 1 } },
    ] }],
  },
  {
    id: 74, level: 'L3', title: '有煤就烧 2 个生铁，否则说没煤',
    description: '如果背包里 coal≥2，就到 furnace 旁用 coal 把 2 个 raw_iron 烧成 iron_ingot；否则说一句"没煤"。当前 coal×3、raw_iron×3，附近有 furnace。',
    setup(sim) {
      mesa(sim); sim.setBlock(44, 3, 44, 'furnace');
      sim.give('coal', 3); sim.give('raw_iron', 3);
    },
    success: sim => sim.count('iron_ingot') >= 2,
    candidates: sim => withDone([
      { key: 'find_furnace', description: '找最近的 furnace', primitive: 'findBlock', params: { blockName: 'furnace' } },
      ...(near(sim, 44, 3, 44, 2.5) ? [] : [{ key: 'goto_furnace', description: '走到熔炉 (44,3,44)', primitive: 'goTo', params: { x: 44, y: 3, z: 44, range: 1 } }]),
      ...(sim.count('coal') >= 1 && sim.count('raw_iron') >= 2
        ? [{ key: 'smelt', description: '用 coal 烧 2 个 raw_iron', primitive: 'smelt', params: { itemName: 'raw_iron', count: 2, fuel: 'coal' } }] : []),
      { key: 'say_no_coal', description: '说一句"没煤"', primitive: 'say', params: { text: '没煤' } },
      { key: 'count', description: '数 coal 数量', primitive: 'countItem', params: { itemName: 'coal' } },
    ]),
    reference: [
      { if: { hasItem: 'coal', atLeast: 2 }, then: [
        { primitive: 'findBlock', params: { blockName: 'furnace' }, id: 'f' },
        { primitive: 'goTo', params: {}, at: 'f' },
        { primitive: 'smelt', params: { itemName: 'raw_iron', count: 2, fuel: 'coal' } },
      ], else: [
        { primitive: 'say', params: { text: '没煤' } },
      ] },
    ],
  },

  // ---------------- L3 (75–80) — 种库任务：skills 预置，aOnly ----------------
  {
    id: 75, level: 'L3', title: '取煤和铁交给 owner',
    description: '从箱子里取 2 个 coal 和 2 个 iron_ingot，拿给 owner。chest 在 (36,3,44)（coal×4、iron_ingot×4），owner 在 (45,3,45)。',
    skills: [FETCH_X],
    aOnly: true,
    setup(sim) {
      mesa(sim); sim.setBlock(36, 3, 44, 'chest');
      sim.containerAt(36, 3, 44).set('coal', 4);
      sim.containerAt(36, 3, 44).set('iron_ingot', 4);
      sim.addOwner(45, 3, 45);
    },
    success: sim => givenTotal(sim, 'coal') >= 2 && givenTotal(sim, 'iron_ingot') >= 2,
    candidates: () => [],
    reference: [
      { call: 'fetch_x', args: { item: 'coal', count: 2 } },
      { call: 'fetch_x', args: { item: 'iron_ingot', count: 2 } },
      { primitive: 'goTo', params: {}, at: '$owner' },
      { primitive: 'give', params: { itemName: 'coal', count: 2 } },
      { primitive: 'give', params: { itemName: 'iron_ingot', count: 2 } },
    ],
  },
  {
    id: 76, level: 'L3', title: '杀 spider 捡丝线',
    description: '附近有一只 spider（还有一只 barrel 在场）。杀掉 spider 并把掉落物捡回背包。',
    skills: [KILL_NEAR, KILL_FAR, FETCH_Y],
    aOnly: true,
    setup(sim) {
      mesa(sim);
      sim.addEntity({ name: 'spider', uuid: 'eeeeeeee-0000-4000-8000-000000000076', x: 44, y: 3, z: 36 });
      sim.setBlock(38, 3, 43, 'barrel'); sim.containerAt(38, 3, 43).set('bread', 3);
    },
    success: sim => aliveCount(sim, 'spider') === 0 && sim.count('string') >= 1,
    candidates: () => [],
    reference: [
      { call: 'kill_near', args: {} },
      { primitive: 'collectDrops', params: {} },
    ],
  },
  {
    id: 77, level: 'L3', title: '拿 3 个 bread 给 owner',
    description: 'chest 在 (37,3,44)（bread×6、coal×4），owner 在 (44,3,37)。拿 3 个 bread 给 owner。',
    skills: [BRING, BRING_ALL],
    aOnly: true,
    setup(sim) {
      mesa(sim); sim.setBlock(37, 3, 44, 'chest');
      sim.containerAt(37, 3, 44).set('bread', 6);
      sim.containerAt(37, 3, 44).set('coal', 4);
      sim.addOwner(44, 3, 37);
    },
    success: sim => givenTotal(sim, 'bread') >= 3,
    candidates: () => [],
    reference: [
      { call: 'bring', args: { item: 'bread', count: 3 } },
    ],
  },
  {
    id: 78, level: 'L3', title: '沿标记走一路插火把',
    description: '场上有 3 块 sandstone 标记：(40,3,38)、(40,3,36)、(40,3,34)。对每个标记：走到旁边、在脚下放一根 torch、再挖掉标记，逐个处理完。背包里 torch×5。',
    skills: [PLACE_TORCH_HERE],
    aOnly: true,
    setup(sim) {
      mesa(sim);
      sim.setBlock(40, 3, 38, 'sandstone'); sim.setBlock(40, 3, 36, 'sandstone'); sim.setBlock(40, 3, 34, 'sandstone');
      sim.give('torch', 5);
    },
    success: sim => blocksOf(sim, 'sandstone').length === 0 && blocksOf(sim, 'torch').length >= 3,
    candidates: () => [],
    reference: [{ repeat: 3, body: [
      { primitive: 'findBlock', params: { blockName: 'sandstone' }, id: 'm' },
      { primitive: 'goTo', params: {}, at: 'm' },
      { call: 'place_torch_here', args: {} },
      { primitive: 'dig', params: {}, at: 'm' },
    ] }],
  },
  {
    id: 79, level: 'L3', title: '烧 2 个生铁',
    description: '附近有一座 furnace。用 coal 把 2 个 raw_iron 烧成 iron_ingot。背包里 coal×3、raw_iron×3。',
    skills: [SMELT_AT],
    aOnly: true,
    setup(sim) {
      mesa(sim); sim.setBlock(38, 3, 44, 'furnace');
      sim.give('coal', 3); sim.give('raw_iron', 3);
    },
    success: sim => sim.count('iron_ingot') >= 2,
    candidates: () => [],
    reference: [
      { primitive: 'findBlock', params: { blockName: 'furnace' }, id: 'f' },
      { primitive: 'goTo', params: {}, at: 'f' },
      { primitive: 'smelt', params: { itemName: 'raw_iron', count: 2, fuel: 'coal' } },
    ],
  },
  {
    id: 80, level: 'L3', title: '数铁数煤各报一次',
    description: '数一数背包里 iron_ingot 和 coal 各有多少，各报一次数（iron_ingot×5、coal×3）。',
    skills: [COUNT_AND_SAY],
    aOnly: true,
    setup(sim) { mesa(sim); sim.give('iron_ingot', 5); sim.give('coal', 3); },
    success: sim => saidHas(sim, '5') && saidHas(sim, '3'),
    candidates: () => [],
    reference: [
      { call: 'count_and_say', args: { item: 'iron_ingot' } },
      { call: 'count_and_say', args: { item: 'coal' } },
    ],
  },
];
