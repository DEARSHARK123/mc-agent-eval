import { validateArgs, allowsArgOverride } from '../skills/format.js';
import { runSkill } from '../skills/runner.js';
import { validateIntent } from '../decision/intent.js';
import { submitIntent } from '../decision/stepper.js';
import { mcData as defaultData } from '../teaching/lexicon.js';

const hostile = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'witch', 'enderman', 'pillager', 'phantom', 'drowned', 'husk', 'stray']);
export function skillOrigin(skill, ownerUuid) {
  const provenance = skill.provenance ?? [];
  const taught = provenance.filter(p => p.route === 'taught').at(-1);
  if (taught) return { origin: 'taught', taught_at: taught.taught_at,
    teacher_is_owner: typeof taught.teacher_uuid === 'string' && taught.teacher_uuid.toLowerCase() === ownerUuid?.toLowerCase() };
  if (provenance.some(p => p.route === 'innate')) return { origin: 'built_in' };
  const self = provenance.filter(p => p.route === 'self').at(-1);
  if (self) return { origin: 'self_learned', learned_at: self.taught_at };
  return { origin: 'built_in' };
}

export function lookAround(bot, ownerUuid, mcData = defaultData) {
  const origin = bot?.entity?.position;
  const relative = position => position && origin ? { x: position.x - origin.x, y: position.y - origin.y,
    z: position.z - origin.z, distance: Math.hypot(position.x - origin.x, position.y - origin.y, position.z - origin.z) } : null;
  const entities = Object.values(bot?.entities ?? {});
  const owner = [...entities, ...Object.values(bot?.players ?? {}).map(p => ({ ...p.entity, uuid: p.entity?.uuid ?? p.uuid }))]
    .find(e => e?.uuid?.toLowerCase() === ownerUuid?.toLowerCase() && e.isValid !== false);
  const blocks = {};
  if (origin && bot?.findBlocks && bot?.blockAt) {
    const positions = bot.findBlocks({ matching: Object.values(mcData.blocksByName).filter(b => !['air', 'cave_air', 'void_air'].includes(b.name)).map(b => b.id), maxDistance: 32, count: 4096 });
    for (const position of positions) {
      const name = bot.blockAt(position)?.name;
      if (name && relative(position)?.distance <= 32) blocks[name] = (blocks[name] ?? 0) + 1;
    }
  }
  return { owner: relative(owner?.position), hostiles: entities.filter(e => e.isValid !== false &&
    (e.hostile || hostile.has(e.name)) && relative(e.position)?.distance <= 16)
    .map(e => ({ name: e.name, ...relative(e.position) })),
    blocks: Object.fromEntries(Object.entries(blocks).sort((a, b) => b[1] - a[1]).slice(0, 10)) };
}

export function createGameTools({ library, arbiter, registry, bot, ownerUuid, jev, learningAutonomy = 0, goals,
  eventlog, traceId, mcData = defaultData, confidenceMin = 0.7, clock, submitIntentFn = submitIntent, budget = null }) {
  let executions = 0;
  const result = details => ({ content: [{ type: 'text', text: JSON.stringify(details) }], details });
  const tool = (name, description, parameters, execute, execution = false) => ({ name, label: name, description, parameters,
    async execute(id, args, signal) {
      if (signal?.aborted) return result({ status: 'cancelled' });
      if (execution && ++executions > 2) return result({ error: 'execution_limit' });
      try { return result(await execute(args, signal)); } catch { return result({ error: 'tool_failed' }); }
    } });
  const empty = { type: 'object', properties: {}, additionalProperties: false };
  const tools = [
    tool('list_skills', 'List learned skills and their provenance.', empty, () => library.list().map(s => ({ name: s.name,
      description: s.description, params: s.params, ...skillOrigin(s, ownerUuid) }))),
    tool('inventory', 'Count inventory items.', empty, () => {
      const items = {};
      for (const item of bot?.inventory?.items?.() ?? []) items[item.name] = (items[item.name] ?? 0) + item.count;
      return items;
    }),
    tool('look_around', 'Observe the owner, hostile mobs and nearby blocks.', empty, () => lookAround(bot, ownerUuid, mcData)),
    tool('run_skill', 'Execute a learned skill.', { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object', additionalProperties: {} } }, required: ['name'], additionalProperties: false }, async (input, signal) => {
      const skill = library.get(input.name);
      if (!skill || !allowsArgOverride(skill, input.args ?? {})) return { error: 'not_learned' };
      const args = input.args ?? {};
      const count = args.count ?? 1;
      const counted = ['count', 'quantity'].includes(skill.params?.count?.type);
      if (!Number.isInteger(count) || count < 1 || count > (skill.params?.count?.type === 'quantity' ? 64 : 16)) {
        return { error: 'invalid_args' };
      }
      const { count: ignored, ...rest } = args;
      const validated = validateArgs(skill.params, counted ? args : rest);
      if (!validated.ok) return { error: 'invalid_args' };
      const abort = () => arbiter.cancel('owner');
      signal?.addEventListener('abort', abort, { once: true });
      try {
        let value;
        if (counted) {
          value = await runSkill({ library, arbiter, name: input.name, args, source: 'owner', traceId });
        } else {
          const outcome = await arbiter.submit({ source: 'owner', label: input.name, library, traceId,
            program: { body: [{ repeat: count, body: [{ call: input.name, args: validated.args }] }], params: {}, args: {} } }).done;
          value = { ok: outcome.status === 'completed', outcome };
          if (['completed', 'failed'].includes(outcome.status)) library.recordOutcome(input.name, value.ok);
        }
        return { status: value.outcome?.status ?? 'failed', completed: value.outcome?.trace?.find(e => e.node === 'repeat')?.completed ?? (value.ok ? count : 0),
          reason: value.reason ?? value.outcome?.error?.code };
      } finally { signal?.removeEventListener('abort', abort); }
    }, true),
    tool('stop', 'Cancel the current task.', empty, () => ({ stopped: arbiter.cancel('owner') === true })),
  ];
  if (learningAutonomy >= 2 && jev?.ask) tools.push(tool('start_intent', 'Collect additional blocks using the intent executor.',
    { type: 'object', properties: { block: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 16 } }, required: ['block', 'count'], additionalProperties: false }, async ({ block, count }, signal) => {
      if (!Number.isInteger(count) || count < 1 || count > 16) return { error: 'invalid_intent' };
      const counted = await registry.run('countItem', { itemName: block }, { traceId, signal });
      const base = counted?.result ?? counted;
      if (counted?.ok === false || !Number.isSafeInteger(base) || base < 0) return { error: 'invalid_intent' };
      const intent = { goal: `Collect ${count} ${block} blocks`, goalText: `Collect ${count} ${block}`, requestedCount: count,
        baseCount: base, target: { block, item: block }, success: { hasItem: block, atLeast: base + count },
        allowed: ['findBlock', 'goTo', 'dig', 'collectDrops'], maxSteps: 40, deadlineMs: 180000 };
      if (!validateIntent(intent, { mcData }).ok || signal?.aborted) return { error: signal?.aborted ? 'cancelled' : 'invalid_intent' };
      const task = submitIntentFn({ arbiter, intent, registry, jev, bot, mcData, eventlog, confidenceMin, traceId, clock });
      const abort = () => arbiter.cancel('owner');
      signal?.addEventListener('abort', abort, { once: true });
      try { return await task.done; } finally { signal?.removeEventListener('abort', abort); }
    }, true));
  if (learningAutonomy >= 2 && goals) tools.push(tool('obtain', '通过规划和执行获得物品。',
    { type: 'object', properties: { item: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 64 }, give_to_owner: { type: 'boolean' } }, required: ['item', 'count'], additionalProperties: false },
    async ({ item, count, give_to_owner = false }, signal) => {
      if (!Number.isInteger(count) || count < 1 || count > 64 || !Object.hasOwn(mcData.itemsByName, item) || typeof give_to_owner !== 'boolean') return { error: 'invalid_goal' };
      const ready = goals.feasibility({ item, count });
      if (!ready.ok) return { status: 'unable', reason: ready.reason };
      if (budget && !budget.spend({ kind: 'goal', item }, traceId)) {
        return { status: 'unable', reason: 'learning_budget_exhausted' };
      }
      const abort = () => arbiter.cancel('owner'); signal?.addEventListener('abort', abort, { once: true });
      try { return await goals.obtain({ item, count, giveToOwner: give_to_owner, traceId }).done; }
      finally { signal?.removeEventListener('abort', abort); }
    }, true));
  return tools;
}
