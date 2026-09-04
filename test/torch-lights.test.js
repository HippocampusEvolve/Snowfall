import test from 'node:test';
import assert from 'node:assert/strict';

import { selectLitTorches } from '../src/torch-lights.js';

test('бюджет выбирает не больше N ближайших факелов', () => {
  const torches = [
    { id: 'far', x: 8, y: 0, z: 0 },
    { id: 'near', x: 1, y: 0, z: 0 },
    { id: 'mid', x: 3, y: 0, z: 0 },
    { id: 'same', x: -3, y: 0, z: 0 },
  ];
  assert.deepEqual(
    selectLitTorches(torches, { x: 0, y: 0, z: 0 }, 2).map((t) => t.id),
    ['near', 'mid']
  );
  assert.equal(selectLitTorches(torches, { x: 0, y: 0, z: 0 }, 0).length, 0);
  assert.equal(selectLitTorches(torches, { x: 0, y: 0, z: 0 }, 99).length, torches.length);
});
