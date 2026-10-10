import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createEventLog } from './eventlog.js';
import { createBody } from './body.js';
import { createPrimitiveRegistry } from './primitives/registry.js';
import { createArbiter } from './arbiter.js';
import { createActionCost } from './cost.js';
import { createSkillLibrary } from './skills/library.js';
import { seedInnateSkills } from './skills/seed.js';
import { resolveStep } from './skills/bindings.js';
import { createMouth } from './mouth.js';
import { createBrain } from './brain/llm.js';
import { createRelationship } from './relationship.js';
import { createOwnerChatHandler } from './teaching/handler.js';
import { createDecisionScheduler } from './decision/scheduler.js';
import { decide as ruleDecide } from './decision/torso.js';
import { createTts } from './voice/tts.js';
import { createPlayer } from './voice/player.js';
import { createVoice } from './voice/pipeline.js';
import { createJev } from './decision/jev.js';
import { createPiManager } from './brain/manager.js';
import { createGameTools } from './brain/tools.js';
import { createGoalRunner } from './decision/goals.js';
import { createGameAgent } from './brain/agent.js';
import { dispatchOwnerChat } from './teaching/stop.js';
import { createSurvival } from './survival/index.js';
import { createProtection } from './safety/protection.js';
import { createLearningBudget } from './proactive/budget.js';
import { createBuilder } from './build/builder.js';
import { createProactive } from './proactive/index.js';
import { createStanceEngine } from './stance/index.js';
import { createBodySensors } from './body/sensors.js';
import { createSafeMovements } from './body/movements.js';
import { errorPayload } from './outcome.js';
import { createDialogue, seedRecentSpeech } from './dialogue.js';

const require = createRequire(import.meta.url);

function sameUuid(value, expected) {
  return typeof value === 'string' && value.toLowerCase() === expected.toLowerCase();
}

export function startCompanion({
  config = loadConfig(), signals = process, createBot, pathfinderPlugin, mcData, fetch,
  spawn, piManagerFactory = createPiManager, repoRoot = fileURLToPath(new URL('../../', import.meta.url)),
} = {}) {
  const eventlog = createEventLog(config.dataDir);
  const resources = { scheduler: null, arbiter: null, library: null, voice: null, agent: null, survival: null, proactive: null, stance: null };
  if (config.ttsDisabledReason) eventlog.append('voice.disabled', { reason: config.ttsDisabledReason });
  let runtime = null;
  let closed = false;
  let closing;
  let spawned = false;
  let spawnListener;
  const nicknameController = new AbortController();
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});

  function queueSpeech(speech) {
    if (!runtime || closed) return;
    runtime.speechQueue = runtime.speechQueue.then(speech).catch(error => {
      if (!closed) eventlog.append('error', { ...errorPayload(error), source: 'speech' });
    });
  }

  function onBodyEvent(kind, payload, traceId) {
    if (closed) return;
    if (runtime?.scheduler) runtime.scheduler.push({ type: kind, payload, traceId });
    if (!runtime?.mouth) return;
    if ((kind === 'playerJoined' || kind === 'chat') && sameUuid(payload?.uuid, config.ownerUuid)) {
      observeOwner(payload.username, traceId);
      if (kind === 'chat') resources.proactive?.noteOwnerChat();
    }
    if (kind === 'playerJoined' && sameUuid(payload?.uuid, config.ownerUuid)) {
      const previous = eventlog.query({ kind: 'playerLeft', limit: Number.MAX_SAFE_INTEGER })
        .filter(event => sameUuid(event.payload?.uuid, config.ownerUuid)).at(-1);
      const situation = { kind: 'owner_joined', ...(previous ? {
        lastLeftAt: previous.ts, awayMs: Math.max(0, Date.now() - previous.ts),
      } : {}) };
      queueSpeech(() => runtime.handler.narrate(situation, traceId));
    } else if (kind === 'playerLeft' && sameUuid(payload?.uuid, config.ownerUuid)) {
      runtime.relationship.setOwnerName(null);
      queueSpeech(() => runtime.handler.narrate({ kind: 'owner_left' }, traceId));
    }
  }

  function observeOwner(name, traceId) {
    try {
      runtime.relationship.setOwnerName(name);
      runtime.relationship.ensureNickname(nicknameController.signal).catch(error => {
        if (!closed) eventlog.append('error', { ...errorPayload(error), source: 'nickname' }, traceId);
      });
    } catch (error) {
      if (!closed) eventlog.append('error', { ...errorPayload(error), source: 'nickname' }, traceId);
    }
  }

  let body;
  try {
    body = createBody(config, eventlog, {
      createBot, pathfinderPlugin,
      canReflex: () => !resources.arbiter?.isBusy(),
      onEvent: onBodyEvent,
    });
  } catch (error) {
    eventlog.close();
    throw error;
  }

  function assemble() {
    const bot = body.bot;
    const data = mcData ?? require('minecraft-data')(config.version);
    const protection = createProtection({ eventlog });
    const sensors = createBodySensors({ bot, eventlog, ownerUuid: config.ownerUuid, clock: {} });
    resources.sensors = sensors;
    const applyMovements = () => {
      if (bot.pathfinder?.setMovements) {
        bot.pathfinder.setMovements(createSafeMovements(bot, { protection, mcData: data }));
      }
    };
    applyMovements();
    protection.onChange?.(applyMovements);
    const registry = createPrimitiveRegistry({ bot, eventlog, mcData: data, ownerUuid: config.ownerUuid,
      commands: config.commands, protection, body: sensors });
    // P1 §4 action cost: created before the arbiter so every step execution can
    // consult and charge it. Derived from the event log, so restarts keep count.
    const cost = createActionCost({ eventlog, limit: config.actionBudgetDaily });
    const arbiter = createArbiter({ registry, eventlog, cost,
      resolver: (step, priorResults) => resolveStep(step, priorResults, { bot, ownerUuid: config.ownerUuid }),
      obtain: (args, context) => goals.obtainInline({ ...args, context }) });
    const library = createSkillLibrary({ dataDir: config.dataDir, registry, eventlog });
    resources.arbiter = arbiter;
    // T28: survival/proactive consult the active stance lazily — the engine is
    // assembled later, so both share this deferred handle.
    const stanceRef = { current: () => resources.stance?.current() ?? null };
    if (config.survival) resources.survival = createSurvival({ bot, registry, arbiter, eventlog, mcData: data, ownerUuid: config.ownerUuid, config: { tickMs: config.survivalTickMs, foodUrgent: config.foodUrgent, foodComfort: config.foodComfort, fleeHealth: config.fleeHealth }, protection, body: sensors, stance: stanceRef });
    resources.library = library;
    seedInnateSkills(library);
    if (config.ttsEnabled) {
      const tts = createTts({ baseUrl: config.brainBaseUrl, apiKey: config.brainApiKey,
        providers: config.ttsProviders, openrouterApiKey: config.openrouterApiKey,
        fishModel: config.ttsFishModel, fishVoice: config.ttsFishVoice,
        model: config.ttsModel, fallbackModels: config.ttsFallbackModels, voice: config.ttsVoice,
        timeoutMs: config.ttsTimeoutMs, fetch, eventlog });
      const player = createPlayer({ repoRoot, spawn, eventlog, volume: config.ttsVolume });
      resources.voice = createVoice({ tts, player, eventlog });
    }
    const voice = resources.voice;
    const mouth = createMouth({ bot, eventlog, voice });
    const brain = createBrain({
      baseUrl: config.brainBaseUrl, apiKey: config.brainApiKey, model: config.brainModel, fetch,
      provider: config.brainProvider, speakModel: config.brainSpeakModel, parseModel: config.brainParseModel,
      speakThinking: config.brainSpeakThinking, parseThinking: config.brainParseThinking,
      fallbackModels: config.brainFallbackModels, speakTimeoutMs: config.brainSpeakTimeoutMs,
      parseTimeoutMs: config.brainParseTimeoutMs, stanceTimeoutMs: config.brainStanceTimeoutMs, eventlog,
    });
    const relationship = createRelationship({ eventlog, brain, ownerUuid: config.ownerUuid });
    const jev = config.typesafeApiKey && config.learningAutonomy >= 2
      ? createJev({ apiKey: config.typesafeApiKey, model: config.jevModel,
        timeoutMs: config.jevTimeoutMs, fetch, eventlog }) : null;
    // goals.obtainInline steps inherit the caller's arbiter source — the same
    // `cost` the arbiter consults must be injectable here for plan/idle billing.
    const goals = createGoalRunner({ registry, arbiter, bot, mcData: data, jev, eventlog, confidenceMin: config.jevConfidenceMin, cost });
    const dialogue = createDialogue();
    seedRecentSpeech(dialogue, eventlog);
    const budget = createLearningBudget({ eventlog, limit: config.learningBudgetDaily });
    const builder = createBuilder({ registry, arbiter, bot, mcData: data, goals, eventlog, protection,
      ownerPosition: () => Object.values(bot.players ?? {}).find(player => sameUuid(player?.uuid, config.ownerUuid))?.entity?.position ?? null });
    resources.builder = builder;
    const pi = piManagerFactory({ piBin: config.piBin, piHome: config.piHome,
      model: config.agentModel, dailyLimit: config.openrouterDailyLimit, eventlog, spawn,
      tools: createGameTools({ library, arbiter, registry, bot, ownerUuid: config.ownerUuid, jev,
        learningAutonomy: config.learningAutonomy, eventlog, goals, budget }) });
    const handler = createOwnerChatHandler({
      agent: resources.agent = createGameAgent({ pi,
        timeoutMs: config.agentTimeoutMs, maxToolRounds: config.agentMaxToolRounds,
        library, arbiter, registry, bot, ownerUuid: config.ownerUuid, jev, goals,
        learningAutonomy: config.learningAutonomy, confidenceMin: config.jevConfidenceMin, eventlog }),
      library, arbiter, mouth, brain, eventlog, ownerUuid: config.ownerUuid, relationship, registry, voice, bot,
      jev, learningAutonomy: config.learningAutonomy, jevConfidenceMin: config.jevConfidenceMin,
      dialogue, goals, budget, builder, protection,
    });
    if (config.proactive) {
      resources.proactive = createProactive({
        bot, registry, arbiter, eventlog, mcData: data, ownerUuid: config.ownerUuid, goals, budget,
        dialogue,
        narrate: (situation, traceId) => new Promise((resolve, reject) => {
          queueSpeech(() => runtime.handler.narrate(situation, traceId).then(resolve, reject));
        }),
        config: { tickMs: config.proactiveTickMs,
          idleProposalMs: config.proactiveIdleProposalMs,
          proposalCooldownMs: config.proactiveProposalCooldownMs },
        stance: stanceRef,
      });
    }
    // T28: the stance layer needs survival's snapshot, goals' retry hook and
    // the brain's advisory pick — assembled last, ticking once a second.
    if (config.survival) resources.stance = createStanceEngine({
      bot, eventlog, registry, arbiter, survival: resources.survival, goals, brain, protection,
      body: sensors, ownerUuid: config.ownerUuid,
      speak: (situation, traceId) => new Promise((resolve, reject) => {
        queueSpeech(() => runtime.handler.narrate(situation, traceId).then(resolve, reject));
      }),
      getSnapshot: () => resources.survival?.snapshot?.() ?? null,
      config: { tickMs: 1_000, cooldownMs: config.stanceCooldownMs },
    });
    void pi.start().catch(() => { if (!closed) eventlog.append('agent.fallback', { reason: 'pi_crashed' }); });
    const scheduler = createDecisionScheduler({
      decide: ruleDecide,
      fallbackDecide: ruleDecide,
      getState: () => {
        const current = arbiter.current();
        return { arbiter: {
          busy: Boolean(current), source: current?.source ?? null, label: current?.label ?? null,
        } };
      },
      onDecision: result => {
        for (const action of result?.actions ?? []) {
          if (action.type !== 'handleOwnerChat') continue;
          const pending = dispatchOwnerChat(runtime, action, resources.agent);
          const handled = pending.catch(error => {
            if (!closed) eventlog.append('error', { ...errorPayload(error), source: 'ownerChat' }, action.traceId);
          });
          if (runtime.actionQueue === pending) runtime.actionQueue = handled;
        }
      },
    });
    resources.scheduler = scheduler;
    runtime = { bot, registry, arbiter, goals, library, mouth, brain, relationship, handler, scheduler,
      actionQueue: Promise.resolve(), speechQueue: Promise.resolve() };
    const owner = Object.values(bot.players ?? {}).find(player => sameUuid(player?.uuid, config.ownerUuid));
    observeOwner(owner?.username ?? null);
    scheduler.start();
  }

  function onSpawn() {
    if (spawned || closed) return;
    spawned = true;
    if (spawnListener) body.bot.off('spawn', spawnListener);
    try {
      assemble();
      resolveReady();
    } catch (error) {
      rejectReady(error);
      close();
    }
  }

  spawnListener = onSpawn;
  body.bot.on('spawn', spawnListener);

  function close() {
    if (closed) return closing;
    closed = true;
    nicknameController.abort();
    signals.off?.('SIGINT', close);
    signals.off?.('SIGTERM', close);
    if (spawnListener) body.bot.off('spawn', spawnListener);
    resources.scheduler?.stop();
    resources.stance?.stop();
    resources.survival?.stop();
    resources.sensors?.stop();
    resources.proactive?.stop();
    resources.agent?.cancel();
    resources.arbiter?.cancel();
    runtime?.goals?.cancel();
    resources.library?.close();
    closing = Promise.all([resources.voice?.close().catch(() => {}), resources.agent?.close()]);
    try {
      body.close();
    } finally {
      eventlog.close();
    }
    if (!spawned) rejectReady(new Error('Companion closed before spawn'));
    return closing;
  }

  signals.once?.('SIGINT', close);
  signals.once?.('SIGTERM', close);
  return { bot: body.bot, eventlog, ready, close, agentAvailable: () => resources.agent?.available() === true,
    get registry() { return runtime?.registry; }, get goals() { return runtime?.goals; },
    get arbiter() { return runtime?.arbiter; },
    get library() { return runtime?.library; }, get survival() { return resources.survival; },
    get proactive() { return resources.proactive; }, get builder() { return resources.builder; },
    get stance() { return resources.stance; } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const app = startCompanion();
    app.ready.catch(error => {
      console.error(error.message);
      app.close();
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
