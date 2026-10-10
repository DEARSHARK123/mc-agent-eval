import { actionSkillName, parseUtterance } from './parser.js';
import { displayName, mcData, validateTeaching } from './lexicon.js';
import { runSkill } from '../skills/runner.js';
import { normalizeDraft } from '../skills/repair.js';
import { allowsArgOverride, validateArgs } from '../skills/format.js';
import { describeWhen } from '../persona.js';
import { createPrimitiveRegistry } from '../primitives/registry.js';
import { createDialogue, parseShortReply } from '../dialogue.js';
import { parseCollectIntent, validateIntent } from '../decision/intent.js';
import { submitIntent } from '../decision/stepper.js';
import { RECOVER_REASONS } from '../brain/agent.js';
import { skillOrigin } from '../brain/tools.js';
import { isStopCommand, cancelOwnerWork } from './stop.js';
import { resolveClock } from '../clock.js';
import { createSpeaker, duplicateFragment } from './speech.js';
import { firstError } from '../outcome.js';
import { BLUEPRINTS } from '../build/blueprints.js';

const skillNamePattern = /^[a-z][a-zA-Z0-9_]{1,40}$/;
const teachingCuePattern = /就是|的方法|这样做|是这样|教你|步骤|先.+(?:再|然后|接着)/u;

function hasTeachingCue(message) {
  return typeof message === 'string' && teachingCuePattern.test(message);
}

function fallbackAction(message) {
  return Array.from(typeof message === 'string' ? message.trim() : '').slice(0, 20).join('') || '这个动作';
}

export function createOwnerChatHandler({ library, arbiter, mouth, brain, eventlog, ownerUuid, relationship, voice,
  registry = createPrimitiveRegistry({ mcData }), bot, jev, learningAutonomy = 0, jevConfidenceMin = 0.7,
  agent, clock = {}, dialogue = createDialogue({ clock }), goals = null, budget = null, builder = null,
  protection = null }) {
  const now = resolveClock(clock).now;
  const allowedItems = Object.keys(mcData.itemsByName);

  async function agentChat(message, traceId, mode = 'chat', recovery) {
    if (!agent?.enabled) return null;
    const owner = { playerName: relationship?.ownerName() ?? null, nickname: relationship?.nickname() ?? null };
    const result = await agent.run({ message, traceId, mode, recovery, owner, recent: dialogue.recent(6) });
    if (result.timeout) return say({ kind: mode, ownerMessage: message, suppressSpeech: true }, traceId);
    if (result.fallback) return null;
    let text = result.text;
    if (typeof text !== 'string' || !text.trim() || text.includes('主人') ||
        dialogue.recentLines().some(line => duplicateFragment(text, line, { owner }))) text = null;
    eventlog.append('say', { kind: mode, usedBrain: text !== null }, traceId);
    if (text !== null) {
      text = await mouth.say(text, traceId, { kind: mode }) ?? text;
      dialogue.record('companion', text, mode);
    }
    return { kind: mode, text };
  }

  function currentPending() {
    const question = dialogue.getQuestion();
    return question?.type === 'teach_request'
      ? { action: question.action, skillName: question.skillName, at: question.at } : null;
  }

  function stop(message, traceId, fastStop) {
    const stopped = fastStop && fastStop.traceId === traceId ? fastStop
      : cancelOwnerWork({ arbiter, agent }, traceId);
    const action = stopped.label || (stopped.agentCancelled ? '刚才的事' : '当前任务');
    return say(stopped.taskCancelled || stopped.agentCancelled
      ? { kind: 'stopped', action, taskName: action, ownerMessage: message }
      : { kind: 'idle', ownerMessage: message }, traceId);
  }

  function dontKnow(action, skillName, traceId, message, extra = {}) {
    dialogue.setQuestion({ type: 'teach_request', action, skillName, args: extra.args });
    return say({ kind: 'dont_know', action, itemName: action, ownerMessage: message, ...extra }, traceId);
  }

  function requiresTable(item) {
    const recipes = mcData.recipes[mcData.itemsByName[item]?.id] ?? [];
    if (!recipes.length) return null;
    return !recipes.some(recipe => recipe.inShape
      ? recipe.inShape.length <= 2 && recipe.inShape.every(row => row.length <= 2)
      : recipe.ingredients?.length <= 4);
  }

  // T29 A5: speak payloads only need identity/provenance; the DSL bodies stay
  // for the parseIntent path, which composes `call` nodes against them.
  // P3 C: proficiency/uses/successes ride along so the model prefers proven skills.
  function skillsMemory({ withBody = false } = {}) {
    return library.list().map(skill => ({ name: skill.name, description: skill.description,
      params: skill.params, ...(withBody ? { body: skill.body } : {}), origin: skillOrigin(skill, ownerUuid).origin,
      proficiency: skill.proficiency, uses: skill.uses, successes: skill.successes,
      itemName: skill.name.startsWith('craft_') ? displayName(skill.name.slice(6))
        : skill.name.startsWith('make_') ? displayName(skill.name.slice(5)) : skill.description || skill.name,
      provenance: skill.provenance.map(source => ({ taughtAt: source.taught_at, route: source.route ?? 'taught',
        ...((source.route ?? 'taught') === 'taught'
          ? { taughtBy: source.teacher_uuid === ownerUuid ? 'owner' : 'other' } : {}) })) }));
  }

  function capabilities() {
    return [...skillsMemory().map(skill => ({ name: skill.name, description: skill.description || skill.itemName })),
      { name: 'follow', description: 'Follow the owner.', builtin: true },
      { name: 'stop', description: 'Stop the current owner task.', builtin: true }];
  }

  const { say } = createSpeaker({ brain, mouth, dialogue, eventlog, relationship, ownerUuid, skillsMemory, capabilities });

  function provenance(source) {
    if (!source) return { taughtBy: null, taughtWhen: null };
    return { taughtBy: { playerName: source.teacher_uuid?.toLowerCase() === ownerUuid.toLowerCase()
      ? relationship?.ownerName() ?? null : null }, taughtWhen: describeWhen(source.taught_at, now()) };
  }

  function failure(outcome, ingredients = []) {
    const error = firstError(outcome);
    const reason = error?.message ?? (typeof error === 'string' ? error : outcome?.status ?? '试做未完成');
    const missing = error?.code === 'missing_ingredients'
      || /missing[ _-]?(?:ingredients|items?|materials?)|缺(?:少|材料|物品)|材料不足/iu.test(`${error?.code ?? ''} ${reason}`);
    // The craft primitive's combined message cannot distinguish an absent table from materials.
    const missingItem = error?.item ?? ingredients.map(value => value.item).filter(Boolean).join('、');
    return { kind: missing ? 'missing_item' : 'try_failed', reason,
      vars: missing ? { item: missingItem || '合成材料', reason } : { reason } };
  }

  function actionFailure(outcome) {
    const error = firstError(outcome);
    if (error?.code === 'out_of_reach' || /beyond dig reach/iu.test(error?.message ?? '')) {
      return { code: 'out_of_reach', message: '超出挖掘距离' };
    }
    return { code: error?.code ?? 'action_failed',
      message: error?.message ?? (typeof error === 'string' ? error : outcome?.status ?? '试做未完成'),
      ...(error?.blockName ? { blockName: error.blockName } : {}) };
  }

  async function teachAction(draft, action, message, traceId) {
    const previousSkill = typeof draft?.name === 'string' ? library.get(draft.name) : null;
    const history = { previousTeachings: previousSkill?.provenance.length ?? 0,
      ...provenance(previousSkill?.provenance.at(-1)) };
    const itemName = action || draft?.description || draft?.name || '动作';
    const validation = library.validateDraft(draft, { taught: true });
    let outcome;
    if (!validation.ok) outcome = { status: 'failed', error: { code: 'invalid_skill', message: validation.errors.join('; ') } };
    else {
      try {
        const input = validateArgs(draft.params);
        if (!input.ok) throw new Error('invalid_args');
        outcome = await arbiter.submit({ source: 'owner', label: draft.name,
          program: { body: draft.body, params: draft.params ?? {}, args: input.args }, library, traceId }).done;
      } catch {
        outcome = { status: 'failed', error: { code: 'action_failed', message: '试做未能开始' } };
      }
    }
    if (outcome.status !== 'completed') {
      const reason = actionFailure(outcome);
      eventlog.append('teaching.failed', { name: draft?.name, action: itemName, context: message, reason }, traceId);
      return say({ kind: 'try_failed', action: itemName, itemName, reason, ownerMessage: message, ...history }, traceId);
    }
    const learned = library.learn(draft, { teacherUuid: ownerUuid, context: message });
    dialogue.clearQuestion();
    const latest = learned.skill.provenance.at(-1);
    eventlog.append('teaching.learned', { name: draft.name, teacherUuid: ownerUuid,
      context: message, taughtAt: latest.taught_at, version: learned.skill.version }, traceId);
    const previous = learned.previousTeachings.at(-1);
    return say({ kind: previous ? 'relearned' : 'learned', action: itemName, itemName,
      ...provenance(previous ?? latest), previousTeachings: learned.previousTeachings.length, ownerMessage: message }, traceId);
  }

  async function commandAction(name, action, message, traceId, args = {}) {
    if (!library.has(name)) return dontKnow(action || name, name, traceId, message);
    const skill = library.get(name);
    const commandArgs = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'capped'));
    if (!allowsArgOverride(skill, commandArgs)) return dontKnow(action || name, name, traceId, message, { args: commandArgs });
    const itemName = skill.description || action || name;
    const requested = Number.isFinite(args.count) ? Math.max(1, Math.floor(args.count)) : 1;
    const count = Math.min(16, requested);
    let result;
    try {
      if (skill.params.count?.type === 'count') {
        result = await runSkill({ library, arbiter, name, args: { ...commandArgs, count }, source: 'owner', traceId });
      } else {
        const { count: _quantity, ...input } = commandArgs;
        const validated = validateArgs(skill.params, input);
        if (!validated.ok) return dontKnow(action || name, name, traceId, message, { args: input });
        const outcome = await arbiter.submit({ source: 'owner', label: name,
          program: { body: [{ repeat: count, body: [{ call: name, args: validated.args }] }], params: {}, args: {} },
          library, traceId }).done;
        result = { ok: outcome.status === 'completed', outcome };
        if (['completed', 'failed'].includes(outcome.status)) library.recordOutcome(name, result.ok);
      }
    } catch {
      result = { ok: false, outcome: { status: 'failed', error: { message: '执行未能开始' } } };
    }
    const done = result.outcome?.trace?.find(entry => entry.node === 'repeat' && entry.depth === 0)?.completed
      ?? (result.ok ? count : 0);
    const success = result.ok && done === count;
    return say({ kind: success ? 'remembered' : 'try_failed', action: itemName, itemName,
      done, requested, ...(requested > count || args.capped ? { capped: true } : {}),
      ...(success ? {} : { reason: actionFailure(result.outcome) }),
      ...provenance(skill.provenance.at(-1)), previousTeachings: skill.provenance.length, ownerMessage: message }, traceId);
  }

  async function selfTry(message, traceId) {
    if (!jev?.ask || learningAutonomy < 2 || !bot) return null;
    let base = 0;
    const parsedRequest = parseCollectIntent(message, { mcData });
    if (!parsedRequest) return null;
    // T29 A5: countItem is a free query primitive — prefer registry.query()
    // (no arbiter task, no primitive.start/end rows); older doubles may only
    // expose run(), whose outcome wrapper is unwrapped here.
    const countItem = async itemName => typeof registry.query === 'function'
      ? registry.query('countItem', { itemName })
      : (await registry.run('countItem', { itemName }, { traceId }))?.result;
    try {
      base = await countItem(parsedRequest.target.item);
    } catch { return null; }
    if (!Number.isSafeInteger(base) || base < 0) return null;
    const intent = parseCollectIntent(message, { mcData, baseCount: base });
    if (!intent || !validateIntent(intent, { mcData }).ok) return null;
    if (budget && !budget.spend({ kind: 'jev', item: intent.target.item }, traceId)) return null;
    let submitted;
    try {
      submitted = submitIntent({ arbiter, intent, registry, jev, bot, mcData, eventlog,
        confidenceMin: jevConfidenceMin, traceId, clock });
      const result = await submitted.done;
      if (RECOVER_REASONS.has(result.reason)) {
        const recovered = await agentChat(message, traceId, 'recover', result);
        if (recovered) return recovered;
      }
      let got = base;
      try {
        got = await countItem(intent.success.hasItem) ?? base;
      } catch {}
      return say({ kind: 'self_try', status: result.status, reason: result.reason ?? result.error?.code,
        item: intent.target.item, itemName: displayName(intent.target.item), got: got - base, wanted: intent.requestedCount,
        ownerMessage: message }, traceId);
    } catch {
      return say({ kind: 'self_try', status: 'failed', reason: '未完成', item: intent.target.item,
        itemName: displayName(intent.target.item), got: 0, wanted: intent.requestedCount, ownerMessage: message }, traceId);
    }
  }

  async function goalCommand(parsed, message, traceId, recent) {
    const item = parsed.item;
    const count = parsed.count ?? 1;
    const giveToOwner = parsed.giveToOwner === true;
    const craftName = `craft_${item}`;
    const makeName = `make_${item}`;
    const goalFacts = (kind, origin, extra = {}) => say({ kind, item, itemName: displayName(item),
      count, giveToOwner, ...(parsed.capped ? { capped: true } : {}), origin,
      ...(origin === 'taught'
        ? provenance((library.get(makeName)?.provenance ?? []).filter(source => source.route === 'taught').at(-1))
        : {}), ...extra, ownerMessage: message }, traceId);
    if (parsed.kind === 'command_craft' && !giveToOwner && library.has(craftName)) {
      let result;
      try { result = await runSkill({ library, arbiter, name: craftName, source: 'owner', traceId }); } catch {
        result = { ok: false, outcome: { status: 'failed', error: { message: '执行未能开始' } } };
      }
      if (!result.ok) {
        const failed = failure(result.outcome);
        const skill = library.get(craftName);
        return say({ kind: failed.kind, item, ...failed.vars, ownerMessage: message,
          ...provenance(skill.provenance.at(-1)), previousTeachings: skill.provenance.length }, traceId);
      }
      const skill = library.get(craftName);
      return say({ kind: 'remembered', item, ...provenance(skill.provenance.at(-1)),
        previousTeachings: skill.provenance.length, ownerMessage: message }, traceId);
    }
    if (library.has(makeName)) {
      let result;
      try {
        result = await runSkill({ library, arbiter, name: makeName,
          args: { count }, source: 'owner', traceId });
      } catch {
        result = { ok: false, outcome: { status: 'failed', error: { message: '执行未能开始' } } };
      }
      let reason = result.ok ? null
        : (firstError(result.outcome)?.code ?? result.outcome?.status ?? 'goal_failed');
      if (result.ok && giveToOwner) {
        try {
          const outcome = await arbiter.submit({ source: 'owner', label: 'give',
            steps: [{ primitive: 'give', params: { itemName: item, count } }], traceId }).done;
          if (outcome.status !== 'completed') reason = 'give_failed';
        } catch { reason = 'give_failed'; }
      }
      const origin = skillOrigin(library.get(makeName), ownerUuid).origin;
      return goalFacts(reason ? 'goal_failed' : 'goal_done', origin,
        { ...(reason ? { reason } : {}), newly_learned: false });
    }
    if (learningAutonomy >= 2 && typeof goals?.feasibility === 'function' && typeof goals?.obtain === 'function') {
      let ready = null;
      try { ready = goals.feasibility({ item, count }); } catch {}
      if (ready && !ready.ok) {
        return goalFacts('goal_unable', null, { reason: ready.reason, newly_learned: false });
      }
      if (ready?.ok) {
        if (budget && !budget.spend({ kind: 'goal', item }, traceId)) {
          return goalFacts('goal_unable', null, { reason: 'learning_budget_exhausted', newly_learned: false });
        }
        let result;
        try { result = await goals.obtain({ item, count, giveToOwner, traceId }).done; }
        catch { result = { status: 'failed', reason: 'goal_failed' }; }
        const learned = result?.status === 'succeeded'
          && (giveToOwner ? result.given === count : (result.have?.[item] ?? 0) >= count);
        if (learned) {
          try {
            library.learnSelf({ item, count, traceId,
              plan: { stepCount: result.plan?.stepCount, summary: ready.plan.summary } });
            eventlog.append('skills.self_learned', { name: makeName, item, count }, traceId);
          } catch {}
        }
        return goalFacts(learned ? 'goal_done' : 'goal_failed', learned ? 'self_learned' : null,
          { newly_learned: learned, ...(learned ? {} : { reason: result?.reason ?? result?.status ?? 'goal_failed' }) });
      }
    }
    if (parsed.kind === 'command_craft') {
      const chatted = !recent ? await agentChat(message, traceId) : null;
      if (chatted) return chatted;
      return dontKnow(displayName(item), craftName, traceId, message, { item });
    }
    return dontKnow(displayName(item), makeName, traceId, message, { item });
  }

  return {
    narrate: say,
    async handle(message, traceId, fastStop) {
      try { void Promise.resolve(voice?.interrupt()).catch(() => {}); } catch {}
      dialogue.record('owner', message, 'owner_message');
      if (isStopCommand(message)) {
        return stop(message, traceId, fastStop);
      }
      const question = dialogue.getQuestion();
      const reply = parseShortReply(message);
      if (question && reply) {
        if (reply === 'no') {
          dialogue.clearQuestion();
          return say({ kind: 'cancelled', action: question.action, itemName: question.action,
            ownerMessage: message }, traceId);
        }
        if (question.type === 'confirm') {
          dialogue.clearQuestion();
          return commandAction(question.skillName, question.action, message, traceId, question.args ?? {});
        }
        if (question.type === 'propose_goal') {
          dialogue.clearQuestion();
          const { item, count } = question.args ?? {};
          return goalCommand({ kind: 'command_goal', item, count, giveToOwner: false }, message, traceId, null);
        }
        return { kind: 'teach_wait', text: null };
      }
      const recent = currentPending();
      let parsed = parseUtterance(message, { pending: recent });
      if (parsed.kind === 'chat' && !recent && !hasTeachingCue(message)) {
        const chatted = await agentChat(message, traceId);
        if (chatted) return chatted;
      }
      const unknownActionStep = parsed.kind === 'teach_action' && parsed.unknownText !== undefined;
      if (brain?.enabled && (parsed.kind === 'chat' || unknownActionStep)) {
        let intent;
        try { intent = await brain.parseIntent?.(message, { skills: skillsMemory({ withBody: true }), pending: recent,
          dialogue: dialogue.recent(8),
          primitives: registry.list().filter(name => name !== 'say').map(name => registry.describe(name)) }); } catch {}
        // T29 A1: the unknownActionStep path mechanically repairs the model's
        // draft before validation and logs each applied rule. (The llm.js teach
        // branch normalizes on its own; internal learn paths never do.)
        let teachSkill = null;
        if (intent?.kind === 'teach') {
          if (unknownActionStep) {
            const normalized = normalizeDraft(intent.skill, { registry });
            // llm.js already normalized once and surfaces its repairs on the
            // intent — log whichever side actually applied them.
            const rules = [...(Array.isArray(intent.repairs) ? intent.repairs : []), ...normalized.repairs];
            if (rules.length) {
              eventlog.append('skills.repaired', { rules }, traceId);
            }
            if (library.validateDraft(normalized.draft, { taught: true }).ok) teachSkill = normalized.draft;
          } else {
            teachSkill = intent.skill;
          }
        }
        if (teachSkill) {
          if (recent || hasTeachingCue(message)) {
            parsed = { kind: 'teach_action', draft: teachSkill, action: teachSkill?.description };
          } else {
            const action = typeof teachSkill.description === 'string' && teachSkill.description.trim()
              ? teachSkill.description.trim() : fallbackAction(message);
            const skillName = typeof teachSkill.name === 'string' && skillNamePattern.test(teachSkill.name)
              ? teachSkill.name : null;
            eventlog.append('teaching.rejected_untaught', {
              name: typeof teachSkill.name === 'string' ? teachSkill.name : null,
              reason: 'no_teaching_cue',
            }, traceId);
            parsed = { kind: 'unknown_action', action, skillName };
          }
        }
        else if (!unknownActionStep && intent?.kind === 'command') parsed = { kind: 'command_action', skill: intent.skill,
          action: intent.action, args: intent.args, confidence: intent.confidence };
        else if (!unknownActionStep && ['unknown_action', 'ask_skills'].includes(intent?.kind)) parsed = intent;
      }
      const validRule = parsed.kind === 'teach_craft' && validateTeaching(parsed);
      if (brain?.enabled && (parsed.kind === 'chat' || (parsed.kind === 'teach_craft' && !validRule))) {
        let suggestion;
        try { suggestion = await brain.parseTeaching(message, { allowedItems }); } catch {}
        const valid = validateTeaching(suggestion, allowedItems);
        if (valid) parsed = { kind: 'teach_craft', ...valid, raw: message };
      }
      if ((parsed.kind === 'teach_craft' || parsed.kind === 'command_craft'
          || parsed.kind === 'command_store' || parsed.kind === 'command_fetch') &&
          (!parsed.item || !mcData.itemsByName[parsed.item] || parsed.unknownText)) {
        return say({ kind: 'unknown_word', unknownWord: parsed.unknownText ?? '这个物品', ownerMessage: message }, traceId);
      }
      if (parsed.kind === 'follow') {
        try {
          const submitted = arbiter.submit({ source: 'owner', label: 'follow',
            steps: [{ primitive: 'follow', params: { range: 2 } }], traceId });
          if (submitted?.accepted === false) return say({ kind: 'try_failed', action: '跟随', itemName: '跟随',
            reason: { code: 'action_failed', message: '任务未被接受' }, ownerMessage: message }, traceId);
          return say({ kind: 'following', action: '跟随', ownerMessage: message }, traceId);
        } catch (error) {
          return say({ kind: 'try_failed', action: '跟随', itemName: '跟随',
            reason: { code: 'action_failed', message: error?.message || '任务未能开始' }, ownerMessage: message }, traceId);
        }
      }
      if (parsed.kind === 'protect_here') {
        const owner = bot && Object.values(bot.players ?? {})
          .find(player => player?.uuid?.toLowerCase() === ownerUuid?.toLowerCase())?.entity;
        const position = owner?.position;
        const added = position && protection?.add({ x: Math.floor(position.x), y: Math.floor(position.y),
          z: Math.floor(position.z), radius: 12, reason: 'owner' }, traceId);
        if (!added) {
          return say({ kind: 'protect_failed', reason: position ? 'zone_limit' : 'owner_not_found',
            ownerMessage: message }, traceId);
        }
        return say({ kind: 'protected', radius: 12, ownerMessage: message }, traceId);
      }
      if (parsed.kind === 'stop') return stop(message, traceId);
      if (['command_action', 'unknown_action'].includes(parsed.kind) && (!parsed.skill || !library.has(parsed.skill))) {
        const autonomous = await selfTry(message, traceId);
        if (autonomous) return autonomous;
      }
      if (parsed.kind === 'unknown_action') {
        if (!recent && !hasTeachingCue(message)) {
          const chatted = await agentChat(message, traceId);
          if (chatted) return chatted;
        }
        const skillName = Object.hasOwn(parsed, 'skillName') ? parsed.skillName : actionSkillName(parsed.action);
        return dontKnow(parsed.action, skillName, traceId, message, { args: parsed.args });
      }
      if (parsed.kind === 'teach_action') {
        if (parsed.unknownText !== undefined) {
          return say({ kind: 'unknown_word', unknownWord: parsed.unknownText, ownerMessage: message }, traceId);
        }
        let draft = parsed.draft;
        let action = parsed.action;
        if (!action && !draft?.name) {
          if (!recent?.skillName) return say({ kind: 'try_failed', itemName: recent?.action || '动作',
            reason: '教学没有动作名', ownerMessage: message }, traceId);
          draft = { ...draft, name: recent.skillName, description: recent.action };
          action = recent.action;
        }
        return teachAction(draft, action, message, traceId);
      }
      if (parsed.kind === 'ask_ability') {
        if (!parsed.skill || !library.has(parsed.skill)) return dontKnow(parsed.action, parsed.skill, traceId, message,
          { args: parsed.args });
        const skill = library.get(parsed.skill);
        return say({ kind: 'ask_ability', action: parsed.action, itemName: skill.description || parsed.action,
          ...provenance(skill.provenance.at(-1)), ownerMessage: message }, traceId);
      }
      if (parsed.kind === 'command_action') {
        if (!parsed.skill || !library.has(parsed.skill)) {
          const chatted = !recent ? await agentChat(message, traceId) : null;
          if (chatted) return chatted;
          return dontKnow(parsed.action || parsed.skill, parsed.skill ?? null, traceId, message, { args: parsed.args });
        }
        if (parsed.confidence !== undefined && parsed.confidence < 0.6) {
          dialogue.setQuestion({ type: 'confirm', action: parsed.action || parsed.skill, skillName: parsed.skill,
            args: parsed.args });
          return say({ kind: 'confirm', action: parsed.action || parsed.skill, itemName: parsed.action || parsed.skill,
            ownerMessage: message }, traceId);
        }
        return commandAction(parsed.skill, parsed.action, message, traceId, parsed.args);
      }
      if (parsed.kind === 'teach_craft') {
        const teaching = validateTeaching(parsed, allowedItems);
        const useTable = teaching ? requiresTable(teaching.item) : null;
        const draft = { name: `craft_${parsed.item}`, description: `制作 ${parsed.item}`,
          body: [{ primitive: 'craft', params: { itemName: parsed.item, count: 1, useTable } }] };
        const previousSkill = library.get(draft.name);
        const history = { previousTeachings: previousSkill?.provenance.length ?? 0,
          ...provenance(previousSkill?.provenance.at(-1)) };
        const validation = library.validateDraft(draft);
        if (!teaching || useTable === null || !validation.ok) {
          const reason = !teaching ? '材料或数量不明确' : useTable === null ? '找不到合成配方' : validation.errors.join('; ');
          eventlog.append('teaching.failed', { item: parsed.item, context: message, reason }, traceId);
          return say({ kind: 'try_failed', item: parsed.item, reason, ownerMessage: message, ...history }, traceId);
        }
        let outcome;
        try {
          outcome = await arbiter.submit({ source: 'owner', label: draft.name, steps: draft.body, traceId }).done;
        } catch {
          outcome = { status: 'failed', error: { message: '试做未能开始' } };
        }
        if (outcome.status !== 'completed') {
          const failed = failure(outcome, teaching.ingredients);
          eventlog.append('teaching.failed', { item: parsed.item, context: message, reason: failed.reason }, traceId);
          return say({ kind: failed.kind, item: parsed.item, ...failed.vars, ownerMessage: message, ...history }, traceId);
        }
        const learned = library.learn(draft, { teacherUuid: ownerUuid, context: message });
        eventlog.append('teaching.learned', { name: draft.name, teacherUuid: ownerUuid,
          context: message, taughtAt: learned.skill.provenance.at(-1).taught_at, version: learned.skill.version }, traceId);
        const previous = learned.previousTeachings.at(-1);
        return say({ kind: previous ? 'relearned' : 'learned',
          item: parsed.item, ...provenance(previous ?? learned.skill.provenance.at(-1)),
          previousTeachings: learned.previousTeachings.length, ownerMessage: message,
        }, traceId);
      }
      if (['command_craft', 'command_goal'].includes(parsed.kind)) {
        return goalCommand(parsed, message, traceId, recent);
      }
      if (parsed.kind === 'command_toolset') {
        const { tier } = parsed;
        const items = [`${tier}_pickaxe`, `${tier}_axe`, `${tier}_sword`];
        const skillName = `make_${tier}_tools`;
        const itemName = `一套${{ wooden: '木制', stone: '石质', iron: '铁质' }[tier]}工具`;
        const facts = (kind, extra = {}) => say({ kind, item: skillName, itemName,
          ...extra, ownerMessage: message }, traceId);
        if (library.has(skillName)) {
          let result;
          try {
            result = await runSkill({ library, arbiter, name: skillName, source: 'owner', traceId });
          } catch {
            result = { ok: false, outcome: { status: 'failed', error: { message: '执行未能开始' } } };
          }
          const reason = result.ok ? null
            : (firstError(result.outcome)?.code ?? result.outcome?.status ?? 'goal_failed');
          const origin = skillOrigin(library.get(skillName), ownerUuid).origin;
          return facts(reason ? 'goal_failed' : 'goal_done',
            { origin, newly_learned: false, ...(reason ? { reason } : {}) });
        }
        if (learningAutonomy >= 2 && typeof goals?.feasibility === 'function' && typeof goals?.obtain === 'function') {
          let ready = null;
          try { ready = goals.feasibility({ item: items[0], count: 1 }); } catch {}
          if (ready && !ready.ok) return facts('goal_unable', { reason: ready.reason, newly_learned: false });
          if (ready?.ok) {
            if (budget && !budget.spend({ kind: 'goal', item: skillName }, traceId)) {
              return facts('goal_unable', { reason: 'learning_budget_exhausted', newly_learned: false });
            }
            for (const item of items) {
              let result;
              // busy/craft_failed/step_budget are transient: a collect can end
              // while scattered drops still lie in the mining trench, and the
              // retry's fresh plan picks them up against the real stock.
              // Reflex preemption resumes inside obtain itself, and a cancelled
              // goal means the owner said stop — never retry those.
              for (let attempt = 0; attempt < 2; attempt++) {
                try { result = await goals.obtain({ item, count: 1, traceId }).done; }
                catch { result = { status: 'failed', reason: 'goal_failed' }; }
                const transient = result?.status === 'failed'
                  && ['busy', 'craft_failed', 'step_budget'].includes(result?.reason);
                if (!transient) break;
                const deadline = now() + 15_000;
                while (arbiter.current?.() && now() < deadline) {
                  await new Promise(resolve => setTimeout(resolve, 300));
                }
              }
              if (result?.status !== 'succeeded' || (result.have?.[item] ?? 0) < 1) {
                return facts('goal_failed', { newly_learned: false,
                  reason: `${displayName(item)}：${result?.reason ?? result?.status ?? 'goal_failed'}` });
              }
            }
            let equipped = false;
            try {
              const outcome = await arbiter.submit({ source: 'owner', label: `equip ${tier}_pickaxe`,
                steps: [{ primitive: 'equip', params: { itemName: `${tier}_pickaxe`, slot: 'hand' } }],
                traceId }).done;
              equipped = outcome?.status === 'completed';
            } catch {}
            if (!equipped) return facts('goal_failed', { reason: 'equip_failed', newly_learned: false });
            try {
              library.learnSelfProgram({ name: skillName, description: itemName, traceId,
                context: { goal: { tools: items } },
                body: [...items.map(item => ({ obtain: { item, count: 1 } })),
                  { primitive: 'equip', params: { itemName: `${tier}_pickaxe`, slot: 'hand' } }] });
              eventlog.append('skills.self_learned', { name: skillName, tools: items }, traceId);
            } catch {}
            return facts('goal_done', { origin: 'self_learned', newly_learned: true });
          }
        }
        return dontKnow(itemName, skillName, traceId, message);
      }
      if (parsed.kind === 'command_build') {
        const blueprint = parsed.blueprint === null ? null : BLUEPRINTS[parsed.blueprint];
        const buildFacts = (kind, extra) => say({ kind, itemName: blueprint?.displayName ?? parsed.unknownText,
          ...extra, ownerMessage: message }, traceId);
        if (!blueprint) return buildFacts('build_failed', { reason: 'unknown_blueprint' });
        if (!builder) return buildFacts('build_failed', { reason: 'unavailable' });
        let info;
        try { info = builder.inspect({ blueprint: parsed.blueprint }); } catch { info = { ok: false, reason: 'unavailable' }; }
        if (!info.ok) return buildFacts('build_failed', { reason: info.reason });
        if (info.need > info.have && budget && !budget.spend({ kind: 'build', item: info.material }, traceId)) {
          return buildFacts('build_failed', { reason: 'learning_budget_exhausted' });
        }
        let result;
        try { result = await builder.build({ blueprint: parsed.blueprint, traceId }).done; }
        catch { result = { status: 'failed', reason: 'busy' }; }
        return result.status === 'succeeded'
          ? buildFacts('build_done', { placed: result.placed, frame: result.frame })
          : buildFacts('build_failed', { reason: result.reason ?? result.status, placed: result.placed });
      }
      if (['command_store', 'command_fetch'].includes(parsed.kind)) {
        const item = parsed.item;
        const isStore = parsed.kind === 'command_store';
        const count = isStore ? parsed.count : (parsed.count ?? 1);
        const params = count == null ? { itemName: item } : { itemName: item, count };
        let outcome;
        try {
          outcome = await arbiter.submit({ source: 'owner', label: `${isStore ? 'store' : 'fetch'} ${item}`,
            steps: [{ primitive: isStore ? 'deposit' : 'withdraw', params }], traceId }).done;
        } catch {
          outcome = { status: 'failed', error: { message: '未能开始' } };
        }
        const moved = outcome.results?.at(-1)?.result?.moved
          ?? outcome.results?.at(-1)?.error?.moved ?? outcome.error?.moved ?? 0;
        const reason = outcome.status === 'completed' ? null
          : (outcome.error?.code ?? outcome.results?.at(-1)?.error?.code ?? outcome.status ?? 'action_failed');
        return say({
          kind: outcome.status === 'completed' ? (isStore ? 'stored' : 'fetched')
            : (isStore ? 'store_failed' : 'fetch_failed'),
          item, itemName: displayName(item), count, moved,
          ...(parsed.capped ? { capped: true } : {}),
          ...(reason ? { reason } : {}), ownerMessage: message,
        }, traceId);
      }
      if (parsed.kind === 'ask_skills') {
        return say({ kind: 'skills_list', ownerMessage: message }, traceId);
      }
      return say({ kind: 'chat', ownerMessage: message }, traceId);
    },
  };
}
