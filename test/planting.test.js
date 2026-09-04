import test from 'node:test';
import assert from 'node:assert/strict';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';

import { createCaves } from '../src/caves.js';
import { createPlantScatter, cullThinCaveRoofs, MIN_PLANT_ROOF } from '../src/planting.js';
import { WORLD_SEED } from '../src/seed.js';

const CABIN_AVOID = [{ x: -4.5, z: -13, r: 7.5 }];
const CAVE_AVOID = [
  { x: -4.5, z: -13, r: 9 },
  { x: 2.5, z: -9, r: 6 },
  { x: 0, z: 0, r: 14 },
];

const noise = new ImprovedNoise();
const smoothstep = (x, lo, hi) => {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};
// Формула Terrain.getHeight без создания WebGL-текстур и DOM.
const heightAt = (x, z) => {
  let h = 0;
  h += noise.noise(x * 0.012, z * 0.012, 0) * 3.4;
  h += noise.noise(x * 0.04 + 7.3, z * 0.04 + 3.1, 0.5) * 0.9;
  h += noise.noise(x * 0.14 + 13.7, z * 0.14 + 9.4, 1) * 0.2;
  return h * (0.2 + 0.8 * smoothstep(Math.hypot(x, z), 5, 22));
};

function defaultSpots() {
  const layout = createPlantScatter({ avoid: CABIN_AVOID });
  const trees = layout.treeSpots(200);
  // При сборке моделей каждая сосна берёт рост, ширину и поворот до рассева
  // камней. Здесь позы не нужны, но поток ГПСЧ должен пройти те же места.
  for (let i = 0; i < trees.length; i++) layout.treePose(0, 1);
  const rocks = layout.rockSpots(45);
  return { trees, rocks };
}

function caveInRoof(caves, x, z) {
  const h = heightAt(x, z);
  for (let depth = 0; depth <= MIN_PLANT_ROOF + 1e-6; depth += 0.05) {
    if (caves.sdf(x, h - depth, z, depth) < 0) return true;
  }
  return false;
}

test('деревья и камни не стоят над потолком тоньше 3 м', () => {
  const first = defaultSpots();
  const second = defaultSpots();
  assert.deepEqual(second, first, 'раскладка от одного семени изменилась');

  const items = [
    ...first.trees.map(([x, z]) => ({ kind: 'tree', x, z })),
    ...first.rocks.map(([x, z]) => ({ kind: 'rock', x, z })),
  ];
  const caves = createCaves({ seed: WORLD_SEED, avoid: CAVE_AVOID });
  const culled = cullThinCaveRoofs(items, caves, heightAt, (item) => { item.culled = true; });
  assert.ok(culled > 0, 'проверка потолка не отбросила ни одного кандидата');

  const planted = items.filter((item) => !item.culled);
  for (const item of planted) {
    assert.equal(
      caveInRoof(caves, item.x, item.z),
      false,
      `${item.kind} стоит над тонким потолком: ${item.x.toFixed(2)}, ${item.z.toFixed(2)}`
    );
  }
  console.log(
    `      посадки: оставлено ${planted.length}, отбраковано над пещерами ${culled}`
  );
});
