import test from 'node:test';
import assert from 'node:assert/strict';

import { createCaves, DEPTH_MIN, MATERIAL } from '../src/caves.js';
import { meshChunk, VN, VS, SW } from '../src/mesher.worker.js';
import { surfaceOpen, SURFACE_CAP } from '../src/cavebudget.js';
import { shovelAppliedStrength } from '../src/dig-rules.js';
import { WORLD_SEED } from '../src/seed.js';

// Приповерхностная полоса мира: вырез террейна и шапка неразрезанной колонки.
// Три замечания с прода про пещеры сходятся именно здесь, поэтому правила
// проверяются на настоящем поле пещер и настоящем marching cubes, без three.

const AVOID = [
  { x: -4.5, z: -13, r: 9 },
  { x: 2.5, z: -9, r: 6 },
  { x: 0, z: 0, r: 14 },
];

const caves = createCaves({ seed: WORLD_SEED, avoid: AVOID });

// Колонка с плоской поверхностью на высоте h: тот же формат, что у Digger.
function column(h = 0) {
  return new Float32Array(SW * SW).fill(h);
}

// Прежнее правило выреза: «пещера ближе двух метров от приповерхностной полосы»
// на редкой сетке 2 м. Оставлено в тесте как эталон того, от чего ушли.
function oldCut(cx, cz, h = 0) {
  const bandLo = h - 1, bandHi = h + 1;
  for (let i = 0; i <= VN; i += VN / 2) {
    const x = (cx * VN + i) * VS;
    for (let k = 0; k <= VN; k += VN / 2) {
      const z = (cz * VN + k) * VS;
      for (let y = bandLo; y <= bandHi + 1e-6; y += 2) {
        if (caves.sdf(x, y, z, h - y) < 2) return true;
      }
      if (caves.sdf(x, bandHi, z, h - bandHi) < 2) return true;
    }
  }
  return false;
}

// Есть ли под колонкой настоящая пустота не глубже depth метров.
function airWithin(cx, cz, depth, h = 0) {
  for (let i = 0; i <= VN; i += 1) {
    const x = (cx * VN + i) * VS;
    for (let k = 0; k <= VN; k += 1) {
      const z = (cz * VN + k) * VS;
      for (let d = 0; d <= depth + 1e-6; d += 0.25) {
        if (caves.sdf(x, h - d, z, d) < 0) return true;
      }
    }
  }
  return false;
}

test('вырез террейна назначается только там, где пустота выходит к поверхности', () => {
  let open = 0, old = 0, spurious = 0, total = 0;
  for (let cx = -12; cx <= 12; cx++) {
    for (let cz = -12; cz <= 12; cz++) {
      total++;
      const h = column(0);
      const now = surfaceOpen(caves, h, cx, cz);
      if (oldCut(cx, cz)) old++;
      if (!now) continue;
      open++;
      // Каждый вырез оправдан: пустота действительно рядом с поверхностью.
      // Запас правила - 0.75 м на полудиагональ сетки, отсюда и глубина сверки.
      if (!airWithin(cx, cz, SURFACE_CAP + 1.5)) spurious++;
    }
  }
  assert.equal(spurious, 0, `вырезов без пустоты у поверхности: ${spurious}`);
  assert.ok(open < old, `вырезов было ${old} из ${total}, стало ${open}`);
});

test('шапка = DEPTH_MIN: выше неё пустоты не бывает нигде, кроме ствола выхода', () => {
  assert.equal(SURFACE_CAP, DEPTH_MIN);
  let bad = 0;
  for (let cx = -10; cx <= 10; cx++) {
    for (let cz = -10; cz <= 10; cz++) {
      if (surfaceOpen(caves, column(0), cx, cz)) continue; // устье ствола
      if (airWithin(cx, cz, SURFACE_CAP - 0.05)) bad++;
    }
  }
  assert.equal(bad, 0, `колонок с пустотой под шапкой: ${bad}`);
});

// Найти колонку и чанк, где свод пещеры лежит в верхних четырёх метрах: это тот
// самый случай, в котором потолка не было видно.
// Поверхность стоит НЕ на границе чанков, иначе снежная кромка достаётся
// соседу сверху и сравнивать в чанке [-4, 0] нечего.
const H = -0.6;

function findShallowCeiling() {
  for (let cx = -40; cx <= 40; cx++) {
    for (let cz = -40; cz <= 40; cz++) {
      if (surfaceOpen(caves, column(H), cx, cz)) continue; // колонка режет террейн
      for (let i = 0; i <= VN; i += 2) {
        const x = (cx * VN + i) * VS;
        for (let k = 0; k <= VN; k += 2) {
          const z = (cz * VN + k) * VS;
          for (let d = SURFACE_CAP + 0.6; d <= 3.2; d += 0.1) {
            if (caves.sdf(x, H - d, z, d) < 0) return { cx, cz, top: d };
          }
        }
      }
    }
  }
  return null;
}

test('свод пещеры под самой поверхностью получает геометрию', () => {
  const spot = findShallowCeiling();
  assert.ok(spot, 'в мире не нашлось свода в верхних четырёх метрах');
  const { cx, cz } = spot;
  const cy = -1; // чанк [-4, 0] - тот, что задевает поверхность
  const job = { cx, cy, cz, colH: column(H), edits: null, editMaterials: null };
  const capTop = H - SURFACE_CAP; // ниже этой высоты живёт только свод

  const capped = meshChunk({ ...job, capDepth: SURFACE_CAP }, caves);
  assert.ok(capped, 'под шапкой свод не построился');

  // Ни одной вершины в шапке: второй снежной поверхности нет.
  let above = 0;
  for (let i = 1; i < capped.position.length; i += 3) {
    if (capped.position[i] > capTop + 1e-4) above++;
  }
  assert.equal(above, 0, `вершин выше шапки: ${above}`);

  // Без шапки тот же чанк построил бы вторую поверхность снега поверх террейна.
  const plain = meshChunk(job, caves);
  let plainAbove = 0;
  for (let i = 1; i < plain.position.length; i += 3) {
    if (plain.position[i] > capTop + 1e-4) plainAbove++;
  }
  assert.ok(plainAbove > 0, 'эталон без шапки не дал поверхности - тест не о том');
});

test('шапка не трогает поле глубже себя', () => {
  let plain = null, capped = null;
  for (let cx = -10; cx <= 10 && !plain; cx++) {
    for (let cz = -10; cz <= 10 && !plain; cz++) {
      const cy = -3; // чанк [-12, -8]: до шапки далеко
      const job = { cx, cy, cz, colH: column(0), edits: null, editMaterials: null };
      const a = meshChunk(job, caves);
      if (!a) continue;
      plain = { position: [...a.position], index: [...a.index] };
      const b = meshChunk({ ...job, capDepth: SURFACE_CAP }, caves);
      capped = b && { position: [...b.position], index: [...b.index] };
    }
  }
  assert.ok(plain && capped, 'чанк пуст - нечего сравнивать');
  assert.deepEqual(capped.position, plain.position);
  assert.deepEqual(capped.index, plain.index);
});

test('потолок хода твёрд: над головой поле положительное', () => {
  // Точка в ходе, свод над ней, и грунт от свода до самой поверхности.
  let checked = 0;
  for (let cx = -20; cx <= 20 && checked < 6; cx++) {
    for (let cz = -20; cz <= 20 && checked < 6; cz++) {
      const x = (cx * VN + VN / 2) * VS, z = (cz * VN + VN / 2) * VS;
      let floorD = null;
      for (let d = 4; d <= 20; d += 0.25) if (caves.sdf(x, -d, z, d) < 0) { floorD = d; break; }
      if (floorD === null) continue;
      let ceil = null;
      for (let d = floorD; d >= DEPTH_MIN; d -= 0.1) {
        if (caves.sdf(x, -d, z, d) >= 0) { ceil = d; break; }
      }
      if (ceil === null || ceil - floorD > -0.2) continue;
      checked++;
      // от свода и выше - только грунт, без вторых пустот
      for (let d = ceil; d >= 0; d -= 0.25) {
        assert.ok(
          caves.sdf(x, -d, z, d) >= 0,
          `пустота над сводом на глубине ${d.toFixed(2)} в (${x}, ${z})`
        );
      }
    }
  }
  assert.ok(checked > 0, 'не нашлось ни одного хода со сводом');
});

test('лопата берёт вниз весь снег и грунт, камень начинается ниже', () => {
  // Точка вдали от пещер: у стенки хода материал становится камнем по замыслу,
  // и правило «лопата не берёт камень» там законно.
  let spot = null;
  for (let x = -50; x <= 50 && !spot; x += 7) {
    for (let z = -50; z <= 50 && !spot; z += 7) {
      let clean = true;
      for (let d = 0; d <= 4.5; d += 0.25) if (caves.sdf(x, -d, z, d) < 3) clean = false;
      if (clean) spot = { x, z };
    }
  }
  assert.ok(spot, 'не нашлось колонки вдали от пещер');

  const seen = new Set();
  for (let d = 0.1; d <= 3.9; d += 0.1) {
    const m = caves.materialAt(spot.x, -d, spot.z, 0);
    seen.add(m);
    assert.ok(
      shovelAppliedStrength(m, -1) > 0,
      `лопата встала на глубине ${d.toFixed(1)} при материале ${m}`
    );
  }
  assert.deepEqual([...seen].sort(), [MATERIAL.SNOW, MATERIAL.SOIL]);
  // Глубже слоя грунта идёт камень - и лопата честно перестаёт брать.
  assert.equal(shovelAppliedStrength(caves.materialAt(spot.x, -5, spot.z, 0), -1), 0);
});
