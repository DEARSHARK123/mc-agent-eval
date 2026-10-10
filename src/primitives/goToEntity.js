import { goals, navigate, positionResult } from './helpers.js';

export const name = 'goToEntity';
export const description = 'Walk within range of a visible entity identified by UUID.';
export const params = {
  uuid: { type: 'string', required: true, pattern: '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$' },
  range: { type: 'number', min: 0, default: 2 },
};
export const defaultTimeoutMs = 30_000;
export async function run({ bot }, { uuid, range }, signal) {
  const entity = Object.values(bot.entities).find(entity =>
    entity.uuid?.toLowerCase() === uuid.toLowerCase() && entity.isValid !== false && entity.position
  );
  if (!entity) throw new Error(`Entity not found: ${uuid}`);
  await navigate(bot, new goals.GoalFollow(entity, range), signal);
  return positionResult(entity.position);
}
