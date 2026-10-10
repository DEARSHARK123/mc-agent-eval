import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createPrimitiveRegistry, UnknownPrimitiveError, InvalidParamsError } from '../src/primitives/registry.js';
import { Vec3 } from '../src/primitives/helpers.js';
import { validateDraft } from '../src/skills/format.js';
import { createGameTools } from '../src/brain/tools.js';
import { ALLOWED } from '../src/decision/intent.js';
import { loadConfig } from '../src/config.js';
import { createLimiter, MARKERS } from '../src/primitives/command.js';

const require = createRequire(import.meta.url);
const mcData = require('minecraft-data')('1.20.4');
const OWNER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const GLASS = 'light_blue_stained_glass';

function botAt(position, blocks = new Map()) {
  const bot = new EventEmitter();
  const chats = [];
  Object.assign(bot, {
    entity: { id: 1, position },
    blockAt: pos => ({ name: blocks.get(`${pos.x},${pos.y},${pos.z}`) ?? 'air' }),
    chat: text => chats.push(text),
  });
  return { bot, chats, set: (pos, name) => blocks.set(`${pos.x},${pos.y},${pos.z}`, name) };
}

function registryOf(bot, options = {}) {
  return createPrimitiveRegistry({ bot, eventlog: { append() {}, query: () => [] }, mcData,
    ownerUuid: OWNER, commands: true, ...options });
}

const setblock = (from, extra = {}) => ({ kind: 'setblock', marker: GLASS, from, ...extra });
const fill = (from, to, extra = {}) => ({ kind: 'fill', marker: GLASS, from, to, ...extra });
const clear = (from, to, extra = {}) => ({ kind: 'clear', marker: GLASS, from, to, ...extra });

test('whitelist: exact command text for setblock, fill and clear', async () => {
  const { bot, chats, set } = botAt(new Vec3(0, 0, 0));
  set({ x: 2, y: 0, z: 0 }, GLASS);
  for (const pos of [{ x: 1, y: 0, z: 1 }, { x: 2, y: 0, z: 2 }, { x: 3, y: 0, z: 3 }]) set(pos, 'yellow_stained_glass');
  const registry = registryOf(bot);
  const placed = await registry.run('command', setblock({ x: 2, y: 0, z: 0 }));
  assert.equal(placed.ok, true);
  assert.equal(placed.result.placed, true);
  assert.deepEqual(chats, ['/setblock 2 0 0 light_blue_stained_glass keep']);
  chats.length = 0;
  const filled = await registry.run('command',
    { kind: 'fill', marker: 'yellow_stained_glass', from: { x: 1, y: 0, z: 1 }, to: { x: 3, y: 0, z: 3 } });
  assert.equal(filled.ok, true);
  assert.equal(filled.result.placed, true);
  assert.deepEqual(chats, ['/fill 1 0 1 3 0 3 yellow_stained_glass keep']);
  chats.length = 0;
  const glassPoints = [{ x: 1, y: 0, z: 1 }, { x: 2, y: 0, z: 2 }, { x: 3, y: 0, z: 3 }];
  bot.chat = text => { chats.push(text); for (const pos of glassPoints) set(pos, 'air'); };
  const cleared = await registry.run('command',
    clear({ x: 1, y: 0, z: 1 }, { x: 3, y: 0, z: 3 }, { marker: 'yellow_stained_glass' }));
  assert.equal(cleared.ok, true);
  assert.equal(cleared.result.cleared, true);
  assert.deepEqual(chats, ['/fill 1 0 1 3 0 3 air replace yellow_stained_glass']);
});

test('whitelist: every non-whitelisted shape is rejected before bot.chat', () => {
  const { bot, chats } = botAt(new Vec3(0, 0, 0));
  const registry = registryOf(bot);
  const from = { x: 1, y: 0, z: 1 };
  const to = { x: 2, y: 0, z: 2 };
  const cases = [
    ['unknown kind', { kind: 'op', marker: GLASS, from }],
    ['clear missing to', { kind: 'clear', marker: GLASS, from }],
    ['setblock with to', setblock(from, { to })],
    ['fill missing to', { kind: 'fill', marker: GLASS, from }],
    ...['stone', 'tnt', 'lava', 'bedrock', 'barrier', 'command_block', 'air', 'water',
      'light_blue_stained_glass[waterlogged=true]', 'light_blue_stained_glass{Custom:1}']
      .map(marker => [`marker ${marker}`, { kind: 'setblock', marker, from }]),
    ['decimal coordinate', setblock({ x: 1.5, y: 0, z: 1 })],
    ['string coordinate', setblock({ x: '1', y: 0, z: 1 })],
    ['relative coordinate', setblock({ x: '~1', y: 0, z: 1 })],
    ['caret coordinate', setblock({ x: '^1', y: 0, z: 1 })],
    ['selector coordinate', setblock({ x: '@e', y: 0, z: 1 })],
    ['extra point field', setblock({ x: 1, y: 0, z: 1, w: 0 })],
    ['missing point field', setblock({ x: 1, y: 0 })],
    ['point not object', setblock('1 0 1')],
    ['point null', setblock(null)],
    ['point array', setblock([1, 0, 1])],
    ['extra top field', setblock(from, { mode: 'destroy' })],
    ['null params', null],
    ['non-object params', '/setblock 1 0 1 air'],
  ];
  for (const [label, params] of cases) {
    assert.throws(() => registry.run('command', params), error =>
      (error instanceof InvalidParamsError || error.code === 'not_allowed')
        && /not_allowed|Invalid parameter/.test(error.message), label);
  }
  assert.equal(chats.length, 0, 'a rejected command reached bot.chat');
  assert.equal(bot.listenerCount('message'), 0);
});

test('source scan: command text is built only from whitelisted words', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/primitives/command.js', import.meta.url)), 'utf8');
  const sends = source.match(/bot\.chat\(/g) ?? [];
  assert.equal(sends.length, 1);
  assert.ok(/bot\.chat\(`\/\$\{buildText\(params\)\}`\)/u.test(source));
  const build = source.slice(source.indexOf('function buildText'), source.indexOf('function watchPoints'));
  assert.deepEqual([...build.matchAll(/`(setblock|fill) [^`]+`/g)].map(match => match[0]), [
    '`setblock ${from.x} ${from.y} ${from.z} ${marker} keep`',
    '`fill ${from.x} ${from.y} ${from.z} ${to.x} ${to.y} ${to.z} air replace ${marker}`',
    '`fill ${from.x} ${from.y} ${from.z} ${to.x} ${to.y} ${to.z} ${marker} keep`',
  ]);
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  assert.ok(!/destroy|hollow|outline|gamemode|\bgive\b|\bkill\b|summon|execute|\bdata\b|effect|enchant|\bxp\b|\bop\b|deop|\bban\b|kick|\bstop\b|\bsay\b|tellraw|scoreboard|setworldspawn|clone|forceload|datapack|attribute|weather|difficulty|\bwhitelist\b|reload|\btime\b|gamerule|\btp\b|teleport/iu.test(code));
});

test('keep protects existing blocks and clear only removes markers', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/primitives/command.js', import.meta.url)), 'utf8');
  const build = source.slice(source.indexOf('function buildText'), source.indexOf('function watchPoints'));
  const templates = [...build.matchAll(/`(setblock|fill) [^`]+`/g)].map(match => match[0]);
  assert.ok(templates.length >= 3);
  for (const template of templates) {
    assert.ok(/(keep|replace \$\{marker\})`$/u.test(template), template);
    assert.ok(!/destroy|hollow|outline|replace \$\{(?!marker)/u.test(template), template);
  }
});

test('per-axis range, y bounds and inclusive volume limits', () => {
  const at = (x, y, z) => registryOf(botAt(new Vec3(x, y, z)).bot);
  const rejects = (registry, params, code) =>
    assert.throws(() => registry.run('command', params), error => error.code === code, JSON.stringify(params));
  const registry = at(0, 0, 0);
  rejects(registry, setblock({ x: 33, y: 0, z: 0 }), 'out_of_range');
  rejects(registry, setblock({ x: 0, y: 0, z: -33 }), 'out_of_range');
  rejects(registry, setblock({ x: 1, y: 33, z: 0 }), 'out_of_range');
  assert.doesNotThrow(() => registry.validate('command', setblock({ x: 32, y: 32, z: -32 })));
  rejects(at(0, -40, 0), setblock({ x: 0, y: -65, z: 0 }), 'out_of_range');
  rejects(at(0, 300, 0), setblock({ x: 0, y: 320, z: 0 }), 'out_of_range');
  assert.doesNotThrow(() => at(0, 288, 0).validate('command', setblock({ x: 0, y: 319, z: 0 })));
  rejects(registry, fill({ x: 0, y: 0, z: 0 }, { x: 7, y: 7, z: 8 }), 'too_large');
  assert.doesNotThrow(() => registry.validate('command', fill({ x: 0, y: 0, z: 0 }, { x: 7, y: 7, z: 7 })));
});

test('sliding window: 30 commands and 2048 blocks in 60 seconds', async () => {
  let now = 0;
  const { bot, chats, set } = botAt(new Vec3(0, 0, 0));
  set({ x: 1, y: 0, z: 0 }, GLASS);
  const registry = registryOf(bot, { clock: { now: () => now } });
  for (let i = 0; i < 30; i++) {
    const result = await registry.run('command', setblock({ x: 1, y: 0, z: 0 }));
    assert.equal(result.ok, true, `command ${i + 1} unexpectedly failed`);
  }
  const over = await registry.run('command', setblock({ x: 1, y: 0, z: 0 }));
  assert.equal(over.ok, false);
  assert.equal(over.error.code, 'rate_limited');
  assert.equal(chats.length, 30, 'a rate-limited command reached bot.chat');
  now = 61_000;
  assert.equal((await registry.run('command', setblock({ x: 1, y: 0, z: 0 }))).ok, true);

  const second = botAt(new Vec3(0, 0, 0));
  for (const pos of [{ x: 0, y: 0, z: 0 }, { x: 3, y: 3, z: 3 }, { x: 7, y: 7, z: 7 }]) {
    second.set(pos, 'lime_stained_glass');
  }
  const other = registryOf(second.bot, { clock: { now: () => now } });
  const big = { kind: 'fill', marker: 'lime_stained_glass', from: { x: 0, y: 0, z: 0 }, to: { x: 7, y: 7, z: 7 } };
  for (let i = 0; i < 4; i++) assert.equal((await other.run('command', big)).ok, true);
  const volumeOver = await other.run('command', setblock({ x: 1, y: 0, z: 0 }));
  assert.equal(volumeOver.ok, false);
  assert.equal(volumeOver.error.code, 'rate_limited');
  assert.equal(second.chats.length, 4);
  now = 122_000;
  assert.equal((await other.run('command', big)).ok, true);

  const third = botAt(new Vec3(0, 0, 0));
  third.set({ x: 0, y: 0, z: 0 }, GLASS);
  const fresh = registryOf(third.bot, { clock: { now: () => now } });
  assert.equal((await fresh.run('command', setblock({ x: 0, y: 0, z: 0 }))).ok, true,
    'a new registry instance shares no limiter state');
});

test('verification: placed, keep-blocked, verified:false, no_permission and cleanup', async () => {
  const { bot, set } = botAt(new Vec3(0, 0, 0));
  const registry = registryOf(bot);
  set({ x: 1, y: 0, z: 0 }, GLASS);
  assert.deepEqual((await registry.run('command', setblock({ x: 1, y: 0, z: 0 }))).result, { placed: true });

  // Deadline-exhausting cases use a clock whose now() advances per poll, so the
  // verify window exits quickly while real setTimeout keeps the registry timeout intact.
  let now = 0;
  const fast = () => ({ now: () => (now += 700) });
  const blocked = botAt(new Vec3(0, 0, 0));
  blocked.set({ x: 1, y: 0, z: 0 }, 'stone');
  const keepResult = await registryOf(blocked.bot, { clock: fast() }).run('command', setblock({ x: 1, y: 0, z: 0 }));
  assert.deepEqual(keepResult.result, { placed: false });
  assert.equal(blocked.bot.listenerCount('message'), 0);

  const weird = botAt(new Vec3(0, 0, 0));
  weird.bot.chat = () => weird.set({ x: 1, y: 0, z: 0 }, 'diamond_block');
  const weirdResult = await registryOf(weird.bot, { clock: fast() }).run('command', setblock({ x: 1, y: 0, z: 0 }));
  assert.deepEqual(weirdResult.result, { placed: false, verified: false });
  assert.equal(weird.bot.listenerCount('message'), 0);

  for (const text of ['Unknown or incomplete command, see below for error',
    "I'm sorry, but you do not have permission to perform this command.",
    'Unknown command. Type "/help" for help.']) {
    const denied = botAt(new Vec3(0, 0, 0));
    denied.bot.chat = () => denied.bot.emit('message', text);
    const outcome = await registryOf(denied.bot).run('command', setblock({ x: 1, y: 0, z: 0 }));
    assert.equal(outcome.ok, false, text);
    assert.equal(outcome.error.code, 'no_permission');
    assert.equal(denied.bot.listenerCount('message'), 0, 'message listener leaked');
  }

  const { bot: cancellable } = botAt(new Vec3(0, 0, 0));
  const controller = new AbortController();
  const pending = registryOf(cancellable).run('command', setblock({ x: 1, y: 0, z: 0 }), { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  const cancelled = await pending;
  assert.equal(cancelled.cancelled, true);
  // The registry resolves cancelled as soon as the signal fires; run() still needs
  // one poll interval to unwind through its finally and drop the listener.
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(cancellable.listenerCount('message'), 0, 'message listener leaked after cancel');
});

test('default off: no command primitive without COMMANDS=1', () => {
  const base = { bot: botAt(new Vec3(0, 0, 0)).bot, eventlog: { append() {}, query: () => [] }, mcData, ownerUuid: OWNER };
  const off = createPrimitiveRegistry(base);
  assert.equal(off.has('command'), false);
  assert.equal(off.list().includes('command'), false);
  assert.throws(() => off.run('command', setblock({ x: 1, y: 0, z: 0 })), UnknownPrimitiveError);
  assert.throws(() => off.validate('command', setblock({ x: 1, y: 0, z: 0 })), UnknownPrimitiveError);
  assert.throws(() => off.describe('command'), UnknownPrimitiveError);
  assert.equal(off.list().length, 25);
  const on = registryOf(base.bot);
  assert.equal(on.has('command'), true);
  assert.equal(on.list().includes('command'), true);
  assert.equal(on.list().length, 26);

  assert.equal(loadConfig({ OWNER_UUID: OWNER }).commands, false);
  assert.equal(loadConfig({ OWNER_UUID: OWNER, COMMANDS: '0' }).commands, false);
  assert.equal(loadConfig({ OWNER_UUID: OWNER, COMMANDS: '1' }).commands, true);
  assert.throws(() => loadConfig({ OWNER_UUID: OWNER, COMMANDS: 'bogus' }),
    error => error.message.includes('COMMANDS') && !error.message.includes('bogus'));
  assert.equal(Object.keys(loadConfig({ OWNER_UUID: OWNER, COMMANDS: '1' })).includes('commands'), false);
});

test('command stays out of intent, tool and skill entry points', () => {
  assert.equal(ALLOWED.has('command'), false);
  const { bot } = botAt(new Vec3(0, 0, 0));
  const registry = registryOf(bot);
  const tools = createGameTools({ library: { list: () => [] }, arbiter: { cancel: () => false, current: () => null },
    registry, bot, ownerUuid: OWNER, learningAutonomy: 2, goals: { feasibility: () => ({ ok: false, reason: 'x' }) } });
  assert.equal(tools.some(tool => tool.name === 'command'), false);
  for (const draft of [
    { name: 'marker_box', body: [{ primitive: 'command', params: {} }] },
    { name: 'marker_box', body: [{ primitive: 'command', params: { kind: 'setblock', marker: GLASS, from: { x: 1, y: 0, z: 1 } } }] },
  ]) {
    const result = validateDraft(draft, { registry });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error === 'skills cannot use command'), result.errors.join(' '));
  }
});

test('limiter counts timestamps without intervals and is per instance', () => {
  let now = 0;
  const limiter = createLimiter({ now: () => now });
  for (let i = 0; i < 30; i++) limiter.spend(1);
  assert.throws(() => limiter.spend(1), error => error.code === 'rate_limited');
  now = 59_999;
  assert.throws(() => limiter.spend(1), error => error.code === 'rate_limited');
  now = 60_000;
  assert.doesNotThrow(() => limiter.spend(1));
  const other = createLimiter({ now: () => now });
  for (let i = 0; i < 4; i++) other.spend(512);
  assert.throws(() => other.spend(1), error => error.code === 'rate_limited');
  assert.equal(MARKERS.length, 6);
});
