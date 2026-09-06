import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Footprints, createCircleStampMaterial } from '../src/footprints.js';
import { createSnowMaterial, createDiggerMaterial } from '../src/snowmaterial.js';

test('smooth circles use spare B channel without adding false tread to either footprint map', () => {
  const circle = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), createCircleStampMaterial());
  const boot = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
  const writes = [];
  const field = Object.create(Footprints.prototype);
  Object.assign(field, { circleQuad: circle, _coarse: 'coarse', _hi: 'detail',
    _showOnly(mesh) { this.current = mesh; }, _inWindow: () => true,
    _renderTo(target) { writes.push({ target, channels: this.current.material.color.toArray(), strength: this.current.material.opacity }); },
  });
  field._stampMesh(circle, 2, -9, 0.09);
  assert.deepEqual(writes, [
    { target: 'coarse', channels: [0, 0, 1], strength: 0.09 },
    { target: 'detail', channels: [0, 0, 1], strength: 0.09 },
  ]);
  writes.length = 0;
  field._stampMesh(boot, 2, -9);
  assert.deepEqual(writes, [
    { target: 'coarse', channels: [1, 0.26, 0], strength: 1 },
    { target: 'detail', channels: [1, 0, 0], strength: 1 },
  ]);
  writes.length = 0;
  field._stampMesh(circle, 2, -9, 0.4, true);
  assert.deepEqual(writes, [{ target: 'detail', channels: [0, 0, 1], strength: 0.4 }], 'recenter replays the same channel');
});

test('all snow surfaces read melt colour and depth while detailed normals remain footprint-only', () => {
  const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const footprints = { texture, area: 160, hiUniform: { value: texture },
    hiCenterUniform: { value: new THREE.Vector2() }, hiArea: 24 };
  const textures = { map: texture, normalMap: texture, roughnessMap: texture };
  const compile = material => {
    const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader };
    material.onBeforeCompile(shader);
    return shader;
  };
  const base = compile(createSnowMaterial({ footprints, textures, mode: 'base' }).material);
  assert.match(base.fragmentShader, /max\(max\(packedTrail\.r, packedTrail\.g\), packedTrail\.b\)/);
  const patch = compile(createSnowMaterial({ footprints, textures, mode: 'patch', heightTex: texture }).material);
  assert.match(patch.vertexShader, /max\(max\(t\.r, t\.g\), t\.b\)/, 'melt still displaces snow');
  const digger = compile(createDiggerMaterial({ footprints, textures, heightTex: texture }));
  for (const shader of [patch, digger]) {
    assert.match(shader.fragmentShader, /float trailDepthAt[\s\S]*?max\(max\(t\.r, t\.g\), t\.b\)/);
    assert.match(shader.fragmentShader, /float trailHiAt\(vec2 uv\)\s*\{[^}]*texture2D\(uTrailHi, uv\)\.r;/,
      'melt quantization must not enter the amplified tread normal');
    assert.match(shader.fragmentShader, /oldCircleFade/, 'legacy saved R/G circles are suppressed under renewed heat');
  }
});
