import { mulberry32 } from './seed.js';

// Чистая часть раскладки леса и камней. three здесь нет, поэтому позиции и
// проверку потолка можно воспроизвести в Node без загрузки моделей.

export const FOREST_SEED = 20260706;
export const MIN_PLANT_ROOF = 3;

const density = (x, z) =>
  0.52
  + 0.3 * Math.sin(x * 0.043 + 1.7) * Math.cos(z * 0.037 - 0.8)
  + 0.24 * Math.sin((x - z) * 0.021 + 0.5);

/**
 * Поток раскладки. Методы вызываются в порядке trees.js, чтобы рассев и позы
 * брали ровно те же числа ГПСЧ, что и до отделения чистого модуля.
 */
export function createPlantScatter({ seed = FOREST_SEED, avoid = [] } = {}) {
  const rand = mulberry32(seed);
  const placed = [];

  const scatter = (n, rMin, rMax, minGap2, dens = null) => {
    const out = [];
    let guard = 0;
    while (out.length < n && guard++ < n * 40) {
      const a = rand() * Math.PI * 2;
      const r = rMin + Math.pow(rand(), 0.7) * (rMax - rMin);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (dens && rand() >= dens(x, z)) continue;
      if (avoid.some((av) => (av.x - x) ** 2 + (av.z - z) ** 2 < av.r * av.r)) continue;
      if (placed.some((p) => (p[0] - x) ** 2 + (p[1] - z) ** 2 < minGap2)) continue;
      placed.push([x, z]);
      out.push([x, z]);
    }
    return out;
  };

  return {
    treeSpots: (count) => scatter(count, 13, 140, 12, density),
    treePose(hMin, hMax) {
      return {
        height: hMin + rand() * (hMax - hMin),
        width: 0.9 + rand() * 0.2,
        yaw: rand() * Math.PI * 2,
      };
    },
    rockSpots: (count) => scatter(count, 10, 130, 6),
    rockPose() {
      return {
        size: 0.5 + rand() * 1.5,
        yaw: rand() * Math.PI * 2,
        scaleX: 0.9 + rand() * 0.2,
        scaleZ: 0.9 + rand() * 0.2,
      };
    },
  };
}

/** Есть ли пустота в первых трёх метрах под точкой поверхности. */
export function hasThinCaveRoof(caves, x, z, surfaceY) {
  // Шаг мельче вокселя: касательный край хода бывает уже 0.25 м и не должен
  // проскочить между двумя сэмплами. Проверка идёт один раз при сборке леса.
  const step = 0.05;
  for (let depth = 0; depth <= MIN_PLANT_ROOF + 1e-6; depth += step) {
    if (caves.sdf(x, surfaceY - depth, z, depth) < 0) return true;
  }
  return false;
}

/** Скрыть объекты над тонким потолком, не меняя их места и номера. */
export function cullThinCaveRoofs(items, caves, heightAt, hide) {
  if (!caves) return 0;
  let count = 0;
  for (const item of items) {
    if (item.culled || !hasThinCaveRoof(caves, item.x, item.z, heightAt(item.x, item.z))) continue;
    hide(item);
    count++;
  }
  return count;
}
