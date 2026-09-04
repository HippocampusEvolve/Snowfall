import test from 'node:test';
import assert from 'node:assert/strict';

import { createCaves, compose, DEPTH_MIN, Y_FLOOR, SHAFT_R } from '../src/caves.js';
import { WORLD_SEED } from '../src/seed.js';

// Поле пещер не зависит от рельефа ничем, кроме глубины под поверхностью, -
// значит в тестах вместо настоящей heightmap годится простая волна.
const base = (x, z) => 2 * Math.sin(x * 0.03) + 1.5 * Math.cos(z * 0.021);

const AVOID = [
  { x: -4.5, z: -13, r: 9 }, // изба
  { x: 2.5, z: -9, r: 6 }, // костёр
  { x: 0, z: 0, r: 14 }, // стартовая площадка
];

const caves = createCaves({ seed: WORLD_SEED, avoid: AVOID });
const at = (c, x, y, z) => c.sdf(x, y, z, base(x, z) - y);

test('одно семя даёт одно поле, другое - другое', () => {
  const a = createCaves({ seed: 12345, avoid: AVOID });
  const b = createCaves({ seed: 12345, avoid: AVOID });
  const other = createCaves({ seed: 999, avoid: AVOID });
  let same = 0, diff = 0;
  for (let i = 0; i < 2000; i++) {
    const x = (Math.random() * 2 - 1) * 120;
    const z = (Math.random() * 2 - 1) * 120;
    const y = base(x, z) - (Math.random() * 30 + 1);
    const va = at(a, x, y, z);
    assert.equal(va, at(b, x, y, z));
    same++;
    if (Math.abs(va - at(other, x, y, z)) > 1e-6) diff++;
  }
  assert.equal(same, 2000);
  assert.ok(diff > 1500, `с другим семенем совпало слишком много точек: разных ${diff} из 2000`);
});

test('под избой, костром и стартовой площадкой грунт цел', () => {
  for (const c of AVOID) {
    for (let dx = -c.r; dx <= c.r; dx += 0.5) {
      for (let dz = -c.r; dz <= c.r; dz += 0.5) {
        if (Math.hypot(dx, dz) > c.r) continue;
        const x = c.x + dx, z = c.z + dz, h = base(x, z);
        for (let y = h; y >= Y_FLOOR; y -= 0.5) {
          assert.ok(
            at(caves, x, y, z) >= 0,
            `пещера внутри запретного цилиндра ${c.x},${c.z}: ${x.toFixed(1)} ${y.toFixed(1)} ${z.toFixed(1)}`
          );
        }
      }
    }
  }
});

test('у поверхности и ниже дна пещер нет', () => {
  // вне шахт выходов свод нигде не ближе DEPTH_MIN к поверхности
  let checked = 0;
  for (let i = 0; i < 40000; i++) {
    const x = (Math.random() * 2 - 1) * 150;
    const z = (Math.random() * 2 - 1) * 150;
    const d = Math.random() * DEPTH_MIN;
    if (caves.shaftDist(x, z, d) < SHAFT_R + 0.5) continue; // это устье выхода
    checked++;
    const y = base(x, z) - d;
    assert.ok(caves.sdf(x, y, z, d) > 0, `пещера у самой поверхности на глубине ${d.toFixed(2)}`);
  }
  assert.ok(checked > 39000, `проверено лишь ${checked} точек у поверхности`);
  for (let i = 0; i < 20000; i++) {
    const x = (Math.random() * 2 - 1) * 150;
    const z = (Math.random() * 2 - 1) * 150;
    const y = Y_FLOOR - Math.random() * 20;
    assert.ok(at(caves, x, y, z) > 0, 'пещера ниже дна');
  }
});

test('доля объёма пещер укладывается в 6-12 %', () => {
  let inside = 0, total = 0;
  for (let x = -100; x < 100; x += 1) {
    for (let z = -100; z < 100; z += 1) {
      const h = base(x, z);
      for (let d = 2; d <= 25; d += 1) {
        total++;
        if (caves.sdf(x, h - d, z, d) < 0) inside++;
      }
    }
  }
  const frac = (100 * inside) / total;
  console.log(`      доля объёма пещер: ${frac.toFixed(2)} % (${inside} из ${total})`);
  assert.ok(frac >= 6 && frac <= 12, `доля объёма ${frac.toFixed(2)} % вне коридора 6-12 %`);
});

test('нижний квартиль высоты ходов не меньше 2.2 м', () => {
  const heights = [];
  // Вертикальные срезы сети через 2 м. Шаг 0.1 м даёт точность, с которой
  // различаются исходные 2.0 м и требуемые 2.2 м.
  for (let x = -100; x <= 100; x += 2) {
    for (let z = -100; z <= 100; z += 2) {
      const h = base(x, z);
      let start = null;
      for (let d = 2; d <= 25 + 1e-6; d += 0.1) {
        const inside = caves.sdf(x, h - d, z, d) < 0;
        if (inside && start === null) start = d;
        if (!inside && start !== null) {
          // Срез, открытый на верхней границе диапазона, не является полным
          // измерением хода и в статистику не входит.
          if (start > 2 + 1e-6) heights.push(d - start);
          start = null;
        }
      }
    }
  }
  heights.sort((a, b) => a - b);
  const quantile = (p) => heights[Math.floor((heights.length - 1) * p)];
  const q25 = quantile(0.25);
  const median = quantile(0.5);
  console.log(
    `      высота ходов: нижний квартиль ${q25.toFixed(2)} м, медиана ${median.toFixed(2)} м`
  );
  assert.ok(q25 >= 2.2 - 1e-6, `нижний квартиль высоты ${q25.toFixed(2)} м`);
  assert.ok(median >= 2.5 - 1e-6, `медиана высоты ${median.toFixed(2)} м`);
});

test('каждый выход открыт сверху и связан с полосой ходов', () => {
  assert.ok(caves.exits.length >= 3 && caves.exits.length <= 5, `выходов ${caves.exits.length}`);
  for (const e of caves.exits) {
    const r = Math.hypot(e.x, e.z);
    assert.ok(r >= 25 && r <= 60, `выход на расстоянии ${r.toFixed(1)} м`);
    // устье: у самой поверхности пусто
    const yTop = base(e.x, e.z) - 0.3;
    assert.ok(caves.sdf(e.x, yTop, e.z, 0.3) < 0, 'устье выхода закрыто');

    // заливка по сетке 0.5 м в кубе 30 м вокруг устья: от устья вниз есть путь
    // до полосы ходов (глубже DEPTH_MIN + 6 м)
    const G = 0.5, N = 60; // 30 м
    const ox = e.x - 15, oz = e.z - 15, oyTop = base(e.x, e.z);
    const idx = (i, j, k) => (k * N + j) * N + i;
    const seen = new Uint8Array(N * N * N);
    const empty = (i, j, k) => {
      const x = ox + i * G, z = oz + k * G, y = oyTop - 0.3 - j * G;
      return caves.sdf(x, y, z, base(x, z) - y) < 0;
    };
    const start = [Math.round(15 / G), 0, Math.round(15 / G)];
    const stack = [start];
    seen[idx(...start)] = 1;
    let deepest = 0;
    while (stack.length) {
      const [i, j, k] = stack.pop();
      if (j * G > deepest) deepest = j * G;
      for (const [di, dj, dk] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const ni = i + di, nj = j + dj, nk = k + dk;
        if (ni < 0 || nj < 0 || nk < 0 || ni >= N || nj >= N || nk >= N) continue;
        if (seen[idx(ni, nj, nk)]) continue;
        seen[idx(ni, nj, nk)] = 1;
        if (empty(ni, nj, nk)) stack.push([ni, nj, nk]);
      }
    }
    assert.ok(
      deepest >= DEPTH_MIN + 6,
      `от устья выхода (${e.x.toFixed(0)}, ${e.z.toFixed(0)}) заливка ушла лишь на ${deepest.toFixed(1)} м`
    );
  }
});

test('compose режет пещеру пересечением, а не сложением', () => {
  // на глубине 10 м рельефное слагаемое равно +10; зал с sdf -3 должен победить
  assert.equal(compose(0, -10, -3, 0), -3);
  // вне пещеры остаётся рельеф
  assert.equal(compose(0, -10, 40, 0), 10);
  // правка складывается поверх
  assert.equal(compose(0, -10, 40, -12), -2);
});
