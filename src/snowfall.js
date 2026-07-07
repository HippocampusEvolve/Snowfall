import * as THREE from 'three';

// Снегопад: GPU-частицы в боксе, зацикленном вокруг камеры.
// Фазы падения и ветра накапливаются на CPU (uFallT, uWindOff),
// чтобы смена силы ветра/метели не телепортировала снежинки.
const COUNT = 6500;
const BOX = new THREE.Vector3(70, 34, 70);

export class Snowfall {
  constructor() {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(COUNT * 3);
    const seed = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3] = Math.random() * BOX.x;
      pos[i * 3 + 1] = Math.random() * BOX.y;
      pos[i * 3 + 2] = Math.random() * BOX.z;
      seed[i] = Math.random();
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));

    this.uniforms = {
      uTime: { value: 0 },
      uFallT: { value: 0 },
      uWindOff: { value: new THREE.Vector2(0, 0) },
      uCam: { value: new THREE.Vector3() },
      uBliz: { value: 0 },
      uPR: { value: Math.min(window.devicePixelRatio, 1.75) },
      // домик: (x, z, cos, sin) и (полуразмеры, высота кровли) — под крышей снег гаснет
      uCabin: { value: new THREE.Vector4(0, 0, 1, 0) },
      uCabinExt: { value: new THREE.Vector3(0, 0, -1e3) },
    };

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: false,
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime;
        uniform float uFallT;
        uniform vec2 uWindOff;
        uniform vec3 uCam;
        uniform float uPR;
        uniform vec4 uCabin;
        uniform vec3 uCabinExt;
        varying float vFade;
        void main() {
          vec3 box = vec3(${BOX.x.toFixed(1)}, ${BOX.y.toFixed(1)}, ${BOX.z.toFixed(1)});
          vec3 p = position;
          float fall = 1.0 + aSeed * 1.4;
          p.y -= uFallT * fall;
          p.x += uWindOff.x * (0.4 + aSeed) + sin(uTime * (0.5 + aSeed) + aSeed * 40.0) * 0.9;
          p.z += uWindOff.y * (0.4 + aSeed) + cos(uTime * (0.4 + aSeed * 0.7) + aSeed * 30.0) * 0.9;
          p = mod(p, box);
          vec3 wp = p - box * 0.5 + uCam;
          vec4 mv = viewMatrix * vec4(wp, 1.0);
          float dist = max(-mv.z, 0.001);
          gl_PointSize = clamp((1.6 + aSeed * 2.6) * uPR * (16.0 / dist), 1.0, 10.0 * uPR);
          vFade = smoothstep(0.7, 2.5, dist) * (1.0 - smoothstep(26.0, 34.0, dist));
          // под крышей домика снег не падает (поворот в локаль футпринта)
          vec2 cd = wp.xz - uCabin.xy;
          vec2 cl = vec2(cd.x * uCabin.z - cd.y * uCabin.w, cd.x * uCabin.w + cd.y * uCabin.z);
          if (abs(cl.x) < uCabinExt.x && abs(cl.y) < uCabinExt.y && wp.y < uCabinExt.z) vFade = 0.0;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vFade;
        uniform float uBliz;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.14, d) * (0.8 + uBliz * 0.35) * vFade;
          if (a < 0.01) discard;
          gl_FragColor = vec4(0.82, 0.87, 0.98, min(a, 1.0));
        }
      `,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this._wind = new THREE.Vector2(1.6, 0.5);
  }

  // футпринт крыши домика — в этой зоне ниже кровли снежинки гаснут
  setCabinMask(m) {
    this.uniforms.uCabin.value.set(m.x, m.z, m.cos, m.sin);
    this.uniforms.uCabinExt.value.set(m.hx, m.hz, m.topY);
  }

  update(dt, t, camPos, windLevel, blizzard) {
    const u = this.uniforms;
    u.uTime.value = t;
    u.uCam.value.copy(camPos);
    u.uBliz.value = blizzard;
    // в метель снег валит быстрее (интегрируем фазу, а не множим время)
    u.uFallT.value += dt * (1 + blizzard * 1.1);
    // плавно подтягиваем ветер к уровню порывов из аудио
    const target = 1.0 + windLevel * 3.2 + blizzard * 3.5;
    this._wind.x += (target - this._wind.x) * 0.02;
    this._wind.y += (target * 0.35 - this._wind.y) * 0.02;
    u.uWindOff.value.x += this._wind.x * dt;
    u.uWindOff.value.y += this._wind.y * dt;
  }
}
