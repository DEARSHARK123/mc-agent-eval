import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createBot } from 'mineflayer';
import { startCompanion } from '../src/main.js';
import { loadConfig } from '../src/config.js';
import { offlineUuid } from './owner-uuid.mjs';
import { mcData } from '../src/teaching/lexicon.js';
import { acquireRunLock, removeDirRobust, sweepStaleRunDirs } from './e2e-cleanup.mjs';
import { prepareE2eServer } from './e2e-server.mjs';
import { ensureCompanionOp } from '../launcher/lib/ops.mjs';
import { agentEnvironment, runAgentScenario } from './e2e-agent.mjs';
import { primitivesEnvironment, runPrimitivesScenario } from './e2e-primitives.mjs';
import { survivalEnvironment, runSurvivalScenario } from './e2e-survival.mjs';
import { goalsEnvironment, runGoalsScenario, runSelfLearningScenario } from './e2e-goals.mjs';
import { proactiveEnvironment, runProactiveScenario } from './e2e-proactive.mjs';
import { commandsEnvironment, runCommandsScenario } from './e2e-commands.mjs';
import { buildEnvironment, runBuildScenario } from './e2e-build.mjs';
import { v1Environment, runV1Scenario } from './e2e-v1.mjs';
import { edgesEnvironment, runEdgesScenario } from './e2e-edges.mjs';
import { stanceEnvironment, runStanceScenario } from './e2e-stance.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const testServer = join(root, 'test-server');
const tmpRoot = join(root, '.tmp');
const runDir = join(tmpRoot, `e2e-${Date.now()}-${process.pid}`);
const dataDir = join(runDir, 'companion-data');
const port = Number(process.env.MC_PORT ?? 25565);
const ownerName = 'TestOwner';
const ownerUuid = offlineUuid(ownerName);
const botName = 'Companion';
const brainMode = process.execArgv.some(value => value.startsWith('--env-file='));
const scenario = process.env.E2E_SCENARIO ?? 'default';

let server;
let owner;
let appA;
let appB;
let appC;
let serverLog;
let releaseLock;
let cleanupPromise;
let shuttingDown = false;
let runDirCreated = false;
// null|undefined|string: undefined = never touched, null = file absent before,
// string = original bytes to restore after the commands scenario.
let opsBackup;
const printedSpeech = new Set();

async function delay(ms) {
  await new Promise(resolveDelay => setTimeout(resolveDelay, ms));
  if (shuttingDown) throw new Error('E2E is shutting down');
}

function waitForOutput(stream, text, timeoutMs) {
  return new Promise((resolveWait, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for server output: ${text}`));
    }, timeoutMs);
    const onData = chunk => {
      buffer += chunk.toString();
      if (buffer.includes(text)) {
        cleanup();
        resolveWait();
      }
    };
    const onError = error => { cleanup(); reject(error); };
    const cleanup = () => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('error', onError);
    };
    stream.on('data', onData);
    stream.on('error', onError);
  });
}

function command(text) {
  if (shuttingDown) throw new Error('E2E is shutting down');
  if (!server?.stdin?.writable) throw new Error('Test server stdin is closed');
  server.stdin.write(`${text}\n`);
}

async function waitForSpeech(app, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = app.eventlog.query({ kind: 'speech' });
    for (const row of rows) {
      if (printedSpeech.has(row.id)) continue;
      printedSpeech.add(row.id);
      console.log(`[${botName}] ${row.payload.text}`);
      if (predicate(row.payload.text, row)) return row.payload.text;
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for companion speech');
    await delay(100);
  }
}

function itemCount(bot, name) {
  return bot.inventory.items().filter(item => item.name === name)
    .reduce((total, item) => total + item.count, 0);
}

async function ensureGrass(bot) {
  if (bot.findBlock({ matching: mcData.blocksByName.grass_block.id, maxDistance: 32 })) return;
  const { x, y, z } = bot.entity.position;
  const [tx, ty, tz] = [Math.floor(x) + 2, Math.floor(y) - 1, Math.floor(z)];
  const target = `${tx} ${ty} ${tz}`;
  command(`setblock ${tx} ${ty + 1} ${tz} air`);
  command(`setblock ${tx} ${ty + 2} ${tz} air`);
  command(`setblock ${target} grass_block`);
  const deadline = Date.now() + 5_000;
  while (!bot.findBlock({ matching: mcData.blocksByName.grass_block.id, maxDistance: 32 })) {
    if (Date.now() >= deadline) throw new Error('Grass fixture did not reach the companion');
    await delay(100);
  }
}

async function waitForDirt(bot, before) {
  const deadline = Date.now() + 5_000;
  while (itemCount(bot, 'dirt') <= before) {
    if (Date.now() >= deadline) throw new Error('Companion did not collect new dirt');
    await delay(100);
  }
}

async function connectOwner() {
  owner = createBot({ host: '127.0.0.1', port, username: ownerName, auth: 'offline', version: '1.20.4' });
  await new Promise((resolveConnect, rejectConnect) => {
    owner.once('spawn', resolveConnect);
    owner.once('error', rejectConnect);
  });
}

function startCompanionInstance() {
  if (shuttingDown) throw new Error('E2E is shutting down');
  const brainEnv = brainMode
    ? Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('BRAIN_'))) : {};
  return startCompanion({ signals: new EventEmitter(), config: loadConfig({
    ...brainEnv,
    OWNER_UUID: ownerUuid, MC_HOST: '127.0.0.1', MC_PORT: String(port),
    MC_VERSION: '1.20.4', BOT_NAME: botName, COMPANION_DATA_DIR: dataDir,
    LEARNING_AUTONOMY: ['jev', 'goals', 'proactive', 'v1'].includes(scenario) ? '2' : '0',
    TYPESAFE_API_KEY: scenario === 'jev' ? process.env.TYPESAFE_API_KEY : '',
    // Only the agent scenario may use pi; other scenarios must stay rule/Gemini-only.
    PI_HOME: join(runDir, 'no-pi-home'),
    SURVIVAL: ['survival', 'v1', 'edges', 'stance'].includes(scenario) ? '1' : '0',
    // Only the proactive scenario runs the proactive layer: stay_near/pickup submissions
    // would break the other scenarios' no-movement and no-new-accept assertions.
    PROACTIVE: ['proactive', 'v1'].includes(scenario) ? '1' : '0',
    ...(scenario === 'proactive' ? { PROACTIVE_IDLE_PROPOSAL_MS: '20000', PROACTIVE_PROPOSAL_COOLDOWN_MS: '60000' } : {}),
    // Only the commands scenario registers the command primitive.
    COMMANDS: ['commands', 'build', 'v1'].includes(scenario) ? '1' : '0',
    ...(scenario === 'agent' ? agentEnvironment(process.env) : {}),
    // T28: shorter per-trigger cooldown keeps the two-take e2e affordable.
    ...(scenario === 'stance' ? { STANCE_COOLDOWN_MS: '5000' } : {}),
  }) });
}

function printJevDiagnostics(app) {
  const events = app.eventlog.query({ limit: Number.MAX_SAFE_INTEGER })
    .filter(row => ['intent.start', 'intent.step', 'intent.end', 'jev.call'].includes(row.kind))
    .sort((a, b) => a.id - b.id);
  for (const row of events) console.log(`E2E JEV EVENT ${JSON.stringify({ kind: row.kind, ts: row.ts, payload: row.payload })}`);
  const position = app.bot.entity?.position;
  const bot = position ? { x: position.x, y: position.y, z: position.z } : null;
  const dirtId = mcData.blocksByName.dirt.id;
  const dirtCount = position && app.bot.findBlocks
    ? app.bot.findBlocks({ matching: dirtId, maxDistance: 32, count: 1_000_000 }).length : 0;
  console.log(`E2E JEV COMPANION ${JSON.stringify({ position: bot, dirt_within_32: dirtCount })}`);
}

async function stopServer() {
  if (!server) return;
  const child = server;
  if (child.exitCode !== null || child.signalCode !== null) {
    server = undefined;
    return;
  }
  await new Promise(resolveStop => {
    let killTimer;
    const finish = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      child.off('exit', finish);
      resolveStop();
    };
    const timer = setTimeout(() => {
      killTimer = setTimeout(finish, 5_000);
      try { child.kill(); } catch (error) {
        console.warn(`E2E cleanup warning: server.kill: ${error.message}`);
      }
    }, 15_000);
    child.once('exit', finish);
    try {
      if (child.stdin?.writable) child.stdin.write('stop\n');
    } catch (error) {
      console.warn(`E2E cleanup warning: server stop: ${error.message}`);
    }
  });
  server = undefined;
}

function cleanupOnce() {
  if (cleanupPromise) return cleanupPromise;
  shuttingDown = true;
  cleanupPromise = Promise.resolve().then(async () => {
    const step = async (name, action) => {
      try { await action(); } catch (error) {
        console.warn(`E2E cleanup warning: ${name}: ${error.message}`);
      }
    };
    await step('appC.close', () => appC?.close());
    await step('appB.close', () => appB?.close());
    await step('appA.close', () => appA?.close());
    await step('owner.quit', () => owner?.quit());
    await step('stopServer', stopServer);
    await step('serverLog.end', async () => {
      if (!serverLog || serverLog.closed) return;
      // Wait for close, not just finish, so Windows releases the log handle.
      await new Promise((resolveLog, rejectLog) => {
        const onClose = () => { serverLog.off('error', onError); resolveLog(); };
        const onError = error => { serverLog.off('close', onClose); rejectLog(error); };
        serverLog.once('close', onClose);
        serverLog.once('error', onError);
        serverLog.end();
      });
    });
    await step('remove run directory', () => {
      if (runDirCreated && !removeDirRobust(runDir)) {
        console.warn(`E2E cleanup warning: could not remove ${runDir}`);
      }
    });
    await step('release lock', () => releaseLock?.());
    await step('restore ops.json', () => {
      if (opsBackup === undefined) return;
      const opsFile = join(testServer, 'ops.json');
      if (opsBackup === null) rmSync(opsFile, { force: true });
      else writeFileSync(opsFile, opsBackup, 'utf8');
      opsBackup = undefined;
    });
  });
  return cleanupPromise;
}

async function onSignal() {
  await cleanupOnce();
  process.exit(130);
}

const signals = ['SIGINT', 'SIGTERM', ...(process.platform === 'win32' ? ['SIGBREAK'] : [])];
for (const signal of signals) process.on(signal, onSignal);

// Windows kill() never reaches the signal handlers, so the launcher demo drives
// a graceful stop over stdin instead.
if (process.env.E2E_STDIN_STOP === '1') {
  process.stdin.setEncoding('utf8');
  let buffer = '';
  process.stdin.on('data', chunk => {
    buffer += chunk;
    if (!buffer.split(/\r?\n/u).includes('stop')) return;
    shuttingDown = true;
    cleanupOnce().then(() => process.exit(process.exitCode ?? 0));
  });
}

async function main() {
  if (scenario === 'survival' && !survivalEnvironment(process.env)) return;
  if (scenario === 'primitives' && !primitivesEnvironment(process.env)) return;
  if (scenario === 'goals' && !goalsEnvironment(process.env)) return;
  if (scenario === 'proactive' && !proactiveEnvironment(process.env)) return;
  if (scenario === 'commands' && !commandsEnvironment(process.env)) return;
  if (scenario === 'build' && !buildEnvironment(process.env)) return;
  if (scenario === 'v1' && !v1Environment(process.env)) return;
  if (scenario === 'edges' && !edgesEnvironment(process.env)) return;
  if (scenario === 'stance' && !stanceEnvironment(process.env)) return;
  if (scenario === 'agent' && !agentEnvironment(process.env)) return;
  mkdirSync(tmpRoot, { recursive: true });
  releaseLock = acquireRunLock(join(tmpRoot, 'e2e.lock'));
  sweepStaleRunDirs(tmpRoot);
  mkdirSync(runDir, { recursive: true });
  runDirCreated = true;
  // The commands scenario grants Companion op level 2: the server reads ops.json from
  // its cwd (test-server), not the universe dir, so merge there and restore the
  // original file during cleanup.
  if (['commands', 'build', 'v1'].includes(scenario)) {
    const opsFile = join(testServer, 'ops.json');
    opsBackup = existsSync(opsFile) ? readFileSync(opsFile, 'utf8') : null;
    ensureCompanionOp(root);
  }
  const { config, plugins } = prepareE2eServer(testServer, runDir,
    // stance needs spawn-monsters too: with it false this Purpur build culls a
    // summoned zombie within a second, so night_pressure never builds up.
    ['survival', 'v1', 'stance'].includes(scenario) ? { 'spawn-monsters': 'true', 'spawn-animals': 'true', 'spawn-npcs': 'true' } : ['primitives', 'goals'].includes(scenario) ? { 'spawn-animals': 'true' } : {});
  serverLog = createWriteStream(join(runDir, 'server.log'), { encoding: 'utf8' });
  server = spawn('java', [
    '-Xms512M', '-Xmx1200M', '-jar', 'server.jar', 'nogui',
    '--universe', runDir, '--config', config, '--plugins', plugins,
  ], {
    cwd: testServer, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  server.stdout.pipe(serverLog);
  server.stderr.pipe(serverLog);
  if (process.env.E2E_SERVER_ECHO === '1') {
    server.stdout.on('data', chunk => {
      for (const line of String(chunk).split(/\r?\n/u)) {
        if (line.trim()) console.log(`SERVER ${line}`);
      }
    });
  }
  await waitForOutput(server.stdout, 'Done (', 180_000);
  command('gamerule doDaylightCycle false');
  command('time set day');
  command('difficulty peaceful');
  command('gamerule doMobSpawning false');
  await connectOwner();

  appA = startCompanionInstance();
  await appA.ready;
  await delay(3_000);
  command(`clear ${botName}`);

  if (scenario === 'survival') {
    await runSurvivalScenario({ app: appA, command, delay, botName });
    return;
  }

  if (scenario === 'primitives') {
    await delay(2_000);
    await runPrimitivesScenario({ app: appA, owner, command, delay, botName, ownerName });
    return;
  }
  if (scenario === 'proactive') {
    await delay(2_000);
    await runProactiveScenario({ app: appA, owner, command, delay, botName, ownerName });
    return;
  }

  if (scenario === 'commands') {
    await delay(2_000);
    await runCommandsScenario({ app: appA, owner, command, delay, server, botName, ownerName });
    return;
  }

  if (scenario === 'build') {
    await delay(2_000);
    await runBuildScenario({ app: appA, owner, command, delay, server, botName, ownerName });
    return;
  }

  if (scenario === 'v1') {
    await delay(2_000);
    await runV1Scenario({ app: appA, owner, command, delay, server, botName, ownerName, dataDir,
      restart: async () => {
        appA.close(); appA = undefined;
        await delay(3_000);
        appB = startCompanionInstance();
        await appB.ready;
        return appB;
      } });
    return;
  }

  if (scenario === 'edges') {
    await delay(2_000);
    await runEdgesScenario({ app: appA, owner, command, delay, server, botName, ownerName });
    return;
  }

  if (scenario === 'stance') {
    await delay(2_000);
    await runStanceScenario({ app: appA, owner, command, delay, server, botName, ownerName });
    return;
  }

  if (scenario === 'goals') {
    await delay(2000);
    await runGoalsScenario({ app: appA, owner, command, delay, botName, ownerName });
    await runSelfLearningScenario({ app: appA, owner, command, delay, botName,
      restart: async () => {
        appA.close(); appA = undefined;
        await delay(3_000);
        appB = startCompanionInstance();
        await appB.ready;
        return appB;
      } });
    return;
  }

  if (scenario === 'agent') {
    await delay(2_000);
    await runAgentScenario({ app: appA, owner, countDirt: () => itemCount(appA.bot, 'dirt'), delay });
    return;
  }

  if (scenario === 'jev') {
    if (!process.env.TYPESAFE_API_KEY) {
      console.log('E2E JEV SKIP: TYPESAFE_API_KEY is not set');
      return;
    }
    const before = itemCount(appA.bot, 'dirt');
    owner.chat('挖3个泥土');
    const deadline = Date.now() + 120_000;
    while (!appA.eventlog.query({ kind: 'intent.end' }).length) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for Jev intent');
      await delay(100);
    }
    printJevDiagnostics(appA);
    const end = appA.eventlog.query({ kind: 'intent.end' }).at(-1);
    assert.equal(end.payload.status, 'succeeded');
    assert.ok(itemCount(appA.bot, 'dirt') >= before + 3);
    for (const row of appA.eventlog.query({ kind: 'intent.step' })) {
      assert.ok(row.payload.candidate_keys?.includes(row.payload.chosen));
    }
    console.log('E2E JEV PASS');
    return;
  }

  const beforeAccept = appA.eventlog.query({ kind: 'arbiter.accept' }).length;
  const beforeSpeech = appA.eventlog.query({ kind: 'speech' }).at(-1)?.id ?? 0;
  owner.chat('做个工作台');
  await waitForSpeech(appA, (_, row) => row.id > beforeSpeech && appA.eventlog.query({ kind: 'say' })
    .some(event => event.trace_id === row.trace_id && event.payload.kind === 'dont_know'));
  assert.equal(appA.eventlog.query({ kind: 'arbiter.accept' }).length, beforeAccept);

  command(`give ${botName} oak_planks 4`);
  await delay(2_000);
  owner.chat('四个木板就能合成工作台');
  await waitForSpeech(appA, (_, row) => appA.eventlog.query({ kind: 'teaching.learned' })
    .some(event => event.trace_id === row.trace_id));
  assert.ok(itemCount(appA.bot, 'crafting_table') >= 1, 'A should craft a crafting table');

  if (brainMode) {
    const deadline = Date.now() + Number(process.env.BRAIN_PARSE_TIMEOUT_MS ?? 15_000) + 1_000;
    while (!appA.eventlog.query({ kind: 'relationship.nickname' }).length && Date.now() < deadline) await delay(100);
  }
  const nicknamesBefore = appA.eventlog.query({ kind: 'relationship.nickname', limit: Number.MAX_SAFE_INTEGER });
  if (brainMode && !nicknamesBefore.length) console.warn('E2E warning: brain did not generate a nickname this run');
  if (brainMode && nicknamesBefore.length) {
    assert.equal(nicknamesBefore.length, 1);
    assert.equal(nicknamesBefore[0].payload.playerName, ownerName);
  }

  appA.close();
  appA = undefined;
  await delay(3_000);
  appB = startCompanionInstance();
  await appB.ready;
  command(`clear ${botName}`);
  command(`give ${botName} oak_planks 4`);
  await delay(2_000);
  const beforeRemembered = appB.eventlog.query({ kind: 'say' }).at(-1)?.id ?? 0;
  owner.chat('做个工作台');
  const rememberedText = await waitForSpeech(appB, (_, row) => appB.eventlog.query({ kind: 'say' })
    .some(event => event.id > beforeRemembered && event.trace_id === row.trace_id && event.payload.kind === 'remembered'));
  assert.ok(itemCount(appB.bot, 'crafting_table') >= 1, 'B should craft a crafting table');
  const db = new DatabaseSync(join(dataDir, 'skills.sqlite'));
  const provenance = db.prepare('SELECT teacher_uuid FROM skill_provenance WHERE skill_name = ? ORDER BY id DESC LIMIT 1')
    .get('craft_crafting_table');
  db.close();
  assert.equal(provenance?.teacher_uuid, ownerUuid);
  if (!brainMode) assert.ok(rememberedText.includes(ownerName), 'remembered fact should name the player');
  for (const row of appB.eventlog.query({ kind: 'speech', limit: Number.MAX_SAFE_INTEGER })) {
    assert.equal(row.payload.text.includes('主人'), false, 'speech must not call the player 主人');
  }
  if (brainMode && nicknamesBefore.length) {
    assert.equal(appB.eventlog.query({ kind: 'relationship.nickname', limit: Number.MAX_SAFE_INTEGER }).length,
      nicknamesBefore.length, 'restart must reuse the stored nickname');
  }

  const dirtBefore = itemCount(appB.bot, 'dirt');
  const acceptsBeforeAction = appB.eventlog.query({ kind: 'arbiter.accept', limit: Number.MAX_SAFE_INTEGER }).length;
  const speechBeforeAction = appB.eventlog.query({ kind: 'speech' }).at(-1)?.id ?? 0;
  const positionBeforeAction = appB.bot.entity.position.clone();
  owner.chat('挖草方块');
  await waitForSpeech(appB, (_, row) => row.id > speechBeforeAction && appB.eventlog.query({ kind: 'say' })
    .some(event => event.trace_id === row.trace_id && event.payload.kind === 'dont_know'));
  assert.equal(appB.eventlog.query({ kind: 'arbiter.accept', limit: Number.MAX_SAFE_INTEGER }).length, acceptsBeforeAction);
  assert.ok(appB.bot.entity.position.distanceTo(positionBeforeAction) < 0.1, 'Unknown action must not move the body');

  await ensureGrass(appB.bot);
  const speechBeforeTeaching = appB.eventlog.query({ kind: 'speech' }).at(-1)?.id ?? 0;
  owner.chat('挖草方块就是找到最近的草方块，走过去，挖掉，捡起来');
  await waitForSpeech(appB, (_, row) => row.id > speechBeforeTeaching && appB.eventlog.query({ kind: 'teaching.learned' })
    .some(event => event.trace_id === row.trace_id && event.payload.name === 'dig_grass_block'), 90_000);
  await waitForDirt(appB.bot, dirtBefore);
  const dirtAfterTeaching = itemCount(appB.bot, 'dirt');
  appB.close();
  appB = undefined;
  await delay(3_000);
  appC = startCompanionInstance();
  await appC.ready;
  await delay(2_000);
  assert.ok(itemCount(appC.bot, 'dirt') >= dirtAfterTeaching, 'Restart must retain inventory');
  await ensureGrass(appC.bot);
  const dirtBeforeRecall = itemCount(appC.bot, 'dirt');
  const sayBeforeRecall = appC.eventlog.query({ kind: 'say' }).at(-1)?.id ?? 0;
  owner.chat('挖草方块');
  const actionText = await waitForSpeech(appC, (_, row) => appC.eventlog.query({ kind: 'say' })
    .some(event => event.id > sayBeforeRecall && event.trace_id === row.trace_id && event.payload.kind === 'remembered'), 90_000);
  await waitForDirt(appC.bot, dirtBeforeRecall);
  const actionDb = new DatabaseSync(join(dataDir, 'skills.sqlite'));
  try {
    assert.equal(actionDb.prepare('SELECT teacher_uuid FROM skill_provenance WHERE skill_name = ? ORDER BY id DESC LIMIT 1')
      .get('dig_grass_block')?.teacher_uuid, ownerUuid);
  } finally { actionDb.close(); }
  if (!brainMode) assert.ok(actionText.includes(ownerName));
  for (const row of appC.eventlog.query({ kind: 'speech', limit: Number.MAX_SAFE_INTEGER })) {
    assert.equal(row.payload.text.includes('主人'), false, 'All speech must use the player name');
  }

  const ownerStart = owner.entity.position.floored();
  const { x, y, z } = ownerStart;
  command(`fill ${x} ${y - 1} ${z - 1} ${x + 13} ${y - 1} ${z + 1} stone`);
  command(`fill ${x} ${y} ${z - 1} ${x + 13} ${y + 2} ${z + 1} air`);
  command(`tp ${ownerName} ${x} ${y} ${z}`);
  command(`tp ${botName} ${x + 2} ${y} ${z}`);
  const fixtureDeadline = Date.now() + 5_000;
  while (owner.entity.position.distanceTo(ownerStart.offset(0.5, 0, 0.5)) > 1.0
    || appC.bot.entity.position.distanceTo(ownerStart.offset(2.5, 0, 0.5)) > 1.0) {
    if (Date.now() >= fixtureDeadline) throw new Error('Follow corridor fixture did not reach the bots');
    await delay(100);
  }
  const followSpeechBefore = appC.eventlog.query({ kind: 'speech' }).at(-1)?.id ?? 0;
  owner.chat('跟着我');
  await waitForSpeech(appC, (_, row) => row.id > followSpeechBefore && appC.eventlog.query({ kind: 'say' })
    .some(event => event.trace_id === row.trace_id && event.payload.kind === 'following'));
  command(`tp ${ownerName} ${x + 10} ${y} ${z}`);
  const followDeadline = Date.now() + 10_000;
  while (owner.entity.position.distanceTo(ownerStart.offset(10.5, 0, 0.5)) > 1.0
    || appC.bot.entity.position.distanceTo(owner.entity.position) > 4) {
    if (Date.now() >= followDeadline) throw new Error('Companion did not follow the owner');
    await delay(100);
  }
  const stoppedSpeechBefore = appC.eventlog.query({ kind: 'speech' }).at(-1)?.id ?? 0;
  owner.chat('停');
  await waitForSpeech(appC, (_, row) => row.id > stoppedSpeechBefore && appC.eventlog.query({ kind: 'say' })
    .some(event => event.trace_id === row.trace_id && event.payload.kind === 'stopped'));
  const stoppedAt = appC.bot.entity.position.clone();
  await delay(1_000);
  assert.ok(appC.bot.entity.position.distanceTo(stoppedAt) < 0.5, 'Companion moved after follow was stopped');
  console.log('E2E PASS');
}

try {
  await main();
} catch (error) {
  console.error(`E2E FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cleanupOnce();
  for (const signal of signals) process.off(signal, onSignal);
}
