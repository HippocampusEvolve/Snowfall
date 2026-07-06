import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Костёр: каменное костровище (Poly Haven, CC0), шейдерное пламя,
// искры-угли, дым, мерцающий тёплый свет. Источник тепла для Stats.
export class Campfire {
  constructor(scene, terrain, x, z) {
    this.position = new THREE.Vector3(x, terrain.getHeight(x, z), z);
    this.group = new THREE.Group();
    this.group.position.copy(this.position);
    scene.add(this.group);

    this.time = { value: 0 };

    // ---- костровище ----
    new GLTFLoader().load('/models/firepit/stone_fire_pit.gltf', (gltf) => {
      const pit = gltf.scene;
      pit.traverse((c) => {
        if (c.isMesh) {
          c.castShadow = true;
          c.receiveShadow = true;
        }
      });
      pit.position.y = -0.02;
      this.group.add(pit);
    });

    // ---- поленья ----
    const logMat = new THREE.MeshStandardMaterial({ color: 0x1c120a, roughness: 1 });
    for (let i = 0; i < 4; i++) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.65, 6), logMat);
      const a = (i / 4) * Math.PI * 2 + 0.4;
      log.rotation.z = Math.PI / 2 - 0.35;
      log.rotation.y = a;
      log.position.y = 0.12;
      log.castShadow = true;
      this.group.add(log);
    }

    // ---- пламя: два скрещенных полотна с fbm-шейдером ----
    const flameMat = new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      uniforms: { uTime: this.time },
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
        float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float vnoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash(i), hash(i + vec2(1, 0)), f.x),
            mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x),
            f.y
          );
        }
        float fbm(vec2 p) {
          float v = 0.0, a = 0.5;
          for (int i = 0; i < 3; i++) { v += a * vnoise(p); p *= 2.2; a *= 0.5; }
          return v;
        }
        void main() {
          vec2 uv = vUv;
          float t = uTime;
          float n = fbm(vec2(uv.x * 3.5, uv.y * 2.2 - t * 2.1));
          float n2 = fbm(vec2(uv.x * 7.0 + 13.7, uv.y * 3.0 - t * 3.2));
          float xm = 1.0 - abs(uv.x - 0.5) * 2.0;
          float flame = (1.0 - uv.y) * pow(max(xm, 0.0), 0.7);
          flame *= 0.55 + 0.6 * n;
          flame -= n2 * 0.22 * uv.y;
          float a = smoothstep(0.18, 0.5, flame);
          vec3 col = mix(vec3(0.9, 0.16, 0.01), vec3(1.0, 0.62, 0.08), smoothstep(0.2, 0.75, flame));
          col = mix(col, vec3(1.0, 0.93, 0.55), smoothstep(0.62, 0.95, flame));
          gl_FragColor = vec4(col * (1.2 + flame * 2.2), a * 0.9);
        }
      `,
    });
    const flameGeo = new THREE.PlaneGeometry(0.85, 1.05);
    for (let i = 0; i < 2; i++) {
      const f = new THREE.Mesh(flameGeo, flameMat);
      f.position.y = 0.62;
      f.rotation.y = (i * Math.PI) / 2;
      f.renderOrder = 3;
      this.group.add(f);
    }

    // ---- угли-искры ----
    const EMBERS = 60;
    const eGeo = new THREE.BufferGeometry();
    const ePos = new Float32Array(EMBERS * 3); // нули — позиция в шейдере
    const eSeed = new Float32Array(EMBERS);
    for (let i = 0; i < EMBERS; i++) eSeed[i] = Math.random();
    eGeo.setAttribute('position', new THREE.BufferAttribute(ePos, 3));
    eGeo.setAttribute('aSeed', new THREE.BufferAttribute(eSeed, 1));
    const eMat = new THREE.ShaderMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      uniforms: { uTime: this.time, uPR: { value: Math.min(window.devicePixelRatio, 1.75) } },
      vertexShader: /* glsl */ `
        attribute float aSeed;
        uniform float uTime;
        uniform float uPR;
        varying float vLife;
        void main() {
          float speed = 0.35 + aSeed * 0.5;
          float life = fract(uTime * speed + aSeed * 7.31);
          vLife = life;
          vec3 p;
          float ang = aSeed * 40.0 + uTime * (0.5 + aSeed);
          float rad = 0.06 + aSeed * 0.14 + life * 0.12;
          p.x = cos(ang) * rad + sin(life * 12.0 + aSeed * 20.0) * 0.05;
          p.z = sin(ang) * rad + cos(life * 10.0 + aSeed * 30.0) * 0.05;
          p.y = 0.25 + life * (1.3 + aSeed * 0.9);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = (2.5 * (1.0 - life) + 1.0) * uPR * (3.0 / max(-mv.z, 0.5));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vLife;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          if (d > 0.5) discard;
          float a = (1.0 - vLife) * smoothstep(0.0, 0.08, vLife);
          vec3 col = mix(vec3(1.0, 0.7, 0.2), vec3(0.9, 0.2, 0.03), vLife);
          gl_FragColor = vec4(col * 2.0, a);
        }
      `,
    });
    const embers = new THREE.Points(eGeo, eMat);
    embers.frustumCulled = false;
    embers.renderOrder = 3;
    this.group.add(embers);

    // ---- дым ----
    const smokeCanvas = document.createElement('canvas');
    smokeCanvas.width = smokeCanvas.height = 64;
    const sctx = smokeCanvas.getContext('2d');
    const sg = sctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    sg.addColorStop(0, 'rgba(150,150,160,0.5)');
    sg.addColorStop(1, 'rgba(150,150,160,0)');
    sctx.fillStyle = sg;
    sctx.fillRect(0, 0, 64, 64);
    const smokeTex = new THREE.CanvasTexture(smokeCanvas);
    this.smoke = [];
    for (let i = 0; i < 8; i++) {
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: smokeTex, transparent: true, opacity: 0, depthWrite: false })
      );
      s.userData = { life: Math.random() * 3, ttl: 3 + Math.random() * 1.5 };
      this.group.add(s);
      this.smoke.push(s);
    }

    // ---- свет ----
    this.light = new THREE.PointLight(0xff9040, 50, 26, 2);
    this.light.position.set(0, 0.9, 0);
    this.group.add(this.light);

    // тёплое свечение на снегу вокруг
    const glowCanvas = document.createElement('canvas');
    glowCanvas.width = glowCanvas.height = 128;
    const gctx = glowCanvas.getContext('2d');
    const gg = gctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gg.addColorStop(0, 'rgba(255,150,60,0.28)');
    gg.addColorStop(1, 'rgba(255,120,40,0)');
    gctx.fillStyle = gg;
    gctx.fillRect(0, 0, 128, 128);
    this.glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(glowCanvas),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      })
    );
    this.glow.position.y = 0.75;
    this.glow.scale.setScalar(5.5);
    this.glow.renderOrder = 2;
    this.group.add(this.glow);
  }

  update(dt, t, windLevel) {
    this.time.value = t;

    // мерцание света
    const fl =
      0.82 +
      0.1 * Math.sin(t * 11.3) +
      0.06 * Math.sin(t * 23.7 + 1.3) +
      0.05 * Math.sin(t * 5.1 + 4.2);
    this.light.intensity = 50 * fl;
    this.light.position.x = Math.sin(t * 7.7) * 0.04;
    this.light.position.z = Math.cos(t * 6.3) * 0.04;
    this.glow.material.opacity = 0.75 + 0.25 * fl;

    // дым поднимается и сносится ветром
    for (const s of this.smoke) {
      const u = s.userData;
      u.life += dt;
      if (u.life > u.ttl) {
        u.life = 0;
        u.ttl = 3 + Math.random() * 1.5;
      }
      const k = u.life / u.ttl;
      s.position.set(
        Math.sin(u.ttl * 13.7 + k * 4.0) * 0.15 + k * k * windLevel * 2.2,
        0.9 + k * 3.2,
        Math.cos(u.ttl * 9.3 + k * 3.0) * 0.15 + k * k * windLevel * 0.8
      );
      s.scale.setScalar(0.3 + k * 1.6);
      s.material.opacity = 0.085 * Math.sin(Math.PI * Math.min(k * 1.15, 1));
    }
  }
}
