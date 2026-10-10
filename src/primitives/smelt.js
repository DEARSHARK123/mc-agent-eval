import { checkSignal, codedError, itemName, point, positionResult, step, syncWindow } from './helpers.js';
import { resolveClock } from '../clock.js';
import { fuelNeeded, fuelValue, smeltOutput } from '../decision/smelting.js';

export const name = 'smelt';
export const description = 'Smelt items in a nearby furnace using a fuel item.';
export const params = {
  itemName,
  count: { type: 'number', integer: true, min: 1, max: 64, default: 1 },
  fuel: { type: 'string', required: true, catalog: 'itemsByName' },
  // `at` binds the furnace position; without it the nearest furnace within
  // SEARCH_RANGE is used, as before.
  x: { type: 'number', integer: true },
  y: { type: 'number', integer: true },
  z: { type: 'number', integer: true },
};
export const defaultTimeoutMs = 120_000;

const SEARCH_RANGE = 4;
// skills/approach.js walks her within reach-1.5 of a bound target before run.
export const reach = SEARCH_RANGE;
const SYNC_TIMEOUT_MS = 1000;
const MAX_ROUNDS = 3;
// First cook needs ~10 s of furnace time plus window loading and server lag;
// 15 s was marginal on a busy real server.
const STALL_MS = 30_000;
const INPUT_SLOT = 0;
const FUEL_SLOT = 1;
const OUTPUT_SLOT = 2;

export const smeltable = item => smeltOutput(item) !== null;
export const usableFuel = item => fuelValue(item) > 0;
export const allowed = value => smeltable(value.itemName) && usableFuel(value.fuel);

export async function run({ bot, mcData, eventlog, clock }, { itemName, count, fuel, x, y, z }, signal) {
  const timers = resolveClock(clock);
  let furnace = null;
  if (x !== undefined) {
    // A bound furnace position: the executor already walked her into reach;
    // the block there must actually be a furnace.
    const bound = bot.blockAt(point({ x, y, z }));
    if (bound?.name === 'furnace') furnace = bound;
  } else {
    furnace = bot.findBlock({ matching: block => block?.name === 'furnace', maxDistance: SEARCH_RANGE });
  }
  if (!furnace) {
    throw codedError('no_furnace',
      x !== undefined ? 'No furnace at the bound position' : `No furnace within ${SEARCH_RANGE} blocks`);
  }
  if (bot.entity.position.distanceTo(furnace.position) > SEARCH_RANGE) {
    throw codedError('no_furnace', `No furnace within ${SEARCH_RANGE} blocks`);
  }
  const inputId = mcData.itemsByName[itemName].id;
  const fuelId = mcData.itemsByName[fuel].id;
  const outputName = smeltOutput(itemName);
  const outputId = mcData.itemsByName[outputName].id;
  const neededFuel = fuelNeeded(fuel, count);
  const owned = id => bot.inventory.items().filter(item => item.type === id)
    .reduce((total, item) => total + item.count, 0);
  if (owned(inputId) < count || owned(fuelId) < neededFuel) {
    throw codedError('missing_ingredients',
      `Smelting ${count} ${itemName} needs ${count} input and ${neededFuel} ${fuel}`);
  }
  let window;
  window = await step(signal, () => {
    const opening = bot.openFurnace(furnace);
    opening.then(opened => {
      if (signal.aborted && window !== opened) { try { bot.closeWindow(opened); } catch {} }
    }, () => {});
    return opening;
  }, () => {
    if (bot.currentWindow && bot.currentWindow !== bot.inventory) bot.closeWindow(bot.currentWindow);
  });
  const click = async (slot, button, mode) => {
    checkSignal(signal);
    await bot.clickWindow(slot, button, mode);
    await syncWindow(bot, window, signal, SYNC_TIMEOUT_MS, 'container_desync');
  };
  const stackRoom = slot => (slot?.stackSize ?? 64) - (slot?.count ?? 0);
  // Her own inventory view is authoritative; the furnace window's player
  // region can lag a packet behind on this server.
  const inventoryCount = id => bot.inventory.items()
    .filter(item => item.type === id)
    .reduce((total, item) => total + item.count, 0);
  const firstInvSlot = id => {
    for (let s = window.inventoryStart; s < window.inventoryEnd; s++) {
      if (window.slots[s]?.type === id) return s;
    }
    return null;
  };
  // putBack and the end-of-run cleanup also run after an abort, where checkSignal
  // would throw and strand both the held item and the furnace contents; these clicks
  // always run and tolerate a rejected sync.
  const cleanupClick = async (slot, button, mode) => {
    await bot.clickWindow(slot, button, mode);
    try { await syncWindow(bot, window, signal, SYNC_TIMEOUT_MS, 'container_desync'); } catch {}
  };
  const putBack = async () => {
    for (let tries = 0; window?.selectedItem && tries < 40; tries++) {
      const held = window.selectedItem;
      let target = null;
      let empty = null;
      for (let s = window.inventoryStart; s < window.inventoryEnd; s++) {
        const slot = window.slots[s];
        if (slot?.type === held.type && stackRoom(slot) > 0) { target = s; break; }
        if (empty === null && slot == null) empty = s;
      }
      const dest = target ?? empty ?? window.firstEmptyInventorySlot?.();
      if (dest == null) return;
      await cleanupClick(dest, 0, 0);
    }
  };
  // Moves exactly n of id into one furnace slot, verifying every synced state.
  const moveExact = async (id, n, dest) => {
    const baseline = window.slots[dest]?.type === id ? window.slots[dest].count : 0;
    const placed = () => (window.slots[dest]?.type === id ? window.slots[dest].count : 0) - baseline;
    for (let round = 0; round < MAX_ROUNDS && placed() < n; round++) {
      checkSignal(signal);
      if (window.selectedItem?.type !== id) {
        if (window.selectedItem) await putBack();
        if (!window.selectedItem) {
          const src = firstInvSlot(id);
          if (src == null) break;
          await click(src, 0, 0);
        }
      }
      if (window.selectedItem?.type !== id) continue;
      const remaining = n - placed();
      const room = (window.selectedItem.stackSize ?? 64) - (window.slots[dest]?.count ?? 0);
      if (room <= 0) break;
      if (window.selectedItem.count <= Math.min(remaining, room)) {
        await click(dest, 0, 0);
      } else {
        for (let i = 0; i < Math.min(remaining, room); i++) {
          if (window.selectedItem?.type !== id) break;
          await click(dest, 1, 0);
        }
      }
    }
    await putBack();
    if (placed() < n) {
      throw codedError('container_desync', `Could not place ${n} items into furnace slot ${dest}`);
    }
  };
  const outputCountOf = item => (item?.itemId === outputId || item?.type === outputId ? (item.itemCount ?? item.count) : 0);
  let pktHits = 0;
  let waits = 0;
  let tkns = -1;
  let pktSeen = '';
  const pktProbe = pkt => {
    if (pkt?.windowId !== window?.id || pkt?.slot > 2) return;
    pktHits++;
    if (pkt.slot === 2) pktSeen += `|${pkt.item?.itemId}/${pkt.item?.itemCount}`;
  };
  // Track the output slot at PACKET level: container updates arrive on
  // set_slot/window_items, and on this server window.updateSlot is not
  // reliable for the furnace output slot.
  let lastOutputCount = 0;
  let onOutputPacket = null;
  const wireOutputPackets = () => {
    const bump = count => { onOutputPacket?.(count); };
    const onSet = pkt => { if (pkt.windowId === window.id && pkt.slot === OUTPUT_SLOT) bump(outputCountOf(pkt.item)); };
    const onItems = pkt => {
      if (pkt.windowId === window.id && Array.isArray(pkt.items) && pkt.items.length > OUTPUT_SLOT) {
        bump(outputCountOf(pkt.items[OUTPUT_SLOT]));
      }
    };
    bot._client?.on?.('set_slot', onSet);
    bot._client?.on?.('window_items', onItems);
    return () => { bot._client?.off?.('set_slot', onSet); bot._client?.off?.('window_items', onItems); };
  };
  const waitOutput = () => {
    waits++;
    if (window.slots[OUTPUT_SLOT]?.type === outputId) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const unwire = wireOutputPackets();
      const cleanup = () => {
        timers.clearTimeout(timer);
        timers.clearInterval(poll);
        unwire();
        window.off?.(`updateSlot:${OUTPUT_SLOT}`, onUpdate);
        bot.off(`setSlot:${window.id}`, onUpdate);
        signal.removeEventListener('abort', onAbort);
      };
      const timer = timers.setTimeout(() => {
        cleanup();
        const slotName = s => window.slots[s]?.name ?? 'empty';
        reject(codedError('smelt_stalled',
          `No smelting output for ${STALL_MS}ms (input=${slotName(INPUT_SLOT)} fuel=${slotName(FUEL_SLOT)} out=${slotName(OUTPUT_SLOT)} wid=${window.id} pkts=${pktHits} waits=${waits} taken=${tkns} oid=${outputId}${pktSeen.slice(0, 80)})`));
      }, STALL_MS);
      const onUpdate = () => {
        // produced+taken covers a theft that lands between wait calls.
        if (window.slots[OUTPUT_SLOT]?.type === outputId
          || produced + taken >= count) { cleanup(); resolve(); }
      };
      onOutputPacket = count => { if (count > 0) { cleanup(); resolve(); } };
      const poll = timers.setInterval(onUpdate, 100);
      const onAbort = () => { cleanup(); reject(signal.reason); };
      window.on?.(`updateSlot:${OUTPUT_SLOT}`, onUpdate);
      bot.on(`setSlot:${window.id}`, onUpdate);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  };
  // Whatever stays in the furnace belongs to the bot: pull input, fuel and any
  // leftover output back before closing so a cleanup failure never strands items.
  const cleanup = async () => {
    try {
      await putBack();
      for (const slot of [OUTPUT_SLOT, INPUT_SLOT, FUEL_SLOT]) {
        if (window?.slots[slot]) await cleanupClick(slot, 0, 1);
      }
      await putBack();
    } catch (error) {
      try { eventlog?.append('smelt.cleanup_failed', { message: error?.message ?? String(error) }); } catch {}
    }
  };
  const closeWindow = async () => {
    if (window && window !== bot.inventory) {
      const closing = window;
      window = undefined;
      try { await bot.closeWindow(closing); } catch {}
    }
  };
  let operating = false;
  let produced = 0;
  let taken = 0;
  try {
    await syncWindow(bot, window, signal, SYNC_TIMEOUT_MS, 'container_desync');
    const input = window.slots[INPUT_SLOT];
    const fuelSlot = window.slots[FUEL_SLOT];
    const output = window.slots[OUTPUT_SLOT];
    if ((input && input.type !== inputId) || (fuelSlot && fuelSlot.type !== fuelId)
      || (output && output.type !== outputId)) {
      throw codedError('furnace_busy', 'Furnace already holds different items');
    }
    // Only a furnace we actually touched gets emptied; a busy one keeps its contents.
    operating = true;
    if (output) await click(OUTPUT_SLOT, 0, 1);
    await moveExact(fuelId, neededFuel, FUEL_SLOT);
    await moveExact(inputId, count, INPUT_SLOT);
    const producedBase = inventoryCount(outputId);
    // The output slot is the only shared one: a drop in its count that our own
    // shift-click did not cause means someone else took the finished items.
    let lastOutputCount = 0;
    let invAtLast = inventoryCount(outputId);
    const onOutputUpdate = (direct) => {
      const current = typeof direct === 'number' ? direct
        : (window.slots[OUTPUT_SLOT]?.type === outputId ? window.slots[OUTPUT_SLOT].count : 0);
      const inv = inventoryCount(outputId);
      if (current < lastOutputCount) {
        // A slot drop she did not collect — whatever did not land in her
        // inventory was taken by someone else.
        const missing = lastOutputCount - current - Math.max(0, inv - invAtLast);
        if (missing > 0) {
          taken += missing;
          try { eventlog?.append('body.items_taken', { by: 'owner', where: 'furnace', item: outputName, count: missing }); } catch {}
        }
      }
      lastOutputCount = current;
      invAtLast = inv;
    };
    // Track every channel: packets (most reliable on the real server),
    // window updateSlot (unit-test fakes) and a slot poll as backstop.
    const tracker = timers.setInterval(onOutputUpdate, 100);
    const slotEvent = `setSlot:${window.id}`;
    const pktSet = pkt => { if (pkt.windowId === window.id && pkt.slot === OUTPUT_SLOT) onOutputUpdate(outputCountOf(pkt.item)); };
    const pktItems = pkt => {
      if (pkt.windowId === window.id && Array.isArray(pkt.items) && pkt.items.length > OUTPUT_SLOT) {
        onOutputUpdate(outputCountOf(pkt.items[OUTPUT_SLOT]));
      }
    };
    bot._client?.on?.('set_slot', pktSet);
    bot._client?.on?.('set_slot', pktProbe);
    bot._client?.on?.('window_items', pktItems);
    window.on?.(`updateSlot:${OUTPUT_SLOT}`, onOutputUpdate);
    bot.on(slotEvent, onOutputUpdate);
    try {
      while (produced + taken < count) {
        tkns = taken;
        await waitOutput();
        await click(OUTPUT_SLOT, 0, 1);
        const still = window.slots[OUTPUT_SLOT];
        lastOutputCount = still?.type === outputId ? still.count : 0;
        invAtLast = inventoryCount(outputId);
        produced = invAtLast - producedBase;
      }
    } finally {
      timers.clearInterval(tracker);
      bot._client?.off?.('set_slot', pktSet);
      bot._client?.off?.('window_items', pktItems);
      window.off?.(`updateSlot:${OUTPUT_SLOT}`, onOutputUpdate);
      bot.off(slotEvent, onOutputUpdate);
    }
    return { itemName, output: outputName, count: produced, taken, fuel,
      furnace: positionResult(furnace.position) };
  } finally {
    if (operating) await cleanup();
    await closeWindow();
  }
}
