import test from 'node:test';
import assert from 'node:assert/strict';

import { Journal } from '../src/journal.js';
import { Inventory } from '../src/inventory.js';
import { MATERIAL } from '../src/caves.js';
import {
  HAMMER_BLOCK, hammerBlockCenter, placeHammerBlock,
} from '../src/hammer-block.js';

class FakeDigger {
  blockStroke(center, material) {
    this.center = { ...center };
    this.material = material;
  }

  materialAt(x, y, z) {
    const c = this.center;
    if (!c) return null;
    const inside = Math.abs(x - c.x) <= HAMMER_BLOCK.half.x
      && Math.abs(y - c.y) <= HAMMER_BLOCK.half.y
      && Math.abs(z - c.z) <= HAMMER_BLOCK.half.z;
    return inside ? this.material : null;
  }
}

test('блок прилипает к земле и выравнивается по сетке 0.5 м', () => {
  const center = hammerBlockCenter({
    point: { x: 1.24, y: 2.02, z: -3.26 },
    normal: { x: 0, y: 1, z: 0 },
  });
  assert.deepEqual(center, { x: 1, y: 2.25, z: -3.5 });
});

test('молот кладёт камень во всём боксе и списывает один block', () => {
  const inventory = new Inventory(new Journal());
  const digger = new FakeDigger();
  inventory.add('block', 1);
  const center = placeHammerBlock(inventory, digger, {
    point: { x: 1.1, y: 2, z: -3.1 }, normal: { x: 0, y: 1, z: 0 },
  });

  assert.deepEqual([HAMMER_BLOCK.half.x * 2, HAMMER_BLOCK.half.y * 2, HAMMER_BLOCK.half.z * 2], [1, 0.5, 1]);
  assert.equal(digger.materialAt(center.x, center.y, center.z), MATERIAL.STONE);
  assert.equal(digger.materialAt(center.x + 0.49, center.y + 0.24, center.z - 0.49), MATERIAL.STONE);
  assert.equal(inventory.count('block'), 0);
});

test('на avoid блок не ставится и не списывается', () => {
  const inventory = new Inventory(new Journal());
  const digger = new FakeDigger();
  inventory.add('block', 1);
  const placed = placeHammerBlock(
    inventory,
    digger,
    { point: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 1, z: 0 } },
    [{ x: 0, z: 0, r: 2 }]
  );
  assert.equal(placed, null);
  assert.equal(inventory.count('block'), 1);
  assert.equal(digger.center, undefined);
});
