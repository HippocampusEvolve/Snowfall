import test from 'node:test';
import assert from 'node:assert/strict';

import { MATERIAL } from '../src/caves.js';
import { DIG_RULES, shovelAppliedStrength, pickaxeAppliedStrength } from '../src/dig-rules.js';

test('лопата не правит камень и руду', () => {
  assert.equal(shovelAppliedStrength(MATERIAL.STONE, -1), 0);
  assert.equal(shovelAppliedStrength(MATERIAL.ORE, -1), 0);
  assert.equal(shovelAppliedStrength(MATERIAL.SOIL, -1), DIG_RULES.SHOVEL_STRENGTH);
});

test('кирка правит камень с третью силы лопаты', () => {
  assert.equal(
    pickaxeAppliedStrength(MATERIAL.STONE),
    DIG_RULES.SHOVEL_STRENGTH / 3
  );
});
