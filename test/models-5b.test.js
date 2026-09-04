import test from 'node:test';
import assert from 'node:assert/strict';

import { countWorkbenchTriangles } from '../src/workbench-geometry.js';
import { countTorchTriangles } from '../src/torch-geometry.js';
import { countHammerTriangles } from '../src/hammer-geometry.js';

test('модели этапа 5б укладываются в лимиты треугольников', () => {
  const workbench = countWorkbenchTriangles();
  const torch = countTorchTriangles();
  const hammer = countHammerTriangles();
  console.log(`      верстак: ${workbench}, факел: ${torch}, молот: ${hammer} треугольников`);
  assert.ok(workbench <= 600, `в верстаке ${workbench} треугольников`);
  assert.ok(torch <= 200, `в факеле ${torch} треугольников`);
  assert.ok(hammer <= 300, `в молоте ${hammer} треугольников`);
});
