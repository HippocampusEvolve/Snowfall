import test from 'node:test';
import assert from 'node:assert/strict';

import { Journal, KIND } from '../src/journal.js';
import { Inventory } from '../src/inventory.js';
import { ITEMS } from '../src/data/items.js';

test('инвентарь восстанавливается из ITEM в порядке журнала', () => {
  const journal = new Journal(1_700_000_000);
  journal.item(2, 5, 1);
  journal.item(2, -2, 2);
  journal.item(1, 4, 3);
  journal.fuel(4);

  const inventory = new Inventory(journal).restore(journal.records());
  assert.equal(inventory.count('stone'), 3);
  assert.equal(inventory.count('soil'), 4);
  assert.equal(inventory.count('snow'), 0);
});

test('add и take пишут только фактическое изменение', () => {
  const journal = new Journal(1_700_000_000);
  const inventory = new Inventory(journal);
  const stone = ITEMS.find((item) => item.id === 'stone');

  assert.equal(inventory.add('stone', stone.stack + 5), stone.stack);
  assert.equal(inventory.add('stone', 1), 0);
  assert.equal(inventory.take('stone', stone.stack + 1), 0);
  assert.equal(inventory.take('stone', 2), 2);
  assert.equal(inventory.count('stone'), stone.stack - 2);
  assert.deepEqual(
    [...journal.records()].map((record) => [record.kind, record.id, record.delta]),
    [[KIND.ITEM, 2, stone.stack], [KIND.ITEM, 2, -2]]
  );
});

test('старый журнал без ITEM даёт пустой инвентарь', () => {
  const journal = new Journal(1_700_000_000);
  journal.dig(0, 0, 0, 0, -1, 2.4, 1);
  journal.pile(3, 2);
  const inventory = new Inventory(journal).restore(journal.records());
  assert.equal(inventory.total(), 0);
});
