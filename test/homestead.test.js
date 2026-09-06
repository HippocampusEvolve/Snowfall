import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Homestead } from '../src/homestead.js';
import {
  MEMBER, groundedPlacement, memberBounds, canPlaceMember, validateHomestead, intersectsObstacles, worldPoint,
} from '../src/homestead-rules.js';

const flat = () => 0;
const make = (options = {}) => new Homestead(new THREE.Scene(), { groundAt: flat, ...options });
const beam = (x, z, row = 0, yaw = 0) => ({ form: 'beam', x, y: 0.14 + row * 0.28, z, yaw });
const cameraAt = (position, aim) => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 100);
  camera.position.set(...position);
  camera.lookAt(...aim);
  camera.updateMatrixWorld(true);
  return camera;
};

function buildWalls(home) {
  for (let row = 0; row < 8; row++) {
    assert.ok(home.place('timber', beam(-1.2, 0, row, Math.PI / 2)));
    assert.ok(home.place('timber', beam(1.2, 0, row, Math.PI / 2)));
    assert.ok(home.place('timber', beam(0, -1.2, row)));
  }
}

test('one carried timber adds one visible beam; stacking needs an existing crown', () => {
  const home = make();
  assert.equal(home.place('timber', beam(0, 0, 1)), null);
  const first = home.place('timber', beam(0, 0));
  assert.ok(first);
  assert.equal(home.entries.length, 1);
  assert.equal(home.group.children.length, 1);
  assert.equal(home.place('timber', beam(0, 0)), null, 'no duplicate hidden member');
  assert.ok(home.place('timber', beam(0, 0, 1)));
  assert.equal(home.entries.length, 2);
  assert.equal(home.remove(first), null, 'cannot take away the loaded foundation');
  assert.equal(home.remove(home.entries[1]), 'timber');
  assert.equal(home.remove(first), 'timber');
  assert.equal(home.entries.length, 0);
  assert.equal(home.colliders.length, 0);
});

test('placement checks both beam ends, snowbanks, protected objects and player body', () => {
  assert.equal(groundedPlacement('timber', 0, 0, 0, (x) => x > 0 ? 0.4 : 0), null);
  const home = make({ avoid: [{ x: 1.6, z: 0, r: 0.6 }] });
  assert.equal(home.place('timber', beam(0, 0)), null, 'beam end touches protected area');
  assert.equal(make().place('timber', beam(0, 0), { playerPosition: { x: 0, y: 0, z: 0 } }), null);
  assert.equal(make({ groundAt: (x) => Math.abs(x) < 0.3 ? 0.4 : 0 }).place('timber', beam(0, 0)), null);
  const roof = { kind: 'timber', form: 'roof', x: 0, y: 2.29, z: 0, yaw: 0 };
  assert.equal(canPlaceMember(roof, [], { groundAt: flat }), false);
});

test('corners join only at their ends and cannot intersect an existing wall middle', () => {
  const home = make();
  assert.ok(home.place('timber', beam(0, 0)));
  assert.ok(home.place('timber', beam(1.2, 1.2, 0, Math.PI / 2)));
  assert.equal(home.place('timber', beam(0, 0, 0, Math.PI / 2)), null);
});

test('three walls and a supported lintel leave a traversable door; roof grows board by board', () => {
  const home = make();
  buildWalls(home);
  const lintel = home.place('timber', beam(0, 1.2, 7));
  assert.ok(lintel, 'beam bridges doorway on both side walls');
  const doorway = new THREE.Vector3(0, 0, 1.2);
  assert.equal(home.resolve(doorway), false, 'opening has no invisible prefab collider');
  assert.deepEqual(doorway.toArray(), [0, 0, 1.2]);
  assert.equal(home.shelterAt({ x: 0, y: 1.6, z: 0 }), 0, 'walls alone cannot stop falling snow');
  assert.equal(home.place('timber', { form: 'roof', x: 1.2, y: 2.29, z: 0, yaw: 0 }), null,
    'one supported end is insufficient');
  for (let i = -3; i <= 3; i++) {
    const piece = home.place('timber', { form: 'roof', x: 0, y: 2.29, z: i * 0.36, yaw: 0 });
    assert.ok(piece);
  }
  assert.ok(home.shelterAt({ x: 0, y: 1.6, z: 0 }) > 0.75);
  const sideTop = home.entries.find((p) => p.form === 'beam' && p.x === -1.2 && p.y > 2);
  assert.equal(home.remove(sideTop), null, 'roof bearing cannot be removed');
  assert.equal(home.floorHeightAt(0, 0, 0.4), null, 'floor query must not teleport player to roof');
  assert.ok(Math.abs(home.floorHeightAt(0, 0, 3) - 2.34) < 1e-9);
});

test('masonry pieces keep visible seams and need support under their full footprint', () => {
  const home = make();
  const first = home.place('block', { x: 0, y: 0.15, z: 0, yaw: 0 });
  assert.ok(first);
  assert.equal(home.place('block', { x: 0.3, y: 0.45, z: 0, yaw: 0 }), null);
  assert.ok(home.place('block', { x: 0.6, y: 0.15, z: 0, yaw: 0 }));
  assert.ok(home.place('block', { x: 0.3, y: 0.45, z: 0, yaw: 0 }), 'bond spans two supporting blocks');
  first.mesh.geometry.computeBoundingBox();
  const size = first.mesh.geometry.boundingBox.getSize(new THREE.Vector3());
  assert.ok(Math.abs(size.x - MEMBER.block.length) < 1e-6);
  assert.ok(Math.abs(size.y - MEMBER.block.height) < 1e-6);
  assert.notEqual(first.mesh, home.entries[1].mesh, 'individual masonry members remain separate');
  const normals = first.mesh.geometry.getAttribute('normal');
  assert.ok(Array.from({ length: normals.count }, (_, i) => i)
    .some(i => Math.abs(normals.getY(i)) > 0.5 && Math.abs(normals.getZ(i)) > 0.5),
  'the bevel, rather than an air slit, makes the visible masonry joint');
});

test('F target uses actual ray hits to stack beams and install supported roof boards', () => {
  const home = make();
  const camera = cameraAt([0, 1.6, 2.2], [0, 0, 0]);
  const first = home.target({ point: new THREE.Vector3(0, 0, 0), normal: new THREE.Vector3(0, 1, 0) }, camera);
  assert.ok(first);
  assert.equal(first.yaw, 0);
  assert.ok(home.place('timber', first));
  const stacked = home.target(null, cameraAt([0, 1.6, 2.2], [0, 0.27, 0]));
  assert.ok(stacked);
  assert.ok(Math.abs(stacked.y - (first.y + MEMBER.beam.height)) < 1e-9);

  const shelter = make();
  buildWalls(shelter);
  const roofCamera = cameraAt([0, 1.65, 0], [-1.2, 2.235, 0]);
  const roof = shelter.target(null, roofCamera);
  assert.ok(roof);
  assert.equal(roof.form, 'roof');
  assert.ok(shelter.place('timber', roof));
  const nextRoof = shelter.target(null, cameraAt([0, 1.65, 0], [0, 2.29, 0.14]));
  assert.ok(nextRoof);
  assert.equal(nextRoof.form, 'roof');
  assert.ok(Math.abs(nextRoof.z - roof.z) > 0.35);
  const hit = shelter.pickTarget(roofCamera);
  assert.equal(hit.kind, 'construction');
  assert.ok(hit.dist <= 3.4);
});

test('a saved construction round-trips; invalid or floating snapshots leave live world intact', () => {
  const home = make();
  buildWalls(home);
  home.place('timber', { form: 'roof', x: 0, y: 2.29, z: 0, yaw: 0 });
  const snapshot = JSON.parse(JSON.stringify(home.serialize()));
  assert.equal(snapshot.pieces.length, 25);
  assert.equal(snapshot.pieces.some((p) => 'mesh' in p || 'collider' in p), false);
  const restored = make();
  assert.equal(restored.restore({ ...snapshot, pieces: [...snapshot.pieces].reverse() }), true);
  assert.deepEqual(restored.serialize().pieces.map((p) => p.id).sort((a, b) => a - b),
    snapshot.pieces.map((p) => p.id));
  assert.equal(restored.entries.length, 25);
  const before = restored.serialize();
  assert.equal(restored.restore({ version: 1, pieces: [{ id: 80, kind: 'timber', ...beam(7, 7, 3) }] }), false);
  assert.equal(restored.restore({ ...snapshot, pieces: [snapshot.pieces[0], snapshot.pieces[0]] }), false);
  assert.equal(validateHomestead({ version: 1, pieces: [{ id: 1, kind: 'timber', x: NaN, y: 0, z: 0 }] }, { groundAt: flat }), null);
  assert.deepEqual(restored.serialize(), before);
});

test('collision moves even a body exactly inside a beam and allows standing on its top', () => {
  const home = make();
  const piece = home.place('timber', beam(0, 0));
  const body = new THREE.Vector3(0, 0, 0);
  assert.equal(home.resolve(body), true);
  assert.ok(Math.abs(body.z) >= 0.439);
  const atop = new THREE.Vector3(0, memberBounds(piece).y1, 0);
  assert.equal(home.resolve(atop), false);
});

test('snow can bury a saved foundation without erasing it or allowing fresh pieces inside terrain', () => {
  const home = make();
  home.place('timber', beam(0, 0));
  home.place('timber', beam(0, 0, 1));
  const buried = make({ groundAt: () => 0.35 });
  assert.equal(buried.restore(home.serialize()), true);
  assert.equal(buried.entries.length, 2);
  assert.equal(buried.place('timber', beam(4, 0)), null);
  const malformed = home.serialize();
  malformed.pieces[0].yaw = 0.4;
  assert.equal(buried.restore(malformed), false, 'do not silently rotate malformed saved pieces');
});

test('live tree colliders block the whole beam footprint and felling unlocks placement', () => {
  const colliders = [{ x: 0.7, z: 0.05, r: 0.2 }];
  const home = make({ obstacles: () => colliders });
  const record = beam(0, 0);
  assert.equal(home.place('timber', record), null, 'tree intersects middle, not either endpoint');
  const camera = cameraAt([0, 1.6, 2.2], [0, 0, 0]);
  const surface = { point: new THREE.Vector3(0, 0, 0), normal: new THREE.Vector3(0, 1, 0) };
  assert.equal(home.target(surface, camera), null);
  colliders.splice(0, 1);
  const proposal = home.target(surface, camera);
  assert.ok(proposal, 'same position is valid once the live trunk collider is gone');
  assert.ok(home.place('timber', proposal));
});

test('segment obstacles are checked through their middle and can clear vertically', () => {
  const record = { kind: 'timber', ...beam(0, 0) };
  const wall = { x1: -2, z1: -2, x2: 2, z2: 2, r: 0.12 };
  assert.equal(intersectsObstacles(record, [wall]), true);
  assert.equal(intersectsObstacles(record, [{ ...wall, y0: 0.28, y1: 2 }]), false,
    'touching the bottom of an obstacle does not overlap its body');
  assert.equal(intersectsObstacles(record, [{ ...wall, y0: -1, y1: 0 }]), false,
    'touching a support surface does not overlap it');
  assert.equal(intersectsObstacles(record, [{ x1: -3, z1: 1, x2: 3, z2: 1, r: 0.2 }]), false);
  const turned = { ...record, yaw: Math.PI / 2 };
  assert.equal(intersectsObstacles(turned, [{ x: 0, z: 0.7, r: 0.2 }]), true);
});

test('roof spans above a low pile and restoration ignores newly regrown obstacles', () => {
  const colliders = [];
  const home = make({ obstacles: () => colliders });
  buildWalls(home);
  colliders.push({ x: 0, z: 0, r: 0.45, y0: 0, y1: 0.6 });
  const roof = { form: 'roof', x: 0, y: 2.29, z: 0, yaw: 0 };
  assert.ok(home.place('timber', roof));
  const snapshot = home.serialize();
  colliders.push({ x: -1.2, z: 0, r: 0.3 });
  const restored = make({ obstacles: () => colliders });
  assert.equal(restored.restore(snapshot), true, 'regrowth never erases an already saved home');
  assert.equal(restored.entries.length, snapshot.pieces.length);
  assert.equal(restored.place('timber', beam(-1.2, 0, 8, Math.PI / 2)), null,
    'the new crown is still refused through the regrown tree');
});

test('a foundation settles into sloping snow across its footprint without an airborne end', () => {
  // Measured QA slope: old max-height placement left about 8 cm under one end.
  const groundAt = (x, z) => 0.252825 + (x - 9) * (0.29130 - 0.21435) / 2.24 + (z + 5.0218) * 0.03;
  const home = make({ groundAt });
  const record = groundedPlacement('timber', 9, -5.0218, 0, groundAt);
  assert.ok(record);
  const entry = home.place('timber', record);
  assert.ok(entry);
  const bottom = memberBounds(entry).y0;
  entry.mesh.geometry.computeBoundingBox();
  const visibleBottom = entry.y + entry.mesh.geometry.boundingBox.min.y;
  for (let x = -1.2; x <= 1.2 + 1e-8; x += 0.12) for (const z of [-0.14, 0, 0.14]) {
    const p = worldPoint(entry, x, z), ground = groundAt(p.x, p.z);
    assert.ok(visibleBottom <= ground + 1e-6, 'even the rendered lower edge touches/enters the snow');
    assert.ok(ground - bottom <= 0.17, 'high edge is only shallowly embedded');
  }
  const oldFloating = { ...record, x: 14, y: groundAt(14, -5.0218) + 0.14 + 0.08 };
  assert.equal(home.place('timber', oldFloating), null, 'an 8 cm air gap is no longer a valid support');
  const next = home.place('timber', { ...record, y: record.y + MEMBER.beam.height });
  assert.ok(next, 'successive crown stays supported at the seated elevation');
  const restored = make({ groundAt: (x, z) => groundAt(x, z) + 0.35 });
  assert.equal(restored.restore(home.serialize()), true, 'later snowfall can still bury the foundation');
});

test('stone foundations also seat into snow while steep banks and true floating members are refused', () => {
  const groundAt = (x, z) => 0.2 + x * 0.15 + z * 0.1;
  const block = groundedPlacement('block', 0, 0, 0, groundAt);
  assert.ok(block);
  assert.ok(make({ groundAt }).place('block', block));
  assert.ok(memberBounds(block).y0 < groundAt(-0.3, -0.15));
  assert.equal(groundedPlacement('timber', 0, 0, 0, x => x * 0.3), null);
  assert.equal(make().place('timber', { x: 0, y: 0.22, z: 0, yaw: 0 }), null);
  assert.equal(make().restore({ version: 1, pieces: [{ kind: 'timber', id: 1, x: 0, y: 1, z: 0, yaw: 0 }] }), false);
});

test('restored construction can be cloned for scene warm-up without circular userData', () => {
  const first = make();
  first.place('timber', beam(0, 0));
  first.place('timber', beam(0, 0, 1));
  const restored = make();
  assert.equal(restored.restore(first.serialize()), true);
  for (const entry of restored.entries) {
    const clone = entry.mesh.clone();
    assert.equal(clone.geometry, entry.mesh.geometry);
    assert.equal(clone.material, entry.mesh.material);
    assert.doesNotThrow(() => JSON.stringify(entry.mesh.userData));
    assert.doesNotThrow(() => JSON.stringify(entry.mesh.toJSON()));
  }
  assert.equal(restored.group.clone().children.length, 2);
  const camera = cameraAt([0, 1.6, 2.2], [0, 0.5, 0]);
  const hit = restored.pickTarget(camera);
  assert.equal(hit.ref, restored.entries[1], 'picking still resolves the original entry after restore');
  assert.equal(restored.remove(hit.ref), 'timber');
  assert.equal(restored.entries.length, 1);
});

test('a jump into a roof is clamped downward without pushing the player toward its edge', () => {
  const home = make();
  buildWalls(home);
  assert.ok(home.place('timber', { form: 'roof', x: 0, y: 2.29, z: 0, yaw: 0 }));
  const body = new THREE.Vector3(0.15, 0.7, 0.05);
  const beforeXZ = [body.x, body.z];
  const underside = home.ceilingHeightAt(body.x, body.z, body.y, 0.3);
  assert.ok(Math.abs(underside - 2.24) < 1e-9);
  assert.equal(home.resolve(body, 0.3, 1.7), true);
  assert.deepEqual([body.x, body.z], beforeXZ);
  assert.ok(Math.abs(body.y + 1.7 - (underside - 0.02)) < 1e-9);
  assert.equal(home.resolve(body, 0.3, 1.7), false, 'resting at the ceiling does not oscillate');
  assert.equal(home.ceilingHeightAt(0, 0.6, 0, 0.3), null, 'clear space beside the board has no ceiling');
  assert.ok(home.ceilingHeightAt(0, 0.25, 0, 0.3) !== null, 'the capsule edge also sees the underside');

  const onRoof = new THREE.Vector3(0, 2.34, 0);
  const before = onRoof.clone();
  assert.equal(home.ceilingHeightAt(onRoof.x, onRoof.z, onRoof.y), null);
  assert.equal(home.resolve(onRoof, 0.3, 1.7), false);
  assert.deepEqual(onRoof, before, 'walking on the roof keeps the player above it');
  assert.ok(Math.abs(home.floorHeightAt(0, 0, 2.74) - 2.34) < 1e-9);
});

test('actual wall triangles close horizontal crown and masonry joints', () => {
  const ray = new THREE.Raycaster();
  ray.far = 4;
  for (const kind of ['timber', 'block']) {
    const home = make();
    const d = MEMBER[kind === 'timber' ? 'beam' : 'block'];
    for (let row = 0; row < 3; row++) assert.ok(home.place(kind,
      { x: 0, y: d.height / 2 + row * d.height, z: 0, yaw: 0 }));
    home.group.updateMatrixWorld(true);
    for (const fraction of [-0.9, -0.55, 0, 0.43, 0.9]) for (let joint = 1; joint <= 2; joint++) {
      for (const offset of [-0.003, 0, 0.003]) {
        ray.set(new THREE.Vector3(fraction * d.length / 2, joint * d.height + offset, 2),
          new THREE.Vector3(0, 0, -1));
        assert.ok(ray.intersectObjects(home.group.children, false).length > 0,
          `${kind}: no sky slit at joint ${joint}, x fraction ${fraction}, y offset ${offset}`);
      }
    }
  }
});

test('actual roof triangles close the seam between separately placed boards', () => {
  const home = make();
  buildWalls(home);
  for (const z of [-0.36, 0, 0.36]) assert.ok(home.place('timber',
    { form: 'roof', x: 0, y: 2.29, z, yaw: 0 }));
  const roofMeshes = home.entries.filter(entry => entry.form === 'roof').map(entry => entry.mesh);
  assert.equal(new Set(roofMeshes).size, 3);
  home.group.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  ray.far = 4;
  for (const x of [-1.2, -0.6, 0, 0.7, 1.2]) for (const joint of [-0.18, 0.18]) {
    for (const offset of [-0.003, 0, 0.003]) {
      ray.set(new THREE.Vector3(x, 4, joint + offset), new THREE.Vector3(0, -1, 0));
      assert.ok(ray.intersectObjects(roofMeshes, false).length > 0,
        `no roof opening at x ${x}, seam ${joint}, offset ${offset}`);
    }
  }
});
