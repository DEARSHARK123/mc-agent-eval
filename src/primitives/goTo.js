import { coordinates, goals, navigate } from './helpers.js';

export const name = 'goTo';
export const description = 'Walk within range of a position.';
export const params = { ...coordinates, range: { type: 'number', min: 0, default: 1 } };
export const defaultTimeoutMs = 30_000;
export async function run({ bot }, { x, y, z, range }, signal) {
  await navigate(bot, new goals.GoalNear(x, y, z, range), signal);
  return { x, y, z };
}
