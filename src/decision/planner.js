import { SMELTING, fuelNeeded, smeltInput } from './smelting.js';

const MOBS = Object.freeze({ leather: 'cow', beef: 'cow', porkchop: 'pig', mutton: 'sheep', white_wool: 'sheep', feather: 'chicken', chicken: 'chicken', string: 'spider', bone: 'skeleton', arrow: 'skeleton', rotten_flesh: 'zombie' });
const OTHER_DIMENSION = ['nether', 'blaze', 'ender_pearl', 'ghast', 'soul', 'basalt', 'quartz', 'glowstone', 'end_stone', 'chorus', 'purpur', 'shulker', 'elytra', 'dragon'];
const NATURAL_SELF_DROPS = new Set(['dirt', 'sand', 'red_sand', 'gravel', 'clay', 'obsidian', 'cactus', 'sugar_cane', 'pumpkin']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Recipe IDs are item IDs (including inShape), not block IDs.
function ingredients(recipe, data) {
  const result = new Map();
  for (const id of recipe.inShape ? recipe.inShape.flat() : recipe.ingredients ?? []) {
    if (id === null || id === -1) continue;
    const name = data.items[id]?.name;
    if (!name) throw { reason: 'no_source', detail: { ingredientId: id } };
    result.set(name, (result.get(name) ?? 0) + 1);
  }
  return result;
}
function needsTable(recipe) {
  return recipe.inShape ? recipe.inShape.length > 2 || recipe.inShape.some(row => row.length > 2) : recipe.ingredients.length > 4;
}

function recipeList(name, id, options, data) {
  return options.recipeOverride?.[id] ?? options.recipeOverride?.[name] ?? data.recipes[id] ?? [];
}

function isReversibleRecipe(name, materials, options, data) {
  const id = data.itemsByName[name].id;
  for (const material of materials.keys()) {
    const materialId = data.itemsByName[material]?.id;
    if (materialId === undefined) continue;
    if (recipeList(material, materialId, options, data).some(recipe => {
      const outputId = recipe.result?.id ?? materialId;
      if (outputId !== materialId) return false;
      return [...(recipe.inShape?.flat() ?? recipe.ingredients ?? [])].includes(id);
    })) return true;
  }
  return false;
}

export function planGoal(input) {
  if (!record(input)) return { ok: false, reason: 'invalid_input', detail: {} };
  const { item, count, inventory = {}, mcData, options = {} } = input;
  const invalid = field => ({ ok: false, reason: 'invalid_input', detail: { field } });
  if (typeof item !== 'string' || !Number.isInteger(count) || count < 1 || count > 64) return invalid('goal');
  if (!record(inventory) || Object.values(inventory).some(n => !Number.isSafeInteger(n) || n < 0)) return invalid('inventory');
  if (!record(mcData) || !record(mcData.itemsByName) || !mcData.items || !mcData.blocks || !mcData.recipes) return invalid('mcData');
  if (!record(options) || (options.tableNearby !== undefined && typeof options.tableNearby !== 'boolean') ||
      (options.furnaceNearby !== undefined && typeof options.furnaceNearby !== 'boolean') ||
      (options.smelting !== undefined && typeof options.smelting !== 'boolean') ||
      (options.preferredLog !== undefined && (typeof options.preferredLog !== 'string' || !options.preferredLog.endsWith('_log') || !mcData.itemsByName[options.preferredLog])) ||
      (options.availableBlocks != null && (!Array.isArray(options.availableBlocks) || options.availableBlocks.some(n => typeof n !== 'string'))) ||
      (options.recipeOverride !== undefined && !record(options.recipeOverride)) ||
      (options.limits !== undefined && !record(options.limits))) return invalid('options');
  const maxSteps = options.limits?.maxSteps ?? 48;
  const maxDepth = options.limits?.maxDepth ?? 8;
  if (![maxSteps, maxDepth].every(n => Number.isInteger(n) && n >= 0) || maxSteps > 48 || maxDepth > 8) return invalid('limits');
  if (!Object.hasOwn(mcData.itemsByName, item)) return { ok: false, reason: 'unknown_item', detail: { item } };
  const preferredLog = options.preferredLog ?? 'oak_log';
  let stock = Object.assign(Object.create(null), inventory);
  let steps = [];
  let table = options.tableNearby === true;
  let furnace = options.furnaceNearby === true;
  let hand = null;
  const fail = (reason, name) => { throw { reason, detail: { item: name } }; };
  const add = step => {
    const previous = step.type === 'collect' && step.tool === null
      ? steps.find(existing => existing.type === 'collect' && existing.tool === null && existing.item === step.item && JSON.stringify(existing.blocks) === JSON.stringify(step.blocks))
      : steps.at(-1);
    if (previous?.type === step.type && previous.item === step.item &&
        (step.type === 'craft' && previous.yields === step.yields && previous.needsTable === step.needsTable ||
         step.type === 'collect' && previous.tool === step.tool && JSON.stringify(previous.blocks) === JSON.stringify(step.blocks))) {
      previous[step.type === 'craft' ? 'times' : 'count'] += step[step.type === 'craft' ? 'times' : 'count'];
    } else steps.push(step);
    if (steps.length > maxSteps) fail('too_complex', step.item);
  };
  const ensure = (name, target, chain = []) => {
    if ((stock[name] ?? 0) >= target) return;
    if (chain.includes(name)) fail('cycle', name);
    if (chain.length > maxDepth) fail('too_complex', name);
    if (OTHER_DIMENSION.some(part => name.includes(part))) fail('needs_nether_or_end', name);
    const next = [...chain, name];
    const id = mcData.itemsByName[name]?.id;
    if (id === undefined) fail('no_source', name);
    const recipes = recipeList(name, id, options, mcData);
    let recipeFailure;
    let best;
    if (recipes.length) {
      const candidates = recipes.map(recipe => ({ recipe, materials: ingredients(recipe, mcData) }))
        .filter(candidate => !isReversibleRecipe(name, candidate.materials, options, mcData))
        .slice(0, 8);
      for (const { recipe, materials } of candidates) {
        const saved = { stock: { ...stock }, steps: structuredClone(steps), table, furnace, hand };
        try {
          const useTable = needsTable(recipe);
          if (useTable && !table) {
            ensure('crafting_table', 1, next);
            stock.crafting_table--;
            add({ type: 'place_table' });
            table = true;
          }
          const times = Math.ceil((target - (stock[name] ?? 0)) / recipe.result.count);
          // Reserve each material immediately: later dependencies cannot consume it.
          for (const [material, amount] of materials) {
            ensure(material, amount * times, next);
            stock[material] -= amount * times;
          }
          add({ type: 'craft', item: name, times, yields: recipe.result.count, needsTable: useTable });
          stock[name] = (stock[name] ?? 0) + times * recipe.result.count;
          const candidate = { stock: { ...stock }, steps: structuredClone(steps), table, furnace, hand };
          if (!best || candidate.steps.length < best.steps.length) best = candidate;
        } catch (error) {
          if (!recipeFailure) recipeFailure = error;
        }
        stock = Object.assign(Object.create(null), saved.stock);
        steps = saved.steps;
        table = saved.table;
        furnace = saved.furnace;
        hand = saved.hand;
      }
    }
    if (!best && (recipeFailure?.reason === 'too_complex' || recipeFailure?.reason === 'cycle')) throw recipeFailure;
    if (SMELTING.has(name) && !best && !options.smelting && !options.availableBlocks?.includes(name)) fail('needs_smelting', name);
    const blocks = Object.values(mcData.blocks).filter(block => block.hardness >= 0 &&
      (block.drops?.includes(id) || block.name === 'wheat' && name === 'wheat') &&
      !OTHER_DIMENSION.some(part => block.name.includes(part)) &&
      (block.name !== name || NATURAL_SELF_DROPS.has(block.name) || block.name.endsWith('_log') || block.name === 'wheat' && name === 'wheat' || options.availableBlocks?.includes(block.name)) &&
      (options.availableBlocks == null || options.availableBlocks.includes(block.name)));
    blocks.sort((a, b) => {
      const priority = block => block.name === preferredLog && name.endsWith('_log') ? -2 : block.name === name ? -1 : 0;
      return priority(a) - priority(b) || a.hardness - b.hardness;
    });
    const initial = { stock: { ...stock }, steps: structuredClone(steps), table, furnace, hand };
    let blockPlan;
    let sourceFailure;
    if (blocks.length) {
      try {
        const tools = Object.keys(blocks[0].harvestTools ?? {}).filter(key => blocks[0].harvestTools[key]).map(key => mcData.items[key].name);
        const tier = tool => ['wooden_', 'golden_', 'stone_', 'iron_', 'diamond_', 'netherite_'].findIndex(prefix => tool.startsWith(prefix));
        tools.sort((a, b) => tier(a) - tier(b));
        const tool = tools.find(toolName => stock[toolName] > 0) ?? tools[0] ?? null;
        if (tool) {
          ensure(tool, 1, next);
          if (hand !== tool) { add({ type: 'equip', itemName: tool, slot: 'hand' }); hand = tool; }
        }
        const candidates = blocks.filter(block => !block.harvestTools || tool && block.harvestTools[mcData.itemsByName[tool].id]);
        const missing = target - (stock[name] ?? 0);
        add({ type: 'collect', blocks: candidates.map(block => block.name), item: name, count: missing, tool });
        stock[name] = (stock[name] ?? 0) + missing;
        blockPlan = { stock: { ...stock }, steps: structuredClone(steps), table, furnace, hand };
      } catch (error) {
        sourceFailure = error;
      }
      stock = Object.assign(Object.create(null), initial.stock);
      steps = initial.steps;
      table = initial.table;
      furnace = initial.furnace;
      hand = initial.hand;
    }
    let mobPlan;
    if (MOBS[name]) {
      try {
        const missing = target - (stock[name] ?? 0);
        add({ type: 'kill', entityName: MOBS[name], item: name, count: missing });
        stock[name] = (stock[name] ?? 0) + missing;
        mobPlan = { stock: { ...stock }, steps: structuredClone(steps), table, furnace, hand };
      } catch (error) {
        if (!sourceFailure) sourceFailure = error;
      }
      stock = Object.assign(Object.create(null), initial.stock);
      steps = initial.steps;
      table = initial.table;
      furnace = initial.furnace;
      hand = initial.hand;
    }
    let smeltPlan;
    let smeltFailure;
    if (options.smelting === true) {
      const input = smeltInput(name, preferredLog);
      if (input && mcData.itemsByName[input]) {
        try {
          const missing = target - (stock[name] ?? 0);
          // Input first so the tool chain (e.g. a stone pickaxe for ore) appears before
          // the furnace work, matching how a player would read the plan.
          ensure(input, missing, next);
          stock[input] -= missing;
          if (!furnace) {
            ensure('furnace', 1, next);
            stock.furnace -= 1;
            add({ type: 'place_furnace' });
            furnace = true;
          }
          let fuel;
          if ((stock.coal ?? 0) >= fuelNeeded('coal', missing)) fuel = 'coal';
          else if ((stock.charcoal ?? 0) >= fuelNeeded('charcoal', missing)) fuel = 'charcoal';
          else {
            const planks = `${preferredLog.slice(0, -'_log'.length)}_planks`;
            fuel = mcData.itemsByName[planks] ? planks : 'oak_planks';
          }
          const fuelCount = fuelNeeded(fuel, missing);
          ensure(fuel, fuelCount, next);
          stock[fuel] -= fuelCount;
          add({ type: 'smelt', item: name, input, count: missing, fuel, fuelCount });
          stock[name] = (stock[name] ?? 0) + missing;
          smeltPlan = { stock: { ...stock }, steps: structuredClone(steps), table, furnace, hand };
        } catch (error) {
          smeltFailure = error;
        }
        stock = Object.assign(Object.create(null), initial.stock);
        steps = initial.steps;
        table = initial.table;
        furnace = initial.furnace;
        hand = initial.hand;
      }
    }
    const plans = [best, !best || options.availableBlocks?.includes(name) ? blockPlan : null, mobPlan, smeltPlan].filter(Boolean);
    if (plans.length) {
      let selected = plans[0];
      for (const plan of plans.slice(1)) if (plan.steps.length < selected.steps.length) selected = plan;
      stock = Object.assign(Object.create(null), selected.stock);
      steps = selected.steps;
      table = selected.table;
      furnace = selected.furnace;
      hand = selected.hand;
      return;
    }
    if (sourceFailure) throw sourceFailure;
    if (smeltFailure) throw smeltFailure;
    if (recipeFailure) throw recipeFailure;
    fail('no_source', name);
  };
  try {
    ensure(item, count);
    const summary = { collect: {}, craft: {}, kill: {}, smelt: {} };
    for (const step of steps) if (summary[step.type]) summary[step.type][step.item] = (summary[step.type][step.item] ?? 0) + (step.times ?? step.count);
    return { ok: true, steps, summary };
  } catch (error) {
    if (!error.reason) throw error;
    return { ok: false, reason: error.reason, detail: error.detail };
  }
}
