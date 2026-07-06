import * as THREE from 'three';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';

// Снежный террейн: процедурный рельеф + PBR-текстуры снега (Poly Haven, CC0)
// + шейдер: искры-блёстки, затемнение и рельеф следов из trail-карты.
export class Terrain {
  constructor(footprints, maxAnisotropy = 4) {
    this.noise = new ImprovedNoise();

    const size = 400;
    const seg = 240;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, this.getHeight(x, z));
    }
    geo.computeVertexNormals();

    const tl = new THREE.TextureLoader();
    const setup = (t, srgb) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(48, 48);
      t.anisotropy = maxAnisotropy;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    const map = setup(tl.load('/textures/snow_02_diff_2k.jpg'), true);
    const normalMap = setup(tl.load('/textures/snow_02_nor_gl_2k.jpg'));
    const roughnessMap = setup(tl.load('/textures/snow_02_rough_2k.jpg'));

    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.85, 0.88, 0.96),
      map,
      normalMap,
      normalScale: new THREE.Vector2(0.65, 0.65),
      roughnessMap,
      roughness: 1.0,
      metalness: 0.0,
    });

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTrail = { value: footprints.texture };
      shader.uniforms.uTrailArea = { value: footprints.area };

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWp;')
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;'
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vWp;
          uniform sampler2D uTrail;
          uniform float uTrailArea;
          float hash21(vec2 p) {
            p = fract(p * vec2(123.34, 456.21));
            p += dot(p, p + 45.32);
            return fract(p.x * p.y);
          }
          vec2 trailUv(vec3 wp) { return vec2(wp.x, -wp.z) / uTrailArea + 0.5; }
          float trailAt(vec2 uv) {
            if (any(greaterThan(abs(uv - 0.5), vec2(0.499)))) return 0.0;
            return texture2D(uTrail, uv).r;
          }`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          vec2 tuv = trailUv(vWp);
          float tr = clamp(trailAt(tuv), 0.0, 1.0);
          // утоптанный снег темнее и синее
          diffuseColor.rgb *= 1.0 - tr * 0.42;
          diffuseColor.b *= 1.0 + tr * 0.06;
          // искры на снегу — мерцают при движении взгляда
          float camDist = length(cameraPosition - vWp);
          vec3 vdir = normalize(cameraPosition - vWp);
          vec2 cell = floor(vWp.xz * 24.0);
          float h1 = hash21(cell);
          float tw = fract(h1 * 93.7 + dot(vdir.xz, vec2(7.3, 11.1)) + vdir.y * 5.0);
          float sparkle = step(0.985, h1) * pow(smoothstep(0.72, 1.0, tw), 4.0);
          sparkle *= (1.0 - tr) * exp(-camDist * 0.045);
          diffuseColor.rgb += sparkle * 1.4;`
        )
        // после карты нормалей — рельеф следов поверх неё
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
          {
            float e = 1.5 / 2048.0;
            float tC = trailAt(tuv);
            float tX = trailAt(tuv + vec2(e, 0.0));
            float tY = trailAt(tuv + vec2(0.0, e));
            // наклон нормали по градиенту следа — вмятина ловит лунный свет
            vec3 nOff = vec3(tX - tC, 0.0, -(tY - tC)) * 4.0;
            normal = normalize(normal + (viewMatrix * vec4(nOff, 0.0)).xyz);
          }`
        );
    };

    this.mesh = new THREE.Mesh(geo, mat);
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
