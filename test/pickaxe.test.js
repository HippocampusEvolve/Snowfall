import test from 'node:test';
import assert from 'node:assert/strict';

import { countPickaxeTriangles } from '../src/pickaxe-geometry.js';

test('лабораторная кирка с объёмной обмоткой укладывается в 1800 треугольников', () => {
  const triangles = countPickaxeTriangles();
  console.log(`      кирка: ${triangles} треугольников`);
  assert.ok(triangles <= 1800, `в модели кирки ${triangles} треугольников`);
});
