import * as THREE from 'three';

// Короткий фонтан частиц от удара инструмента: снежная крошка из-под штыка
// лопаты, щепа из-под топора, снежная пыль рухнувшей кроны. Одна система —
// один цвет и одна физика (щепа тяжелее крошки), поэтому у каждого источника
// свой экземпляр.
const DEFAULTS = {
  color: '0.84, 0.88, 0.97', // снежная крошка
  size: 52.0, // px·м — масштаб точки до деления на глубину
  gravity: 7.5, // снежная крошка лёгкая — падает мягче камня
  drag: 1.6,
  max: 220,
};

export class Burst {
  constructor(scene, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    this.gravity = o.gravity;
    this.drag = o.drag;
    this.max = o.max;
    this.live = []; // {x,y,z,vx,vy,vz,age,ttl}
    this.posArr = new Float32Array(o.max * 3);
    this.aArr = new Float32Array(o.max);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.posArr, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.aArr, 1));
    geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uPR: { value: Math.min(window.devicePixelRatio, 1.75) } },
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        uniform float uPR;
        varying float vA;
        void main() {
          vA = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = uPR * ${o.size.toFixed(1)} / max(0.5, -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.16, d) * vA;
          gl_FragColor = vec4(vec3(${o.color}), a);
        }
      `,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  // point — очаг выброса, dir — направление (модуль = сила), n — сколько частиц
  spawn(point, dir, n = 26) {
    for (let i = 0; i < n; i++) {
      if (this.live.length >= this.max) break;
      // случайная сфера + направление выброса
      const a = Math.random() * Math.PI * 2;
      const c = Math.random() * 2 - 1;
      const s = Math.sqrt(1 - c * c);
      const sp = 0.5 + Math.random() * 0.9;
      this.live.push({
        x: point.x + (Math.random() - 0.5) * 0.24,
        y: point.y + Math.random() * 0.12,
        z: point.z + (Math.random() - 0.5) * 0.24,
        vx: dir.x * (0.5 + Math.random() * 0.9) + Math.cos(a) * s * sp,
        vy: dir.y * (0.5 + Math.random() * 0.9) + Math.abs(c) * sp * 0.8,
        vz: dir.z * (0.5 + Math.random() * 0.9) + Math.sin(a) * s * sp,
        age: 0,
        ttl: 0.45 + Math.random() * 0.35,
      });
    }
  }

  update(dt) {
    if (this.live.length === 0) {
      this.points.geometry.setDrawRange(0, 0);
      return;
    }
    const drag = Math.exp(-this.drag * dt);
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.age += dt;
      if (p.age >= p.ttl) {
        this.live[i] = this.live[this.live.length - 1];
        this.live.pop();
        continue;
      }
      p.vy -= this.gravity * dt;
      p.vx *= drag;
      p.vz *= drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
    }
    for (let i = 0; i < this.live.length; i++) {
      const p = this.live[i];
      this.posArr[i * 3] = p.x;
      this.posArr[i * 3 + 1] = p.y;
      this.posArr[i * 3 + 2] = p.z;
      this.aArr[i] = 0.85 * (1 - p.age / p.ttl);
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.aAlpha.needsUpdate = true;
    this.points.geometry.setDrawRange(0, this.live.length);
  }
}
