import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Digger } from '../src/digger.js';

const col = (x, z = 0) => x + 1024 + (z + 1024) * 2048;
const key = (x, y, z = 0) => col(x, z) + (y + 256) * 4194304;
function world() {
  const d = Object.create(Digger.prototype);
  for (const name of ['_parts', 'chunks', '_plan', '_ver', '_heightCache', '_samples', '_editCols', 'edits', 'editMaterials']) d[name] = new Map();
  for (const name of ['_pending', '_dirtyColumns', '_cutCols', '_queued', '_sampleWanted']) d[name] = new Set();
  d._queue = [];
  d._busy = [];
  d.group = new THREE.Group();
  d.material = new THREE.MeshBasicMaterial();
  d._covDirty = false;
  d._workers = [];
  d._sampleQueue = [];
  d.baseHeight = () => 0.5;
  d.caves = { sdf: () => 100, materialAt: () => 0 };
  d._updateCoverage = () => {};
  return d;
}
function plan(d, x, cut = true) {
  d._plan.set(col(x), { cut, set: new Set([-1, 0]), wide: new Set([-1, 0]) });
  for (const y of [-1, 0]) d._enqueue(key(x, y));
}
function ready(d, x, y, { empty = false, ver = d._ver.get(key(x, y)) } = {}) {
  d._install({ cx: x, cy: y, cz: 0, ver, empty,
    position: new Float32Array([x * 4, y * 4, 0, x * 4 + 1, y * 4, 0, x * 4, y * 4, 1]),
    normal: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
    material: new Uint8Array(3), index: new Uint32Array([0, 1, 2]),
  });
}

test('new excavation keeps terrain until the whole replacement is ready', () => {
  const d = world();
  plan(d, 0);
  ready(d, 0, -1);
  assert.equal(d._flushColumns(), 0);
  assert.equal(d.isCutAt(1, 1), false);
  assert.equal(d.chunks.size, 0); // no overlap with the original snow
  ready(d, 0, 0);
  assert.equal(d._flushColumns(), 1);
  assert.equal(d.isCutAt(1, 1), true);
  assert.equal(d.chunks.get(col(0)).geometry.index.count, 6);
  assert.equal(d._covDirty, true);
});

test('a real stroke publishes all four columns before returning, without waiting for deep work', () => {
  const d = world();
  d._caveNear = (_x, _z, lo) => lo < -4;
  d._enqueue(key(0, -3)); // deliberately unfinished background work
  let notifications = 0;
  d.onChanged = () => {
    notifications++;
    for (const x of [0, 1]) for (const z of [-1, 0]) {
      assert.equal(d._cutCols.has(col(x, z)), true);
      assert.ok(d.chunks.has(col(x, z)));
    }
  };
  d.shovelStroke({ x: 4, y: 0.35, z: 0 }, 0, -1);
  assert.equal(notifications, 1);
  assert.equal(d._pending.has(key(0, -3)), true);
  assert.equal(d._ver.get(key(0, -3)), 1);
  assert.ok([...d._parts.keys()].every(k => (k >>> 22) - 256 >= -1));
  const old = d.chunks.get(col(0)).geometry;
  d.shovelStroke({ x: 4, y: 0.25, z: 0 }, 0, -1);
  assert.equal(notifications, 2);
  assert.notEqual(d.chunks.get(col(0)).geometry, old);
});

test('stale worker output cannot publish an unfinished newer stroke', () => {
  const d = world();
  plan(d, 0);
  ready(d, 0, -1);
  d._enqueue(key(0, 0), true);
  ready(d, 0, 0, { ver: 1 });
  assert.equal(d._flushColumns(), 0);
  ready(d, 0, 0, { empty: true });
  assert.equal(d._flushColumns(), 1);
  assert.equal(d.chunks.get(col(0)).geometry.index.count, 3);
});

test('closing an excavation retains the cut until capped replacement is ready', () => {
  const d = world();
  plan(d, 0); ready(d, 0, -1); ready(d, 0, 0); d._flushColumns();
  const old = d.chunks.get(col(0)).geometry;
  plan(d, 0, false);
  ready(d, 0, -1, { empty: true });
  d._flushColumns();
  assert.equal(d.isCutAt(1, 1), true);
  assert.equal(d.chunks.get(col(0)).geometry, old);
  ready(d, 0, 0, { empty: true }); d._flushColumns();
  assert.equal(d.isCutAt(1, 1), false);
  assert.equal(d.chunks.size, 0);
});

test('unloading cancels unfinished work without a delayed ghost mesh', () => {
  const d = world();
  for (const x of [0, 1]) plan(d, x);
  ready(d, 0, -1); ready(d, 0, 0);
  d._unloadColumn(col(1));
  ready(d, 1, 0, { ver: 1 });
  assert.equal(d._flushColumns(), 1);
  assert.equal(d.chunks.has(col(1)), false);
  assert.equal(d._pending.size, 0);
});

test('a late worker response cannot undo an immediate stroke', () => {
  const d = world();
  d._enqueue(key(0, 0));
  d.shovelStroke({ x: 2, y: 0.35, z: 2 }, 0, -1);
  const part = d._parts.get(key(0, 0));
  const geo = d.chunks.get(col(0)).geometry;
  ready(d, 0, 0, { ver: 1, empty: true });
  d._flushColumns();
  assert.equal(d._parts.get(key(0, 0)), part);
  assert.equal(d.chunks.get(col(0)).geometry, geo);
});

test('geology prefetch follows the player and has bounded storage', () => {
  const d = world();
  d._workers = [{}];
  d._warmSamples({ x: 0, y: 0, z: 0 });
  assert.ok(d._sampleQueue.length > 0 && d._sampleQueue.length <= 96);
  for (const k of d._sampleQueue) d._rememberSamples(k, {});
  d._warmSamples({ x: 100, y: -12, z: 100 });
  assert.equal(d._samples.size, 0);
  for (let i = 0; i < 200; i++) d._rememberSamples(i, {});
  assert.equal(d._samples.size, 96);
});
