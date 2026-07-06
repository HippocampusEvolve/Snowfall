import * as THREE from 'three';
import { createSnowMaterial, SNOW_CONST } from './snowmaterial.js';

// Деформируемый снег: плотная сетка 32×32 м (0.125 м/вершина) следует за
// игроком; вершины вдавливаются по trail-карте в вершинном шейдере,
// базовый террейн под патчем вырезается (discard).
const SIZE = 32;
const SEGS = 256;
const SNAP = 0.25; // шаг привязки, чтобы сетка не «плыла» по следам
const MARGIN = 0.45; // запас перекрытия с базовым террейном

export class SnowPatch {
  constructor(footprints, terrain) {
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEGS, SEGS);
    geo.rotateX(-Math.PI / 2);

    const { material, uniforms } = createSnowMaterial({
      footprints,
      textures: terrain.textures,
      mode: 'patch',
      heightTex: terrain.heightTex,
    });
    this.uniforms = uniforms;
    this.terrainUniforms = terrain.uniforms;

    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false; // bbox плоский, смещение в шейдере
  }

  update(camPos) {
    const x = Math.round(camPos.x / SNAP) * SNAP;
    const z = Math.round(camPos.z / SNAP) * SNAP;
    this.mesh.position.set(x, 0, z);

    const h = SIZE / 2 - MARGIN;
    this.terrainUniforms.uPatchRect.value.set(x - h, z - h, x + h, z + h);
  }
}
