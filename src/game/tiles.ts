import { layoutConfig, pointInGoal, type LegacyRaceLayout, type MapConfig } from './modes';
import type { Point, PowerTile } from './state';

export function seededRandom(seed: number): () => number {
  let value = (seed >>> 0) || 0x6d2b79f5;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let n = value;
    n = Math.imul(n ^ n >>> 15, n | 1);
    n ^= n + Math.imul(n ^ n >>> 7, n | 61);
    return ((n ^ n >>> 14) >>> 0) / 4294967296;
  };
}

const pointKey = (point: Point) => `${point.row},${point.col}`;
export function generateTiles(seed: number, config: MapConfig, layoutId: LegacyRaceLayout = config.defaultLayout): PowerTile[] {
  const random = seededRandom(seed);
  const race = layoutConfig(config, layoutId);
  const [minimum, maximum] = config.rewardRange;
  const counts: number[] = [];
  for (let count = minimum + (minimum % 2); count <= maximum; count += 2) counts.push(count);
  const rewardCount = counts[Math.floor(random() * counts.length)] ?? 2;
  const spawns = [race.spawns.blue.point, race.spawns.red.point];
  const sharedEdge = race.goals.blue.kind === 'edge' && race.goals.red.kind === 'edge' && race.goals.blue.edge === race.goals.red.edge ? race.goals.blue.edge : null;
  const mirror = (point: Point): Point => {
    if (layoutId === 'parallel' && (sharedEdge === 'left' || sharedEdge === 'right')) return { row: config.height - 1 - point.row, col: point.col };
    if (layoutId === 'parallel') return { row: point.row, col: config.width - 1 - point.col };
    return { row: config.height - 1 - point.row, col: config.width - 1 - point.col };
  };
  const pairs: [Point, Point][] = [];
  const used = new Set<string>();
  for (let row = 0; row < config.height; row++) for (let col = 0; col < config.width; col++) {
    const a = { row, col }; const b = mirror(a);
    if (pointKey(a) === pointKey(b) || used.has(pointKey(a)) || used.has(pointKey(b))) continue;
    if (pointInGoal(a, race.goals.blue, config) || pointInGoal(a, race.goals.red, config) ||
        pointInGoal(b, race.goals.blue, config) || pointInGoal(b, race.goals.red, config)) continue;
    const nearSpawn = spawns.some(spawn => Math.abs(a.row - spawn.row) + Math.abs(a.col - spawn.col) <= 2 ||
      Math.abs(b.row - spawn.row) + Math.abs(b.col - spawn.col) <= 2);
    if (nearSpawn) continue;
    used.add(pointKey(a)); used.add(pointKey(b)); pairs.push([a, b]);
  }
  for (let i = pairs.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pairs[i], pairs[j]] = [pairs[j], pairs[i]]; }
  const boostChance = config.rewardWeights.boost / (config.rewardWeights.energy + config.rewardWeights.boost);
  return pairs.slice(0, rewardCount / 2).flatMap(pair => {
    const kind: PowerTile['kind'] = random() < boostChance ? 'boost' : 'energy';
    return pair.map(point => ({ kind, point, consumed: false }));
  });
}
