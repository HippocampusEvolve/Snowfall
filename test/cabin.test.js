import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCabin,
  CABIN_DRAW_LIMIT,
  CABIN_TRI_LIMIT,
} from '../src/cabin-geometry.js';

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
