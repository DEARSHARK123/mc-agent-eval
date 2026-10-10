import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDataDir = fileURLToPath(new URL('../data/', import.meta.url));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function loadConfig(env = process.env) {
  if (!env.OWNER_UUID) throw new Error('OWNER_UUID is required');
  if (!uuidPattern.test(env.OWNER_UUID)) {
    throw new Error('OWNER_UUID must be a hyphenated UUID');
  }

  const host = env.MC_HOST ?? '127.0.0.1';
  const portText = String(env.MC_PORT ?? '25565');
  const version = env.MC_VERSION ?? '1.20.4';
  const botName = env.BOT_NAME ?? 'Companion';
  const dataDir = env.COMPANION_DATA_DIR ?? defaultDataDir;
  for (const [name, value] of [
    ['MC_HOST', host], ['MC_VERSION', version],
    ['BOT_NAME', botName], ['COMPANION_DATA_DIR', dataDir],
  ]) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${name} must not be empty`);
    }
  }
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('MC_PORT must be an integer between 1 and 65535');
  }

  const config = {
    host, port, version, botName,
    ownerUuid: env.OWNER_UUID.toLowerCase(),
    dataDir: resolve(dataDir),
  };
  const choice = (name, fallback, allowed) => {
    const value = env[name] ?? fallback;
    if (!allowed.includes(value)) throw new Error(`${name} has an invalid value`);
    return value;
  };
  const timeout = (name, fallback) => {
    const value = String(env[name] ?? fallback);
    const number = Number(value);
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) {
      throw new Error(`${name} must be a positive integer <= 2147483647`);
    }
    return number;
  };
  const brainProvider = choice('BRAIN_PROVIDER', 'openai', ['openai', 'gemini']);
  const ttsRequested = choice('TTS_ENABLED', '0', ['0', '1']) === '1';
  const ttsVoice = env.TTS_VOICE ?? 'Leda';
  if (!/^[A-Za-z]{2,32}$/u.test(ttsVoice)) throw new Error('TTS_VOICE must contain 2 to 32 ASCII letters');
  const ttsVolume = Number(env.TTS_VOLUME ?? 80);
  if (String(env.TTS_VOLUME ?? 80).trim() === '' || !Number.isFinite(ttsVolume) || ttsVolume < 0 || ttsVolume > 100) {
    throw new Error('TTS_VOLUME must be between 0 and 100');
  }
  const ttsPrimary = choice('TTS_PRIMARY', 'fish', ['fish', 'gemini']);
  const fishVoice = env.TTS_FISH_VOICE ?? '';
  if (fishVoice && !/^[A-Za-z0-9_-]{1,64}$/u.test(fishVoice)) throw new Error('TTS_FISH_VOICE has an invalid value');
  const availableTts = { fish: !!env.OPENROUTER_API_KEY?.trim(),
    gemini: brainProvider === 'gemini' && !!env.BRAIN_API_KEY?.trim() };
  const ttsProviders = (ttsPrimary === 'fish' ? ['fish', 'gemini'] : ['gemini', 'fish']).filter(p => availableTts[p]);
  const ttsDisabledReason = ttsRequested && !ttsProviders.length
    ? brainProvider !== 'gemini' ? 'provider' : 'missing_key' : null;
  const autonomy = choice('LEARNING_AUTONOMY', '2', ['0', '1', '2']);
  const survival = choice('SURVIVAL', '1', ['0', '1']) === '1';
  const survivalNumber = (name, fallback, min) => {
    const text=String(env[name] ?? fallback), v=Number(text);
    const max=name==='SURVIVAL_TICK_MS' ? 2_147_483_647 : 20;
    if (!/^\d+$/u.test(text) || !Number.isSafeInteger(v) || v < min || v > max) throw new Error(`${name} has an invalid value`);
    return v;
  };
  const survivalTickMs=survivalNumber('SURVIVAL_TICK_MS',250,1), survivalFoodUrgent=survivalNumber('SURVIVAL_FOOD_URGENT',6,0), survivalFoodComfort=survivalNumber('SURVIVAL_FOOD_COMFORT',14,0), survivalFleeHealth=survivalNumber('SURVIVAL_FLEE_HEALTH',8,1);
  const proactive = choice('PROACTIVE', '1', ['0', '1']) === '1';
  const bounded = (name, fallback, min, max) => {
    const text=String(env[name] ?? fallback), v=Number(text);
    if (!/^\d+$/u.test(text) || !Number.isSafeInteger(v) || v < min || v > max) throw new Error(`${name} has an invalid value`);
    return v;
  };
  const proactiveTickMs=bounded('PROACTIVE_TICK_MS',1000,1,2_147_483_647), proactiveIdleProposalMs=bounded('PROACTIVE_IDLE_PROPOSAL_MS',180000,1,2_147_483_647), proactiveProposalCooldownMs=bounded('PROACTIVE_PROPOSAL_COOLDOWN_MS',600000,1,2_147_483_647);
  const learningBudgetDaily=bounded('LEARNING_BUDGET_DAILY',30,0,1000);
  const actionBudgetDaily=bounded('ACTION_BUDGET_DAILY',300,0,100000);
  const commands = choice('COMMANDS', '0', ['0', '1']) === '1';
  const jevConfidence = Number(env.JEV_CONFIDENCE_MIN ?? 0.7);
  if (!Number.isFinite(jevConfidence) || jevConfidence < 0 || jevConfidence > 1) {
    throw new Error('JEV_CONFIDENCE_MIN must be between 0 and 1');
  }
  // Keep credentials out of enumeration, serialization, and ordinary logging.
  Object.defineProperties(config, {
    openrouterApiKey: { value: env.OPENROUTER_API_KEY ?? '', enumerable: false },
    ttsPrimary: { value: ttsPrimary, enumerable: false },
    ttsProviders: { value: Object.freeze(ttsProviders), enumerable: false },
    ttsFishModel: { value: env.TTS_FISH_MODEL ?? 'fish-audio/s2.1-pro-free:free', enumerable: false },
    ttsFishVoice: { value: fishVoice, enumerable: false },
    piBin: { value: env.PI_BIN || 'pi', enumerable: false },
    piHome: { value: resolve(fileURLToPath(new URL('../', import.meta.url)), env.PI_HOME || 'pi-home'), enumerable: false },
    agentModel: { value: env.AGENT_MODEL || 'openrouter/thinkingmachines/inkling:free', enumerable: false },
    agentTimeoutMs: { value: env.AGENT_TIMEOUT_MS === '' ? 20000 : timeout('AGENT_TIMEOUT_MS', 20000), enumerable: false },
    agentMaxToolRounds: { value: env.AGENT_MAX_TOOL_ROUNDS === '' ? 6 : timeout('AGENT_MAX_TOOL_ROUNDS', 6), enumerable: false },
    openrouterDailyLimit: { value: env.OPENROUTER_DAILY_LIMIT === '' ? 1000 : timeout('OPENROUTER_DAILY_LIMIT', 1000), enumerable: false },
    brainBaseUrl: { value: env.BRAIN_BASE_URL ?? '', enumerable: false },
    brainApiKey: { value: env.BRAIN_API_KEY ?? '', enumerable: false },
    brainModel: { value: env.BRAIN_MODEL ?? '', enumerable: false },
    brainProvider: { value: brainProvider, enumerable: false },
    brainSpeakModel: { value: env.BRAIN_SPEAK_MODEL ?? env.BRAIN_MODEL ?? '', enumerable: false },
    brainParseModel: { value: env.BRAIN_PARSE_MODEL ?? env.BRAIN_MODEL ?? '', enumerable: false },
    brainSpeakThinking: { value: choice('BRAIN_SPEAK_THINKING', 'low', ['low', 'medium', 'high']), enumerable: false },
    brainParseThinking: { value: choice('BRAIN_PARSE_THINKING', 'medium', ['low', 'medium', 'high']), enumerable: false },
    brainFallbackModels: { value: Object.freeze((env.BRAIN_FALLBACK_MODELS ?? '').split(',').map(value => value.trim()).filter(Boolean)), enumerable: false },
    brainSpeakTimeoutMs: { value: timeout('BRAIN_SPEAK_TIMEOUT_MS', 6000), enumerable: false },
    brainParseTimeoutMs: { value: timeout('BRAIN_PARSE_TIMEOUT_MS', 15000), enumerable: false },
    brainStanceTimeoutMs: { value: timeout('BRAIN_STANCE_TIMEOUT_MS', 8000), enumerable: false },
    stanceCooldownMs: { value: timeout('STANCE_COOLDOWN_MS', 30000), enumerable: false },
    ttsEnabled: { value: ttsRequested && !ttsDisabledReason, enumerable: false },
    ttsDisabledReason: { value: ttsDisabledReason, enumerable: false },
    ttsModel: { value: env.TTS_MODEL ?? 'gemini-3.8-flash-lite-tts', enumerable: false },
    ttsFallbackModels: { value: Object.freeze((env.TTS_FALLBACK_MODELS ?? 'gemini-3.8-flash-tts')
      .split(',').map(value => value.trim()).filter(Boolean)), enumerable: false },
    ttsVoice: { value: ttsVoice, enumerable: false },
    ttsTimeoutMs: { value: timeout('TTS_TIMEOUT_MS', 15000), enumerable: false },
    ttsVolume: { value: ttsVolume, enumerable: false },
    typesafeApiKey: { value: env.TYPESAFE_API_KEY ?? '', enumerable: false },
    jevModel: { value: env.JEV_MODEL ?? 'jev-latest', enumerable: false },
    jevTimeoutMs: { value: timeout('JEV_TIMEOUT_MS', 2000), enumerable: false },
    jevConfidenceMin: { value: jevConfidence, enumerable: false },
    learningAutonomy: { value: Number(autonomy), enumerable: false },
    survival: { value: survival, enumerable: false }, survivalTickMs: { value: survivalTickMs, enumerable: false },
    foodUrgent: { value: survivalFoodUrgent, enumerable: false }, foodComfort: { value: survivalFoodComfort, enumerable: false }, fleeHealth: { value: survivalFleeHealth, enumerable: false },
    proactive: { value: proactive, enumerable: false }, proactiveTickMs: { value: proactiveTickMs, enumerable: false },
    proactiveIdleProposalMs: { value: proactiveIdleProposalMs, enumerable: false },
    proactiveProposalCooldownMs: { value: proactiveProposalCooldownMs, enumerable: false },
    learningBudgetDaily: { value: learningBudgetDaily, enumerable: false },
    actionBudgetDaily: { value: actionBudgetDaily, enumerable: false },
    commands: { value: commands, enumerable: false },
  });
  return Object.freeze(config);
}
