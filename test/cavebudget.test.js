import test from 'node:test';
import assert from 'node:assert/strict';

import { createCaves, Y_FLOOR } from '../src/caves.js';
import { meshChunk, VN, VS, SW } from '../src/mesher.worker.js';
import {
  CAVE_LOAD_RADIUS,
  SURFACE_LOAD_RADIUS,
  mergeChunkParts,
} from '../src/cavebudget.js';
import { WORLD_SEED } from '../src/seed.js';

const CHUNK = VN * VS;
const AVOID = [
  { x: -4.5, z: -13, r: 9 },
  { x: 2.5, z: -9, r: 6 },
  { x: 0, z: 0, r: 14 },
];

const flatColumn = new Float32Array(SW * SW);

// Та же редкая проверка приповерхностной полосы, что в Digger._caveNear.
function cutsSurface(caves, cx, cz) {
  for (let i = 0; i <= VN; i += VN / 2) {
    const x = (cx * VN + i) * VS;
    for (let k = 0; k <= VN; k += VN / 2) {
      const z = (cz * VN + k) * VS;
      for (const y of [-1, 1]) {
        if (caves.sdf(x, y, z, -y) < 2) return true;
      }
    }
  }
  return false;
}

function boundingSphere(position) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < position.length; i += 3) {
    const x = position[i], y = position[i + 1], z = position[i + 2];
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const x = (minX + maxX) / 2, y = (minY + maxY) / 2, z = (minZ + maxZ) / 2;
  let radius = 0;
  for (let i = 0; i < position.length; i += 3) {
    radius = Math.max(radius, Math.hypot(position[i] - x, position[i + 1] - y, position[i + 2] - z));
  }
  return { x, y, z, radius };
}

// Камера спавна смотрит вдоль -Z: FOV 75 градусов, глаз на высоте 1.7 м.
function inSpawnFrustum(s) {
  const depth = -s.z;
  const y = s.y - 1.7;
  const va = (75 / 2) * Math.PI / 180;
  const ha = Math.atan(Math.tan(va) * 16 / 9);
  return depth - 0.1 >= -s.radius
    && depth * Math.sin(ha) - Math.abs(s.x) * Math.cos(ha) >= -s.radius
    && depth * Math.sin(va) - Math.abs(y) * Math.cos(va) >= -s.radius;
}

test('пещеры у спавна укладываются в бюджет кадра без three', { timeout: 30000 }, () => {
  const caves = createCaves({ seed: WORLD_SEED, avoid: AVOID });
  const columns = new Map();
  const rad = Math.ceil(SURFACE_LOAD_RADIUS / CHUNK);
  for (let cz = -rad; cz <= rad; cz++) {
    for (let cx = -rad; cx <= rad; cx++) {
      const dist = Math.hypot((cx + 0.5) * CHUNK, (cz + 0.5) * CHUNK);
      if (dist > SURFACE_LOAD_RADIUS) continue;
      const cut = cutsSurface(caves, cx, cz);
      const top = cut ? 0 : -2;
      if (dist > CAVE_LOAD_RADIUS && !cut) continue;
      for (let cy = Math.floor(Y_FLOOR / CHUNK); cy <= top; cy++) {
        if (dist > CAVE_LOAD_RADIUS && cy < -1) continue;
        const out = meshChunk({ cx, cy, cz, colH: flatColumn, edits: null }, caves);
        if (!out) continue;
        const key = `${cx}|${cz}`;
        if (!columns.has(key)) columns.set(key, []);
        columns.get(key).push(out);
      }
    }
  }

  let meshes = 0;
  let triangles = 0;
  for (const parts of columns.values()) {
    const merged = mergeChunkParts(parts);
    assert.equal(merged.material.length, merged.position.length / 3);
    assert.ok([...merged.material].every((v) => v >= 0 && v <= 3));
    if (!inSpawnFrustum(boundingSphere(merged.position))) continue;
    meshes++;
    triangles += merged.index.length / 3;
  }
  console.log(`      пещеры у спавна: ${meshes} мешей, ${triangles} треугольников`);
  assert.ok(meshes <= 40, `в кадре ${meshes} мешей вместо не более 40`);
  assert.ok(triangles <= 250000, `в кадре ${triangles} треугольников вместо не более 250000`);
});
