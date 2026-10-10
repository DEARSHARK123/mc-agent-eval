import { blockCoordinates, checkSignal, itemName, point, step, Vec3 } from './helpers.js';

export const name = 'place';
export const description = 'Equip an inventory item and place it against an adjacent solid block.';
export const params = { itemName, ...blockCoordinates };
// skills/approach.js walks her within reach-1.5 before the run.
export const reach = 4.5;
export const defaultTimeoutMs = 10_000;
export async function run({ bot, mcData }, params, signal) {
  const target = point(params);
  if (bot.entity.position.distanceTo(target) > reach) throw new Error(`Target is beyond place reach (${reach} blocks)`);
  const targetBlock = bot.blockAt(target);
  if (!targetBlock || !['air', 'cave_air', 'void_air'].includes(targetBlock.name)) {
    throw new Error('Target position is not empty');
  }
  const item = bot.inventory.items().find(item => item.type === mcData.itemsByName[params.itemName].id);
  if (!item) throw new Error(`Item not in inventory: ${params.itemName}`);
  let reference;
  let face;
  for (const offset of [[0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1]]) {
    const block = bot.blockAt(target.offset(...offset));
    if (block?.boundingBox === 'block') {
      reference = block;
      face = new Vec3(...offset.map(value => value === 0 ? 0 : -value));
      break;
    }
  }
  if (!reference) throw new Error('No adjacent solid reference block');
  await step(signal, () => bot.equip(item, 'hand'));
  checkSignal(signal);
  await step(signal, () => bot.placeBlock(reference, face));
  return { x: params.x, y: params.y, z: params.z };
}
