import { resolveItem, mcData as defaultMcData } from '../teaching/lexicon.js';

const ALLOWED = new Set(['findBlock', 'goTo', 'dig', 'collectDrops']);
const numberWords = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function parseNumber(text) {
  if (!text) return 1;
  if (/^\d+$/u.test(text)) return Number(text);
  if (text === '十') return 10;
  const chars = [...text];
  const ten = chars.indexOf('十');
  if (ten >= 0) return (ten ? numberWords[chars[0]] : 1) * 10 + (chars[ten + 1] ? numberWords[chars[ten + 1]] : 0);
  return numberWords[text] ?? 1;
}

export function parseCollectIntent(message, { mcData = defaultMcData, baseCount = 0 } = {}) {
  if (typeof message !== 'string') return null;
  const match = message.trim().replace(/[。！？!?.,，]+$/u, '').match(/^(?:挖|采|弄)\s*(?:(\d+|[一二两三四五六七八九十])\s*(?:个|块|份)?\s*)?(.+)$/u);
  if (!match) return null;
  const item = resolveItem(match[2]);
  const block = item && Object.hasOwn(mcData.blocksByName ?? {}, item) ? item : null;
  if (!block) return null;
  const count = Math.min(16, Math.max(1, parseNumber(match[1])));
  return {
    goal: `Collect ${count} ${block} blocks for the owner`, goalText: message,
    requestedCount: count, baseCount, success: { hasItem: block, atLeast: baseCount + count }, target: { block, item: block },
    allowed: ['findBlock', 'goTo', 'dig', 'collectDrops'], maxSteps: 40, deadlineMs: 180_000,
  };
}

export function validateIntent(intent, { mcData = defaultMcData } = {}) {
  const errors = [];
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return { ok: false, errors: ['intent must be an object'] };
  if (typeof intent.goal !== 'string' || !intent.goal.trim()) errors.push('goal');
  if (typeof intent.goalText !== 'string' || !intent.goalText.trim()) errors.push('goalText');
  if (!intent.success || intent.success.hasItem === undefined || !Number.isSafeInteger(intent.success.atLeast) ||
      intent.success.atLeast < 1 || intent.success.atLeast > 2304) errors.push('success');
  else if (!Object.hasOwn(mcData.itemsByName ?? {}, intent.success.hasItem)) errors.push('success.hasItem');
  if (!intent.target || typeof intent.target !== 'object') errors.push('target');
  else {
    const blocks = intent.target.blocks ?? (intent.target.block ? [intent.target.block] : []);
    if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > 8 || blocks.some(b => !Object.hasOwn(mcData.blocksByName ?? {}, b)) ||
      !Object.hasOwn(mcData.itemsByName ?? {}, intent.target.item)) errors.push('target');
    else { intent = structuredClone(intent); intent.target.blocks = blocks; intent.target.block = blocks[0]; }
  }
  if (!Array.isArray(intent.allowed) || intent.allowed.length === 0 || intent.allowed.some(name => !ALLOWED.has(name))) errors.push('allowed');
  if (!Number.isSafeInteger(intent.maxSteps) || intent.maxSteps < 1 || intent.maxSteps > 60) errors.push('maxSteps');
  if (!Number.isSafeInteger(intent.deadlineMs) || intent.deadlineMs < 1 || intent.deadlineMs > 600_000) errors.push('deadlineMs');
  if (errors.length) return { ok: false, errors };
  return { ok: true, intent: structuredClone(intent) };
}

export function assertValidIntent(intent, options) {
  const result = validateIntent(intent, options);
  if (!result.ok) throw new Error(`Invalid intent: ${result.errors.join(', ')}`);
  return result.intent;
}

export { ALLOWED };
