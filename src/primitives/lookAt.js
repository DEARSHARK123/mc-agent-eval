import { coordinates, point, step } from './helpers.js';

export const name = 'lookAt';
export const description = 'Turn to face a position.';
export const params = coordinates;
export const defaultTimeoutMs = 5_000;
export async function run({ bot }, params, signal) {
  await step(signal, () => bot.lookAt(point(params)));
  return null;
}
