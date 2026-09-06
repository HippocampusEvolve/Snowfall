import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Wildlife, findRabbitPatch, SIGHTING_DELAY } from '../src/wildlife.js';
import { createRabbitBody } from '../src/props/lab/rabbit.js';
import { createRabbitBehavior } from '../src/props/lab/rabbit-behavior.js';

test('rare rabbit placement is deterministic, away from player and rejects unloaded ground, cliffs and obstacles', () => {
  const origin = { x: 0, y: 2, z: 0 };
  const height = (x, z) => Math.sin(x * 0.05) * 0.3 + Math.cos(z * 0.05) * 0.2;
  const a = findRabbitPatch(origin, 31, height);
  assert.deepEqual(a, findRabbitPatch(origin, 31, height));
  assert.ok(Math.hypot(a.x, a.z) >= 25);
  assert.equal(findRabbitPatch(origin, 31, () => null), null);
  assert.equal(findRabbitPatch(origin, 31, () => 1, () => false), null);
  assert.equal(findRabbitPatch(origin, 31, x => x * 3), null);
  const behind = findRabbitPatch(origin, 31, height, () => true, { x: 0, z: 1 });
  assert.ok(behind.z / Math.hypot(behind.x, behind.z) <= 0.2);
});

test('laboratory SDF rabbit carries finite skin weights and stays within geometry budget', () => {
  const body = createRabbitBody(7319);
  assert.ok(body.attributes.position.count / 3 < 21000);
  for (const attribute of Object.values(body.attributes)) assert.ok(attribute.array.every(Number.isFinite));
  const w = body.attributes.skinWeight;
  for (let i = 0; i < w.count; i++) {
    assert.ok(Math.abs(w.getX(i) + w.getY(i) + w.getZ(i) + w.getW(i) - 1) < 1e-5);
  }
  body.dispose();
});

test('lab hops remain deterministic and reject newly dug gaps in their path', () => {
  const options = { placement: { x: 0, z: 0 }, meadow: { minX: -4, maxX: 4, minZ: -4, maxZ: 4 },
    patches: [[2, 2], [-2, -2]], canStand: (x, z) => Math.hypot(x, z) < 0.2 };
  const a = createRabbitBehavior(11, () => 0, options);
  const b = createRabbitBehavior(11, () => 0, options);
  for (let i = 0; i < 2000; i++) { a.advance(1 / 60); b.advance(1 / 60); }
  assert.deepEqual(a.state, b.state);
  assert.ok(Math.hypot(a.state.x, a.state.z) < 0.2);
  assert.ok(Number.isFinite(a.state.groundY));
});

test('wildlife does no worker work at boot or indoors and fails gracefully if workers are unavailable', async () => {
  let workers = 0;
  const wildlife = new Wildlife(new THREE.Scene(), { surfaceAt: () => 0,
    workerFactory: () => { workers++; throw new Error('worker unavailable'); } });
  for (let i = 0; i < SIGHTING_DELAY * 4 + 1; i++) wildlife.update(0.25, i / 4, { x: 0, y: 2, z: 0 }, { shelter: 1 });
  assert.equal(workers, 0);
  wildlife.update(0.25, 56, { x: 0, y: 2, z: 0 });
  await wildlife.init();
  assert.equal(workers, 1);
  assert.equal(wildlife.failed, true);
  assert.equal(wildlife.active, false);
  wildlife.dispose();
});

test('worker attributes create the original skinned rabbit and the first sighting stays delayed', async () => {
  const geometry = createRabbitBody(7319);
  const attributes = Object.fromEntries(Object.entries(geometry.attributes)
    .map(([name, attr]) => [name, { array: attr.array, itemSize: attr.itemSize }]));
  let terminated = 0;
  const scene = new THREE.Scene();
  const wildlife = new Wildlife(scene, { surfaceAt: () => 0, workerFactory: () => {
    const worker = { terminate() { terminated++; }, postMessage() {
      queueMicrotask(() => worker.onmessage({ data: { seed: 7319, attributes } }));
    } };
    return worker;
  } });
  assert.equal(await wildlife.init(), true);
  assert.equal(terminated, 1);
  assert.equal(wildlife.rabbit.body.isSkinnedMesh, true);
  assert.equal(wildlife.rabbit.root.visible, false);
  const player = { x: 0, y: 2, z: 0 };
  for (let i = 0; i < SIGHTING_DELAY * 4 - 1; i++) wildlife.update(0.25, i / 4, player);
  assert.equal(wildlife.active, false);
  wildlife.update(0.25, SIGHTING_DELAY, player);
  assert.equal(wildlife.active, true);
  assert.ok(Math.hypot(wildlife.rabbit.root.position.x, wildlife.rabbit.root.position.z) >= 25);
  wildlife.dispose();
  assert.equal(scene.children.length, 0);
  geometry.dispose();
});
