import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildCabin } from '../src/cabin-geometry.js';
import { visibility, nearestStructureSurface } from '../src/interaction.js';

const cabin = buildCabin();
const root = new THREE.Group();
for (const [name, data] of Object.entries(cabin.meshes)) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.index, 1));
  const material = name === 'glass'
    ? new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.24, depthWrite: false, side: THREE.DoubleSide })
    : new THREE.MeshStandardMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  if (name === 'door') mesh.position.set(cabin.layout.door.hingeX, 0, cabin.layout.door.hingeZ);
  root.add(mesh);
}
const cameraAt = (x, y, z) => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(x, y, z);
  return camera;
};

test('hearth can be fed inside the cabin but never through its back wall', () => {
  const { room, interior } = cabin.layout;
  const mouth = new THREE.Vector3(interior.stove.x, room.floorY + 0.5, interior.stove.z + 0.6);
  assert.equal(visibility(cameraAt(mouth.x, room.floorY + 1.5, mouth.z + 1.2), mouth, [root]), true);
  assert.equal(visibility(cameraAt(mouth.x, room.floorY + 1.5, room.z0 - 1), mouth, [root]), false);
});

test('door centre is reachable through its own surface tolerance, objects behind it are not', () => {
  const { room, door } = cabin.layout;
  const centre = new THREE.Vector3(door.centerX, room.floorY + 1, door.hingeZ);
  const camera = cameraAt(centre.x, centre.y, centre.z + 1);
  assert.equal(visibility(camera, centre, [root]), true);
  assert.equal(visibility(camera, centre.clone().add(new THREE.Vector3(0, 0, -0.8)), [root]), false);
});

test('transparent cabin glass stops a hand on either side of the pane', () => {
  const window = cabin.layout.windows.find(w => w.wall === 'back');
  const target = new THREE.Vector3(window.center + 0.2, window.centerY + 0.2, window.fixed + 0.6);
  const camera = cameraAt(target.x, target.y, window.fixed - 0.6);
  assert.equal(visibility(camera, target, [root]), false);
  camera.position.z = window.fixed + 0.6;
  target.z = window.fixed - 0.6;
  assert.equal(visibility(camera, target, [root]), false);
});

test('flame planes and sprites do not block interactions, opaque walls do', () => {
  const effects = new THREE.Group();
  effects.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending })));
  effects.add(new THREE.Sprite(new THREE.SpriteMaterial()));
  const camera = cameraAt(0, 0, 2), target = new THREE.Vector3(0, 0, -1);
  assert.equal(visibility(camera, target, [undefined, effects]), true);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 0.1), new THREE.MeshStandardMaterial());
  effects.add(wall);
  assert.equal(visibility(camera, target, [effects]), false);
  wall.visible = false;
  assert.equal(visibility(camera, target, [effects]), true);
});

test('placement finds the actual cabin floor before the terrain below it', () => {
  const { room } = cabin.layout;
  const camera = cameraAt(0.4, room.floorY + 1.6, -0.2);
  camera.lookAt(0.4, room.floorY - 0.5, -0.2);
  const surface = nearestStructureSurface(camera, [root]);
  assert.equal(surface.object.name, 'boards');
  assert.ok(Math.abs(surface.point.y - room.floorY) < 1e-6);
  assert.ok(surface.normal.y > 0.999);
});

test('surface query updates transformed groups and keeps world-space normals', () => {
  const group = new THREE.Group();
  group.position.set(0, 2, -1);
  group.rotation.x = 0.2;
  group.add(new THREE.Mesh(new THREE.BoxGeometry(3, 0.2, 3), new THREE.MeshStandardMaterial()));
  const camera = cameraAt(0, 4, -1);
  camera.lookAt(0, 2, -1);
  const surface = nearestStructureSurface(camera, [group]);
  assert.ok(surface.point.y > 2 && surface.point.y < 2.2);
  assert.ok(Math.abs(surface.normal.y - Math.cos(0.2)) < 1e-6);
  assert.ok(Math.abs(surface.normal.z - Math.sin(0.2)) < 1e-6);
  assert.equal(nearestStructureSurface(camera, [group], 0.5), null);
});
