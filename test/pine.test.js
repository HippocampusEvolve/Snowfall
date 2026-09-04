import test from 'node:test';
import assert from 'node:assert/strict';

import { LOD_TRI_BUDGET, VARIANTS, buildPine, kindOf } from '../src/pine.js';
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

test('рост ровно 1 при масштабе 1, основание в нуле', () => {
  for (const lod of [0, 1, 2]) {
    for (const name of VARIANTS) {
      const b = bbox(buildPine(31 + lod, lod, name));
      assert.ok(Math.abs(b[1]) < 1e-6, `${name} LOD${lod}: низ ${b[1]}`);
      assert.ok(Math.abs(b[4] - 1) < 1e-6, `${name} LOD${lod}: верх ${b[4]}`);
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
