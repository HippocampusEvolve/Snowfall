import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { SaveGame } from '../src/save.js';
import { KIND } from '../src/journal.js';
import { ITEM_INDEX } from '../src/data/items.js';
import { Homestead } from '../src/homestead.js';
import { ResourceYard } from '../src/resources.js';
import { Torch, advanceTorchState, TORCH_FUEL_SECONDS } from '../src/torch.js';
import { createHearthState, HEARTH_FUEL_SECONDS } from '../src/hearth-state.js';

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

function storage(t) {
  const keys = ['localStorage', 'navigator', 'location'];
  const before = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const data = new Map();
  const store = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: { locks: {
    request: async (_key, callback) => callback(),
  } }, configurable: true });
  Object.defineProperty(globalThis, 'location', { value: { search: '' }, configurable: true });
  t.after(() => keys.forEach((key, i) => {
    if (before[i]) Object.defineProperty(globalThis, key, before[i]);
    else delete globalThis[key];
  }));
  return store;
}

function persistentGame() {
  const saver = game(async () => new Uint8Array(3));
  saver._open = async () => null;
  saver.digger.load = () => {};
  saver.footprints.restore = () => {};
  saver.player.pos.set = () => {};
  return saver;
}

function physicalGame({ initialGround = 0, loadedGround = initialGround } = {}) {
  let ground = initialGround;
  const scene = new THREE.Scene();
  const saver = new SaveGame({
    digger: { edits: new Map(), load(entries) { this.edits = new Map(entries); ground = loadedGround; } },
    footprints: { snapshot: () => new Uint8Array(3), snapshotAsync: async () => new Uint8Array(3), restore() {} },
    campfire: { fuel: 1 },
    player: { pos: new THREE.Vector3(1, 0, 3), carrying: false, carryKind: null },
    yard: new ResourceYard(scene, () => ground),
    homestead: new Homestead(scene, { groundAt: () => ground }),
    torch: new Torch(scene, new THREE.Group()),
  });
  saver._open = async () => null;
  return saver;
}

const carry = (saver, kind) => {
  saver.player.carryKind = kind;
  saver.player.carrying = !!kind;
};

test('кучи, деталь в руках, постройка и факелы сохраняются на своих местах без дубликатов', async (t) => {
  storage(t);
  t.mock.method(Date, 'now', () => 1800000000000);
  const first = physicalGame();
  first.yard.drop('ore', new THREE.Vector3(8, 0, 5));
  first.yard.drop('timber', new THREE.Vector3(10, 0, 4), 0.5);
  first.inventory.add('stone', 5);
  first.inventory.add('timber', 3);
  first.inventory.add('block', 2);
  first.inventory.add('torch', 2);
  first.homestead.place('timber', { x: 12, y: 0.14, z: -1, yaw: 0 });
  first.inventory.take('timber', 1);
  first.homestead.place('block', { x: 8, y: 0.15, z: -1, yaw: 0 });
  first.inventory.take('block', 1);
  first.torch.take(); first.torch.ignite();
  advanceTorchState(first.torch._state, 45);
  first.torch.plantAt(new THREE.Vector3(9, 0, 8), first.inventory,
    (position, take) => first.notePlace('torch', position, take));
  carry(first, 'timber');
  const loose = first.yard.serialize();
  const members = first.homestead.serialize();
  assert.equal(await first.save({ sync: true }), true);

  for (let run = 0; run < 2; run++) {
    const loaded = physicalGame();
    assert.equal(await loaded.load(), true);
    assert.equal(loaded.blocked, false);
    assert.deepEqual(loaded.yard.serialize(), loose);
    assert.deepEqual(loaded.homestead.serialize(), members);
    assert.deepEqual(['stone', 'timber', 'block', 'torch'].map(id => loaded.inventory.count(id)), [5, 2, 1, 1]);
    assert.equal(loaded.player.carryKind, 'timber');
    assert.equal(loaded.player.carrying, true);
    assert.equal(loaded.torch.held, false);
    assert.equal(loaded.torch.placed.length, 1);
    assert.equal(loaded.torch.placed[0].fuel, TORCH_FUEL_SECONDS - 45);
    assert.deepEqual(loaded.torch.placed[0].position.toArray(), [9, 0, 8]);
    loaded.yard.update(loaded.inventory, loaded.player.carryKind, loaded.torch.held);
    assert.equal(loaded.yard.slots.find(slot => slot.kind === 'timber').meshes.filter(mesh => mesh.visible).length, 1);
    assert.equal(await loaded.save({ sync: true }), true);
  }
});

test('ожидание замка хранилища не смешивает старую кучу с новым ITEM после поднятия', async (t) => {
  storage(t);
  const first = physicalGame();
  const ore = first.yard.drop('ore', new THREE.Vector3(8, 0, 5));
  const entered = deferred(), gate = deferred();
  navigator.locks.request = async (_key, callback) => { entered.resolve(); await gate.promise; return callback(); };
  const writing = first.save({ sync: true });
  await entered.promise;
  first.yard.take(ore);
  first.inventory.add('ore', 1);
  carry(first, 'ore');
  gate.resolve();
  assert.equal(await writing, true);

  const beforePickup = physicalGame();
  assert.equal(await beforePickup.load(), true);
  assert.equal(beforePickup.yard.loose.length, 1);
  assert.equal(beforePickup.inventory.count('ore'), 0);
  assert.equal(beforePickup.player.carrying, false);

  assert.equal(await first.save({ sync: true }), true);
  const afterPickup = physicalGame();
  assert.equal(await afterPickup.load(), true);
  assert.equal(afterPickup.yard.loose.length, 0);
  assert.equal(afterPickup.inventory.count('ore'), 1);
  assert.equal(afterPickup.player.carryKind, 'ore');
});

test('фундамент проверяется после восстановления намытой площадки', async (t) => {
  storage(t);
  const first = physicalGame();
  first.digger.edits.set(17, 2);
  first.homestead.place('timber', { x: 8, y: 0.14, z: 4, yaw: 0 });
  await first.save({ sync: true });
  const restored = physicalGame({ initialGround: -2, loadedGround: 0 });
  assert.equal(await restored.load(), true);
  assert.equal(restored.blocked, false);
  assert.equal(restored.homestead.entries.length, 1);
  assert.equal(restored.digger.edits.get(17), 2);
});

test('испорченные физические предметы или постройка блокируют перезапись сохранения', async (t) => {
  const store = storage(t);
  const first = physicalGame();
  await first.save({ sync: true });
  const valid = JSON.parse(store.getItem('snowfall.save.v3'));
  for (const corrupt of [
    { ...valid, head: { ...valid.head, resources: [{ kind: 'ore', x: 8, y: 0, z: 5, yaw: null }] } },
    { ...valid, head: { ...valid.head, homestead: { version: 1, pieces: [{ kind: 'timber', id: 4, x: 8, y: 4, z: 5, yaw: 0 }] } } },
  ]) {
    const raw = JSON.stringify(corrupt);
    store.setItem('snowfall.save.v3', raw);
    const restored = physicalGame();
    assert.equal(await restored.load(), false);
    assert.equal(restored.status, 'read-error');
    assert.equal(await restored.save({ sync: true }), false);
    assert.equal(store.getItem('snowfall.save.v3'), raw);
  }
});

test('сохранение до загрузки камина не возвращает уже сгоревшие за оффлайн дрова', async (t) => {
  storage(t);
  let clock = 1800000000000;
  t.mock.method(Date, 'now', () => clock);
  const first = persistentGame();
  first.attachHearth(createHearthState(1));
  await first.save({ sync: true });
  clock += 180000;
  const beforeCabin = persistentGame();
  await beforeCabin.load();
  assert.equal(beforeCabin.hearth, null);
  assert.equal(await beforeCabin.save({ sync: true }), true);
  clock += 120000;
  const reloaded = persistentGame();
  await reloaded.load();
  const hearth = createHearthState();
  reloaded.attachHearth(hearth);
  assert.ok(Math.abs(hearth.fuel - (1 - 300 / HEARTH_FUEL_SECONDS)) < 1e-9);
  assert.equal(await reloaded.save({ sync: true }), true);
  const final = persistentGame();
  await final.load();
  const finalHearth = createHearthState();
  final.attachHearth(finalHearth);
  assert.equal(finalHearth.fuel, hearth.fuel, 'тот же оффлайн не списывается дважды');
});

test('современный факел сохраняет руку и остаток топлива через два оффлайн периода', async (t) => {
  storage(t);
  let clock = 1800000000000;
  t.mock.method(Date, 'now', () => clock);
  const first = physicalGame();
  first.inventory.add('torch', 1);
  first.torch.take(); first.torch.ignite();
  advanceTorchState(first.torch._state, 60);
  await first.save({ sync: true });
  clock += 120000;
  const second = physicalGame();
  assert.equal(await second.load(), true);
  assert.equal(second.torch.held, true);
  assert.equal(second.torch.burning, true);
  assert.equal(second.torch.fuel, TORCH_FUEL_SECONDS - 180);
  await second.save({ sync: true });
  clock += 30000;
  const third = physicalGame();
  assert.equal(await third.load(), true);
  assert.equal(third.torch.held, true);
  assert.equal(third.torch.fuel, TORCH_FUEL_SECONDS - 210);
  assert.equal(third.inventory.count('torch'), 1);
});

test('старый заголовок с факелом в руке и PLACE мигрирует с оффлайн расходом', async (t) => {
  const store = storage(t);
  let clock = 1800000000000;
  t.mock.method(Date, 'now', () => clock);
  const first = physicalGame();
  first.inventory.add('torch', 1);
  first.torch.take();
  first.notePlace('torch', { x: 9, y: 0, z: 8 });
  await first.save({ sync: true });
  const old = JSON.parse(store.getItem('snowfall.save.v3'));
  delete old.head.torchState;
  delete old.head.resources;
  delete old.head.homestead;
  delete old.head.hearth;
  store.setItem('snowfall.save.v3', JSON.stringify(old));
  clock += 90000;
  const restored = physicalGame();
  assert.equal(await restored.load(), true);
  assert.equal(restored.torch.held, true);
  assert.equal(restored.torch.burning, true);
  assert.equal(restored.torch.fuel, TORCH_FUEL_SECONDS - 90);
  assert.equal(restored.torch.placed.length, 1);
  assert.equal(restored.torch.placed[0].fuel, TORCH_FUEL_SECONDS - 90);
  assert.equal(restored.inventory.count('torch'), 1);
  assert.equal(restored.homestead.entries.length, 0);
});

test('неудачная запись не выдаётся за успех, повтор сохраняет прогресс', async (t) => {
  const store = storage(t);
  const write = store.setItem;
  store.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
  const saver = persistentGame();
  saver.inventory.add('ore', 2);
  assert.equal(await saver.save({ sync: true }), false);
  assert.equal(saver.status, 'error');
  store.setItem = write;
  assert.equal(await saver.save({ sync: true }), true);
  assert.equal(saver.status, 'ok');
  const restored = persistentGame();
  await restored.load();
  assert.equal(restored.inventory.count('ore'), 2);
});

test('устаревшая вкладка не перезаписывает более свежий мир', async (t) => {
  storage(t);
  const first = persistentGame();
  first.inventory.add('ore', 2);
  await first.save({ sync: true });
  const second = persistentGame();
  await second.load();
  first.inventory.add('ore', 7);
  assert.equal(await first.save({ sync: true }), true);
  second.inventory.add('stone', 3);
  assert.equal(await second.save({ sync: true }), false);
  assert.equal(second.status, 'conflict');
  assert.equal(second.blocked, true);
  const restored = persistentGame();
  await restored.load();
  assert.equal(restored.inventory.count('ore'), 9);
  assert.equal(restored.inventory.count('stone'), 0);
});

test('ошибка чтения не позволяет автосейву затереть старый мир', async (t) => {
  const store = storage(t);
  const first = persistentGame();
  first.inventory.add('ore', 5);
  await first.save({ sync: true });
  const read = store.getItem;
  store.getItem = () => { throw new Error('storage unavailable'); };
  const second = persistentGame();
  assert.equal(await second.load(), false);
  store.getItem = read;
  assert.equal(await second.save({ sync: true }), false);
  assert.equal(second.status, 'read-error');
  const restored = persistentGame();
  await restored.load();
  assert.equal(restored.inventory.count('ore'), 5);
});

test('факел после сохранения снова находится в руке', async (t) => {
  storage(t);
  const first = persistentGame();
  first.torch = { held: true };
  first.inventory.add('torch', 2);
  await first.save({ sync: true });
  const restored = persistentGame();
  restored.torch = { held: false, restore() {}, take() { this.held = true; } };
  await restored.load();
  assert.equal(restored.torch.held, true);
  assert.equal(restored.inventory.count('torch'), 2);
});

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

test('воткнутые факелы восстанавливаются свёрткой PLACE', () => {
  let torches = null;
  const saver = new SaveGame({
    digger: { edits: new Map(), load() {} },
    footprints: { restore() {} },
    campfire: { fuel: 1 },
    player: { pos: { set() {} }, carrying: false },
    torch: { restore(records) { torches = records; } },
  });
  saver.journal.place(ITEM_INDEX.torch, 1, 2, 3, 1);
  saver.journal.place(ITEM_INDEX.torch, -4, 5, 6, 2);
  saver.journal.place(ITEM_INDEX.torch, 1, 2, 3, 3, true);
  const head = {
    epoch: saver.journal.epoch,
    savedAt: Math.round(Date.now() / 1000),
    seqHead: saver.journal.seqHead,
    mined: {},
  };
  saver._apply(head, { seq: saver.journal.seqHead, editsK: [], editsV: [] });
  assert.deepEqual(torches.map((r) => [r.x, r.y, r.z]), [[-4, 5, 6]]);
});

test('PLACE блока при переигрывании восстанавливает центр над нижней гранью', () => {
  const saver = game(async () => new Uint8Array());
  const blocks = [];
  saver.digger.replayBegin = () => {};
  saver.digger.replayEnd = () => {};
  saver.digger.blockStroke = (center, material) => blocks.push({ ...center, material });
  saver.journal.place(ITEM_INDEX.block, 1, 2, -3, 1);
  saver._replayDigs(1);
  assert.deepEqual(blocks, [{ x: 1, y: 2.25, z: -3, material: 2 }]);
});
