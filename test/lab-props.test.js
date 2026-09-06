import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createGameProp, disposeModel, geometryStats, LAB_TOOLS } from '../src/props/lab/tools.js';
import { Axe } from '../src/axe.js';
import { Pickaxe } from '../src/pickaxe.js';
import { Hammer } from '../src/hammer.js';
import { fitToolToAspect } from '../src/hand-model.js';

test('axe retains the timber stroke through release or a second button press before impact', () => {
  globalThis.window = { devicePixelRatio: 1 };
  const axe = new Axe(new THREE.Scene(), new THREE.Group());
  axe.take();
  assert.equal(axe.trySwing('timber'), true);
  assert.equal(axe.trySwing('chop'), false, 'a new intent cannot change an active cut');
  const impacts = [];
  axe.update(axe.dur * 0.5, kind => { impacts.push(kind); return true; });
  assert.deepEqual(impacts, ['timber']);
});

for (const name of Object.keys(LAB_TOOLS)) {
  test(`lab ${name}: real procedural geometry has finite vertices, metre scale and a measured budget`, () => {
    const model = createGameProp(name);
    const stats = geometryStats(model);
    assert.ok(stats.triangles <= (name === 'torch' ? 1400 : 1800), JSON.stringify(stats));
    assert.ok(stats.draws <= 5);
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    assert.ok(size.y > 0.5 && size.y < 1.05, `physical size ${size.toArray()}`);
    model.traverse(object => {
      if (object.geometry) assert.ok(object.geometry.attributes.position.array.every(Number.isFinite));
    });
    const raw = model.userData.labModel;
    const strike = new THREE.Vector3(...LAB_TOOLS[name].strike).applyMatrix4(raw.matrix);
    assert.ok(strike.length() < 1e-7, 'working point must remain the rig origin');
    const grip = model.userData.grip;
    assert.ok(grip.y > 0.1 && grip.y < 0.6);
    disposeModel(model);
  });
}

for (const Tool of [Axe, Pickaxe, Hammer]) {
  test(`${Tool.name}: rest tool and mitten fit 9:16 and 9:19.5 without moving the impact pose`, () => {
    globalThis.window = { devicePixelRatio: 1 };
    const view = new THREE.Group();
    const tool = new Tool(new THREE.Scene(), view);
    tool.take();
    const originalX = tool.holder.position.x;
    for (const aspect of [9 / 16, 9 / 19.5]) {
      const camera = new THREE.PerspectiveCamera(55, aspect, 0.01, 12);
      tool._rest();
      fitToolToAspect(tool, aspect);
      const restX = tool.holder.position.x;
      for (let frame = 0; frame < 60; frame++) fitToolToAspect(tool, aspect);
      assert.equal(tool.holder.position.x, restX, 'repeated frames must not accumulate an offset');
      view.updateMatrixWorld(true);
      tool.swing.traverse(object => {
        if (!object.isMesh) return;
        const vertices = object.geometry.attributes.position;
        for (let i = 0; i < vertices.count; i++) {
          const point = new THREE.Vector3().fromBufferAttribute(vertices, i).applyMatrix4(object.matrixWorld).project(camera);
          // The sleeve exits through the bottom of the frame by design.
          if (point.y < -1) continue;
          assert.ok(Math.abs(point.x) < 0.93, `${object.name} cropped at ${aspect}: ${point.toArray()}`);
        }
      });
      tool.trySwing(Tool === Axe ? 'chop' : 'mine');
      tool.amp = 1; tool.cross = 1;
      tool.update(tool.dur * tool.strokes[tool.kind].impact, () => true);
      fitToolToAspect(tool, aspect);
      assert.ok(Math.abs(tool.holder.position.x - originalX) < 1e-7, 'contact pose must retain its established aim');
      view.updateMatrixWorld(true);
      const tip = tool.swing.children[0].getWorldPosition(new THREE.Vector3()).project(camera);
      assert.ok(Math.abs(tip.x) < 0.04 && Math.abs(tip.y) < 0.04, `contact misses mobile aim: ${tip.toArray()}`);
    }
    tool._rest();
    fitToolToAspect(tool, 16 / 9);
    assert.equal(tool.holder.position.x, originalX, 'wide view restores the original rest pose');
  });

  test(`${Tool.name}: mitten stays on shaft and stroke working point reaches the aim`, () => {
    globalThis.window = { devicePixelRatio: 1 };
    const view = new THREE.Group();
    const tool = new Tool(new THREE.Scene(), view);
    tool.take();
    const carried = tool.swing.children[0];
    assert.ok(tool.grip.position.length() < 1e-7, 'rotation pivot must be at the real grip');
    assert.equal(tool.world.getObjectByName('Right mitten gripping handle'), undefined);
    assert.equal(tool.world.getObjectByName('Tool bounced skylight'), undefined);
    assert.ok(tool.holder.getObjectByName('Tool bounced skylight'));
    // Follow the centre of the wrist into the sleeve. Bounding-box overlap is
    // insufficient here: the former rotated ellipsoids left a visible gap.
    tool.grip.updateMatrixWorld(true);
    const arm = tool.grip.children.filter(o => o.isMesh);
    const inside = (point, mesh) => {
      const local = point.clone().applyMatrix4(mesh.matrix.clone().invert());
      if (mesh.geometry.type === 'SphereGeometry') return local.lengthSq() <= 1;
      const p = mesh.geometry.parameters;
      if (Math.abs(local.y) > p.height / 2) return false;
      const t = local.y / p.height + 0.5;
      const radius = THREE.MathUtils.lerp(p.radiusBottom, p.radiusTop, t);
      return local.x * local.x + local.z * local.z <= radius * radius;
    };
    const path = [[0.035, -0.002, 0.028], [0.075, -0.089, 0.049], [0.19, -0.39, 0.11]];
    for (let segment = 0; segment < path.length - 1; segment++) for (let i = 0; i <= 40; i++) {
      const point = new THREE.Vector3(...path[segment]).lerp(new THREE.Vector3(...path[segment + 1]), i / 40);
      assert.ok(arm.some(mesh => inside(point, mesh)), `gap in wrist/sleeve at ${point.toArray()}`);
    }
    const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.01, 12);
    for (const cross of [0.55, 1]) for (const amp of [0.92, 1.08]) {
      tool._rest();
      tool.trySwing(Tool === Axe ? 'chop' : 'mine');
      tool.cross = cross; tool.amp = amp;
      tool.update(tool.dur * tool.strokes[tool.kind].impact, () => true);
      view.updateMatrixWorld(true);
      const shaft = carried.userData.grip.clone().applyMatrix4(carried.matrixWorld);
      assert.ok(shaft.distanceTo(tool.grip.getWorldPosition(new THREE.Vector3())) < 1e-6);
      const tip = carried.getWorldPosition(new THREE.Vector3()).project(camera);
      assert.ok(Math.abs(tip.x) < 0.19 && Math.abs(tip.y) < 0.19, `strike misses aim: ${tip.toArray()}`);
    }
  });
}
