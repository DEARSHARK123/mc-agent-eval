const MAX_ZONES = 32;
const MIN_RADIUS = 1;
const MAX_RADIUS = 24;

const valid = zone => zone && [zone.x, zone.y, zone.z, zone.radius].every(Number.isFinite)
  && zone.radius >= MIN_RADIUS && zone.radius <= MAX_RADIUS
  && typeof zone.reason === 'string' && zone.reason.length > 0;

export function createProtection({ eventlog } = {}) {
  const list = [];
  const listeners = [];
  try {
    for (const row of eventlog?.query({ kind: 'protection.zone_added', limit: Number.MAX_SAFE_INTEGER }) ?? []) {
      const zone = row.payload;
      if (valid(zone) && list.length < MAX_ZONES) {
        list.push({ x: zone.x, y: zone.y, z: zone.z, radius: zone.radius, reason: zone.reason });
      }
    }
  } catch {}

  function zones() {
    return list.map(zone => ({ ...zone }));
  }

  function add(zone, traceId) {
    if (!valid(zone) || list.length >= MAX_ZONES) return null;
    const stored = { x: zone.x, y: zone.y, z: zone.z, radius: zone.radius, reason: zone.reason };
    eventlog?.append('protection.zone_added', stored, traceId);
    list.push(stored);
    for (const fn of listeners) { try { fn(stored); } catch {} }
    return { ...stored };
  }

  // Pathfinding movements re-read the zones on each change.
  function onChange(fn) {
    listeners.push(fn);
    return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
  }

  function contains({ x, y, z } = {}) {
    if (![x, y, z].every(Number.isFinite)) return false;
    return list.some(zone =>
      (x - zone.x) ** 2 + (y - zone.y) ** 2 + (z - zone.z) ** 2 <= zone.radius ** 2);
  }

  // True when the inclusive axis-aligned box touches a zone; zones with a reason
  // in `allow` are ignored (a resumed build may sit inside its own_build zone).
  function intersects(box, { allow = [] } = {}) {
    const exempt = new Set(allow);
    return list.some(zone => {
      if (exempt.has(zone.reason)) return false;
      const dx = Math.max(box.from.x - zone.x, 0, zone.x - box.to.x);
      const dy = Math.max(box.from.y - zone.y, 0, zone.y - box.to.y);
      const dz = Math.max(box.from.z - zone.z, 0, zone.z - box.to.z);
      return dx * dx + dy * dy + dz * dz <= zone.radius ** 2;
    });
  }

  return { zones, add, contains, intersects, onChange };
}
