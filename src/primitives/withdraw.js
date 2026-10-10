import { checkSignal, codedError, goals, itemName, navigate, positionResult, step, syncWindow } from './helpers.js';

export const name = 'withdraw';
export const description = 'Take count of an item out of the nearest chest or barrel.';
export const params = {
  itemName,
  count: { type: 'number', integer: true, min: 1, max: 2304, default: 1 },
};
export const defaultTimeoutMs = 30_000;

const CONTAINERS = ['chest', 'trapped_chest', 'barrel'];
const SEARCH_RANGE = 16;
const SYNC_TIMEOUT_MS = 1000;
const MAX_ROUNDS = 3;

export async function run({ bot, mcData }, { itemName, count }, signal) {
  const type = mcData.itemsByName[itemName].id;
  const ids = new Set(CONTAINERS.map(blockName => mcData.blocksByName[blockName]?.id));
  const container = bot.findBlock({ matching: block => ids.has(block?.type), maxDistance: SEARCH_RANGE });
  if (!container) throw codedError('no_container', `No chest or barrel within ${SEARCH_RANGE} blocks`);
  await navigate(bot, new goals.GoalNear(container.position.x, container.position.y, container.position.z, 2), signal);
  await step(signal, () => bot.lookAt(container.position.offset(0.5, 0.5, 0.5)));
  let window;
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
  const regionCount = (id, start, end) => {
    let total = 0;
    for (let s = start; s < end; s++) if (window.slots[s]?.type === id) total += window.slots[s].count;
    return total;
  };
  const containerCount = id => regionCount(id, 0, window.inventoryStart);
  const inventoryCount = id => regionCount(id, window.inventoryStart, window.inventoryEnd);
  const firstContainerSlot = id => {
    for (let s = 0; s < window.inventoryStart; s++) {
      if (window.slots[s]?.type === id) return s;
    }
    return null;
  };
  const inventorySpace = id => {
    for (let s = window.inventoryStart; s < window.inventoryEnd; s++) {
      const slot = window.slots[s];
      if (slot == null || (slot.type === id && stackRoom(slot) > 0)) return true;
    }
    return false;
  };
  const inventoryDest = id => {
    let empty = null;
    for (let s = window.inventoryStart; s < window.inventoryEnd; s++) {
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
  // Leftover cursor items belong back inside the container, not the inventory.
  const putBack = async () => {
    for (let tries = 0; window?.selectedItem && tries < 40; tries++) {
      const held = window.selectedItem;
      let target = null;
      let empty = null;
      for (let s = 0; s < window.inventoryStart; s++) {
        const slot = window.slots[s];
        if (slot?.type === held.type && stackRoom(slot) > 0) { target = s; break; }
        if (empty === null && slot == null) empty = s;
      }
      const dest = target ?? empty;
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
  try {
    await syncWindow(bot, window, signal, SYNC_TIMEOUT_MS, 'container_desync');
    if (containerCount(type) < count) {
      throw codedError('not_enough_in_container',
        `Container holds only ${containerCount(type)} ${itemName} (wanted ${count})`, { moved: 0 });
    }
    const inventoryBefore = inventoryCount(type);
    const moved = () => inventoryCount(type) - inventoryBefore;
    let full = false;
    for (let round = 0; round < MAX_ROUNDS && moved() < count && !full; round++) {
      while (moved() < count && !full) {
        checkSignal(signal);
        const src = firstContainerSlot(type);
        if (src == null) break;
        const stack = window.slots[src];
        const remaining = count - moved();
        if (stack.count <= remaining) {
          const before = inventoryCount(type);
          await click(src, 0, 1);
          const delta = inventoryCount(type) - before;
          if (delta < stack.count) {
            if (!inventorySpace(type)) full = true;
            break;
          }
        } else {
          await click(src, 0, 0);
          for (let i = 0; i < remaining; i++) {
            if (window.selectedItem?.type !== type) break;
            const dest = inventoryDest(type);
            if (dest == null) { full = true; break; }
            await click(dest, 1, 0);
          }
          await putBack();
        }
      }
    }
    if (moved() < count) {
      const extra = { moved: moved() };
      if (full) throw codedError('inventory_full', `Inventory has no room for ${count - moved()} more ${itemName}`, extra);
      throw codedError('container_desync', `Could not confirm withdrawal of ${itemName} (${moved()}/${count})`, extra);
    }
    return { itemName, moved: moved(), container: positionResult(container.position) };
  } finally {
    await closeWindow();
  }
}
