import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  buildCabin,
  cabinDoorSegment,
  CABIN_DRAW_LIMIT,
  CABIN_TRI_LIMIT,
} from '../src/cabin-geometry.js';
import { boundsOf } from '../src/props/parts.js';
import { booksParts } from '../src/props/books-geometry.js';
import { potParts } from '../src/props/pot-geometry.js';
import { fireplaceParts } from '../src/props/fireplace-geometry.js';

const LEGACY_SIZE = [8.117719205479085, 6.212149875036044, 9.6];
const CABIN = buildCabin();

test('изба детерминирована от семени', () => {
  assert.deepEqual(CABIN, buildCabin());
  assert.notDeepEqual(
    CABIN.meshes.logs.position,
    buildCabin({ seed: 72 }).meshes.logs.position
  );
});

test('в буферах избы нет NaN и битых индексов', () => {
  const { meshes } = CABIN;
  for (const mesh of Object.values(meshes)) {
    for (const key of ['position', 'normal', 'uv']) {
      for (const value of mesh[key]) assert.ok(Number.isFinite(value), `${mesh.name}.${key}`);
    }
    const vertices = mesh.position.length / 3;
    for (const index of mesh.index) {
      assert.ok(Number.isInteger(index) && index >= 0 && index < vertices, `${mesh.name}: индекс ${index}`);
    }
    assert.equal(mesh.position.length, mesh.normal.length, mesh.name);
    assert.equal(mesh.position.length / 3 * 2, mesh.uv.length, mesh.name);
    assert.equal(mesh.index.length % 3, 0, mesh.name);
  }
});

test('изба укладывается в бюджет геометрии и проходов', () => {
  const { stats } = CABIN;
  assert.ok(stats.trianglesWithSnow <= CABIN_TRI_LIMIT, `${stats.trianglesWithSnow} треугольников`);
  assert.ok(stats.drawCallsWithSnow <= CABIN_DRAW_LIMIT, `${stats.drawCallsWithSnow} проходов`);
  assert.ok(stats.materialCount <= CABIN_DRAW_LIMIT, `${stats.materialCount} материалов`);
  assert.equal(new Set(stats.materials).size, stats.materialCount);
});

test('габарит совпадает с прежним обмером до пяти сантиметров', () => {
  const { size } = CABIN.layout.bounds;
  size.forEach((value, i) => {
    assert.ok(Math.abs(value - LEGACY_SIZE[i]) <= 0.05, `${i}: ${value} против ${LEGACY_SIZE[i]}`);
  });
});

test('дверной проём не уже 0.8 м и не ниже 2 м', () => {
  const { door } = CABIN.layout;
  assert.ok(door.x1 - door.x0 >= 0.8, `ширина ${door.x1 - door.x0}`);
  assert.ok(door.y1 - door.y0 >= 2, `высота ${door.y1 - door.y0}`);
});

test('коллайдеры закрывают стены и оставляют дверь свободной', () => {
  const { room, door, wallColliders } = CABIN.layout;
  const bySide = Object.fromEntries(wallColliders.map((c) => [c.side, c]));
  assert.deepEqual(
    [bySide.left.x1, bySide.left.z1, bySide.left.x2, bySide.left.z2],
    [room.x0, room.z0, room.x0, room.z1]
  );
  assert.deepEqual(
    [bySide.right.x1, bySide.right.z1, bySide.right.x2, bySide.right.z2],
    [room.x1, room.z0, room.x1, room.z1]
  );
  assert.deepEqual(
    [bySide.back.x1, bySide.back.z1, bySide.back.x2, bySide.back.z2],
    [room.x0, room.z0, room.x1, room.z0]
  );
  assert.equal(bySide['front-left'].x2, door.x0);
  assert.equal(bySide['front-right'].x1, door.x1);
  assert.ok(door.centerX - door.x0 > bySide['front-left'].r);
  assert.ok(door.x1 - door.centerX > bySide['front-right'].r);
  for (const collider of wallColliders) assert.ok(collider.r >= 0.18, collider.side);
});

test('closed door covers the whole opening without gaps between planks', () => {
  const { door } = CABIN.layout;
  const positions = CABIN.meshes.door.position;
  const intervals = [];
  for (let plank = 0; plank < 5; plank++) {
    const p = positions.slice(plank * 24 * 3, (plank + 1) * 24 * 3);
    const xs = Array.from(p).filter((_, i) => i % 3 === 0).map(x => x + door.hingeX);
    const ys = Array.from(p).filter((_, i) => i % 3 === 1);
    assert.ok(Math.min(...ys) <= door.y0 && Math.max(...ys) >= door.y1);
    intervals.push([Math.min(...xs), Math.max(...xs)]);
  }
  assert.ok(intervals[0][0] <= door.x0);
  assert.ok(intervals.at(-1)[1] >= door.x1);
  for (let i = 1; i < intervals.length; i++) assert.ok(intervals[i][0] <= intervals[i - 1][1]);
});

test('door collider covers the complete leaf and swings outside', () => {
  const { door } = CABIN.layout;
  for (const angle of [0, 0.5, 1.2, 2.2]) {
    const c = cabinDoorSegment(door, angle);
    assert.ok(Math.abs(Math.hypot(c.x2 - c.x1, c.z2 - c.z1) - door.leafWidth) < 1e-9);
    assert.ok(c.z1 > door.wallZ && c.z2 >= c.z1);
  }
  const c = cabinDoorSegment(door);
  assert.ok(c.x2 <= door.x0 && c.x1 >= door.x1);
});

test('shelf touches the real log envelope and stays clear of the fireplace', () => {
  const { interior } = CABIN.layout;
  const { shelf, inner, stove } = interior;
  const p = CABIN.meshes.logs.position;
  let measuredBack = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (Math.abs(p[i + 2] - CABIN.layout.room.z0) < 0.21) measuredBack = Math.max(measuredBack, p[i + 2]);
  }
  assert.ok(Math.abs(shelf.z - shelf.depth / 2 - measuredBack) < 1e-9);
  assert.equal(inner.z0, measuredBack);
  const fireplace = boundsOf(fireplaceParts());
  assert.ok(shelf.x - shelf.width / 2 > stove.x + fireplace.max[0] + 0.1);
  assert.ok(stove.z + fireplace.min[2] >= inner.z0 - 1e-9);
});

test('books fit on the tabletop, pot is beside the podium, bed clears logs', () => {
  const { interior: p } = CABIN.layout;
  const books = boundsOf(booksParts());
  const bx = (books.size[0] * Math.cos(0.12) + books.size[2] * Math.sin(0.12)) / 2;
  const bz = (books.size[0] * Math.sin(0.12) + books.size[2] * Math.cos(0.12)) / 2;
  assert.ok(Math.abs(p.books.x - p.table.x) + bx < 1.15 / 2);
  assert.ok(Math.abs(p.books.z - p.table.z) + bz < 0.75 / 2);
  assert.equal(p.table.topY, CABIN.layout.room.floorY + 0.755);
  const pot = boundsOf(potParts());
  assert.ok(p.pot.x - Math.hypot(pot.size[0], pot.size[2]) / 2 > p.stove.x + 1.18);
  assert.ok(p.bed.x + 0.531 < p.inner.x1);
  assert.ok(p.bed.z - 1.1 > p.inner.z0);
});

test('windows follow current wall planes and lamp suspension reaches the beam', () => {
  const { room, windows, interior, roof } = CABIN.layout;
  for (const w of windows) {
    const expected = w.wall === 'front' ? room.z1 : w.wall === 'back' ? room.z0 : w.wall === 'left' ? room.x0 : room.x1;
    assert.equal(w.fixed, expected);
    assert.ok(w.y0 - room.floorY > 0.8);
  }
  assert.equal(interior.lamp.topY, roof.undersideRidgeY);
  assert.ok(interior.lamp.topY > interior.lamp.y + 0.22);
});

function raycastCabin(cabin = CABIN) {
  const meshes = Object.entries(cabin.meshes).map(([name, data]) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
    geometry.setIndex(new THREE.BufferAttribute(data.index, 1));
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ side: name === 'glass' ? THREE.DoubleSide : THREE.FrontSide }));
    mesh.name = name;
    if (name === 'door') mesh.position.set(cabin.layout.door.hingeX, 0, cabin.layout.door.hingeZ);
    mesh.updateMatrixWorld(true);
    return mesh;
  });
  const ray = new THREE.Raycaster();
  return (origin, target, filter = () => true) => {
    const delta = target.clone().sub(origin);
    ray.set(origin, delta.clone().normalize());
    ray.far = delta.length() + 0.3;
    return ray.intersectObjects(meshes.filter(filter), false);
  };
}

test('rays from inside cannot escape between crowns or through window surrounds', () => {
  const cast = raycastCabin();
  const { room } = CABIN.layout;
  const cx = (room.x0 + room.x1) / 2, cz = (room.z0 + room.z1) / 2;
  for (const wall of ['front', 'back', 'left', 'right']) {
    const horizontal = wall === 'front' || wall === 'back';
    const a0 = horizontal ? room.x0 : room.z0, a1 = horizontal ? room.x1 : room.z1;
    for (let u = 0; u < 26; u++) for (let v = 0; v < 24; v++) {
      const a = a0 + 0.22 + (a1 - a0 - 0.44) * u / 25;
      const y = room.floorY + 0.055 + 2.85 * v / 23;
      const target = new THREE.Vector3(horizontal ? a : wall === 'left' ? room.x0 : room.x1,
        y, horizontal ? (wall === 'front' ? room.z1 : room.z0) : a);
      for (const offset of [-0.8, 0.8]) {
        const origin = new THREE.Vector3(cx + offset, room.floorY + 1.55, cz - offset);
        assert.ok(cast(origin, target).length, wall + ' leaks at ' + target.toArray());
      }
    }
  }
});

test('window panes remain transparent openings while every surrounding edge is sealed', () => {
  const cast = raycastCabin();
  for (const w of CABIN.layout.windows) {
    const horizontal = w.wall === 'front' || w.wall === 'back';
    const outward = new THREE.Vector3(w.wall === 'left' ? -1 : w.wall === 'right' ? 1 : 0, 0,
      w.wall === 'back' ? -1 : w.wall === 'front' ? 1 : 0);
    const at = (a, y) => new THREE.Vector3(horizontal ? a : w.fixed, y, horizontal ? w.fixed : a);
    const pane = at(w.center + 0.2, w.centerY + 0.2);
    const eye = pane.clone().addScaledVector(outward, -0.6);
    assert.equal(cast(eye, pane, mesh => mesh.name !== 'glass' && mesh.name !== 'door').length, 0, w.wall + ' pane blocked');
    assert.ok(cast(eye, pane, mesh => mesh.name === 'glass').length, w.wall + ' glass missing');
    for (let u = 0; u < 21; u++) for (let v = 0; v < 25; v++) {
      const a = w.center - w.width / 2 - 0.22 + (w.width + 0.44) * u / 20;
      const y = w.y0 - 0.24 + (w.height + 0.48) * v / 24;
      const target = at(a, y);
      assert.ok(cast(target.clone().addScaledVector(outward, -0.6), target).length, w.wall + ' frame leaks at ' + [a, y]);
    }
  }
});

test('wall seal leaves open door clear and roof/floor joints stop vertical rays', () => {
  const cast = raycastCabin();
  const { room, door } = CABIN.layout;
  const doorway = new THREE.Vector3(door.centerX, room.floorY + 1.2, room.z1);
  assert.equal(cast(doorway.clone().add(new THREE.Vector3(0, 0, -0.6)), doorway,
    mesh => mesh.name !== 'door').length, 0);
  for (let u = 0; u < 22; u++) for (let v = 0; v < 22; v++) {
    const origin = new THREE.Vector3(room.x0 + 0.3 + (room.x1 - room.x0 - 0.6) * u / 21,
      room.floorY + 1.6, room.z0 + 0.3 + (room.z1 - room.z0 - 0.6) * v / 21);
    assert.ok(cast(origin, origin.clone().setY(CABIN.layout.roof.topY + 0.2)).length, 'roof leak at ' + origin.toArray());
    assert.ok(cast(origin, origin.clone().setY(room.floorY - 0.2)).length, 'floor leak at ' + origin.toArray());
  }
});
