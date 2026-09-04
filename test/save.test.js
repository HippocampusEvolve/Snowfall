import test from 'node:test';
import assert from 'node:assert/strict';

import { SaveGame } from '../src/save.js';

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

test('счётчик добытого растёт на успешный удар и уходит в заголовок', () => {
  const saver = game(async () => new Uint8Array([0, 0, 0]));
  const c = { x: 0, y: -8, z: 0 };
  saver.digger.onStroke(c, 0, -1, 2.4, 1, 'shovel');
  saver.digger.onStroke(c, 0, -1, 0.8, 2, 'pickaxe');
  saver.digger.onStroke(c, 0, -1, 0.8, 3, 'pickaxe');
  saver.digger.onStroke(c, 0, -1, 0, 2, 'shovel');
  saver.digger.onStroke(c, 0, 1, 2.4, 1, 'shovel');
  assert.deepEqual(saver._collect().head.mined, { soil: 1, stone: 1, ore: 1 });
});
