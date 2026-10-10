import { checkSignal, codedError, itemName, point, step, syncWindow } from './helpers.js';

export const name = 'craft';
export const description = 'Craft at least count output items, optionally using a nearby table.';
export const params = {
  itemName,
  count: { type: 'number', integer: true, min: 1, default: 1 },
  useTable: { type: 'boolean', default: false },
  // `at` binds the table position for useTable crafts; without it the nearest
  // table within 4 blocks is used, as before.
  x: { type: 'number', integer: true },
  y: { type: 'number', integer: true },
  z: { type: 'number', integer: true },
};
// skills/approach.js walks her within reach-1.5 of a bound target before run.
export const reach = 4;
export const defaultTimeoutMs = 15_000;
// The server applies the previous craft's clicks asynchronously. Crafting again before the inventory settles
// made the client and server disagree about the 2x2 grid (a table craft produced a button on a real server).
const SETTLE_MS = 250;
const MAX_ATTEMPTS = 3;
const RESULT_WAIT_MS = 1500;
const SYNC_TIMEOUT_MS = 1000;
const MAX_TARGET_TRIES = 3;
function settle(signal) {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, SETTLE_MS);
    function onAbort() { clearTimeout(timer); reject(signal.reason); }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
export async function run({ bot, mcData }, { itemName, count, useTable, x, y, z }, signal) {
  let table = null;
  if (useTable) {
    if (x !== undefined) {
      // A bound table position: the executor already walked her into reach;
      // the block there must actually be a crafting table.
      const bound = bot.blockAt(point({ x, y, z }));
      if (bound?.name !== 'crafting_table') {
        throw codedError('no_table', 'No crafting table at the bound position');
      }
      table = bound;
    } else {
      // findBlock bounds by distance to the floored position; checking the
      // unfloored position would reject tables findBlock just found.
      table = bot.findBlock({ matching: mcData.blocksByName.crafting_table.id, maxDistance: 4 });
      const origin = bot.entity.position.floored?.() ?? bot.entity.position;
      if (!table || origin.distanceTo(table.position) > 4) {
        throw codedError('no_table', 'No crafting table within 4 blocks');
      }
    }
  }
  await settle(signal);
  const outId = mcData.itemsByName[itemName].id;
  let window;
  // bot.inventory stays stale while a container window is open (it is only re-synced on close);
  // while our table window is open, its inventory region is the authoritative view.
  const owned = () => {
    if (window && window !== bot.inventory) {
      let total = 0;
      for (let s = window.inventoryStart; s < window.inventoryEnd; s++) {
        if (window.slots[s]?.type === outId) total += window.slots[s].count;
      }
      return total;
    }
    return bot.inventory.items().filter(item => item.type === outId).reduce((total, item) => total + item.count, 0);
  };
  const recipe = bot.recipesFor(outId, null, count, table)[0];
  if (!recipe) {
    const mats = new Set();
    for (const r of mcData.recipes[outId] ?? []) {
      for (const id of [...(r.inShape ?? []).flat(), ...(r.ingredients ?? [])]) {
        if (id !== null && id !== undefined && id !== -1) mats.add(id);
      }
    }
    const countOf = id => bot.inventory.items().filter(i => i.type === id).reduce((n, i) => n + i.count, 0);
    const have = [...mats].map(id => `${mcData.items[id]?.name ?? id}=${countOf(id)}`).join(' ');
    throw codedError('missing_ingredients',
      `No available recipe for ${itemName} (missing ingredients or crafting table; table=${Boolean(table)} ${have})`);
  }
  const repetitions = Math.ceil(count / recipe.result.count);
  const w = table ? 3 : 2;
  const gridSize = w * w;
  // Slot mapping mirrors mineflayer's craft.js: grid slot = 1 + x + w*y; shapeless leftovers fill from the last slot.
  const gridTargets = r => {
    const used = new Set();
    const targets = [];
    if (r.inShape) {
      for (let y = 0; y < r.inShape.length; y++) for (let x = 0; x < r.inShape[y].length; x++) {
        const ingredient = r.inShape[y][x];
        if (ingredient && ingredient.id !== -1) {
          const slot = 1 + x + w * y;
          used.add(slot);
          targets.push({ slot, id: ingredient.id });
        }
      }
    }
    const free = [];
    for (let s = 1; s <= gridSize; s++) if (!used.has(s)) free.push(s);
    for (const ingredient of r.ingredients ?? []) {
      const slot = free.pop();
      if (slot !== undefined) targets.push({ slot, id: ingredient.id ?? ingredient });
    }
    return targets;
  };
  const before = owned();
  let attempts = 0;
  let prev = before;
  const closeWindow = async () => {
    if (window && window !== bot.inventory) {
      const closing = window;
      try { await putBack(); } catch {}
      window = undefined;
      try { await bot.closeWindow(closing); } catch {}
    }
  };
  // Clicks race server resyncs on 1.17+; see helpers.syncWindow for the double-sync rationale.
  const click = async (slot, button, mode) => {
    checkSignal(signal);
    await bot.clickWindow(slot, button, mode);
    await syncWindow(bot, window, signal, SYNC_TIMEOUT_MS, 'craft_desync');
  };
  const findSource = id => {
    for (let s = window.inventoryStart; s < window.inventoryEnd; s++) {
      if (window.slots[s]?.type === id) return s;
    }
    return null;
  };
  // Return whatever the cursor is holding to the inventory; an item left on the cursor when the
  // window closes is dropped into the world by the server (the earlier cobblestone loss). This
  // also runs after an abort while closing, where checkSignal would strand the held item, so it
  // clicks without the signal check and tolerates a rejected sync.
  const putBack = async () => {
    const held = window?.selectedItem;
    if (!held) return;
    const target = findSource(held.type) ?? window.firstEmptyInventorySlot?.();
    if (target == null) return;
    await bot.clickWindow(target, 0, 0);
    try { await syncWindow(bot, window, signal, SYNC_TIMEOUT_MS, 'craft_desync'); } catch {}
  };
  const placeIngredients = async r => {
    const targets = gridTargets(r);
    for (const { slot, id } of targets) {
      for (let tries = 0; tries < MAX_TARGET_TRIES && window.slots[slot]?.type !== id; tries++) {
        checkSignal(signal);
        if (window.selectedItem?.type !== id) {
          if (window.selectedItem) await putBack();
          if (!window.selectedItem) {
            const src = findSource(id);
            if (src === null) throw codedError('missing_ingredients', 'missing ingredient');
            await click(src, 0, 0);
          }
        }
        // The pickup's own sync may have swapped the cursor; only ever place the right item.
        if (window.selectedItem?.type === id) await click(slot, 1, 0);
      }
    }
    await putBack();
    const wanted = new Map(targets.map(t => [t.slot, t.id]));
    for (let s = 1; s <= gridSize; s++) {
      if ((window.slots[s]?.type ?? null) !== (wanted.get(s) ?? null)) {
        throw codedError('craft_desync', 'Crafting grid does not match the recipe (server rejected a placement)');
      }
    }
  };
  const waitResult = r => {
    const ready = () => window.slots[0]?.type === r.result.id;
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); window.off?.('updateSlot:0', onUpdate); signal.removeEventListener('abort', onAbort); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('craft result timed out')); }, RESULT_WAIT_MS);
      const onUpdate = () => { if (ready()) { cleanup(); resolve(); } };
      const onAbort = () => { cleanup(); reject(signal.reason ?? new Error('cancelled')); };
      window.on('updateSlot:0', onUpdate);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  };
  const clearGrid = async () => {
    for (let s = 1; s <= gridSize; s++) {
      try { if (window?.slots[s]) await click(s, 0, 1); } catch {}
    }
    try { await putBack(); } catch {}
  };
  try {
    // Single crafts bound how much work can continue after cancellation.
    for (let i = 0; i < repetitions; i++) {
      checkSignal(signal);
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const current = bot.recipesFor(outId, null, 1, table)[0];
        if (!current) throw codedError('missing_ingredients', `No available recipe for ${itemName} (missing ingredients or crafting table)`);
        attempts++;
        if (useTable && !window) {
          window = await step(signal, () => {
            const opening = bot.openBlock(table);
            // step() rejects on abort while openBlock can still resolve; close that late window then.
            opening.then(opened => {
              if (signal.aborted && window !== opened) { try { bot.closeWindow(opened); } catch {} }
            }, () => {});
            return opening;
          }, () => {
            if (bot.currentWindow && bot.currentWindow !== bot.inventory) bot.closeWindow(bot.currentWindow);
          });
        } else if (!useTable) window = bot.inventory;
        // bot.craft writes the result into slot 0 locally and clicks it right away; the server may still
        // see a partial grid and reject the grab, so we click through ourselves and only grab after the
        // server's result slot shows the item.
        try {
          await placeIngredients(current);
          await waitResult(current);
          checkSignal(signal);
          await click(0, 0, 1);
          await settle(signal);
          if (owned() > prev) { prev = owned(); break; }
        } catch (error) {
          await clearGrid();
          if (signal.aborted) throw signal.reason ?? error;
          if (attempt === MAX_ATTEMPTS - 1) throw codedError('craft_rejected', `Craft of ${itemName} produced nothing (server rejected the craft)`);
          await settle(signal);
          continue;
        }
        // The grab was not rejected but the output never arrived: restore the grid and retry.
        await clearGrid();
        await settle(signal);
        if (attempt === MAX_ATTEMPTS - 1) throw codedError('craft_rejected', `Craft of ${itemName} produced nothing (server rejected the craft)`);
      }
    }
    return { itemName, count: owned() - before, attempts };
  } finally {
    await closeWindow();
  }
}
