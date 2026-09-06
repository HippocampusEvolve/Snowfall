import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaves } from '../src/caves.js';
import { meshChunk, sampleChunk, SW } from '../src/mesher.worker.js';

test('prefetched geology gives exactly the same mesh, including edits, caps and materials', () => {
  const caves = createCaves({ seed: 73, avoid: [] });
  const colH = Float32Array.from({ length: SW * SW }, (_, i) => Math.sin(i / SW) * 0.3);
  for (const cy of [-3, -1, 0]) {
    const job = { cx: 1, cy, cz: -2, colH };
    const samples = sampleChunk(job, caves);
    for (const capDepth of [0, 1.5]) for (const edit of [-2, 2]) {
      const edited = { ...job, capDepth, edits: [[3429, edit], [3430, edit]],
        editMaterials: edit > 0 ? [[3429, 3], [3430, 3]] : null };
      assert.deepEqual(meshChunk({ ...edited, samples }, caves), meshChunk(edited, caves));
    }
  }
});

test('meshing prefetched geology never recalculates cave noise', () => {
  const job = { cx: 0, cy: 0, cz: 0, colH: new Float32Array(SW * SW).fill(0.5) };
  const samples = sampleChunk(job, { sdf: () => 10, materialAt: () => 0 });
  const unavailable = { sdf() { assert.fail('noise on the stroke path'); },
    materialAt() { assert.fail('geology on the stroke path'); } };
  assert.ok(meshChunk({ ...job, samples, edits: [[3429, -2]] }, unavailable));
});
