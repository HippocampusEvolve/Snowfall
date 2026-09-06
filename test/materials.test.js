import test from 'node:test';
import assert from 'node:assert/strict';
import { bake, recipe } from 'world-core/materials';
import { bakeWorldMaterial } from '../src/bake-world-material.js';

function stats(baked) {
  const count = baked.size ** 2, mean = [0, 0, 0];
  let squares = 0, slope = 0, roughMin = 255;
  for (let i = 0; i < baked.albedo.length; i += 4) {
    for (let c = 0; c < 3; c++) mean[c] += baked.albedo[i + c] / count;
    squares += baked.albedo[i] ** 2 / count;
    slope += Math.hypot(baked.normal[i] - 127.5, baked.normal[i + 1] - 127.5) / count;
    roughMin = Math.min(roughMin, baked.rough[i]);
  }
  return { mean, deviation: Math.sqrt(squares - mean[0] ** 2), slope, roughMin };
}

const original = (name) => {
  const source = recipe(name);
  return bake(source.gen, source.size, source.normalStrength);
};

test('процедурный снег сохраняет измеренную яркость прежней поверхности', () => {
  const snow = bakeWorldMaterial('surfaceSnow');
  const linear = v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  const means = [0, 0, 0];
  for (let i = 0; i < snow.albedo.length; i += 4) {
    for (let c = 0; c < 3; c++) means[c] += linear(snow.albedo[i + c] / 255);
    assert.equal(snow.albedo[i + 3], 255);
  }
  const target = [0.381508, 0.379592, 0.390265];
  for (let c = 0; c < 3; c++) {
    means[c] /= snow.albedo.length / 4;
    assert.ok(Math.abs(means[c] - target[c]) < 0.002, `канал ${c}: ${means[c]}`);
  }
  assert.ok(new Set(snow.normal).size > 20, 'карта сохраняет рельеф');
  assert.deepEqual(bakeWorldMaterial('surfaceSnow'), snow, 'fallback и worker получают один результат');
});

test('природный камень и грунт не получают выпуклый рисунок бутовой кладки', () => {
  for (const name of ['rubble', 'rubbleWarm']) {
    const baked = bakeWorldMaterial(name), now = stats(baked), before = stats(original(name));
    assert.ok(now.slope < before.slope * 0.3, `${name}: поверхность не надута картой нормалей`);
    assert.ok(now.slope > 2, `${name}: мелкий рельеф остался`);
    assert.ok(now.deviation < before.deviation * 0.6, `${name}: нет контрастного нарисованного раствора`);
    assert.ok(now.deviation > 3, `${name}: поверхность не стала однотонной`);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(now.mean[c] - before.mean[c]) < 0.2,
      `${name}: сохранён тон камня, канал ${c}`);
    assert.ok(now.roughMin >= 229, `${name}: камень сухой`);
    assert.equal(baked.metal, null);
    assert.equal(baked.size, recipe(name === 'rubble' ? 'surfaceRock' : 'surfaceGravel').size);
    assert.deepEqual(bakeWorldMaterial(name), baked, 'основной поток и воркер выпекают одинаково');
  }
});

test('сухое дерево сохраняет тёплый тон и волокна при более спокойном контрасте', () => {
  for (const name of ['log', 'beam', 'floor']) {
    const baked = bakeWorldMaterial(name), now = stats(baked), before = stats(original(name));
    assert.ok(now.deviation < before.deviation * 0.8, `${name}: полосы приглушены`);
    assert.ok(now.deviation > before.deviation * 0.55, `${name}: волокно осталось`);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(now.mean[c] - before.mean[c]) < 0.15,
      `${name}: сохранена палитра дерева, канал ${c}`);
    assert.ok(now.roughMin >= 229, `${name}: нет мокрых полос`);
    assert.equal(baked.metal, null);
    assert.ok(now.slope > 10, `${name}: не уничтожены затёсы/рельеф`);
  }
});
