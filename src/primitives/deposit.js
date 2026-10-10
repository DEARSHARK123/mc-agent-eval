import { checkSignal, codedError, goals, itemName, navigate, positionResult, step, syncWindow } from './helpers.js';

export const name = 'deposit';
export const description = 'Deposit up to count of an item into the nearest chest or barrel.';
export const params = {
  itemName,
  count: { type: 'number', integer: true, min: 1, max: 2304 },
};
export const defaultTimeoutMs = 30_000;

// Only ordinary loot containers count as a stash; shulker boxes, ender chests, hoppers
// and other inventories must never swallow items.
const CONTAINERS = ['chest', 'trapped_chest', 'barrel'];
const SEARCH_RANGE = 16;
const SYNC_TIMEOUT_MS = 1000;
const MAX_ROUNDS = 3;

export async function run({ bot, mcData }, { itemName, count }, signal) {
  const type = mcData.itemsByName[itemName].id;
  const owned = bot.inventory.items().filter(item => item.type === type)
    .reduce((total, item) => total + item.count, 0);
  const want = count ?? owned;
  if (owned < want) {
    throw codedError('not_enough_items', `Only ${owned} ${itemName} in inventory (wanted ${want})`, { owned });
  }
  const ids = new Set(CONTAINERS.map(blockName => mcData.blocksByName[blockName]?.id));
  const container = bot.findBlock({ matching: block => ids.has(block?.type), maxDistance: SEARCH_RANGE });
  if (!container) throw codedError('no_container', `No chest or barrel within ${SEARCH_RANGE} blocks`);
  await navigate(bot, new goals.GoalNear(container.position.x, container.position.y, container.position.z, 2), signal);
  await step(signal, () => bot.lookAt(container.position.offset(0.5, 0.5, 0.5)));
  let window;
  // Like craft's openBlock: abort must still close a window that opens after the signal fired.
  window = await step(signal, () => {
    const opening = bot.openContainer(container);
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
  // [0, inventoryStart) is the container region, [inventoryStart, inventoryEnd) the player's.
  const firstInvSlot = id => {
    for (let s = window.inventoryStart; s < window.inventoryEnd; s++) {
      if (window.slots[s]?.type === id) return s;
    }
    return null;
  };
  const containerCount = id => {
    let total = 0;
    for (let s = 0; s < window.inventoryStart; s++) {
      if (window.slots[s]?.type === id) total += window.slots[s].count;
    }
    return total;
  };
  const containerSpace = id => {
    for (let s = 0; s < window.inventoryStart; s++) {
      const slot = window.slots[s];
      if (slot == null || (slot.type === id && stackRoom(slot) > 0)) return true;
    }
    return false;
  };
  const containerDest = id => {
    let empty = null;
    for (let s = 0; s < window.inventoryStart; s++) {
      const slot = window.slots[s];
      if (slot?.type === id && stackRoom(slot) > 0) return s;
      if (empty === null && slot == null) empty = s;
    }
    return empty;
  };
  // putBack also runs after an abort while closing, where checkSignal would throw and
  // strand the held item; the server drops a cursor item on close, so these clicks
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
  const closeWindow = async () => {
    if (window && window !== bot.inventory) {
      const closing = window;
      try { await putBack(); } catch {}
      window = undefined;
      try { await bot.closeWindow(closing); } catch {}
    }
  };
  let full = false;
  try {
    await syncWindow(bot, window, signal, SYNC_TIMEOUT_MS, 'container_desync');
    const containerBefore = containerCount(type);
    const moved = () => containerCount(type) - containerBefore;
    for (let round = 0; round < MAX_ROUNDS && moved() < want && !full; round++) {
      while (moved() < want && !full) {
        checkSignal(signal);
        const src = firstInvSlot(type);
        if (src == null) break;
        const stack = window.slots[src];
        const remaining = want - moved();
        if (stack.count <= remaining) {
          const before = containerCount(type);
          await click(src, 0, 1);
          const delta = containerCount(type) - before;
          // A silent or partial shift means the click was ignored (desync) or the
          // container filled; only space left on the container distinguishes them.
          if (delta < stack.count) {
            if (!containerSpace(type)) full = true;
            break;
          }
        } else {
          await click(src, 0, 0);
          for (let i = 0; i < remaining; i++) {
            if (window.selectedItem?.type !== type) break;
            const dest = containerDest(type);
            if (dest == null) { full = true; break; }
            await click(dest, 1, 0);
          }
          await putBack();
        }
      }
    }
    if (moved() < want) {
      const extra = { moved: moved() };
      if (full) throw codedError('container_full', `Container has no room for ${want - moved()} more ${itemName}`, extra);
      throw codedError('container_desync', `Could not confirm deposit of ${itemName} (${moved()}/${want})`, extra);
    }
    return { itemName, moved: moved(), container: positionResult(container.position) };
  } finally {
    await closeWindow();
  }
}
