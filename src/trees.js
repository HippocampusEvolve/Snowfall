import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Ели: инстансированные низкополигональные силуэты со снегом на верхних гранях.
export function createTrees(terrain, count = 190) {
  const group = new THREE.Group();

  // крона — ярусы конусов
  const layers = [
    [2.1, 3.0, 2.1],
    [1.65, 2.7, 3.8],
    [1.2, 2.4, 5.3],
    [0.7, 2.0, 6.6],
  ].map(([r, h, y]) => {
    const c = new THREE.ConeGeometry(r, h, 7);
    c.translate(0, y, 0);
    return c;
  });
  const foliageGeo = mergeGeometries(layers);

  const trunkGeo = new THREE.CylinderGeometry(0.14, 0.24, 2.2, 6);
  trunkGeo.translate(0, 1.1, 0);

  const foliageMat = new THREE.MeshStandardMaterial({
    color: 0x0e1a16,
    roughness: 0.98,
    metalness: 0.0,
  });
  // снег на ветках: подмешиваем холодный тон по мировой нормали вверх
  foliageMat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      `#include <normal_fragment_begin>
      {
        vec3 wN = inverseTransformDirection(normal, viewMatrix);
        float snowAmt = smoothstep(0.45, 0.9, wN.y);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.48, 0.6), snowAmt * 0.55);
      }`
    );
  };

  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x1d150e, roughness: 1.0 });

  const foliage = new THREE.InstancedMesh(foliageGeo, foliageMat, count);
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
  foliage.castShadow = true;
  foliage.receiveShadow = true;
  trunks.castShadow = true;

  const dummy = new THREE.Object3D();
  const placed = [];
  const obstacles = [];
  let i = 0;
  let guard = 0;
  while (i < count && guard++ < count * 30) {
    const a = Math.random() * Math.PI * 2;
    const r = 14 + Math.pow(Math.random(), 0.7) * 126;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    // не слишком плотно
    if (placed.some((p) => (p[0] - x) ** 2 + (p[1] - z) ** 2 < 14)) continue;
    placed.push([x, z]);

    const s = 0.6 + Math.random() * 0.9;
    obstacles.push({ x, z, r: 0.95 * s });
    dummy.position.set(x, terrain.getHeight(x, z) - 0.15, z);
    dummy.rotation.y = Math.random() * Math.PI * 2;
    dummy.scale.set(s * (0.9 + Math.random() * 0.25), s * (0.85 + Math.random() * 0.45), s * (0.9 + Math.random() * 0.25));
    dummy.updateMatrix();
    foliage.setMatrixAt(i, dummy.matrix);
    trunks.setMatrixAt(i, dummy.matrix);
    i++;
  }
  foliage.count = i;
  trunks.count = i;
  foliage.instanceMatrix.needsUpdate = true;
  trunks.instanceMatrix.needsUpdate = true;

  group.add(foliage, trunks);
  return { group, obstacles };
}
