import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ResourceYard, STOCK_KINDS } from '../src/resources.js';
import { ITEMS } from '../src/data/items.js';

const inventory = (counts = {}) => ({ count: kind => counts[kind] ?? 0 });
const fullCounts = Object.fromEntries(ITEMS.map(item => [item.id, item.stack]));
const makeYard = (ground = () => 0) => new ResourceYard(new THREE.Scene(), ground);
const box = mesh => new THREE.Box3().setFromObject(mesh);
const volumeOverlap = (a, b) => ['x', 'y', 'z'].every(axis =>
  Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis]) > 1e-6);

test('all stock items fit their rack and never intersect at maximum capacity', () => {
  const yard = makeYard();
  yard.update(inventory(fullCounts), null, false);
  const all = [];
  for (const slot of yard.slots) {
    const bounds = slot.meshes.map(box);
    assert.equal(slot.meshes.filter(mesh => mesh.visible).length, fullCounts[slot.kind]);
    for (let i = 0; i < bounds.length; i++) {
      assert.ok(bounds[i].min.x >= slot.position.x - slot.width / 2 - 1e-6, slot.kind);
      assert.ok(bounds[i].max.x <= slot.position.x + slot.width / 2 + 1e-6, slot.kind);
      assert.ok(bounds[i].min.z >= slot.position.z - slot.depth / 2 - 1e-6, slot.kind);
      assert.ok(bounds[i].max.z <= slot.position.z + slot.depth / 2 + 1e-6, slot.kind);
      assert.ok(bounds[i].min.y >= 0.09 - 1e-6, slot.kind);
      for (const previous of all) assert.equal(volumeOverlap(bounds[i], previous), false, slot.kind + ' intersects a stocked item');
      all.push(bounds[i]);
    }
  }
});

test('visible stocks deduct exactly one held item including the held torch', () => {
  const yard = makeYard();
  for (const kind of STOCK_KINDS) {
    yard.update(inventory(fullCounts), kind, kind === 'torch');
    for (const slot of yard.slots) assert.equal(slot.meshes.filter(mesh => mesh.visible).length,
      fullCounts[slot.kind] - (kind === slot.kind ? 1 : 0));
  }
  yard.update(inventory({ torch: 1 }), null, true);
  assert.equal(yard.slots.find(slot => slot.kind === 'torch').meshes.some(mesh => mesh.visible), false);
  yard.update(inventory(), 'stone', false);
  assert.equal(yard.slots.some(slot => slot.meshes.some(mesh => mesh.visible)), false);
});

test('empty matching rack accepts a deposit target and stocked rack permits taking', () => {
  const yard = makeYard();
  const slot = yard.slots.find(slot => slot.kind === 'block');
  const camera = new THREE.PerspectiveCamera();
  camera.position.copy(slot.position).add(new THREE.Vector3(0, 1.2, 1));
  camera.lookAt(slot.position);
  assert.equal(yard.target(camera, inventory()), null);
  assert.equal(yard.target(camera, inventory(), 'block')?.ref, slot);
  assert.equal(yard.target(camera, inventory({ block: 2 }))?.ref, slot);
  assert.equal(yard.target(camera, inventory({ block: 2 }), 'timber'), null);
});

test('dropping uses each real geometry bottom and crossed timber settles without intersection', () => {
  const yard = makeYard();
  for (const [i, kind] of STOCK_KINDS.entries()) {
    const entry = yard.drop(kind, new THREE.Vector3(i * 3, -7, 8), 0.7);
    assert.ok(Math.abs(box(entry.mesh).min.y + 7) < 1e-6, kind);
  }
  const first = yard.drop('timber', new THREE.Vector3(0, 0, 0));
  const crossed = yard.drop('timber', new THREE.Vector3(0.95, 0, 0.7), Math.PI / 2);
  assert.equal(volumeOverlap(box(first.mesh), box(crossed.mesh)), false);
  assert.ok(Math.abs(box(crossed.mesh).min.y - box(first.mesh).max.y) < 1e-6);
});

test('loose resource save round trips preserve centres and rotations without height drift', () => {
  const yard = makeYard();
  STOCK_KINDS.forEach((kind, i) => yard.drop(kind, new THREE.Vector3(i * 0.2, 1, 0), i * 0.35));
  const saved = yard.serialize();
  const originalBounds = yard.loose.map(entry => box(entry.mesh));
  for (let cycle = 0; cycle < 20; cycle++) yard.restore(JSON.parse(JSON.stringify(yard.serialize())));
  assert.deepEqual(yard.serialize(), saved);
  yard.loose.forEach((entry, i) => assert.deepEqual(box(entry.mesh), originalBounds[i]));
  const taken = yard.loose[3];
  assert.equal(yard.take(taken), true);
  assert.equal(yard.take(taken), false);
  assert.equal(yard.serialize().length, saved.length - 1);
});

test('loose restore ignores malformed positions and unsupported resource kinds', () => {
  const yard = makeYard();
  const valid = { kind: 'stone', x: 0, y: 0.2, z: 0, yaw: 0 };
  yard.restore([valid, null, { ...valid, kind: 'toString' }, { ...valid, y: Infinity }, { ...valid, x: 800 }]);
  assert.deepEqual(yard.serialize(), [valid]);
  yard.restore(null);
  assert.equal(yard.loose.length, 0);
});
