import { blueprintGeometry } from './blueprints.js';

export const PLANT_NAMES = ['short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dandelion', 'poppy',
  'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'dead_bush', 'snow'];

const AIR = ['air', 'cave_air'];
const DIRECTIONS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const LAYOUT = { x: 5, y: 3, z: 5 };

export const plantSet = mcData => new Set(PLANT_NAMES.filter(name => !mcData || Object.hasOwn(mcData.blocksByName, name)));

export function findSite({ blueprint, origin, blockAt, owner = null, radius = 12, plants = new Set(PLANT_NAMES), remembered = null, protection = null }) {
  const size = blueprint.size ?? LAYOUT;
  const isPlanks = name => typeof name === 'string' && name.endsWith('_planks');
  const clear = (x, y, z, resume) => {
    const name = blockAt(x, y, z)?.name;
    if (name === undefined) return false;
    return AIR.includes(name) || plants.has(name) || (resume && (name === blueprint.marker || isPlanks(name)));
  };
  const solid = (x, y, z) => {
    const block = blockAt(x, y, z);
    return block?.boundingBox === 'block' && block.name !== blueprint.marker;
  };
  const volumeOk = (x0, y0, z0, resume) => {
    for (let dy = 0; dy < size.y; dy++) for (let dx = 0; dx < size.x; dx++) for (let dz = 0; dz < size.z; dz++) {
      if (!clear(x0 + dx, y0 + dy, z0 + dz, resume)) return false;
    }
    for (let dx = 0; dx < size.x; dx++) for (let dz = 0; dz < size.z; dz++) if (!solid(x0 + dx, y0 - 1, z0 + dz)) return false;
    if (owner) {
      const [ox, oy, oz] = [Math.floor(owner.x), Math.floor(owner.y), Math.floor(owner.z)];
      for (const cy of [oy, oy + 1]) {
        if (ox >= x0 && ox < x0 + size.x && cy >= y0 && cy < y0 + size.y && oz >= z0 && oz < z0 + size.z) return false;
      }
    }
    return Math.abs(x0 - origin.x) <= 32 && Math.abs(x0 + size.x - 1 - origin.x) <= 32
      && Math.abs(z0 - origin.z) <= 32 && Math.abs(z0 + size.z - 1 - origin.z) <= 32
      && Math.abs(y0 - origin.y) <= 32 && Math.abs(y0 + size.y - 1 - origin.y) <= 32
      && !(protection?.intersects({ from: { x: x0, y: y0, z: z0 },
        to: { x: x0 + size.x - 1, y: y0 + size.y - 1, z: z0 + size.z - 1 } },
        { allow: resume ? ['own_build'] : [] }));
  };
  const frontOk = (corner, rotation) => {
    const { frontCell } = blueprintGeometry(blueprint, { origin: corner, rotation });
    return clear(frontCell.x, frontCell.y, frontCell.z, false) && clear(frontCell.x, frontCell.y + 1, frontCell.z, false)
      && solid(frontCell.x, frontCell.y - 1, frontCell.z);
  };
  const base = { x: Math.floor(origin.x), y: Math.floor(origin.y), z: Math.floor(origin.z) };
  if (remembered && volumeOk(remembered.origin.x, remembered.origin.y, remembered.origin.z, true)
      && frontOk(remembered.origin, remembered.rotation)) {
    return { ok: true, origin: { ...remembered.origin }, rotation: remembered.rotation, resumed: true };
  }
  const rotationsFor = (x0, z0) => {
    if (!owner) return [0, 1, 2, 3];
    const toward = { x: owner.x - (x0 + 2.5), z: owner.z - (z0 + 2.5) };
    return [0, 1, 2, 3].sort((a, b) => DIRECTIONS[b][0] * toward.x + DIRECTIONS[b][1] * toward.z
      - (DIRECTIONS[a][0] * toward.x + DIRECTIONS[a][1] * toward.z) || a - b);
  };
  const corners = [];
  for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) corners.push({ dx, dz });
  const centerDistance = ({ dx, dz }) => Math.hypot(dx + 2, dz + 2);
  corners.sort((a, b) => centerDistance(a) - centerDistance(b) || a.dz - b.dz || a.dx - b.dx);
  for (const { dx, dz } of corners) {
    for (const dy of [0, -1, 1, -2, 2]) {
      const corner = { x: base.x + dx, y: base.y + dy, z: base.z + dz };
      if (!volumeOk(corner.x, corner.y, corner.z, false)) continue;
      for (const rotation of rotationsFor(corner.x, corner.z)) {
        if (frontOk(corner, rotation)) return { ok: true, origin: corner, rotation, resumed: false };
      }
    }
  }
  return { ok: false, reason: 'no_site' };
}
