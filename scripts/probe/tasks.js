// P0 probe task set — the 16 base tasks.
// Each task: { id, level, title, description (model-facing), setup(sim),
// success(sim), candidates(sim) for paradigm B, reference (skill-v2 body used
// by --selftest) }. Setups are fully deterministic; candidate generators are
// state-aware so a correct strategy can always finish inside the step budget.

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
const ownerPos = sim => {
  const owner = sim.owner();
  return owner ? { x: owner.position.x, y: owner.position.y, z: owner.position.z } : null;
};

export const TASKS = [
  // ---------------- L1 — 一个原语或一个组合就够 ----------------
  {
    id: 1, level: 'L1', title: '把 2 个木棍给他',
    description: '把 2 个木棍（stick）交给身边的 owner（背包里已有木棍）。',
    setup(sim) {
      sim.flat(); sim.addOwner(12, 1, 14); sim.give('stick', 5);
    },
    success: sim => sim.given.filter(g => g.itemName === 'stick').reduce((a, g) => a + g.count, 0) >= 2,
    candidates: sim => withDone([
      { key: 'give_2', description: '把 2 个木棍丢给 owner', primitive: 'give', params: { itemName: 'stick', count: 2 } },
      { key: 'give_1', description: '把 1 个木棍丢给 owner', primitive: 'give', params: { itemName: 'stick', count: 1 } },
      { key: 'say', description: '说一句"给你"', primitive: 'say', params: { text: '给你' } },
      { key: 'count', description: '数一下木棍数量', primitive: 'countItem', params: { itemName: 'stick' } },
    ]),
    reference: [{ primitive: 'give', params: { itemName: 'stick', count: 2 } }],
  },
  {
    id: 2, level: 'L1', title: '挖掉面前标出的草方块',
    description: '挖掉 bot 正前方（面朝方向）那个标出的 grass_block。',
    setup(sim) {
      sim.flat(); sim.setBlock(12, 1, 11, 'grass_block');
    },
    success: sim => airAt(sim, 12, 1, 11),
    candidates: sim => {
      const f = frontCell(sim);
      return withDone([
        { key: 'dig_front', description: `挖正前方的方块 (${f.x},${f.y},${f.z})`, primitive: 'dig', params: { ...f } },
        { key: 'dig_below', description: '挖脚底下的方块', primitive: 'dig', params: { x: 12, y: 0, z: 12 } },
        { key: 'look', description: '看向前方', primitive: 'lookAt', params: { ...f } },
      ]);
    },
    reference: [{ primitive: 'dig', params: {}, at: '$self.front' }],
  },
  {
    id: 3, level: 'L1', title: '合成一把木镐',
    description: '用背包里的材料合成 1 把 wooden_pickaxe（附近有工作台，需要 oak_planks + stick）。',
    setup(sim) {
      sim.flat(); sim.setBlock(12, 1, 11, 'crafting_table');
      sim.give('oak_planks', 8); sim.give('stick', 4);
    },
    success: sim => sim.count('wooden_pickaxe') >= 1,
    candidates: () => withDone([
      { key: 'craft', description: '合成 wooden_pickaxe', primitive: 'craft', params: { itemName: 'wooden_pickaxe', count: 1, useTable: true } },
      { key: 'craft_stick', description: '先合成更多 stick', primitive: 'craft', params: { itemName: 'stick', count: 4 } },
      { key: 'craft_planks', description: '合成 oak_planks', primitive: 'craft', params: { itemName: 'oak_planks', count: 4 } },
    ]),
    reference: [{ primitive: 'craft', params: { itemName: 'wooden_pickaxe', count: 1, useTable: true } }],
  },
  {
    id: 4, level: 'L1', title: '看向指定坐标',
    description: '转身面向坐标 (5, 4, 8)。',
    setup(sim) { sim.flat(); },
    success: sim => {
      const p = sim.bot.entity.position;
      const want = Math.atan2(-(5 - p.x), -(8 - p.z));
      let d = Math.abs(sim.bot.entity.yaw - want) % (Math.PI * 2);
      if (d > Math.PI) d = Math.PI * 2 - d;
      return d < 0.15;
    },
    candidates: () => withDone([
      { key: 'look_target', description: '看向 (5,4,8)', primitive: 'lookAt', params: { x: 5, y: 4, z: 8 } },
      { key: 'look_wrong', description: '看向 (20,4,20)', primitive: 'lookAt', params: { x: 20, y: 4, z: 20 } },
      { key: 'say', description: '说一句"在看"', primitive: 'say', params: { text: '在看' } },
    ]),
    reference: [{ primitive: 'lookAt', params: { x: 5, y: 4, z: 8 } }],
  },
  {
    id: 5, level: 'L1', title: '数背包里的圆石并报数',
    description: '数一数背包里有多少个 cobblestone，然后用 say 把数量报出来。',
    setup(sim) { sim.flat(); sim.give('cobblestone', 7); },
    success: sim => sim.said.some(text => /\b7\b|七个|^7$|7 个|个 7/.test(text) || text.includes('7')),
    candidates: () => withDone([
      { key: 'count', description: '数 cobblestone 数量', primitive: 'countItem', params: { itemName: 'cobblestone' } },
      { key: 'say_7', description: '报数"7"', primitive: 'say', params: { text: '7' } },
      { key: 'say_0', description: '报数"0"', primitive: 'say', params: { text: '0' } },
      { key: 'say_many', description: '含糊地说"有一些"', primitive: 'say', params: { text: '有一些' } },
    ]),
    reference: [
      { primitive: 'countItem', params: { itemName: 'cobblestone' }, id: 'n' },
      { primitive: 'say', params: { text: '7' } },
    ],
  },

  // ---------------- L2 — 查询 + 3–5 步，必须用 id/at 绑定 ----------------
  {
    id: 6, level: 'L2', title: '找到最近的箱子，把 5 个圆石放进去',
    description: '找到附近的 chest，走过去，把 5 个 cobblestone 存进去（背包里有 10 个）。',
    setup(sim) {
      sim.flat(); sim.setBlock(8, 1, 8, 'chest'); sim.give('cobblestone', 10);
    },
    success: sim => sim.containerTotal(8, 1, 8, 'cobblestone') >= 5,
    candidates: sim => withDone([
      { key: 'find_chest', description: '找最近的 chest 位置', primitive: 'findBlock', params: { blockName: 'chest' } },
      ...(near(sim, 8, 1, 8, 2.5) ? [] : [{ key: 'goto_chest', description: '走到 chest 旁边 (8,1,8)', primitive: 'goTo', params: { x: 8, y: 1, z: 8, range: 1 } }]),
      { key: 'deposit5', description: '存入 5 个 cobblestone', primitive: 'deposit', params: { itemName: 'cobblestone', count: 5 } },
      { key: 'deposit10', description: '存入 10 个 cobblestone', primitive: 'deposit', params: { itemName: 'cobblestone', count: 10 } },
      { key: 'say', description: '说一句"找到了"', primitive: 'say', params: { text: '找到了' } },
    ]),
    reference: [
      { primitive: 'findBlock', params: { blockName: 'chest' }, id: 'box' },
      { primitive: 'goTo', params: {}, at: 'box' },
      { primitive: 'deposit', params: { itemName: 'cobblestone', count: 5 } },
    ],
  },
  {
    id: 7, level: 'L2', title: '找到铁矿挖掉并捡回来',
    description: '找到附近的 iron_ore，走过去挖掉，并把掉落物捡回背包。',
    setup(sim) {
      sim.flat(); sim.setBlock(17, 1, 9, 'iron_ore');
    },
    success: sim => sim.count('raw_iron') >= 1,
    candidates: sim => withDone([
      { key: 'find', description: '找最近的 iron_ore', primitive: 'findBlock', params: { blockName: 'iron_ore' } },
      ...(near(sim, 17, 1, 9, 2.5) ? [] : [{ key: 'goto', description: '走到铁矿旁 (17,1,9)', primitive: 'goTo', params: { x: 17, y: 1, z: 9, range: 1 } }]),
      ...(sim.blockAt(17, 1, 9) !== 'air' ? [{ key: 'dig', description: '挖 (17,1,9)', primitive: 'dig', params: { x: 17, y: 1, z: 9 } }] : []),
      { key: 'collect', description: '捡起周围掉落物', primitive: 'collectDrops', params: { radius: 6 } },
      { key: 'dig_far', description: '挖脚下方块', primitive: 'dig', params: { x: 12, y: 0, z: 12 } },
    ]),
    reference: [
      { primitive: 'findBlock', params: { blockName: 'iron_ore' }, id: 'ore' },
      { primitive: 'goTo', params: {}, at: 'ore' },
      { primitive: 'dig', params: {}, at: 'ore' },
      { primitive: 'collectDrops', params: {} },
    ],
  },
  {
    id: 8, level: 'L2', title: '找到熔炉，把 2 个生铁烧掉',
    description: '找到附近的 furnace，走过去，用背包里的 coal 把 2 个 raw_iron 烧成 iron_ingot。',
    setup(sim) {
      sim.flat(); sim.setBlock(9, 1, 8, 'furnace'); sim.give('raw_iron', 3); sim.give('coal', 1);
    },
    success: sim => sim.count('iron_ingot') >= 2,
    candidates: sim => withDone([
      { key: 'find', description: '找最近的 furnace', primitive: 'findBlock', params: { blockName: 'furnace' } },
      ...(near(sim, 9, 1, 8, 2.5) ? [] : [{ key: 'goto', description: '走到熔炉旁 (9,1,8)', primitive: 'goTo', params: { x: 9, y: 1, z: 8, range: 1 } }]),
      { key: 'smelt2', description: '用 coal 烧 2 个 raw_iron', primitive: 'smelt', params: { itemName: 'raw_iron', count: 2, fuel: 'coal' } },
      { key: 'smelt1', description: '用 coal 烧 1 个 raw_iron', primitive: 'smelt', params: { itemName: 'raw_iron', count: 1, fuel: 'coal' } },
    ]),
    reference: [
      { primitive: 'findBlock', params: { blockName: 'furnace' }, id: 'f' },
      { primitive: 'goTo', params: {}, at: 'f' },
      { primitive: 'smelt', params: { itemName: 'raw_iron', count: 2, fuel: 'coal' } },
    ],
  },
  {
    id: 9, level: 'L2', title: '走到他身边并给他一个苹果',
    description: 'owner 在远处，走到他身边并给他 1 个 apple。',
    setup(sim) {
      sim.flat(); sim.addOwner(12, 1, 19); sim.give('apple', 2);
    },
    success: sim => sim.given.filter(g => g.itemName === 'apple').reduce((a, g) => a + g.count, 0) >= 1,
    candidates: sim => {
      const o = ownerPos(sim) ?? { x: 12, y: 1, z: 19 };
      return withDone([
        ...(near(sim, o.x, o.y, o.z, 2.5) ? [] : [{ key: 'goto_owner', description: `走到 owner 旁 (${o.x},${o.y},${o.z})`, primitive: 'goTo', params: { ...o, range: 1 } }]),
        { key: 'give', description: '给 owner 1 个 apple', primitive: 'give', params: { itemName: 'apple', count: 1 } },
        { key: 'follow', description: '跟随 owner', primitive: 'follow', params: { range: 2 } },
        { key: 'say', description: '喊一声"来了"', primitive: 'say', params: { text: '来了' } },
      ]);
    },
    reference: [
      { primitive: 'goTo', params: {}, at: '$owner' },
      { primitive: 'give', params: { itemName: 'apple', count: 1 } },
    ],
  },
  {
    id: 10, level: 'L2', title: '附近 8 格有僵尸就打掉它',
    description: '如果 8 格以内有 zombie 就消灭它（没有就不动）。',
    setup(sim) {
      sim.flat(); sim.addEntity({ name: 'zombie', uuid: 'cccccccc-0000-4000-8000-0000000000c1', x: 13, y: 1, z: 10 });
    },
    success: sim => ![...sim.entities.values()].some(e => e.name === 'zombie' && e.isValid !== false),
    candidates: () => withDone([
      { key: 'find_z', description: '找 8 格内的 zombie', primitive: 'findEntity', params: { entityName: 'zombie', radius: 8 } },
      { key: 'attack', description: '攻击 zombie', primitive: 'attack', params: { entityName: 'zombie' } },
      { key: 'attack_cow', description: '攻击 cow', primitive: 'attack', params: { entityName: 'cow' } },
      { key: 'run', description: '跑远到 (20,1,20)', primitive: 'goTo', params: { x: 20, y: 1, z: 20, range: 1 } },
    ]),
    reference: [
      { primitive: 'findEntity', params: { entityName: 'zombie', radius: 8 }, id: 'z' },
      { if: { found: 'z' }, then: [{ primitive: 'attack', params: { entityName: 'zombie' } }] },
    ],
  },

  // ---------------- L3 — 8+ 步、repeat 或 if ----------------
  {
    id: 11, level: 'L3', title: '收集 4 个原木',
    description: '收集 4 个 oak_log 到背包里（散落在附近地面上，每挖一个都要重新找下一根）。',
    setup(sim) {
      sim.flat();
      sim.setBlock(16, 1, 12, 'oak_log'); sim.setBlock(18, 1, 15, 'oak_log');
      sim.setBlock(9, 1, 16, 'oak_log'); sim.setBlock(14, 1, 18, 'oak_log');
    },
    success: sim => sim.count('oak_log') >= 4,
    candidates: sim => {
      const logs = blocksOf(sim, 'oak_log');
      const first = logs[0];
      const list = [
        { key: 'find', description: '找最近的 oak_log', primitive: 'findBlock', params: { blockName: 'oak_log' } },
        ...(first ? [
          ...(near(sim, first[0], first[1], first[2], 2.5) ? [] : [{ key: 'goto', description: `走到最近的原木 (${first[0]},${first[1]},${first[2]})`, primitive: 'goTo', params: { x: first[0], y: first[1], z: first[2], range: 1 } }]),
          { key: 'dig', description: `挖 (${first[0]},${first[1]},${first[2]})`, primitive: 'dig', params: { x: first[0], y: first[1], z: first[2] } },
        ] : []),
        { key: 'collect', description: '捡起周围掉落物', primitive: 'collectDrops', params: { radius: 6 } },
        { key: 'count', description: '数背包里的 oak_log', primitive: 'countItem', params: { itemName: 'oak_log' } },
      ];
      return withDone(list);
    },
    reference: [{ repeat: 4, body: [
      { primitive: 'findBlock', params: { blockName: 'oak_log' }, id: 't' },
      { primitive: 'goTo', params: {}, at: 't' },
      { primitive: 'dig', params: {}, at: 't' },
      { primitive: 'collectDrops', params: {} },
    ] }],
  },
  {
    id: 12, level: 'L3', title: '向前挖一条 5 格长的沟',
    description: '向 bot 面朝的方向（-Z）挖一条 5 格长的沟：逐格挖掉正前方的 dirt，然后走进挖出的空位继续。',
    setup(sim) {
      sim.flat();
      for (const z of [11, 10, 9, 8, 7]) sim.setBlock(12, 1, z, 'dirt');
    },
    success: sim => [11, 10, 9, 8, 7].every(z => airAt(sim, 12, 1, z)),
    candidates: sim => {
      const f = frontCell(sim);
      const frontName = sim.blockAt(f.x, f.y, f.z);
      return withDone([
        ...(frontName !== 'air' ? [{ key: 'dig_front', description: `挖正前方 (${f.x},${f.y},${f.z}) 的 ${frontName}`, primitive: 'dig', params: { ...f } }] : []),
        { key: 'step_fwd', description: `走进前方的格子 (${f.x},${f.y},${f.z})`, primitive: 'goTo', params: { ...f, range: 0 } },
        { key: 'look', description: '看向正前方', primitive: 'lookAt', params: { ...f } },
      ]);
    },
    reference: [{ repeat: 5, body: [
      { primitive: 'dig', params: {}, at: '$self.front' },
      { primitive: 'goTo', params: {}, at: '$self.front' },
    ] }],
  },
  {
    id: 13, level: 'L3', title: '有煤就烧 3 个生铁，没有就先挖 2 个煤再烧',
    description: '如果背包里有 coal，就用它把 3 个 raw_iron 烧成 iron_ingot；如果没有 coal，先挖 2 个 coal_ore 捡成 coal 再烧。附近有 furnace。',
    setup(sim) {
      sim.flat();
      sim.setBlock(15, 1, 9, 'coal_ore'); sim.setBlock(17, 1, 14, 'coal_ore');
      sim.setBlock(8, 1, 9, 'furnace');
      sim.give('raw_iron', 3);
    },
    success: sim => sim.count('iron_ingot') >= 3,
    candidates: sim => {
      const ores = blocksOf(sim, 'coal_ore');
      const first = ores[0];
      const haveCoal = sim.count('coal') >= 1;
      return withDone([
        ...(haveCoal ? [] : [
          { key: 'find_ore', description: '找最近的 coal_ore', primitive: 'findBlock', params: { blockName: 'coal_ore' } },
          ...(first ? [
            ...(near(sim, first[0], first[1], first[2], 2.5) ? [] : [{ key: 'goto_ore', description: `走到煤矿 (${first[0]},${first[1]},${first[2]})`, primitive: 'goTo', params: { x: first[0], y: first[1], z: first[2], range: 1 } }]),
            { key: 'dig_ore', description: `挖 (${first[0]},${first[1]},${first[2]})`, primitive: 'dig', params: { x: first[0], y: first[1], z: first[2] } },
          ] : []),
          { key: 'collect', description: '捡起掉落物', primitive: 'collectDrops', params: { radius: 6 } },
        ]),
        { key: 'find_furnace', description: '找 furnace', primitive: 'findBlock', params: { blockName: 'furnace' } },
        ...(near(sim, 8, 1, 9, 2.5) ? [] : [{ key: 'goto_furnace', description: '走到熔炉 (8,1,9)', primitive: 'goTo', params: { x: 8, y: 1, z: 9, range: 1 } }]),
        { key: 'smelt', description: '用 coal 烧 3 个 raw_iron', primitive: 'smelt', params: { itemName: 'raw_iron', count: 3, fuel: 'coal' } },
      ]);
    },
    reference: [
      { if: { hasItem: 'coal', atLeast: 1 }, then: [
        { primitive: 'findBlock', params: { blockName: 'furnace' }, id: 'f' },
        { primitive: 'goTo', params: {}, at: 'f' },
        { primitive: 'smelt', params: { itemName: 'raw_iron', count: 3, fuel: 'coal' } },
      ], else: [
        { repeat: 2, body: [
          { primitive: 'findBlock', params: { blockName: 'coal_ore' }, id: 'o' },
          { primitive: 'goTo', params: {}, at: 'o' },
          { primitive: 'dig', params: {}, at: 'o' },
          { primitive: 'collectDrops', params: {} },
        ] },
        { primitive: 'findBlock', params: { blockName: 'furnace' }, id: 'f' },
        { primitive: 'goTo', params: {}, at: 'f' },
        { primitive: 'smelt', params: { itemName: 'raw_iron', count: 3, fuel: 'coal' } },
      ] },
    ],
  },
  {
    id: 14, level: 'L3', title: '找到箱子，有铁就取 2 个出来给他',
    description: '找到附近的 chest，取出 2 个 iron_ingot，交给身边的 owner（箱子里有铁）。',
    setup(sim) {
      sim.flat();
      sim.setBlock(8, 1, 9, 'chest');
      sim.containerAt(8, 1, 9).set('iron_ingot', 5);
      sim.addOwner(9, 1, 8);
    },
    success: sim => sim.given.filter(g => g.itemName === 'iron_ingot').reduce((a, g) => a + g.count, 0) >= 2,
    candidates: sim => {
      const o = ownerPos(sim) ?? { x: 9, y: 1, z: 8 };
      return withDone([
        { key: 'find_chest', description: '找 chest', primitive: 'findBlock', params: { blockName: 'chest' } },
        ...(near(sim, 8, 1, 9, 2.5) ? [] : [{ key: 'goto_chest', description: '走到箱子 (8,1,9)', primitive: 'goTo', params: { x: 8, y: 1, z: 9, range: 1 } }]),
        { key: 'withdraw', description: '从箱子取 2 个 iron_ingot', primitive: 'withdraw', params: { itemName: 'iron_ingot', count: 2 } },
        ...(near(sim, o.x, o.y, o.z, 2.5) ? [] : [{ key: 'goto_owner', description: `走到 owner (${o.x},${o.y},${o.z})`, primitive: 'goTo', params: { ...o, range: 1 } }]),
        { key: 'give', description: '给 owner 2 个 iron_ingot', primitive: 'give', params: { itemName: 'iron_ingot', count: 2 } },
      ]);
    },
    reference: [
      { primitive: 'findBlock', params: { blockName: 'chest' }, id: 'c' },
      { primitive: 'goTo', params: {}, at: 'c' },
      { primitive: 'withdraw', params: { itemName: 'iron_ingot', count: 2 } },
      { primitive: 'give', params: { itemName: 'iron_ingot', count: 2 } },
    ],
  },
  {
    id: 15, level: 'L3', title: '圆石≥10 就全部存进最近的箱子，否则再挖 3 个',
    description: '如果背包里 cobblestone ≥10 个，就全部存进最近的 chest；否则挖 3 个 stone 捡成 cobblestone。',
    setup(sim) {
      sim.flat();
      sim.give('cobblestone', 12);
      sim.setBlock(16, 1, 9, 'chest');
      sim.setBlock(10, 1, 15, 'stone'); sim.setBlock(8, 1, 13, 'stone'); sim.setBlock(17, 1, 16, 'stone');
    },
    success: sim => sim.containerTotal(16, 1, 9, 'cobblestone') >= 12 || sim.count('cobblestone') >= 15,
    candidates: sim => {
      const many = sim.count('cobblestone') >= 10;
      const stones = blocksOf(sim, 'stone');
      const first = stones[0];
      return withDone([
        { key: 'count', description: '数 cobblestone 数量', primitive: 'countItem', params: { itemName: 'cobblestone' } },
        ...(many ? [
          { key: 'find_chest', description: '找 chest', primitive: 'findBlock', params: { blockName: 'chest' } },
          ...(near(sim, 16, 1, 9, 2.5) ? [] : [{ key: 'goto_chest', description: '走到箱子 (16,1,9)', primitive: 'goTo', params: { x: 16, y: 1, z: 9, range: 1 } }]),
          { key: 'deposit_all', description: '存入全部 cobblestone', primitive: 'deposit', params: { itemName: 'cobblestone', count: 64 } },
        ] : [
          { key: 'find_stone', description: '找 stone', primitive: 'findBlock', params: { blockName: 'stone' } },
          ...(first ? [
            ...(near(sim, first[0], first[1], first[2], 2.5) ? [] : [{ key: 'goto_stone', description: `走到石头 (${first[0]},${first[1]},${first[2]})`, primitive: 'goTo', params: { x: first[0], y: first[1], z: first[2], range: 1 } }]),
            { key: 'dig_stone', description: `挖 (${first[0]},${first[1]},${first[2]})`, primitive: 'dig', params: { x: first[0], y: first[1], z: first[2] } },
          ] : []),
          { key: 'collect', description: '捡起掉落物', primitive: 'collectDrops', params: { radius: 6 } },
        ]),
      ]);
    },
    reference: [
      { if: { hasItem: 'cobblestone', atLeast: 10 }, then: [
        { primitive: 'findBlock', params: { blockName: 'chest' }, id: 'c' },
        { primitive: 'goTo', params: {}, at: 'c' },
        { primitive: 'deposit', params: { itemName: 'cobblestone', count: 64 } },
      ], else: [
        { repeat: 3, body: [
          { primitive: 'findBlock', params: { blockName: 'stone' }, id: 's' },
          { primitive: 'goTo', params: {}, at: 's' },
          { primitive: 'dig', params: {}, at: 's' },
          { primitive: 'collectDrops', params: {} },
        ] },
      ] },
    ],
  },
  {
    id: 16, level: 'L3', title: '饿了就吃面包（food<10 且有面包），否则待命',
    description: '如果饿了（food < 10）且背包里有 bread，就吃一个面包；否则原地待命。',
    setup(sim) {
      sim.flat(); sim.bot.food = 8; sim.give('bread', 2);
    },
    success: sim => sim.bot.food > 8 && sim.count('bread') < 2,
    candidates: () => withDone([
      { key: 'eat', description: '吃一个 bread', primitive: 'eat', params: { itemName: 'bread' } },
      { key: 'standby', description: '原地待命（说一句"待命"）', primitive: 'say', params: { text: '待命' } },
      { key: 'count', description: '数 bread 数量', primitive: 'countItem', params: { itemName: 'bread' } },
    ]),
    // 注：P0 任务写于 P1 之前。post-T29 语法已有 foodBelow/healthBelow/hasEffect
    // （经 free `body` 查询求值），本任务现在其实可表达；仍保留 inexpressible
    // 标记以便与 pre-T29 基线同口径比较。
    inexpressible: 'The P0 spec classified this inexpressible under the pre-P1 grammar; kept excluded for cross-run comparability (post-T29 foodBelow could express it)',
    reference: null,
  },
];
