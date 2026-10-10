import test from 'node:test';
import assert from 'node:assert/strict';
import { createJev } from '../src/decision/jev.js';
import { parseCollectIntent } from '../src/decision/intent.js';
import { generateCandidates, runIntent } from '../src/decision/stepper.js';
import * as countItem from '../src/primitives/countItem.js';
import { mcData } from '../src/teaching/lexicon.js';

const point = (x, y = 64, z = 0) => ({ x, y, z });
const drop = (name, count, x) => ({ position: point(x), getDroppedItem: () => ({ name, count }) });
function fixture() {
  const bot = { entity: { position: point(0) }, entities: {}, findBlocks: () => [point(2)],
    inventory: { stacks: [], freeSlots: 36,
      items() { return this.stacks; }, emptySlotCount() { return this.freeSlots; } } };
  const setCount = count => { bot.inventory.stacks = [{ name: 'dirt', type: mcData.itemsByName.dirt.id, count }]; };
  const registry = { run: async (name, params) => {
    assert.equal(name, 'countItem');
    return { ok: true, result: countItem.run({ bot, mcData }, params, new AbortController().signal) };
  } };
  return { bot, setCount, registry };
}
function offlineJev(select) {
  const requests = [];
  const jev = createJev({ apiKey: 'fake-key', fetch: async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const choice = select(body, requests.length - 1);
    return { ok: true, status: 200, json: async () => ({ answers: {
      next_action: { choice, confidence: 0.95 }, danger: { score: 0 },
    } }) };
  } });
  return { jev, requests };
}

test('A1 state reports inventory gain, requested count, nearby target quantity and full inventory', async () => {
  const { bot, setCount, registry } = fixture();
  setCount(6);
  bot.inventory.freeSlots = 0;
  bot.entities = { stack: drop('dirt', 2, 2), boundary: drop('dirt', 1, 8),
    far: drop('dirt', 9, 8.01), other: drop('stone', 7, 1),
    diagonal: { position: point(6, 70), getDroppedItem: () => ({ name: 'dirt', count: 8 }) },
    unknown: { position: point(1), getDroppedItem: () => ({ type: mcData.itemsByName.dirt.id, count: 4 }) },
    broken: { position: point(1), getDroppedItem: () => { throw new Error('unreadable'); } },
    mob: { position: point(1), name: 'zombie' } };
  const { jev, requests } = offlineJev(() => 'escalate');
  const result = await runIntent({ intent: parseCollectIntent('挖3个泥土', { baseCount: 5 }), bot, registry, jev, mcData });
  assert.equal(result.reason, 'escalated');
  const state = JSON.parse(requests[0].state);
  assert.deepEqual(state.progress, { have: 1, need: 3, item: 'dirt' });
  assert.equal(state.nearby_target_drops, 3);
  assert.equal(state.inventory_full, true);
  assert.match(state.goalText, /挖3个泥土/u);
  assert.deepEqual(Object.keys(requests[0].questions.next_action.criteria), state.candidates.map(candidate => candidate.key));
  assert.doesNotMatch(JSON.stringify(requests[0].questions), /[\u3400-\u9fff]/u);
});

test('A1 each round refreshes progress, drops, inventory fullness and bot-relative distance', async () => {
  const { bot, setCount, registry } = fixture();
  setCount(5);
  bot.entities = { old: drop('dirt', 2, 1) };
  const originalRun = registry.run;
  registry.run = async (name, params) => {
    if (name === 'countItem') return originalRun(name, params);
    assert.equal(name, 'goTo');
    setCount(6);
    bot.entity.position = point(10);
    bot.inventory.freeSlots = 0;
    bot.entities.new = drop('dirt', 4, 18);
    return { ok: true };
  };
  const { jev, requests } = offlineJev((_body, index) => index ? 'escalate' : 'search');
  await runIntent({ intent: parseCollectIntent('挖3个泥土', { baseCount: 5 }), bot, registry, jev, mcData });
  assert.equal(requests.length, 2);
  const states = requests.map(body => JSON.parse(body.state));
  assert.deepEqual(states.map(state => state.progress), [
    { have: 0, need: 3, item: 'dirt' }, { have: 1, need: 3, item: 'dirt' },
  ]);
  assert.deepEqual(states.map(state => state.nearby_target_drops), [2, 4]);
  assert.deepEqual(states.map(state => state.inventory_full), [false, true]);
  assert.equal(states[1].recent_actions[0].chosen, 'search');
});

test('A1 legacy intents without baseline expose zero-based progress', async () => {
  const { bot, setCount, registry } = fixture();
  setCount(2);
  const intent = parseCollectIntent('挖3个泥土');
  delete intent.baseCount;
  delete intent.requestedCount;
  const { jev, requests } = offlineJev(() => 'escalate');
  await runIntent({ intent, bot, registry, jev, mcData });
  const state = JSON.parse(requests[0].state);
  assert.deepEqual(state.progress, { have: 2, need: 3, item: 'dirt' });
  assert.equal(state.nearby_target_drops, 0);
  assert.equal(state.inventory_full, false);
});

test('A2 candidates never contain done across worlds and allowed action subsets', () => {
  const { bot } = fixture();
  const intent = parseCollectIntent('挖3个泥土');
  for (let mask = 1; mask < 16; mask++) {
    const allowed = intent.allowed.filter((_name, index) => mask & (1 << index));
    for (const crowded of [false, true]) {
      bot.findBlocks = () => crowded ? [point(2), point(8), point(12)] : [];
      bot.entities = crowded ? { dirt: drop('dirt', 3, 1),
        zombie: { position: point(10), type: 'mob', name: 'zombie' } } : {};
      const candidates = generateCandidates({ bot, intent: { ...intent, allowed }, mcData });
      assert.equal(candidates.some(candidate => candidate.key === 'done' || candidate.category === 'done'), false);
      assert.ok(candidates.length <= 12);
      assert.ok(candidates.every(candidate => candidate.primitive === null || allowed.includes(candidate.primitive)));
      assert.equal(candidates.at(-1).key, 'escalate');
    }
  }
});

test('A2 forged done response fails without executing or claiming success', async () => {
  const { bot, registry } = fixture();
  const { jev, requests } = offlineJev(() => 'done');
  const result = await runIntent({ intent: parseCollectIntent('挖3个泥土'), bot, registry, jev, mcData });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'jev_failed');
  assert.equal(result.steps, 0);
  assert.deepEqual(result.actions, []);
  assert.equal(Object.hasOwn(requests[0].questions.next_action.criteria, 'done'), false);
});

test('A3 three digs offer quantified collection and code confirms success after pickup', async () => {
  const { bot, setCount, registry } = fixture();
  const blocks = [point(1), point(2), point(3)];
  const executed = [], logs = [];
  bot.findBlocks = () => blocks;
  const originalRun = registry.run;
  registry.run = async (name, params) => {
    if (name === 'countItem') return originalRun(name, params);
    executed.push(name);
    if (name === 'dig') {
      assert.deepEqual(params, blocks.shift());
      bot.entities[executed.length] = drop('dirt', 1, params.x);
    } else {
      assert.equal(name, 'collectDrops');
      assert.deepEqual(params, { radius: 8 });
      assert.equal(Object.keys(bot.entities).length, 3);
      setCount(3);
      bot.entities = {};
    }
    return { ok: true };
  };
  const { jev, requests } = offlineJev((body, index) => {
    const state = JSON.parse(body.state);
    assert.deepEqual(state.progress, { have: 0, need: 3, item: 'dirt' });
    assert.equal(state.nearby_target_drops, index);
    assert.equal(state.candidates.some(candidate => candidate.key === 'done'), false);
    return index < 3 ? 'dig_block_1' : 'collect_drops';
  });
  const result = await runIntent({ intent: parseCollectIntent('挖3个泥土'), bot, registry, jev, mcData,
    eventlog: { append: (kind, payload) => logs.push({ kind, payload }) } });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.steps, 4);
  assert.equal(requests.length, 4, 'no model request is needed to announce completion');
  assert.deepEqual(executed, ['dig', 'dig', 'dig', 'collectDrops']);
  assert.deepEqual(result.actions.map(action => action.primitive), executed);
  const collection = JSON.parse(requests[3].state).candidates.find(candidate => candidate.key === 'collect_drops');
  assert.equal(collection.description, 'pick up the 3 dirt items lying within 8 blocks');
  assert.equal(requests[3].questions.next_action.criteria.collect_drops, collection.description);
  assert.ok(logs.filter(event => event.kind === 'intent.step').every(event => !event.payload.candidate_keys.includes('done')));
  assert.equal(logs.at(-1).payload.status, 'succeeded');
});

test('A4 escalate explicitly means the goal cannot be reached', async () => {
  const { bot, registry } = fixture();
  const { jev, requests } = offlineJev(() => 'escalate');
  const result = await runIntent({ intent: parseCollectIntent('挖3个泥土'), bot, registry, jev, mcData });
  const state = JSON.parse(requests[0].state);
  const escalate = state.candidates.find(candidate => candidate.key === 'escalate');
  assert.equal(escalate.description, 'give up: the goal cannot be reached from here');
  assert.equal(requests[0].questions.next_action.criteria.escalate, escalate.description);
  assert.equal(result.reason, 'escalated');
  assert.deepEqual(result.actions, []);
});
