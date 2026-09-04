import test from 'node:test';
import assert from 'node:assert/strict';

import { Journal, KIND, REC } from '../src/journal.js';
import { ITEM_INDEX } from '../src/data/items.js';
import { placedItemsFrom } from '../src/placements.js';

test('PLACE занимает 16 байт и читает поставленный и снятый факел', () => {
  const journal = new Journal(1_700_000_000);
  journal.place(ITEM_INDEX.torch, 1.234, -4.565, 7.891, 11);
  journal.place(ITEM_INDEX.torch, 1.234, -4.565, 7.891, 12, true);
  const put = journal.at(0);
  const take = journal.at(1);

  assert.deepEqual(
    [
      put.kind, put.id,
      Math.round(put.x * 50), Math.round(put.y * 50), Math.round(put.z * 50),
      put.take, journal.bytes,
    ],
    [KIND.PLACE, ITEM_INDEX.torch, 62, -228, 395, false, REC * 2]
  );
  assert.deepEqual([take.kind, take.id, take.take], [KIND.PLACE, ITEM_INDEX.torch, true]);
});

test('старый журнал без PLACE читается без изменений', () => {
  const old = new Journal(1_700_000_000);
  old.fuel(3);
  old.item(2, 4, 4);
  const restored = new Journal(1_700_000_000);
  restored.adopt(0, old.snapshot());

  assert.deepEqual([...restored.records()], [...old.records()]);
  assert.deepEqual(placedItemsFrom(restored.records(), 'torch'), []);
});

test('свёртка факелов детерминирована и учитывает снятие', () => {
  const journal = new Journal();
  journal.place(ITEM_INDEX.torch, 2, 1, 2, 1);
  journal.place(ITEM_INDEX.torch, -3, 0, 4, 2);
  journal.place(ITEM_INDEX.torch, 2, 1, 2, 3, true);
  journal.place(ITEM_INDEX.torch, 2, 1, 2, 4);

  const first = placedItemsFrom(journal.records(), 'torch');
  const second = placedItemsFrom(journal.records(), 'torch');
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((r) => [r.seq, r.x, r.y, r.z]), [
    [2, -3, 0, 4],
    [4, 2, 1, 2],
  ]);
});
