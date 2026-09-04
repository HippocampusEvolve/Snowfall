import test from 'node:test';
import assert from 'node:assert/strict';

import { countPickaxeTriangles } from '../src/pickaxe-geometry.js';

test('модель кирки не тяжелее 400 треугольников', () => {
  const triangles = countPickaxeTriangles();
  console.log(`      кирка: ${triangles} треугольников`);
  assert.ok(triangles <= 400, `в модели кирки ${triangles} треугольников`);
});
