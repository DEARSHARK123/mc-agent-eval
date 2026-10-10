import { createRequire } from 'node:module';
import { createIdentity } from './identity.js';
import { createLookAtOwner } from './reflex/lookAtOwner.js';
import { createTraceId, span } from './trace.js';

const require = createRequire(import.meta.url);

function playerPayload(player) {
  return { username: player?.username, uuid: player?.uuid };
}

function errorPayload(error) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) };
}

export function createBody(config, eventlog, {
  createBot,
  pathfinderPlugin,
  canReflex = () => true,
  onEvent,
} = {}) {
  createBot ??= require('mineflayer').createBot;
  pathfinderPlugin ??= require('mineflayer-pathfinder').pathfinder;
  const bot = createBot({
    host: config.host,
    port: config.port,
    version: config.version,
    username: config.botName,
    auth: 'offline',
  });
  const { isOwner } = createIdentity(config.ownerUuid);
  const lookAtOwner = createLookAtOwner(bot, isOwner);
  const listeners = [];
  let closed = false;
  let tick = 0;

  function record(kind, payload) {
    if (closed) return;
    const traceId = createTraceId();
    const hop = span(traceId, `body.${kind}`);
    eventlog.append(kind, payload, traceId);
    try {
      onEvent?.(kind, payload, traceId);
    } catch (error) {
      eventlog.append('error', { name: error?.name ?? 'Error', message: error?.message ?? String(error), source: 'onEvent' }, traceId);
    }
    eventlog.append('span', hop.end(), traceId);
  }
  function on(name, listener) {
    bot.on(name, listener);
    listeners.push([name, listener]);
  }

  on('spawn', () => record('spawn', {
    username: bot.username,
    uuid: bot.entity?.uuid,
    position: bot.entity?.position && {
      x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z,
    },
  }));
  on('chat', (username, message) => {
    const player = bot.players?.[username];
    record('chat', { username, message, uuid: player?.uuid, from_owner: isOwner(player) });
  });
  on('playerJoined', player => record('playerJoined', playerPayload(player)));
  on('playerLeft', player => record('playerLeft', playerPayload(player)));
  on('death', () => record('death', {}));
  on('kicked', (reason, loggedIn) => record('kicked', { reason, logged_in: loggedIn }));
  on('error', error => record('error', errorPayload(error)));
  on('physicsTick', () => {
    try {
      if (!canReflex()) return;
      const result = lookAtOwner(++tick);
      Promise.resolve(result).catch(error => record('error', {
        ...errorPayload(error), source: 'lookAtOwner',
      }));
    } catch (error) {
      record('error', { ...errorPayload(error), source: 'lookAtOwner' });
    }
  });

  function close() {
    if (closed) return;
    closed = true;
    try {
      bot.quit();
    } finally {
      for (const [name, listener] of listeners) bot.off(name, listener);
    }
  }

  try {
    bot.loadPlugin(pathfinderPlugin);
  } catch (error) {
    close();
    throw error;
  }
  return { bot, close };
}
