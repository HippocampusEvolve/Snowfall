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
