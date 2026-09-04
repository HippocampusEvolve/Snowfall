import test from 'node:test';
import assert from 'node:assert/strict';

import { Journal, KIND, REC, CHUNK } from '../src/journal.js';

const j = () => new Journal(1_700_000_000);

test('копок читается обратно тем же', () => {
  const g = j();
  g.dig(12.34, 3.5, -47.02, Math.PI / 2, -1, 2.4, 120);
  const r = g.at(0);
  assert.deepEqual(
    [r.kind, r.seq, r.t, r.sign, Math.round(r.strength * 100), Math.round(r.yaw * 1000), r.material],
    [KIND.DIG, 1, 120, -1, 240, Math.round((Math.PI / 2) * 1000), 0]
  );
});

test('материал и кирка читаются из записи DIG', () => {
  const g = j();
  g.dig(1, -8, 3, 0, -1, 0.8, 12, 3, 'pickaxe');
  const r = g.at(0);
  assert.deepEqual([r.kind, r.material, r.tool, r.strength], [KIND.DIG, 3, 'pickaxe', 0.8]);
});

test('старая запись DIG без старших битов даёт снег', () => {
  const g = j();
  g.dig(1, 2, 3, 0, -1, 2.4, 0);
  const bytes = g.pending()[0][1];
  bytes[8] &= 0x0f;
  const old = j();
  old.adopt(0, bytes);
  assert.deepEqual([old.at(0).material, old.at(0).tool], [0, 'shovel']);
});

test('центр копка квантуется с ошибкой не больше сантиметра', () => {
  const g = j();
  let worst = 0;
  for (let i = 0; i < 400; i++) {
    const x = (Math.random() * 2 - 1) * 200;
    const y = (Math.random() * 2 - 1) * 50;
    const z = (Math.random() * 2 - 1) * 200;
    g.dig(x, y, z, 0, -1, 2.4, 0);
    const r = g.at(i);
    worst = Math.max(worst, Math.abs(r.x - x), Math.abs(r.y - y), Math.abs(r.z - z));
  }
  assert.ok(worst <= 0.01, `ошибка квантования ${worst} м`);
});

test('намыв отличается от копка знаком', () => {
  const g = j();
  g.dig(1, 2, 3, 0, 1, 2.4, 0);
  assert.equal(g.at(0).sign, 1);
});

test('удар топором читается обратно тем же', () => {
  const g = j();
  g.chop(310, 4, 77);
  const r = g.at(0);
  assert.deepEqual([r.kind, r.id, r.hits, r.t], [KIND.CHOP, 310, 4, 77]);
});

test('валка читается обратно тем же', () => {
  const g = j();
  g.fell(9, -2.6413, 5);
  const r = g.at(0);
  assert.deepEqual([r.kind, r.id, Math.round(r.yaw * 10000)], [KIND.FELL, 9, -26413]);
});

test('разделка читается обратно тем же', () => {
  const g = j();
  g.split(9, 0, 5);
  const r = g.at(0);
  assert.deepEqual([r.kind, r.id, r.left], [KIND.SPLIT, 9, 0]);
});

test('полено в костре читается обратно тем же', () => {
  const g = j();
  g.fuel(42);
  const r = g.at(0);
  assert.deepEqual([r.kind, r.t], [KIND.FUEL, 42]);
});

test('поленница читается обратно тем же', () => {
  const g = j();
  g.pile(17, 3);
  const r = g.at(0);
  assert.deepEqual([r.kind, r.count], [KIND.PILE, 17]);
});

test('номера записей идут подряд', () => {
  const g = j();
  g.fuel(1);
  g.pile(1, 1);
  g.fuel(2);
  assert.deepEqual([...g.records()].map((r) => r.seq), [1, 2, 3]);
});

test('запись занимает ровно шестнадцать байт', () => {
  const g = j();
  g.fuel(0);
  g.fuel(0);
  assert.equal(g.bytes, 2 * REC);
});

test('несохранённый хвост отдаётся порциями по номеру', () => {
  const g = j();
  for (let i = 0; i < CHUNK + 3; i++) g.fuel(i);
  assert.deepEqual(g.pending().map(([i, b]) => [i, b.length]), [
    [0, CHUNK * REC],
    [1, 3 * REC],
  ]);
});

test('дописывание отдаёт только незаконченную порцию и новые', () => {
  const g = j();
  for (let i = 0; i < CHUNK + 1; i++) g.fuel(i);
  g.flushed = g.count;
  g.fuel(999);
  assert.deepEqual(g.pending().map(([i]) => i), [1]);
});

test('порции из хранилища складываются обратно в журнал', () => {
  const g = j();
  for (let i = 0; i < CHUNK + 5; i++) g.pile(i % 200, i);
  const chunks = g.pending();

  const back = j();
  for (const [i, bytes] of chunks) back.adopt(i, bytes);
  assert.deepEqual(
    [back.count, back.seqHead, back.at(CHUNK + 4).count],
    [g.count, g.seqHead, (CHUNK + 4) % 200]
  );
});

test('сдвиг эпохи состаривает все записи разом', () => {
  const g = j();
  g.fuel(10);
  const before = g.now(1_700_000_100 * 1000) - g.at(0).t;
  g.shift(3600);
  assert.equal(g.now(1_700_000_100 * 1000) - g.at(0).t, before + 3600);
});
