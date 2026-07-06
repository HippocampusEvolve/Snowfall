import * as THREE from 'three';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';
import { createSnowMaterial, loadSnowTextures, SNOW_CONST } from './snowmaterial.js';

// Базовый снежный террейн + запечённая heightmap для деформируемого патча.
export class Terrain {
  constructor(footprints, maxAnisotropy = 4) {
    this.noise = new ImprovedNoise();

    const size = SNOW_CONST.WORLD;
    const seg = SNOW_CONST.HN - 1; // 240
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, this.getHeight(pos.getX(i), pos.getZ(i)));
    }
    geo.computeVertexNormals();

    // heightmap: та же сетка, что и вершины (241²), полуплавающая точность
    const N = SNOW_CONST.HN;
    const data = new Uint16Array(N * N);
    for (let j = 0; j < N; j++) {
      const z = -size / 2 + (j * size) / seg;
      for (let i = 0; i < N; i++) {
        const x = -size / 2 + (i * size) / seg;
        data[j * N + i] = THREE.DataUtils.toHalfFloat(this.getHeight(x, z));
      }
    }
    this.heightTex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.HalfFloatType);
    this.heightTex.minFilter = THREE.LinearFilter;
    this.heightTex.magFilter = THREE.LinearFilter;
    this.heightTex.needsUpdate = true;

    this.textures = loadSnowTextures(maxAnisotropy);
    const { material, uniforms } = createSnowMaterial({
      footprints,
      textures: this.textures,
      mode: 'base',
    });
    this.uniforms = uniforms;

    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.receiveShadow = true;
  }

  getHeight(x, z) {
    let h = 0;
    h += this.noise.noise(x * 0.012, z * 0.012, 0.0) * 3.4;
    h += this.noise.noise(x * 0.04 + 7.3, z * 0.04 + 3.1, 0.5) * 0.9;
    h += this.noise.noise(x * 0.14 + 13.7, z * 0.14 + 9.4, 1.0) * 0.2;
    // приплюснутая площадка у точки старта
    const d = Math.hypot(x, z);
    const flat = THREE.MathUtils.smoothstep(d, 5, 22);
    return h * (0.2 + 0.8 * flat);
  }
}
