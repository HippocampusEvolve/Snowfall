import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Torch, TORCH_FUEL_SECONDS, TORCH_BLOWOUT_SECONDS, advanceTorchState } from '../src/torch.js';

const setup = () => {
  const scene = new THREE.Scene(), view = new THREE.Group();
  const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.01, 12);
  return { torch: new Torch(scene, view), scene, view, camera };
};

test('crafted torch starts unlit; ignition spends finite fuel and cold torch gives no light or heat', () => {
  const { torch, camera } = setup();
  torch.take();
  torch.update(1, 1, camera);
  assert.equal(torch.burning, false);
  assert.equal(torch.heldLight.intensity, 0);
  assert.equal(torch.viewLight.intensity, 0);
  assert.equal(torch.heat, 0);
  assert.equal(torch.ignite(), true);
  torch.update(20, 21, camera);
  assert.equal(torch.fuel, TORCH_FUEL_SECONDS - 20);
  assert.ok(torch.heldLight.intensity > 0 && torch.heat > 0);
  assert.ok(torch.viewLight.intensity > 0, 'the separate hand scene must receive the flame light');
  assert.ok(torch.holder.getObjectByName('Carried torch glow'));
  assert.equal(torch.scene.getObjectByName('Carried torch glow'), undefined);
  torch.update(TORCH_FUEL_SECONDS, 700, camera);
  assert.equal(torch.fuel, 0);
  assert.equal(torch.burning, false);
  assert.equal(torch.heldLight.intensity, 0);
  assert.equal(torch.viewLight.intensity, 0);
  assert.equal(torch.ignite(), false);
});

test('sustained blizzard extinguishes a torch; solid shelter protects it and pause spends nothing', () => {
  const exposed = { fuel: 600, burning: true, exposure: 0 };
  advanceTorchState(exposed, TORCH_BLOWOUT_SECONDS - 1, { blizzard: 1 });
  assert.equal(exposed.burning, true);
  advanceTorchState(exposed, 1, { blizzard: 1 });
  assert.equal(exposed.burning, false);
  const sheltered = { fuel: 600, burning: true, exposure: 0 };
  advanceTorchState(sheltered, 30, { blizzard: 1, shelter: 1 });
  assert.equal(sheltered.burning, true);
  assert.equal(sheltered.fuel, 570);
  advanceTorchState(sheltered, 100, { blizzard: 1, spend: false });
  assert.deepEqual(sheltered, { fuel: 570, burning: true, exposure: 0 });
});

test('plant, reload and pickup retain exact fuel; taking a fresh crafted torch resets fuel without igniting', () => {
  const { torch, camera } = setup();
  let count = 1;
  const inventory = { take: () => count-- > 0 ? 1 : 0, add: () => { count++; return 1; } };
  torch.take(); torch.ignite(); torch.update(75, 75, camera);
  const entry = torch.plantAt(new THREE.Vector3(1, 2, 3), inventory, () => 31);
  assert.equal(entry.fuel, 525);
  assert.equal(entry.burning, true);
  const snapshot = torch.snapshot();
  const restored = setup().torch;
  restored.restore([{ seq: 31, x: 1, y: 2, z: 3 }]);
  assert.equal(restored.restoreState(snapshot), true);
  assert.equal(restored.placed[0].fuel, 525);
  assert.equal(restored.takePlaced(restored.placed[0], inventory, () => {}), true);
  assert.equal(restored.fuel, 525);
  assert.equal(restored.burning, true);
  restored.plantAt(new THREE.Vector3(2, 2, 3), inventory, () => 32);
  restored.take();
  assert.equal(restored.fuel, 600);
  assert.equal(restored.burning, false);
});

test('placed torches use their own shelter and only burning ones occupy light slots', () => {
  const { torch, camera } = setup();
  torch.restore([{ seq: 1, x: 0, y: 0, z: -1 }, { seq: 2, x: 0, y: 0, z: -2 }]);
  torch.update(10, 10, camera, 1, { blizzard: 1, shelter: 1,
    shelterAt: p => p.z < -1.5 ? 1 : 0 });
  assert.equal(torch.placed[0].burning, false);
  assert.equal(torch.placed[0].light.intensity, 0);
  assert.equal(torch.placed[1].burning, true);
  assert.ok(torch.placed[1].light.intensity > 0);
});

test('saved and legacy lit torches burn down offline; a modern unlit torch retains fuel', () => {
  const legacy = setup().torch;
  legacy.restore([{ seq: 1, x: 0, y: 0, z: -1 }]);
  legacy.restoreState(undefined, { elapsedSeconds: 120, legacyHeld: true });
  legacy.take();
  assert.equal(legacy.burning, true);
  assert.equal(legacy.fuel, 480);
  assert.equal(legacy.placed[0].fuel, 480);
  const restored = setup().torch;
  restored.restore([{ seq: 1, x: 0, y: 0, z: -1 }]);
  restored.restoreState(legacy.snapshot(), { elapsedSeconds: 500 });
  restored.take();
  assert.equal(restored.burning, false);
  assert.equal(restored.fuel, 0);
  assert.equal(restored.placed[0].burning, false);
  const unlit = setup().torch;
  unlit.take();
  restored.restoreState(unlit.snapshot(), { elapsedSeconds: 5000 });
  restored.take();
  assert.equal(restored.fuel, 600);
  assert.equal(restored.burning, false);
});

test('complete volumetric flame and gripping mitten stay inside desktop and portrait view including sway', () => {
  const { torch, camera, view } = setup();
  torch.take(); torch.ignite();
  const flame = torch.swing.children[0].userData.flame;
  for (const aspect of [16 / 9, 4 / 3, 9 / 16]) {
    camera.aspect = aspect; camera.updateProjectionMatrix();
    torch.update(0, 0, camera);
    for (const pitch of [-0.1, 0, 0.1]) for (const yaw of [-0.1, 0.1]) {
      view.rotation.set(pitch, yaw, 0);
      view.position.y = 0.018;
      view.updateMatrixWorld(true);
      const positions = flame.geometry.attributes.position;
      for (let i = 0; i < positions.count; i++) {
        const point = new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(flame.matrixWorld).project(camera);
        assert.ok(Math.abs(point.x) < 0.96 && Math.abs(point.y) < 0.95, `flame cropped at ${aspect}: ${point.toArray()}`);
      }
      const hand = torch.grip.getWorldPosition(new THREE.Vector3()).project(camera);
      assert.ok(hand.x > -0.1 && hand.x < 0.9 && hand.y > -0.85 && hand.y < -0.1);
    }
  }
});
