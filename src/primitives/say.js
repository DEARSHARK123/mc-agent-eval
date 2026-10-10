import { checkSignal } from './helpers.js';

export const name = 'say';
export const description = 'Send a chat message.';
export const params = { text: { type: 'string', required: true, minLength: 1, maxLength: 200 } };
export const defaultTimeoutMs = 2_000;
export function run({ bot }, { text }, signal) {
  checkSignal(signal);
  bot.chat(text);
  return null;
}
