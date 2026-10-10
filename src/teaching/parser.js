import { resolveItem, resolveGoalItem, mcData } from './lexicon.js';
import { isStopCommand } from './stop.js';
import { findBlueprint } from '../build/blueprints.js';

const numbers = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function chineseNumber(value) {
  if (/^\d+$/u.test(value)) return Number(value);
  if (value === '几' || value === '一些' || value === '点') return 3;
  if (value === '十') return 10;
  const digits = [...value];
  if (digits.length === 1) return numbers[value] ?? 1;
  const ten = digits.indexOf('十');
  if (ten >= 0) return (ten === 0 ? 1 : numbers[digits[0]] ?? 0) * 10 + (digits[ten + 1] ? numbers[digits[ten + 1]] ?? 0 : 0);
  return digits.reduce((total, digit) => total * 10 + (numbers[digit] ?? 0), 0);
}

function actionParts(action) {
  if (typeof action !== 'string') return null;
  const cleaned = action.trim().replace(/^(?:去|帮我|给我|请|帮忙)/u, '').trim();
  if (/^挖(?:掉)?脚下(?:的方块)?$/u.test(cleaned)) return { action: cleaned, skill: 'dig_below', count: 1 };
  const match = cleaned.match(/^(挖|砍|捡|放)(?:掉|起|下)?(?:(一些|\d+|[一二两三四五六七八九十]{1,3}|几|点)\s*(?:个|块|次|根|张)?\s*)?(.+)$/u);
  if (!match) return null;
  const item = resolveItem(match[3]);
  const count = match[2] === undefined ? 1 : chineseNumber(match[2]);
  return { action: cleaned, skill: item ? `${{ 挖: 'dig', 砍: 'chop', 捡: 'collect', 放: 'place' }[match[1]]}_${item}` : null,
    item, count: Number.isFinite(count) && count > 0 ? count : 1 };
}

function quantity(text) {
  const cleaned = text.trim().replace(/[。！？!?.,，]+$/u, '').trim();
  const match = cleaned.match(/^(?:(\d+|一些|点|[一二两三四五六七八九十几]{1,3})\s*[块个根张把件支双份]?\s*|(?:a|an)\s+)(.+)$/iu);
  const name = match ? match[2].trim() : cleaned;
  const count = match?.[1] === '几' ? null : match ? chineseNumber(match[1] ?? '1') : 1;
  return { name, item: resolveItem(name), count };
}

function teaching(input, output, raw) {
  const result = quantity(output);
  const ingredients = input.split(/\s*(?:和|加|、|\+|\band\b|,)\s*/iu).map(quantity);
  const unknown = [result, ...ingredients].find(part => part.item === null);
  return {
    kind: 'teach_craft', item: unknown ? null : result.item,
    ingredients: ingredients.map(({ item, count }) => ({ item, count })), raw,
    ...(unknown ? { unknownText: unknown.name } : {}),
  };
}

export function actionSkillName(action) {
  return actionParts(action)?.skill ?? null;
}

function actionTeaching(action, instructions, raw, pending) {
  const steps = [];
  let lastTarget;
  let targetCount = 0;
  const targetSkill = actionSkillName(action) || pending?.skillName;
  const targetItem = targetSkill?.match(/^(?:dig|chop|collect|place)_(.+)$/u)?.[1];
  const params = targetItem && mcData.blocksByName[targetItem]
    ? { block: { type: 'block', default: targetItem } } : {};
  for (const text of instructions.split(/\s*(?:[，,、]|然后|再)\s*/u).filter(Boolean)) {
    let step;
    let match = text.match(/^找(?:到)?(?:最近的)?(.+)$/u);
    if (match) {
      const blockName = resolveItem(match[1] === '它' ? targetItem : match[1]);
      if (blockName) {
        lastTarget = `t${++targetCount}`;
        step = { primitive: 'findBlock', params: { blockName: params.block && blockName === targetItem ? '$block' : blockName }, id: lastTarget };
      }
    } else if (/^(?:走过去|走到那里)$/u.test(text) && lastTarget) {
      step = { primitive: 'goTo', params: {}, at: lastTarget };
    } else if (/^挖(?:掉)?(?:它)?$/u.test(text) && lastTarget) {
      step = { primitive: 'dig', params: {}, at: lastTarget };
    } else if (/^挖(?:掉)?脚下(?:的方块)?$/u.test(text)) {
      step = { primitive: 'dig', params: {}, at: '$self.below' };
    } else if (/^(?:捡(?:起来)?|捡起掉的东西)$/u.test(text)) {
      step = { primitive: 'collectDrops', params: {} };
    } else if (/^(?:走到我(?:这)?(?:旁边)?|过来)$/u.test(text)) {
      step = { primitive: 'goTo', params: {}, at: '$owner' };
    } else {
      match = text.match(/^放(?:下)?(.+)$/u) ?? text.match(/^把(.+)放(?:在)?前面$/u);
      const itemName = match && resolveItem(match[1]);
      if (itemName) step = { primitive: 'place', params: { itemName: params.block && itemName === targetItem ? '$block' : itemName }, at: '$self.front' };
    }
    if (!step) return { kind: 'teach_action', unknownText: text, raw };
    steps.push(step);
  }
  const name = actionSkillName(action);
  return { kind: 'teach_action', action: action || null,
    draft: { name, description: action || '', params, body: steps }, raw };
}

const TOOLSET_TIERS = {
  木: 'wooden', 木头: 'wooden', 木制: 'wooden', 木质: 'wooden',
  石: 'stone', 石头: 'stone', 石制: 'stone', 石质: 'stone',
  铁: 'iron', 铁制: 'iron', 铁质: 'iron',
};
const TOOLSET_CLAUSE = /(?:做|弄|造|来)?\s*(?:一)?套\s*(木|木头|木制|木质|石|石头|石制|石质|铁|铁制|铁质)\s*(?:的)?\s*工具/u;
const TOOLSET_SWITCH = /^(?:那就|那)?\s*(?:换|换成|升级成|升级到)\s*(木|木头|木制|木质|石|石头|石制|石质|铁|铁制|铁质)\s*(?:的|质的|制的)?\s*(?:工具)?(?:吧)?$/u;
const PROTECT_HERE = /^(?:保护这里|这是我的家|这是我的房子|别动这附近|别动这里)$/u;

export function parseUtterance(text, { pending = null } = {}) {
  const raw = text;
  if (typeof text !== 'string') return { kind: 'chat', raw };
  const normalized = text.trim().replace(/[。！？!?.,，]+$/u, '').trim();
  if (/^(?:你会(?:做)?什么|what can you do)$/iu.test(normalized)) return { kind: 'ask_skills', raw };
  const follow = /^(?:跟着我|跟我来|跟上|过来跟着)$/u.test(normalized);
  if (follow) return { kind: 'follow', raw };
  if (isStopCommand(text)) return { kind: 'stop', raw };
  if (PROTECT_HERE.test(normalized)) return { kind: 'protect_here', raw };
  let tier = null;
  for (const clause of normalized.split(/\s*(?:[，,。；]|然后)\s*/u)) {
    const hit = clause.match(TOOLSET_CLAUSE);
    if (hit) tier = TOOLSET_TIERS[hit[1]];
  }
  tier = TOOLSET_TIERS[normalized.match(TOOLSET_SWITCH)?.[1]] ?? tier;
  if (tier) return { kind: 'command_toolset', tier, raw };
  let match = normalized.match(/^craft\s+(.+?)\s+from\s+(.+)$/iu);
  if (match) return teaching(match[2], match[1], raw);
  match = normalized.match(/^(?:给我们|给我|帮我们|帮我|请|能不能|可以|去)?\s*(?:再)?\s*(?:搭|建|盖|造)\s*(?:一)?\s*(?:个|座|间|栋)?\s*(.+?)(?:吧|吗|嘛)?$/u);
  if (match) {
    const name = match[1].trim();
    const blueprint = findBlueprint(name);
    if (blueprint) return { kind: 'command_build', blueprint: blueprint.key, raw };
    const rest = normalized.match(/(?:搭|建|盖|造)\s*(.+?)(?:吧|吗|嘛)?$/u)?.[1] ?? name;
    if (/^[\u4e00-\u9fff]{1,8}$/u.test(name) && quantity(name).item === null && quantity(rest).item === null) {
      return { kind: 'command_build', blueprint: null, unknownText: name, raw };
    }
  }
  match = normalized.match(/^(?:(能不能|可不可以|能|可以|帮我|给我|请)\s*)?(?:合成|做成|做|造)\s*(.+?)(?:吗|嘛|么)?$/iu);
  const given = match?.[1] === '给我';
  match ??= normalized.match(/^(?:make|craft)\s+(.+?)(?:吗|嘛|么)?$/iu);
  if (match) {
    const target = quantity((match[2] ?? match[1]).replace(/^个/u, ''));
    const wanted = target.count ?? 3;
    return { kind: 'command_craft', item: target.item, count: Math.min(64, Math.max(1, wanted)),
      ...(wanted > 64 ? { capped: true } : {}), giveToOwner: given, raw,
      ...(target.item === null ? { unknownText: target.name } : {}) };
  }
  match = normalized.match(/^(.+?)\s+(?:make|makes|craft|crafts)\s+(.+)$/iu);
  if (match) return teaching(match[1], match[2], raw);
  match = normalized.match(/^(?:用)?(.+?)(?:就能|可以|就可以|能够|能)?(?:合成|做成|变成|做)(.+)$/u);
  if (match) return teaching(match[1], match[2], raw);
  match = normalized.match(/^(.*?)(?:就是[：:]?|的方法是[：:]?|是这样[：:]?)(.+)$/u);
  if (match) return actionTeaching(match[1].trim(), match[2].trim(), raw, pending);
  const ability = normalized.match(/^(?:你会(?:做)?|会不会)(.+?)(?:吗|嘛|么)?$/u);
  if (ability) {
    const parts = actionParts(ability[1].trim());
    return { kind: 'ask_ability', action: ability[1].trim(), skill: parts?.skill ?? null,
      args: { count: Math.min(16, parts?.count ?? 1), ...(parts && (parts.count ?? 1) > 16 ? { capped: true } : {}) }, raw };
  }
  match = normalized.match(/^(拿给我|递给我|给我|来|弄|拿)\s*(?:(\d+|一些|点|几|[一二两三四五六七八九十]{1,3})\s*[块个根张把件支双份]?\s*)?(.+?)(?:吗|嘛|么)?$/u);
  if (match) {
    const item = resolveGoalItem(match[3]);
    if (item) {
      const wanted = match[2] === undefined ? 1 : chineseNumber(match[2]);
      return { kind: 'command_goal', item, count: Math.min(64, Math.max(1, wanted)),
        ...(wanted > 64 ? { capped: true } : {}),
        giveToOwner: ['拿给我', '递给我', '给我', '来'].includes(match[1]), raw };
    }
  }
  const counted = '(\\d+|一些|点|几|[一二两三四五六七八九十]{1,3})';
  match = normalized.match(new RegExp(`^把\\s*(?:${counted}\\s*[块个根张把件支双份]?\\s*)?(.+?)\\s*(?:放进|放到|存进|存到)\\s*箱子(?:里)?$`, 'u'))
    ?? normalized.match(new RegExp(`^把\\s*(?:${counted}\\s*[块个根张把件支双份]?\\s*)?(.+?)\\s*存起来$`, 'u'));
  if (match) {
    const item = resolveGoalItem(match[2]);
    return { kind: 'command_store', item, count: match[1] === undefined ? null : chineseNumber(match[1]),
      ...(item === null ? { unknownText: match[2].trim() } : {}), raw };
  }
  match = normalized.match(new RegExp(`^从\\s*箱子(?:里)?\\s*(?:拿|取)\\s*(?:${counted}\\s*[块个根张把件支双份]?\\s*)?(.+?)\\s*(?:给我)?$`, 'u'));
  if (match) {
    const item = resolveGoalItem(match[2]);
    const wanted = match[1] === undefined ? 1 : chineseNumber(match[1]);
    return { kind: 'command_fetch', item, count: Math.min(64, Math.max(1, wanted)),
      ...(wanted > 64 ? { capped: true } : {}),
      ...(item === null ? { unknownText: match[2].trim() } : {}), raw };
  }
  const polite = normalized.match(/^(?:能不能|可不可以|能|可以|帮我|给我|请|去)\s*(.+?)(?:吗|嘛|么)?$/u);
  const action = (polite?.[1] ?? normalized).trim();
  const parts = actionParts(action);
  if (parts) {
    const args = { count: Math.min(16, parts.count), ...(parts.count > 16 ? { capped: true } : {}) };
    if (parts.skill) return { kind: 'command_action', skill: parts.skill, action: parts.action, args, raw };
    return { kind: 'unknown_action', action: parts.action, args, raw };
  }
  return { kind: 'chat', raw };
}
