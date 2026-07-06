import * as THREE from 'three';

// Северное сияние: шейдерная «занавесь» на внутренней стороне цилиндра,
// анимированный fbm-шум, зелёно-фиолетовый градиент, лучи.
export class Aurora {
  constructor(azimuth = 0.59) {
    this.uniforms = {
      uTime: { value: 0 },
      uGlobal: { value: 1 },
    };

    const geo = new THREE.CylinderGeometry(680, 680, 320, 96, 1, true, -1.25, 2.5);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform float uTime;
        uniform float uGlobal;

        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
            mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
            f.y
          );
        }
        float fbm(vec2 p) {
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 4; i++) {
            v += a * vnoise(p);
            p *= 2.1;
            a *= 0.5;
          }
          return v;
        }

        void main() {
          float t = uTime * 0.045;
          float h = vUv.y;

          // волнистая нижняя кромка занавеси
          float band = fbm(vec2(vUv.x * 7.0 + t, t * 0.7));
          float y0 = 0.10 + band * 0.28;
          float above = smoothstep(y0, y0 + 0.05, h);
          float fall = exp(-(h - y0) * 3.2);

          // вертикальные лучи
          float rays = 0.45 + 0.55 * fbm(vec2(vUv.x * 42.0 - t * 2.2, h * 2.5 - t * 0.6));
          rays = pow(rays, 2.4);

          float inten = above * max(fall, 0.0) * rays;
          inten *= smoothstep(0.0, 0.14, vUv.x) * smoothstep(1.0, 0.86, vUv.x);

          vec3 cGreen = vec3(0.06, 0.85, 0.42);
          vec3 cPurple = vec3(0.42, 0.16, 0.78);
          vec3 col = mix(cGreen, cPurple, smoothstep(y0, y0 + 0.55, h));

          gl_FragColor = vec4(col * inten * 1.1 * uGlobal, inten * 0.7 * uGlobal);
        }
      `,
    });

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.y = 215;
    this.mesh.rotation.y = azimuth;
    this.mesh.renderOrder = 0;
    this.mesh.frustumCulled = false;
  }

  update(t, blizzard) {
    this.uniforms.uTime.value = t;
    // сияние «дышит» и гаснет в метель
    const breathe = 0.72 + 0.28 * Math.sin(t * 0.06) * Math.sin(t * 0.023 + 1.7);
    this.uniforms.uGlobal.value = Math.max(0, breathe * (1 - blizzard * 0.85));
  }
}
