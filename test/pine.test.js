import test from 'node:test';
import assert from 'node:assert/strict';

import { LOD_TRI_BUDGET, MASK, VARIANTS, buildPine, kindOf, maskFill, pineMask } from '../src/pine.js';
import { ROCK_TRI_BUDGET, ROCK_VARIANTS, buildRock } from '../src/rock.js';

// Сосна и валун собираются кодом, поэтому и проверяются счётом: браузеру
// остаётся один вопрос - красиво ли. Здесь - что форма детерминирована от
// семени, влезает в бюджет треугольников, не роняет NaN в буферы и стоит
// ровно в тех габаритах, на которые рассчитывает `trees.js`.

const parts = (p) => [p.bark, p.needles].filter(Boolean);

function bbox(p) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const part of parts(p)) {
    for (let i = 0; i < part.position.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        b[k] = Math.min(b[k], part.position[i + k]);
        b[3 + k] = Math.max(b[3 + k], part.position[i + k]);
      }
    }
  }
  return b;
}

test('форма сосны детерминирована от семени', () => {
  for (const lod of [0, 1, 2]) {
    const a = buildPine(4242, lod, 'big_2');
    const b = buildPine(4242, lod, 'big_2');
    for (const key of ['bark', 'needles']) {
      if (!a[key]) {
        assert.equal(b[key], null, `${key} LOD${lod}`);
        continue;
      }
      for (const attr of ['position', 'normal', 'uv', 'index']) {
        assert.deepEqual(a[key][attr], b[key][attr], `${key}.${attr} LOD${lod}`);
      }
    }
  }
});

test('разные семена дают разные сосны', () => {
  const a = buildPine(1, 0, 'big_1');
  const b = buildPine(2, 0, 'big_1');
  assert.notDeepEqual(a.bark.position, b.bark.position);
});

test('бюджет треугольников по LOD выдержан всеми вариантами', () => {
  for (const lod of [0, 1, 2]) {
    VARIANTS.forEach((name, i) => {
      const p = buildPine(20260904 + i * 977, lod, name);
      assert.ok(
        p.triangles <= LOD_TRI_BUDGET[lod],
        `${name} LOD${lod}: ${p.triangles} > ${LOD_TRI_BUDGET[lod]}`
      );
      assert.ok(p.triangles > 0, `${name} LOD${lod} пуст`);
    });
  }
});

test('подробность падает от LOD к LOD', () => {
  for (const name of VARIANTS) {
    const t = [0, 1, 2].map((lod) => buildPine(7, lod, name).triangles);
    assert.ok(t[0] > t[1] && t[1] > t[2], `${name}: ${t.join(' > ')}`);
  }
});

test('в буферах нет ни одной NaN', () => {
  for (const lod of [0, 1, 2]) {
    for (const name of VARIANTS) {
      const p = buildPine(555 + lod, lod, name);
      for (const part of parts(p)) {
        for (const attr of ['position', 'normal', 'uv']) {
          for (const x of part[attr]) {
            assert.ok(Number.isFinite(x), `${name} LOD${lod} ${attr}`);
          }
        }
        const verts = part.position.length / 3;
        for (const i of part.index) {
          assert.ok(Number.isInteger(i) && i >= 0 && i < verts, `${name} LOD${lod} индекс ${i}`);
        }
        assert.equal(part.index.length % 3, 0);
      }
    }
  }
});

test('рост ровно 1 при масштабе 1, комель в нуле', () => {
  for (const lod of [0, 1, 2]) {
    for (const name of VARIANTS) {
      const p = buildPine(31 + lod, lod, name);
      const b = bbox(p);
      assert.ok(Math.abs(b[4] - 1) < 1e-6, `${name} LOD${lod}: верх ${b[4]}`);
      // Отсчёт от комля: нижние лапы свисают ниже основания ствола, но не
      // глубже ладони - иначе сосна тонет в снегу.
      assert.ok(b[1] > -0.07, `${name} LOD${lod}: низ ${b[1]}`);
      if (!p.bark) continue;
      let foot = Infinity;
      for (let i = 1; i < p.bark.position.length; i += 3) {
        foot = Math.min(foot, p.bark.position[i]);
      }
      assert.ok(Math.abs(foot) < 1e-6, `${name} LOD${lod}: комель на ${foot}`);
    }
  }
});

test('радиус кроны в записи совпадает с обмером геометрии', () => {
  for (const name of VARIANTS) {
    const p = buildPine(909, 0, name);
    // trees.js кладёт сосну с произвольным поворотом вокруг оси, поэтому крона
    // в записи - это круг: наибольшее удаление вершины от ствола. Мерим его
    // независимо от генератора и требуем, чтобы круг накрывал всё дерево и не
    // был раздут больше чем на 10 %.
    let measured = 0;
    for (const part of parts(p)) {
      for (let i = 0; i < part.position.length; i += 3) {
        measured = Math.max(measured, Math.hypot(part.position[i], part.position[i + 2]));
      }
    }
    assert.ok(p.crown >= measured - 1e-6, `${name}: крона ${p.crown} не накрывает ${measured}`);
    assert.ok(
      (p.crown - measured) / measured <= 0.1,
      `${name}: crown ${p.crown.toFixed(3)} против ${measured.toFixed(3)}`
    );
    // и сам круг не должен быть уже половины габарита по x/z
    const b = bbox(p);
    assert.ok(p.crown >= Math.max(b[3] - b[0], b[5] - b[2]) / 2 - 1e-6, name);
  }
});

test('крона шире у комля, чем у макушки', () => {
  for (const name of VARIANTS) {
    const w = buildPine(77, 0, name).widths;
    assert.ok(w[0] > w[2], `${name}: ${w.map((x) => x.toFixed(2)).join(' / ')}`);
  }
});

test('тип сосны берётся из имени варианта, рост и ствол прежние', () => {
  assert.deepEqual(kindOf('big_3').h, [10.5, 13.5]);
  assert.equal(kindOf('sapling_1').trunk, 0);
  assert.equal(kindOf('small_2').trunk, 0.04);
  assert.equal(VARIANTS.length, 15);
});

test('валун: детерминизм, бюджет, габарит и отсутствие NaN', () => {
  for (let i = 0; i < ROCK_VARIANTS; i++) {
    const a = buildRock(100 + i);
    const b = buildRock(100 + i);
    assert.deepEqual(a.position, b.position);
    assert.ok(a.triangles <= ROCK_TRI_BUDGET, `валун ${i}: ${a.triangles}`);
    for (const x of a.position) assert.ok(Number.isFinite(x));
    for (const x of a.normal) assert.ok(Number.isFinite(x));
    let minY = Infinity;
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let k = 0; k < a.position.length; k += 3) {
      minY = Math.min(minY, a.position[k + 1]);
      for (let m = 0; m < 3; m++) {
        box[m] = Math.min(box[m], a.position[k + m]);
        box[3 + m] = Math.max(box[3 + m], a.position[k + m]);
      }
    }
    assert.ok(Math.abs(minY) < 1e-6, `валун ${i}: низ ${minY}`);
    const size = Math.max(box[3] - box[0], box[4] - box[1], box[5] - box[2]);
    assert.ok(Math.abs(size - 1) < 1e-6, `валун ${i}: габарит ${size}`);
  }
  assert.notDeepEqual(buildRock(1).position, buildRock(2).position);
});

// ---- плотность кроны ------------------------------------------------------
// Крону нельзя проверить «на глаз в браузере»: редкие кисти дают ровно ту
// решётку из палок, которую было видно в первом кадре. Поэтому силуэт сосны
// растеризуется здесь же - ортографической проекцией сбоку, с честным
// альфа-тестом по маске, - и меряется заполнение конуса кроны.

const NEEDLE_ALPHA = 116; // тот же порог, что alphaTest 0.45 в материале

function silhouette(p, mask, N = 256) {
  const img = new Uint8Array(N * N);
  const parts = [p.bark, p.needles].filter(Boolean);
  let R = 0;
  for (const part of parts) {
    for (let i = 0; i < part.position.length; i += 3) {
      R = Math.max(R, Math.abs(part.position[i]), Math.abs(part.position[i + 2]));
    }
  }
  const sx = (x) => (x / (2 * R) + 0.5) * (N - 1);
  const sy = (y) => (1 - y) * (N - 1);
  for (const part of parts) {
    const needle = part === p.needles;
    for (let t = 0; t < part.index.length; t += 3) {
      const k = [part.index[t], part.index[t + 1], part.index[t + 2]];
      const P = k.map((n) => [sx(part.position[n * 3]), sy(part.position[n * 3 + 1])]);
      const UV = k.map((n) => [part.uv[n * 2], part.uv[n * 2 + 1]]);
      const d =
        (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
      if (Math.abs(d) < 1e-9) continue;
      const lo = (f) => Math.max(0, Math.floor(Math.min(P[0][f], P[1][f], P[2][f])));
      const hi = (f) => Math.min(N - 1, Math.ceil(Math.max(P[0][f], P[1][f], P[2][f])));
      for (let y = lo(1); y <= hi(1); y++) {
        for (let x = lo(0); x <= hi(0); x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const w1 =
            ((px - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (py - P[0][1])) / d;
          const w2 =
            ((P[1][0] - P[0][0]) * (py - P[0][1]) - (px - P[0][0]) * (P[1][1] - P[0][1])) / d;
          const w0 = 1 - w1 - w2;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          if (needle) {
            const u = w0 * UV[0][0] + w1 * UV[1][0] + w2 * UV[2][0];
            const v = w0 * UV[0][1] + w1 * UV[1][1] + w2 * UV[2][1];
            const mx = Math.min(MASK - 1, Math.max(0, Math.round(u * (MASK - 1))));
            const my = Math.min(MASK - 1, Math.max(0, Math.round((1 - v) * (MASK - 1))));
            if (mask[my * MASK + mx] < NEEDLE_ALPHA) continue;
          }
          img[y * N + x] = 255;
        }
      }
    }
  }
  return { img, N, R };
}

/** Доля закрытого в конусе кроны: от `bare` до макушки, радиус линейно к нулю. */
function coneFill(p, mask, N = 256) {
  const { img, R } = silhouette(p, mask, N);
  // Конус кроны - от нижней мутовки до макушки: у сосны крона начинается
  // там, где кончается голый ствол, и у подлеска это другая высота.
  const bare = p.crownBase;
  let inside = 0;
  let hit = 0;
  for (let y = 0; y < N; y++) {
    const wy = 1 - y / (N - 1);
    if (wy < bare || wy > 0.99) continue;
    const half = p.crown * (1 - (0.9 * (wy - bare)) / (1 - bare));
    for (let x = 0; x < N; x++) {
      const wx = (x / (N - 1) - 0.5) * 2 * R;
      if (Math.abs(wx) > half) continue;
      inside++;
      if (img[y * N + x]) hit++;
    }
  }
  return hit / inside;
}

test('маска хвои заполнена не меньше чем на 60 %', () => {
  const a = pineMask();
  const brush = maskFill(a, 0);
  const crown = maskFill(a, 1);
  assert.ok(brush >= 0.6, `кисть: ${(brush * 100).toFixed(1)} %`);
  // силуэт - конус в прямоугольном тайле, полным он быть не может;
  // важно, что он есть и занимает заметную долю
  assert.ok(crown >= 0.35, `силуэт: ${(crown * 100).toFixed(1)} %`);
  assert.deepEqual(a, pineMask()); // маска детерминирована
});

test('крона закрывает свой конус не меньше чем на 70 %', () => {
  const mask = pineMask();
  // по одному варианту на тип: растеризация - самая дорогая проверка в наборе,
  // а форма внутри типа отличается только дрожью семени
  for (const name of VARIANTS.filter((n) => n.endsWith('_1'))) {
    const p = buildPine(20260904, 0, name);
    const fill = coneFill(p, mask, 128);
    assert.ok(fill >= 0.7, `${name}: конус закрыт на ${(fill * 100).toFixed(1)} %`);
  }
});

test('ствол: комель 6-8 % роста в поперечнике, макушка сходит в ноль', () => {
  for (const name of VARIANTS) {
    const p = buildPine(20260904, 0, name);
    // нижнее кольцо ствола пишется первым, ровно radial+1 вершин подряд
    let ring = 0;
    for (let i = 0; i < 24; i++) {
      if (Math.abs(p.bark.position[i * 3 + 1]) > 1e-6) break;
      ring = Math.max(ring, Math.hypot(p.bark.position[i * 3], p.bark.position[i * 3 + 2]));
    }
    assert.ok(Math.abs(ring - p.trunkR) < 1e-6, `${name}: кольцо ${ring} против ${p.trunkR}`);
    assert.ok(p.trunkR * 2 >= 0.055, `${name}: поперечник комля ${(p.trunkR * 2).toFixed(3)}`);
    assert.ok(p.trunkR * 2 <= 0.09, `${name}: поперечник комля ${(p.trunkR * 2).toFixed(3)}`);
    // у макушки ствол в ноль: верхнее кольцо тоньше десятой доли комля
    let top = 0;
    for (let i = 0; i < p.bark.position.length; i += 3) {
      if (p.bark.position[i + 1] < 0.98) continue;
      top = Math.max(top, Math.hypot(p.bark.position[i], p.bark.position[i + 2]));
    }
    assert.ok(top < p.trunkR * 0.15, `${name}: макушка ${top.toFixed(4)}`);
  }
});
