import test from 'node:test';
import assert from 'node:assert/strict';

import { meshChunk, VN, VS, SW } from '../src/mesher.worker.js';
import { createCaves } from '../src/caves.js';
import { WORLD_SEED } from '../src/seed.js';

// «Пещера» для стендовых случаев: поле задаём руками, чтобы проверять мешинг,
// а не шум.
const flatCaves = { sdf: () => 1e3 }; // пещер нет: остаётся рельеф base - y
const sphereCaves = (cx, cy, cz, r) => ({
  // грунт снаружи сферы: sdf > 0 внутри шара пустоты... нам нужен ШАР ГРУНТА,
  // поэтому поле рельефа задерём вверх, а форму даст пещера как дополнение
  sdf: (x, y, z) => r - Math.hypot(x - cx, y - cy, z - cz),
});

const colFlat = (h) => {
  const a = new Float32Array(SW * SW);
  a.fill(h);
  return a;
};

test('плоское поле кладёт вершины ровно на свою высоту', () => {
  const h = 2.13;
  const m = meshChunk({ cx: 0, cy: 0, cz: 0, colH: colFlat(h), edits: null }, flatCaves);
  assert.ok(m, 'меша нет');
  assert.equal(m.material.length, m.position.length / 3);
  assert.ok([...m.material].every((v) => v >= 0 && v <= 3));
  let worst = 0;
  for (let i = 1; i < m.position.length; i += 3) worst = Math.max(worst, Math.abs(m.position[i] - h));
  assert.ok(worst < 1e-4, `вершина ушла от высоты на ${worst}`);
  // нормали плоскости смотрят вверх
  for (let i = 0; i < m.normal.length; i += 3) {
    assert.ok(m.normal[i + 1] > 0.999, `нормаль плоскости не вертикальна: ${m.normal[i + 1]}`);
  }
});

test('шар грунта даёт замкнутый меш с нормалями наружу', () => {
  // шар радиуса 1.6 в центре чанка: рельеф уводим высоко вверх (base - y всегда
  // велик), форму задаёт «пещера» = дополнение шара
  const cx = 2, cy = 2, cz = 2, r = 1.6;
  const caves = sphereCaves(cx, cy, cz, r);
  const m = meshChunk({ cx: 0, cy: 0, cz: 0, colH: colFlat(1e4), edits: null }, caves);
  assert.ok(m, 'меша нет');

  // каждое ребро ровно в двух треугольниках
  const edges = new Map();
  for (let t = 0; t < m.index.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = m.index[t + e], b = m.index[t + ((e + 1) % 3)];
      const k = a < b ? a * 1e7 + b : b * 1e7 + a;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  let bad = 0;
  for (const n of edges.values()) if (n !== 2) bad++;
  assert.equal(bad, 0, `рёбер не в двух треугольниках: ${bad} из ${edges.size}`);

  // нормали единичные и смотрят от центра шара
  let worstLen = 0, worstDot = 1;
  for (let i = 0; i < m.position.length; i += 3) {
    const nx = m.normal[i], ny = m.normal[i + 1], nz = m.normal[i + 2];
    worstLen = Math.max(worstLen, Math.abs(Math.hypot(nx, ny, nz) - 1));
    const dx = m.position[i] - cx, dy = m.position[i + 1] - cy, dz = m.position[i + 2] - cz;
    const l = Math.hypot(dx, dy, dz);
    worstDot = Math.min(worstDot, (nx * dx + ny * dy + nz * dz) / l);
  }
  assert.ok(worstLen < 1e-5, `нормаль не единичная: ${worstLen}`);
  assert.ok(worstDot > 0.97, `нормаль смотрит не наружу: худший косинус ${worstDot.toFixed(3)}`);
});

test('нормаль на кромке чанка совпадает с аналитической', () => {
  // рельеф-синусоида: аналитический градиент известен
  const H = (x, z) => 1.6 * Math.sin(x * 0.11) + 1.1 * Math.cos(z * 0.07);
  const Hx = (x) => 1.6 * 0.11 * Math.cos(x * 0.11);
  const Hz = (z) => -1.1 * 0.07 * Math.sin(z * 0.07);
  const col = (cx, cz) => {
    const a = new Float32Array(SW * SW);
    for (let k = -1; k <= VN + 1; k++) {
      for (let i = -1; i <= VN + 1; i++) {
        a[(k + 1) * SW + (i + 1)] = H((cx * VN + i) * VS, (cz * VN + k) * VS);
      }
    }
    return a;
  };
  const m = meshChunk({ cx: 3, cy: 0, cz: -2, colH: col(3, -2), edits: null }, flatCaves);
  assert.ok(m);
  let worstDeg = 0;
  for (let i = 0; i < m.position.length; i += 3) {
    const x = m.position[i], z = m.position[i + 2];
    // только вершины на кромке чанка: там сходятся воксельный меш и патч
    const lx = x / VS - 3 * VN, lz = z / VS + 2 * VN;
    const onEdge = lx < 1e-6 || lx > VN - 1e-6 || lz < 1e-6 || lz > VN - 1e-6;
    if (!onEdge) continue;
    // аналитическая нормаль поверхности H(x,z) - y
    let ax = -Hx(x), ay = 1, az = -Hz(z);
    const al = Math.hypot(ax, ay, az);
    ax /= al; ay /= al; az /= al;
    const dot = ax * m.normal[i] + ay * m.normal[i + 1] + az * m.normal[i + 2];
    worstDeg = Math.max(worstDeg, (Math.acos(Math.min(1, dot)) * 180) / Math.PI);
  }
  console.log(`      нормаль на кромке против аналитической: худший угол ${worstDeg.toFixed(3)}°`);
  assert.ok(worstDeg < 1, `нормаль на кромке разошлась на ${worstDeg.toFixed(3)}°`);
});

test('правка игрока попадает в меш', () => {
  const edits = [];
  // выгрызаем узел в середине плоскости
  const at = (i, j, k) => ((k + 1) * SW + (j + 1)) * SW + (i + 1);
  for (let j = 4; j <= 8; j++) edits.push([at(8, j, 8), -3]);
  const m = meshChunk({ cx: 0, cy: 0, cz: 0, colH: colFlat(2.13), edits }, flatCaves);
  assert.ok(m);
  let lowest = Infinity;
  for (let i = 1; i < m.position.length; i += 3) lowest = Math.min(lowest, m.position[i]);
  assert.ok(lowest < 1.2, `правка не углубила меш: низшая вершина ${lowest}`);
});

test('чанк с пещерой мешится не дольше 4 мс', () => {
  const caves = createCaves({ seed: WORLD_SEED, avoid: [] });
  const H = (x, z) => 2 * Math.sin(x * 0.03) + 1.5 * Math.cos(z * 0.021);
  const jobs = [];
  // 50 чанков на глубине 6-14 м вокруг начала координат, каждый с пещерой
  let n = 0;
  while (jobs.length < 50 && n < 400) {
    const cx = ((n * 7) % 21) - 10;
    const cz = (((n * 13) % 21) + ((n / 21) | 0)) % 21 - 10;
    n++;
    for (let cy = -4; cy <= -2 && jobs.length < 50; cy++) {
      const colH = new Float32Array(SW * SW);
      for (let k = -1; k <= VN + 1; k++) {
        for (let i = -1; i <= VN + 1; i++) {
          colH[(k + 1) * SW + (i + 1)] = H((cx * VN + i) * VS, (cz * VN + k) * VS);
        }
      }
      const job = { cx, cy, cz, colH, edits: null };
      if (meshChunk(job, caves)) jobs.push(job);
    }
  }
  assert.equal(jobs.length, 50, `чанков с пещерой набралось лишь ${jobs.length}`);
  meshChunk(jobs[0], caves); // прогрев JIT
  const times = [];
  let tris = 0;
  for (const job of jobs) {
    const t0 = performance.now();
    const m = meshChunk(job, caves);
    times.push(performance.now() - t0);
    tris += m.index.length / 3;
  }
  times.sort((a, b) => a - b);
  const med = times[25];
  console.log(
    `      мешинг чанка с пещерой: медиана ${med.toFixed(2)} мс, ` +
    `худший ${times[49].toFixed(2)} мс, треугольников на чанк ${Math.round(tris / 50)}`
  );
  assert.ok(med <= 4, `медиана мешинга ${med.toFixed(2)} мс при рамке 4 мс`);
});
