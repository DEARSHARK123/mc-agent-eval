import { createRequire } from 'node:module';
import test from 'node:test';
import assert from 'node:assert/strict';
import { planGoal } from '../src/decision/planner.js';
import { SMELTING } from '../src/decision/smelting.js';
const require = createRequire(import.meta.url);
const data = require('minecraft-data')('1.20.4');
const mobs = { leather: 'cow', beef: 'cow', porkchop: 'pig', mutton: 'sheep', white_wool: 'sheep', feather: 'chicken', chicken: 'chicken', string: 'spider', bone: 'skeleton', arrow: 'skeleton', rotten_flesh: 'zombie' };

// Independent executor: derive costs and table requirements from raw game data.
// Fuel rates duplicated from the spec (coal/charcoal 8, planks/logs 1.5, stick 0.5)
// rather than imported so the simulator stays independent of smelting.js.
const fuelRate = name => name === 'coal' || name === 'charcoal' ? 8
  : name.endsWith('_planks') || name.endsWith('_log') ? 1.5
  : name === 'stick' ? 0.5 : 0;
function simulate(steps, inventory, mcData, tableNearby = false, furnaceNearby = false) {
  const stock = { ...inventory }, errors = [];
  let table = tableNearby, furnace = furnaceNearby, hand = null;
  const add = (name, count) => { stock[name] = (stock[name] ?? 0) + count; };
  for (const step of steps) {
    if (step.type === 'collect') {
      for (const name of step.blocks) {
        const block = mcData.blocksByName[name];
        const matureWheat = name === 'wheat' && step.item === 'wheat';
        if (!block?.drops.includes(mcData.itemsByName[step.item].id) && !matureWheat) errors.push('wrong drop');
        if (block?.harvestTools && (!step.tool || !block.harvestTools[mcData.itemsByName[step.tool]?.id] || hand !== step.tool || !(stock[step.tool] > 0))) errors.push('tool not equipped');
      }
      if (!step.blocks.length || step.count < 1) errors.push('invalid collect');
      add(step.item, step.count);
    } else if (step.type === 'craft') {
      const recipe = (mcData.recipes[mcData.itemsByName[step.item].id] ?? []).find(recipe => {
        if (recipe.result.count !== step.yields) return false;
        const costs = {};
        for (const id of recipe.inShape?.flat() ?? recipe.ingredients) if (id != null && id !== -1) {
          const name = mcData.items[id].name;
          costs[name] = (costs[name] ?? 0) + step.times;
        }
        return Object.entries(costs).every(([name, amount]) => (stock[name] ?? 0) >= amount);
      });
      if (!recipe) { errors.push('missing ingredients'); continue; }
      const required = recipe.inShape ? recipe.inShape.length > 2 || recipe.inShape.some(row => row.length > 2) : recipe.ingredients.length > 4;
      if (step.needsTable !== required || required && !table) errors.push('missing table');
      for (const id of recipe.inShape?.flat() ?? recipe.ingredients) if (id != null && id !== -1) add(mcData.items[id].name, -step.times);
      add(step.item, step.times * recipe.result.count);
    } else if (step.type === 'kill') {
      if (mobs[step.item] !== step.entityName) errors.push('wrong mob');
      add(step.item, step.count);
    } else if (step.type === 'place_table') {
      if (!(stock.crafting_table > 0)) errors.push('missing table item');
      add('crafting_table', -1); table = true;
    } else if (step.type === 'place_furnace') {
      if (!(stock.furnace > 0)) errors.push('missing furnace item');
      add('furnace', -1); furnace = true;
    } else if (step.type === 'smelt') {
      if (!furnace) errors.push('missing furnace');
      if ((stock[step.input] ?? 0) < step.count) errors.push('missing smelt input');
      if (!step.item || !step.input || step.count < 1) errors.push('invalid smelt');
      const rate = fuelRate(step.fuel);
      if (rate <= 0 || step.fuelCount !== Math.ceil(step.count / rate)) errors.push('wrong fuel count');
      if ((stock[step.fuel] ?? 0) < step.fuelCount) errors.push('missing fuel');
      add(step.input, -step.count); add(step.fuel, -step.fuelCount); add(step.item, step.count);
    } else if (step.type === 'equip') {
      if (!(stock[step.itemName] > 0) || step.slot !== 'hand') errors.push('missing equipped item');
      hand = step.itemName;
    } else errors.push('unknown step');
    if (Object.values(stock).some(n => n < 0)) errors.push('negative inventory');
  }
  return { stock, errors };
}
function success(item, count = 1, inventory = {}, options = {}) {
  const result = planGoal({ item, count, inventory, options, mcData: data });
  assert.equal(result.ok, true, `${item}: ${JSON.stringify(result)}`);
  const simulation = simulate(result.steps, inventory, data, options.tableNearby, options.furnaceNearby);
  assert.deepEqual(simulation.errors, []);
  assert.ok(simulation.stock[item] >= count, JSON.stringify(simulation.stock));
  const summary = { collect: {}, craft: {}, kill: {}, smelt: {} };
  for (const step of result.steps) if (summary[step.type]) summary[step.type][step.item] = (summary[step.type][step.item] ?? 0) + (step.times ?? step.count);
  assert.deepEqual(result.summary, summary);
  return result;
}
function failure(item, reason, extra = {}) {
  const result = planGoal({ item, count: 1, inventory: {}, mcData: data, ...extra });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.reason, reason, JSON.stringify(result));
  assert.equal(typeof result.detail, 'object');
}

test('A1 independent simulator detects missing materials, tools and tables', () => {
  assert.ok(simulate([{ type: 'craft', item: 'stick', times: 1, yields: 4, needsTable: false }], {}, data).errors.includes('missing ingredients'));
  assert.ok(simulate([{ type: 'collect', blocks: ['stone'], item: 'cobblestone', count: 1, tool: 'wooden_pickaxe' }], { wooden_pickaxe: 1 }, data).errors.includes('tool not equipped'));
  assert.ok(simulate([{ type: 'craft', item: 'wooden_pickaxe', times: 1, yields: 1, needsTable: true }], { oak_planks: 3, stick: 2 }, data).errors.includes('missing table'));
});
for (const item of ['crafting_table', 'stick', 'oak_planks', 'wooden_pickaxe', 'stone_pickaxe', 'furnace', 'chest', 'torch', 'white_bed', 'oak_door', 'cobblestone']) {
  test(`A2 simulated empty inventory ${item}`, () => success(item, 1, {}, { preferredLog: 'oak_log' }));
}
test('A2 real block conversion recipes and restricted natural sources', () => {
  for (const item of ['iron_ingot', 'iron_pickaxe', 'diamond_pickaxe', 'diamond']) failure(item, 'needs_smelting');
  success('bread');
  const options = { availableBlocks: ['oak_log', 'stone', 'iron_ore', 'diamond_ore'] };
  failure('bread', 'no_source', { options });
  assert.ok(success('torch', 1, {}, { availableBlocks: ['oak_log', 'stone', 'coal_ore'] }).steps.some(s => s.type === 'collect' && s.item === 'coal' && s.blocks[0] === 'coal_ore'));
  assert.ok(success('furnace').steps.some(s => s.type === 'craft' && s.item === 'wooden_pickaxe'));
  // Real white_wool has recipes and a block drop. Restrict blocks to natural
  // mining sources to exercise the sheep path required by the bed scenario.
  assert.ok(success('white_bed', 1, { white_wool: 1 }, { availableBlocks: ['oak_log'] }).steps.some(s => s.type === 'kill' && s.entityName === 'sheep'));
});
test('A3 exact log quantities and existing planks', () => {
  // Table costs 4 planks, pick costs 3, sticks cost 2: 9 planks => 3 logs.
  assert.equal(success('wooden_pickaxe').summary.collect.oak_log, 3);
  assert.equal(success('crafting_table', 2).summary.collect.oak_log, 2);
  assert.deepEqual(success('crafting_table', 1, { oak_planks: 12 }).summary.collect, {});
});
test('A4 existing goals, missing quantities and surplus reuse', () => {
  assert.deepEqual(success('stick', 4, { stick: 4 }).steps, []);
  assert.equal(success('oak_log', 5, { oak_log: 3 }).summary.collect.oak_log, 2);
  const result = success('wooden_pickaxe', 1, { crafting_table: 1 });
  assert.equal(result.summary.collect.oak_log, 2);
  assert.equal(result.summary.craft.oak_planks, 2);
});
test('A5 machine readable failures and input validation', () => {
  failure('iron_ingot', 'needs_smelting');
  failure('cooked_beef', 'needs_smelting');
  for (const item of ['blaze_rod', 'ender_pearl']) failure(item, 'needs_nether_or_end');
  failure('not_an_item', 'unknown_item');
  for (const count of [0, 65, 1.5, '1']) failure('stick', 'invalid_input', { count });
  for (const inventory of [{ oak_log: -1 }, { oak_log: 1.5 }, { oak_log: '2' }]) failure('stick', 'invalid_input', { inventory });
  assert.deepEqual(data.blocksByName.bedrock.drops, []);
  failure('bedrock', 'no_source');
});
test('A6 table placement and 2x2 recipes', () => {
  const nearby = success('wooden_pickaxe', 1, {}, { tableNearby: true });
  assert.ok(!nearby.steps.some(s => s.type === 'place_table' || s.item === 'crafting_table'));
  for (const inventory of [{}, { crafting_table: 1 }]) {
    const result = success('wooden_pickaxe', 1, inventory);
    assert.equal(result.steps.filter(s => s.type === 'place_table').length, 1);
    assert.ok(result.steps.findIndex(s => s.type === 'place_table') < result.steps.findIndex(s => s.needsTable));
    if (inventory.crafting_table) assert.ok(!result.steps.some(s => s.type === 'craft' && s.item === 'crafting_table'));
  }
  for (const item of ['stick', 'oak_planks', 'crafting_table']) {
    const result = success(item);
    assert.ok(result.steps.every(s => s.type !== 'place_table' && !s.needsTable));
  }
});
test('A7 lowest usable tools, existing stone pickaxe and bare hand dirt', () => {
  const result = success('cobblestone');
  const index = result.steps.findIndex(s => s.type === 'collect' && s.item === 'cobblestone');
  assert.equal(result.steps[index].tool, 'wooden_pickaxe');
  assert.ok(result.steps.slice(0, index).some(s => s.type === 'equip' && s.itemName === 'wooden_pickaxe'));
  const iron = success('raw_iron', 1, { stone_pickaxe: 1 }, { availableBlocks: ['iron_ore'] });
  assert.ok(!iron.steps.some(s => s.type === 'craft'));
  assert.equal(iron.steps.find(s => s.type === 'collect').tool, 'stone_pickaxe');
  assert.equal(success('dirt').steps[0].tool, null);
});
test('A8 available block filtering and preferred log priority', () => {
  const result = success('cobblestone', 1, { wooden_pickaxe: 1 }, { availableBlocks: ['stone'] });
  assert.deepEqual(result.steps.find(s => s.type === 'collect').blocks, ['stone']);
  failure('oak_log', 'no_source', { options: { availableBlocks: [] } });
  assert.equal(success('oak_log', 1, {}, { preferredLog: 'oak_log' }).steps[0].blocks[0], 'oak_log');
  const dirt = success('dirt').steps[0].blocks;
  assert.equal(dirt[0], 'dirt');
  const rest = dirt.slice(1).map(name => data.blocksByName[name].hardness);
  assert.deepEqual(rest, [...rest].sort((a, b) => a - b));
});
test('A9 step and depth budgets and injected recipe cycle', () => {
  failure('wooden_pickaxe', 'too_complex', { options: { limits: { maxSteps: 2 } } });
  failure('wooden_pickaxe', 'too_complex', { options: { limits: { maxDepth: 0 } } });
  const a = data.itemsByName.bedrock.id;
  const b = data.itemsByName.barrier.id;
  const c = data.itemsByName.structure_block.id;
  const recipe = (input, output) => [{ ingredients: [input], result: { id: output, count: 1 } }];
  failure('bedrock', 'cycle', { options: { recipeOverride: { [a]: recipe(b, a), [b]: recipe(c, b), [c]: recipe(a, c) } } });
});
test('A10 deterministic output and unchanged inventory options and mcData', () => {
  const input = { item: 'stone_pickaxe', count: 2, inventory: { oak_log: 1 }, options: { preferredLog: 'oak_log', availableBlocks: ['oak_log', 'stone'] }, mcData: data };
  // minecraft-data contains helper functions; compare all serializable data.
  const before = JSON.stringify(input);
  const first = success(input.item, input.count, input.inventory, input.options);
  assert.deepEqual(first, success(input.item, input.count, input.inventory, input.options));
  assert.equal(JSON.stringify(input), before);
});
test('A11 fixed mob sources and real wool arrow recipe behavior', () => {
  for (const [item, entityName] of Object.entries(mobs)) {
    if (item === 'arrow' || item === 'white_wool' || item === 'string') continue;
    assert.deepEqual(success(item, 3).steps, [{ type: 'kill', entityName, item, count: 3 }]);
  }
  assert.ok(data.recipes[data.itemsByName.white_wool.id].length > 0);
  assert.deepEqual(success('white_wool').steps, [{ type: 'kill', entityName: 'sheep', item: 'white_wool', count: 1 }]);
  assert.deepEqual(success('string', 3).steps, [{ type: 'collect', blocks: ['tripwire'], item: 'string', count: 3, tool: null }]);
  assert.deepEqual(success('string', 3, {}, { availableBlocks: [] }).steps, [{ type: 'kill', entityName: 'spider', item: 'string', count: 3 }]);
  assert.deepEqual(success('white_wool', 1, {}, { availableBlocks: [] }).steps, [{ type: 'kill', entityName: 'sheep', item: 'white_wool', count: 1 }]);
  // minecraft-data does not list probabilistic flint as a gravel drop.
  assert.ok(!data.blocksByName.gravel.drops.includes(data.itemsByName.flint.id));
  const arrow = success('arrow');
  assert.deepEqual(arrow.steps, [{ type: 'kill', entityName: 'skeleton', item: 'arrow', count: 1 }]);
  for (const item of Object.keys(mobs)) assert.ok(success(item).steps.every(s => !['creeper', 'enderman', 'wither_skeleton'].includes(s.entityName)));
});
test('A12 planner is importable alongside the existing full npm test suite', () => {
  assert.equal(typeof planGoal, 'function');
});

test('iron and diamond goals stop at smelting instead of iron blocks', () => {
  for (const item of ['iron_ingot', 'iron_pickaxe', 'diamond', 'diamond_pickaxe', 'iron_sword']) {
    const result = planGoal({ item, count: 1, inventory: {}, mcData: data, options: { preferredLog: 'oak_log' } });
    assert.equal(result.reason, 'needs_smelting', `${item}: ${JSON.stringify(result)}`);
  }
});

test('coal and torch use coal ore and simulate with an equipped wooden pickaxe', () => {
  for (const item of ['coal', 'torch']) {
    const result = success(item, 1, {}, { preferredLog: 'oak_log' });
    assert.ok(!result.steps.some(step => step.item === 'coal_block' || step.blocks?.includes('coal_block')));
    const collectIndex = result.steps.findIndex(step => step.type === 'collect' && step.item === 'coal');
    assert.ok(collectIndex >= 0, JSON.stringify(result));
    assert.ok(result.steps[collectIndex].blocks.includes('coal_ore') || result.steps[collectIndex].blocks.includes('deepslate_coal_ore'));
    assert.equal(result.steps[collectIndex].tool, 'wooden_pickaxe');
    assert.ok(result.steps.slice(0, collectIndex).some(step => step.type === 'equip' && step.itemName === 'wooden_pickaxe'));
    if (item === 'torch') assert.ok(result.steps.some(step => step.type === 'craft' && step.item === 'torch'));
  }
});

test('bread gathers three wheat without hay blocks', () => {
  const result = success('bread');
  assert.ok(!result.steps.some(step => step.item === 'hay_block' || step.blocks?.includes('hay_block')));
  assert.equal(result.steps.find(step => step.type === 'collect' && step.item === 'wheat')?.count, 3);
  assert.ok(result.steps.some(step => step.type === 'craft' && step.item === 'bread'));
});

test('white bed uses three sheep wool and merges its two oak log collections', () => {
  const result = success('white_bed', 1, {}, { preferredLog: 'oak_log' });
  for (const item of ['black_wool', 'black_bed', 'bone', 'bone_meal', 'white_dye']) {
    assert.ok(!result.steps.some(step => step.item === item || step.blocks?.includes(item)));
  }
  assert.deepEqual(result.steps.filter(step => step.type === 'kill' && step.entityName === 'sheep'), [
    { type: 'kill', entityName: 'sheep', item: 'white_wool', count: 3 },
  ]);
  assert.equal(result.steps.filter(step => step.type === 'collect' && step.item === 'oak_log').length, 1);
  assert.equal(result.steps.find(step => step.type === 'collect' && step.item === 'oak_log').count, 2);
  assert.equal(result.summary.collect.oak_log, 2);
});

test('tries a later craft after the first recipe fails', () => {
  const id = data.itemsByName.bedrock.id;
  const recipes = [
    { ingredients: [data.itemsByName.iron_ingot.id], result: { id, count: 1 } },
    { ingredients: [data.itemsByName.dirt.id], result: { id, count: 1 } },
  ];
  const result = planGoal({ item: 'bedrock', count: 1, inventory: {}, mcData: data, options: { recipeOverride: { [id]: recipes } } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.steps.some(step => step.type === 'collect' && step.item === 'dirt'));
});

test('chooses the shortest successful recipe and preserves mcData order on ties', () => {
  const id = data.itemsByName.bedrock.id;
  const recipe = material => ({ ingredients: [data.itemsByName[material].id], result: { id, count: 1 } });
  const shortest = planGoal({ item: 'bedrock', count: 1, inventory: {}, mcData: data, options: { recipeOverride: { [id]: [recipe('dirt'), recipe('oak_planks')] } } });
  assert.equal(shortest.steps.find(step => step.type === 'collect')?.item, 'dirt');
  const tied = planGoal({ item: 'bedrock', count: 1, inventory: {}, mcData: data, options: { recipeOverride: { [id]: [recipe('dirt'), recipe('sand')] } } });
  assert.equal(tied.steps.find(step => step.type === 'collect')?.item, 'dirt');
});

test('considers at most the first eight non-reversible candidates', () => {
  const id = data.itemsByName.bedrock.id;
  const failures = Array.from({ length: 8 }, () => ({ ingredients: [data.itemsByName.iron_ingot.id], result: { id, count: 1 } }));
  failures.push({ ingredients: [data.itemsByName.dirt.id], result: { id, count: 1 } });
  const result = planGoal({ item: 'bedrock', count: 1, inventory: {}, mcData: data, options: { recipeOverride: { [id]: failures } } });
  assert.equal(result.reason, 'needs_smelting');
});

test('reciprocal recipe filtering is generic for injected items', () => {
  const target = data.itemsByName.bedrock.id;
  const reverse = data.itemsByName.iron_hoe.id;
  const result = planGoal({
    item: 'bedrock', count: 1, inventory: {}, mcData: data,
    options: { recipeOverride: {
      [target]: [
        { ingredients: [reverse], result: { id: target, count: 1 } },
        { ingredients: [data.itemsByName.dirt.id], result: { id: target, count: 1 } },
      ],
      [reverse]: [{ ingredients: [target], result: { id: reverse, count: 1 } }],
    } },
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.steps.some(step => step.type === 'collect' && step.item === 'dirt'));
  assert.ok(!result.steps.some(step => step.item === 'iron_hoe'));
});

test('placed blocks are not sources unless explicitly available', () => {
  for (const item of ['white_wool', 'oak_planks', 'glass', 'bricks']) {
    const result = planGoal({ item, count: 1, inventory: {}, mcData: data });
    assert.ok(!result.steps?.some(step => step.type === 'collect' && step.blocks.includes(item)), `${item}: ${JSON.stringify(result)}`);
  }
  assert.ok(success('oak_log').steps.some(step => step.type === 'collect' && step.blocks.includes('oak_log')));
  const wool = success('white_wool', 1, {}, { availableBlocks: ['white_wool'] });
  assert.ok(wool.steps.some(step => step.type === 'collect' && step.blocks.includes('white_wool')));
});

test('merges tool-free oak logs without adding plan steps', () => {
  const stonePickaxe = success('stone_pickaxe', 1, {}, { preferredLog: 'oak_log' });
  const logs = stonePickaxe.steps.filter(step => step.type === 'collect' && step.item === 'oak_log');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].count, 3);
  assert.equal(logs[0].count, stonePickaxe.summary.collect.oak_log);
  for (const [item, maxSteps] of Object.entries({ furnace: 12, stone_pickaxe: 14, wooden_pickaxe: 12, chest: 12, oak_door: 10 })) {
    assert.ok(success(item, 1, {}, { preferredLog: 'oak_log' }).steps.length <= maxSteps, item);
  }
});

test('previous planner acceptance remains covered by the full planner regression cases', () => {
  assert.equal(success('furnace').steps.at(-1).item, 'furnace');
  assert.equal(success('oak_door').steps.at(-1).item, 'oak_door');
  assert.equal(success('white_bed').steps.at(-1).item, 'white_bed');
  failure('cooked_beef', 'needs_smelting');
  failure('blaze_rod', 'needs_nether_or_end');
});

// --- T18b: smelting planner paths ------------------------------------------------

test('smelting is off unless opted in, and explicit false matches the default', () => {
  failure('iron_ingot', 'needs_smelting', { options: { smelting: false } });
  failure('glass', 'needs_smelting', { options: { smelting: false } });
});

test('smelting:true plans dig-ore, craft furnace, place and smelt in order', () => {
  const result = success('iron_pickaxe', 1, {}, { smelting: true, preferredLog: 'oak_log' });
  const indexOf = predicate => result.steps.findIndex(predicate);
  const pickIndex = indexOf(step => step.type === 'craft' && step.item === 'stone_pickaxe');
  const oreIndex = indexOf(step => step.type === 'collect' && step.item === 'raw_iron'
    && step.blocks.some(name => ['iron_ore', 'deepslate_iron_ore'].includes(name)));
  const furnaceIndex = indexOf(step => step.type === 'craft' && step.item === 'furnace');
  const placeIndex = indexOf(step => step.type === 'place_furnace');
  const smeltIndex = indexOf(step => step.type === 'smelt');
  assert.ok(pickIndex >= 0 && oreIndex > pickIndex && furnaceIndex > oreIndex
    && placeIndex > furnaceIndex && smeltIndex > placeIndex, JSON.stringify(result.steps));
  assert.deepEqual(result.steps[smeltIndex],
    { type: 'smelt', item: 'iron_ingot', input: 'raw_iron', count: 3, fuel: 'oak_planks', fuelCount: 2 });
  assert.deepEqual(result.summary.smelt, { iron_ingot: 3 });
});

test('smelting:true reaches smelt-only items and keeps summary.smelt', () => {
  for (const [item, input] of [['iron_ingot', 'raw_iron'], ['glass', 'sand'],
      ['stone', 'cobblestone'], ['cooked_beef', 'beef']]) {
    const result = success(item, 1, {}, { smelting: true });
    const smelt = result.steps.find(step => step.type === 'smelt');
    assert.equal(smelt?.input, input, `${item}: ${JSON.stringify(result.steps)}`);
    assert.equal(result.summary.smelt[item], 1);
  }
});

test('furnaceNearby skips the furnace craft and placement entirely', () => {
  const result = success('iron_ingot', 1, {}, { smelting: true, furnaceNearby: true });
  assert.ok(!result.steps.some(step => step.type === 'place_furnace'));
  assert.ok(!result.steps.some(step => step.type === 'craft' && step.item === 'furnace'));
  assert.ok(result.steps.some(step => step.type === 'smelt'));
});

test('a furnace item in stock is placed instead of crafted', () => {
  const result = success('iron_ingot', 1, { furnace: 1 }, { smelting: true });
  assert.equal(result.steps.filter(step => step.type === 'place_furnace').length, 1);
  assert.ok(!result.steps.some(step => step.type === 'craft' && step.item === 'furnace'));
});

test('stock coal fuels the smelt without making planks', () => {
  const result = success('iron_ingot', 3, { raw_iron: 3, coal: 1 },
    { smelting: true, furnaceNearby: true });
  assert.deepEqual(result.steps, [
    { type: 'smelt', item: 'iron_ingot', input: 'raw_iron', count: 3, fuel: 'coal', fuelCount: 1 },
  ]);
  assert.deepEqual(result.summary.smelt, { iron_ingot: 3 });
});

test('charcoal is a stock fuel and preferred-log planks are the fallback', () => {
  const charcoal = success('iron_ingot', 3, { raw_iron: 3, charcoal: 1 },
    { smelting: true, furnaceNearby: true });
  assert.equal(charcoal.steps[0].fuel, 'charcoal');
  const birch = success('iron_ingot', 3, { raw_iron: 3, birch_log: 2 },
    { smelting: true, furnaceNearby: true, preferredLog: 'birch_log' });
  const smelt = birch.steps.find(step => step.type === 'smelt');
  assert.equal(smelt.fuel, 'birch_planks');
  assert.equal(smelt.fuelCount, 2);
  // The oak_planks fallback for a plank-less log family is unreachable with real
  // 1.20.4 data: every *_log item has a matching *_planks.
});

test('smelt steps never merge even for back-to-back furnace work', () => {
  const result = success('blast_furnace', 1, {}, { smelting: true });
  const smelts = result.steps.filter(step => step.type === 'smelt');
  assert.ok(smelts.length >= 2, JSON.stringify(result.steps));
  assert.ok(smelts.every(step => step.times === undefined && Number.isInteger(step.count)));
  assert.ok(smelts.some(step => step.item === 'iron_ingot'));
  assert.ok(smelts.some(step => step.item === 'smooth_stone' || step.item === 'stone'));
});

test('nether and end items stay out of reach under smelting', () => {
  for (const item of ['blaze_rod', 'netherite_ingot', 'netherite_scrap', 'ender_pearl']) {
    failure(item, 'needs_nether_or_end', { options: { smelting: true } });
  }
});

test('smelting plans still obey the step budget', () => {
  failure('iron_pickaxe', 'too_complex', { options: { smelting: true, limits: { maxSteps: 4 } } });
});

test('the smeltable output set is exactly the spec list', () => {
  assert.deepEqual([...SMELTING].sort(), [
    'baked_potato', 'brick', 'charcoal', 'cooked_beef', 'cooked_chicken', 'cooked_cod',
    'cooked_mutton', 'cooked_porkchop', 'cooked_salmon', 'copper_ingot', 'glass',
    'gold_ingot', 'iron_ingot', 'smooth_stone', 'stone',
  ]);
});
