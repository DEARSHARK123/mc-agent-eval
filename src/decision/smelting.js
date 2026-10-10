// Exactly the outputs the planner's original SMELTING set recognized; growing this
// list changes what needs_smelting reports even when the smelting option is off.
const INPUTS = {
  iron_ingot: ['raw_iron', 'iron_ore', 'deepslate_iron_ore'],
  gold_ingot: ['raw_gold', 'gold_ore', 'deepslate_gold_ore'],
  copper_ingot: ['raw_copper', 'copper_ore', 'deepslate_copper_ore'],
  glass: ['sand', 'red_sand'],
  stone: ['cobblestone'],
  smooth_stone: ['stone'],
  brick: ['clay_ball'],
  cooked_beef: ['beef'],
  cooked_porkchop: ['porkchop'],
  cooked_mutton: ['mutton'],
  cooked_chicken: ['chicken'],
  baked_potato: ['potato'],
  cooked_cod: ['cod'],
  cooked_salmon: ['salmon'],
  charcoal: ['__log__'],
};

const FUELS = {
  coal: 8,
  charcoal: 8,
  stick: 0.5,
};

const ITEM_PER_LOG_FAMILY = 1.5;

// Every output the smelting table above can produce, including the log-derived charcoal.
export const SMELTING = new Set([...Object.keys(INPUTS), 'charcoal']);

export function smeltOutput(input) {
  for (const [output, inputs] of Object.entries(INPUTS)) {
    if (inputs.includes(input)) return output;
  }
  if (input.endsWith('_log')) return 'charcoal';
  return null;
}

export function smeltInput(output, preferredLog = 'oak_log') {
  if (output === 'charcoal') return preferredLog;
  return INPUTS[output]?.[0] ?? null;
}

export function fuelValue(name) {
  if (FUELS[name] !== undefined) return FUELS[name];
  if (name.endsWith('_planks') || name.endsWith('_log')) return ITEM_PER_LOG_FAMILY;
  return 0;
}

export function fuelNeeded(fuel, count) {
  const value = fuelValue(fuel);
  if (!(value > 0)) return Infinity;
  return Math.ceil(count / value);
}
