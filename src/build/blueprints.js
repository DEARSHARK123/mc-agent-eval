const deepFreeze = value => {
  if (value && typeof value === 'object') for (const inner of Object.values(value)) deepFreeze(inner);
  return Object.freeze(value);
};

export const BLUEPRINTS = deepFreeze({
  hut: {
    key: 'hut',
    aliases: ['小屋', '房子', '小房子', '屋子', '木屋', '小木屋'],
    displayName: '小屋',
    size: { x: 5, y: 3, z: 5 },
    material: 'planks',
    marker: 'light_blue_stained_glass',
  },
});

export function findBlueprint(text) {
  const name = typeof text === 'string' ? text.trim() : '';
  return Object.values(BLUEPRINTS).find(item => item.displayName === name || item.key === name || item.aliases.includes(name)) ?? null;
}

const SEGMENT_ORDER = ['wall:fl', 'wall:left', 'wall:back', 'wall:right', 'wall:fr',
  'roof:0', 'roof:1', 'roof:2', 'roof:3', 'roof:4'];

function localCells() {
  const cells = [];
  const add = (x, y, z, role, seg, i) => cells.push({ x, y, z, role, seg, i });
  for (let y = 0; y < 2; y++) {
    [[0, 1], [3, 4]].forEach(([from, to], index) => {
      for (let x = from; x <= to; x++) add(x, y, 0, 'wall', index === 0 ? 'wall:fl' : 'wall:fr', x);
    });
    add(2, y, 0, 'door', 'door', 0);
    for (let z = 1; z <= 3; z++) { add(0, y, z, 'wall', 'wall:left', z); add(4, y, z, 'wall', 'wall:right', z); }
    for (let x = 0; x <= 4; x++) add(x, y, 4, 'wall', 'wall:back', x);
  }
  for (let z = 0; z <= 4; z++) for (let x = 0; x <= 4; x++) add(x, 2, z, 'roof', `roof:${z}`, x);
  return cells;
}

const rotate = (x, z, turns) => {
  for (let n = 0; n < turns; n++) [x, z] = [4 - z, x];
  return [x, z];
};

export function blueprintGeometry(blueprint, { origin, rotation = 0 }) {
  if (!blueprint || !Number.isInteger(rotation) || rotation < 0 || rotation > 3) throw new RangeError('invalid blueprint geometry');
  const place = (x, y, z) => {
    const [rx, rz] = rotate(x, z, rotation);
    return { x: origin.x + rx, y: origin.y + y, z: origin.z + rz };
  };
  return {
    cells: localCells().map(cell => ({ ...place(cell.x, cell.y, cell.z), role: cell.role, seg: cell.seg, i: cell.i })),
    frontCell: place(2, 0, -1),
    center: place(2, 0, 2),
  };
}

export const blueprintCells = (blueprint, placement) => blueprintGeometry(blueprint, placement).cells;

export function buildOrder(cells) {
  return cells.filter(cell => cell.role !== 'door')
    .sort((a, b) => a.y - b.y || SEGMENT_ORDER.indexOf(a.seg) - SEGMENT_ORDER.indexOf(b.seg) || a.i - b.i);
}

const boxOf = group => ({
  from: { x: Math.min(...group.map(c => c.x)), y: Math.min(...group.map(c => c.y)), z: Math.min(...group.map(c => c.z)) },
  to: { x: Math.max(...group.map(c => c.x)), y: Math.max(...group.map(c => c.y)), z: Math.max(...group.map(c => c.z)) },
});

export function buildSegments(cells) {
  const segments = new Map();
  for (const cell of buildOrder(cells)) {
    const key = `${cell.y}:${cell.seg}`;
    if (!segments.has(key)) segments.set(key, { key, cells: [] });
    segments.get(key).cells.push(cell);
  }
  return [...segments.values()].map(segment => ({ ...segment, box: boxOf(segment.cells) }));
}

export function frameBoxes(cells) {
  const groups = new Map();
  for (const cell of cells.filter(item => item.role !== 'door')) {
    const key = cell.role === 'roof' ? 'roof' : cell.seg;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cell);
  }
  return [...groups.values()].map(boxOf);
}

export const volumeBox = cells => boxOf(cells);
