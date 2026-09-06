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
  // Reused lab profiles include a closed volumetric flame and real wrap coils.
  assert.ok(torch <= 1400, `в факеле ${torch} треугольников`);
  assert.ok(hammer <= 1800, `в молоте ${hammer} треугольников`);
});
