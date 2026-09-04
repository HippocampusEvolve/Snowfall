import test from 'node:test';
import assert from 'node:assert/strict';

import { SaveGame } from '../src/save.js';
import { KIND } from '../src/journal.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function game(snapshotAsync) {
  return new SaveGame({
    digger: { edits: new Map() },
    footprints: {
      snapshotAsync,
      snapshot: () => new Uint8Array([0, 0, 0]),
    },
    campfire: { fuel: 1 },
    player: { pos: { x: 1, y: 2, z: 3 }, carrying: false },
  });
}

test('повторный таймер ждёт текущий сейв и не инвалидирует его', async () => {
  const shot = deferred();
  const saver = game(() => shot.promise);
  const writes = [];
  saver._write = async (_data, generation) => {
    writes.push(generation);
    return true;
  };

  const first = saver.save();
  const second = saver.save();
  assert.equal(second, first);

  shot.resolve(new Uint8Array([0, 0, 0]));
  assert.equal(await first, true);
  assert.deepEqual(writes, [1]);
});

test('pagehide-снимок отменяет более старую асинхронную запись', async () => {
  const shot = deferred();
  const saver = game(() => shot.promise);
  const writes = [];
  saver._write = async (_data, generation) => {
    writes.push(generation);
    return true;
  };

  const old = saver.save();
  assert.equal(await saver.save({ sync: true }), true);
  shot.resolve(new Uint8Array([0, 0, 0]));
  assert.equal(await old, false);
  assert.deepEqual(writes, [2]);
});

test('успешный удар кирки добавляет предмет записью ITEM', () => {
  const saver = game(async () => new Uint8Array([0, 0, 0]));
  const c = { x: 0, y: -8, z: 0 };
  saver.digger.onStroke(c, 0, -1, 2.4, 1, 'shovel');
  saver.digger.onStroke(c, 0, -1, 0.8, 2, 'pickaxe');
  saver.digger.onStroke(c, 0, -1, 0.8, 3, 'pickaxe');
  saver.digger.onStroke(c, 0, -1, 0, 2, 'shovel');
  saver.digger.onStroke(c, 0, 1, 2.4, 1, 'shovel');
  assert.deepEqual(
    [saver.inventory.count('soil'), saver.inventory.count('stone'), saver.inventory.count('ore')],
    [0, 1, 1]
  );
  assert.equal([...saver.journal.records()].filter((record) => record.kind === KIND.ITEM).length, 2);
  assert.deepEqual(saver._collect().head.mined, { soil: 0, stone: 0, ore: 0 });
});

test('старые mined переносятся в ITEM ровно один раз', () => {
  const saver = game(async () => new Uint8Array([0, 0, 0]));
  saver.digger.load = () => {};
  saver.digger.replayBegin = () => {};
  saver.digger.replayEnd = () => {};
  saver.footprints.restore = () => {};
  saver.player.pos.set = () => {};
  const head = {
    epoch: saver.journal.epoch,
    savedAt: Math.round(Date.now() / 1000),
    seqHead: 0,
    mined: { soil: 2, stone: 3, ore: 4 },
  };
  const cache = { seq: 0, editsK: [], editsV: [] };

  assert.equal(saver._apply(head, cache), 9);
  assert.deepEqual(
    [saver.inventory.count('soil'), saver.inventory.count('stone'), saver.inventory.count('ore')],
    [2, 3, 4]
  );
  assert.deepEqual(head.mined, { soil: 0, stone: 0, ore: 0 });
  const count = saver.journal.count;

  assert.equal(saver._apply(head, cache), 0);
  assert.equal(saver.journal.count, count);
  assert.deepEqual(
    [saver.inventory.count('soil'), saver.inventory.count('stone'), saver.inventory.count('ore')],
    [2, 3, 4]
  );
});

test('материалы воксельных правок уходят в кэш и приезжают из него', () => {
  const saver = game(async () => new Uint8Array([0, 0, 0]));
  saver.digger.edits.set(91, 2.5);
  saver.digger.editMaterials = new Map([[91, 2]]);
  const saved = saver._collect();
  assert.deepEqual([...saved.cache.editMatK], [91]);
  assert.deepEqual([...saved.cache.editMatV], [2]);

  const restored = game(async () => new Uint8Array([0, 0, 0]));
  let options = null;
  restored.digger.load = (_entries, value) => { options = value; };
  restored.footprints.restore = () => {};
  restored.player.pos.set = () => {};
  const head = {
    epoch: restored.journal.epoch,
    savedAt: Math.round(Date.now() / 1000),
    seqHead: 0,
    mined: { soil: 0, stone: 0, ore: 0 },
  };
  restored._apply(head, { ...saved.cache, seq: 0 });
  assert.deepEqual(options.materials, [[91, 2]]);
});
