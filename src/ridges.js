import * as THREE from 'three';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';

// Дальние горные хребты — два кольца зубчатых силуэтов за пеленой тумана.
export function createRidges() {
  const group = new THREE.Group();
  const mats = [];
  const noise = new ImprovedNoise();

  const make = (radius, baseH, amp, color, seed) => {
    const N = 220;
    const posArr = new Float32Array((N + 1) * 2 * 3);
    const idx = [];
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const cx = Math.cos(a);
      const sz = Math.sin(a);
      let h = 0;
      h += Math.abs(noise.noise(cx * 2.3 + seed, sz * 2.3, seed)) * amp;
      h += Math.abs(noise.noise(cx * 6.1, sz * 6.1 + seed, seed * 2.0)) * amp * 0.35;
      const o = i * 6;
      posArr[o] = cx * radius;
      posArr[o + 1] = baseH + h;
      posArr[o + 2] = sz * radius;
      posArr[o + 3] = cx * radius;
      posArr[o + 4] = -60;
      posArr[o + 5] = sz * radius;
      if (i < N) {
        const k = i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geo.setIndex(idx);

    const mat = new THREE.MeshBasicMaterial({
      color,
      fog: false,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -1; // после звёзд — хребет их заслоняет
    mesh.frustumCulled = false;
    group.add(mesh);
    mats.push(mat);
  };

  // дальний — светлее (атмосферная дымка), ближний — темнее
  make(760, -15, 200, 0x18243f, 9.2);
  make(640, -20, 135, 0x0d1730, 3.7);

  return { group, mats };
}
