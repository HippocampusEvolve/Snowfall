import * as THREE from 'three';

// Ночное небо: градиентный купол, мерцающие звёзды, луна с гало.
// Луна ЖИВАЯ: ползёт по низкому полярному кругу (полный оборот за MOON_PERIOD),
// высота дышит в противофазе — тени медленно плывут по снегу, мир движется,
// даже когда игрок стоит. this.moonDir мутируется на месте: main.js держит
// ссылку и ведёт за ним DirectionalLight.
const MOON_PERIOD = 5400; // секунд на полный круг по азимуту (~90 мин)
const MOON_EL_MID = 0.42; // средняя высота, рад
const MOON_EL_AMP = 0.2; // размах качания высоты, рад

export class Sky {
  constructor(moonDir) {
    this.group = new THREE.Group();
    this.time = { value: 0 };
    // стартовая фаза — из переданного направления (совпадает с прежней статикой)
    this.moonDir = moonDir; // мутируем на месте — внешние ссылки живые
    this._az0 = Math.atan2(moonDir.x, moonDir.z);

    // ---- купол неба ----
    const domeMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uMoonDir: { value: moonDir }, // живая ссылка — сияние едет за луной
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        uniform vec3 uMoonDir;
        void main() {
          float h = clamp(vDir.y, 0.0, 1.0);
          vec3 zenith = vec3(0.004, 0.007, 0.022);
          vec3 horizon = vec3(0.045, 0.07, 0.13);
          vec3 col = mix(horizon, zenith, pow(h, 0.55));
          // лунное сияние
          float m = max(dot(normalize(vDir), uMoonDir), 0.0);
          col += vec3(0.10, 0.13, 0.20) * pow(m, 24.0);
          col += vec3(0.03, 0.04, 0.07) * pow(m, 5.0);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), domeMat);
    dome.renderOrder = -3;
    this.group.add(dome);

    // ---- звёзды ----
    const STAR_COUNT = 2600;
    const posArr = new Float32Array(STAR_COUNT * 3);
    const sizeArr = new Float32Array(STAR_COUNT);
    const phaseArr = new Float32Array(STAR_COUNT);
    const tintArr = new Float32Array(STAR_COUNT * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < STAR_COUNT; i++) {
      // верхняя полусфера с запасом под горизонт
      do {
        v.set(Math.random() * 2 - 1, Math.random(), Math.random() * 2 - 1);
      } while (v.lengthSq() > 1 || v.lengthSq() < 0.1);
      v.normalize().multiplyScalar(850);
      posArr.set([v.x, v.y + 10, v.z], i * 3);
      const big = Math.random() > 0.94;
      sizeArr[i] = big ? 2.6 + Math.random() * 1.6 : 0.9 + Math.random() * 1.4;
      phaseArr[i] = Math.random();
      // лёгкий разброс температуры звёзд
      const t = Math.random();
      if (t < 0.12) tintArr.set([1.0, 0.82, 0.68], i * 3);
      else if (t < 0.3) tintArr.set([0.75, 0.84, 1.0], i * 3);
      else tintArr.set([0.92, 0.94, 1.0], i * 3);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    starGeo.setAttribute('aSize', new THREE.BufferAttribute(sizeArr, 1));
    starGeo.setAttribute('aPhase', new THREE.BufferAttribute(phaseArr, 1));
    starGeo.setAttribute('aTint', new THREE.BufferAttribute(tintArr, 3));

    const starMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTime: this.time,
        uPR: { value: Math.min(window.devicePixelRatio, 1.75) },
      },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aPhase;
        attribute vec3 aTint;
        uniform float uTime;
        uniform float uPR;
        varying float vAlpha;
        varying vec3 vTint;
        void main() {
          vTint = aTint;
          vAlpha = 0.55 + 0.45 * sin(uTime * (0.4 + aPhase * 2.2) + aPhase * 60.0);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uPR;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying vec3 vTint;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.12, d) * vAlpha;
          gl_FragColor = vec4(vTint, a);
        }
      `,
    });
    const stars = new THREE.Points(starGeo, starMat);
    stars.renderOrder = -2;
    stars.frustumCulled = false;
    this.group.add(stars);

    // ---- луна ----
    const moonPos = moonDir.clone().multiplyScalar(800);
    const moon = new THREE.Mesh(
      new THREE.CircleGeometry(20, 48),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 2.6, 3.0), fog: false })
    );
    moon.position.copy(moonPos);
    moon.lookAt(0, 0, 0);
    moon.renderOrder = -1;
    this.moon = moon;
    this.group.add(moon);

    // гало луны — спрайт с радиальным градиентом
    const haloCanvas = document.createElement('canvas');
    haloCanvas.width = haloCanvas.height = 256;
    const hctx = haloCanvas.getContext('2d');
    const g = hctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    g.addColorStop(0, 'rgba(190,210,255,0.55)');
    g.addColorStop(0.25, 'rgba(150,175,235,0.18)');
    g.addColorStop(1, 'rgba(120,150,220,0)');
    hctx.fillStyle = g;
    hctx.fillRect(0, 0, 256, 256);
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(haloCanvas),
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    );
    halo.position.copy(moonPos);
    halo.scale.setScalar(240);
    halo.renderOrder = -1;
    this.halo = halo;
    this.group.add(halo);
  }

  update(t) {
    this.time.value = t;

    // полярный круг: азимут ползёт, высота дышит в противофазе. При t=0
    // направление совпадает с переданным в конструктор (стартовая сцена та же).
    const ph = (t / MOON_PERIOD) * Math.PI * 2;
    const az = this._az0 + ph;
    const el = MOON_EL_MID + MOON_EL_AMP * Math.cos(ph);
    const ce = Math.cos(el);
    this.moonDir.set(Math.sin(az) * ce, Math.sin(el), Math.cos(az) * ce);
    this.moon.position.copy(this.moonDir).multiplyScalar(800);
    this.moon.lookAt(0, 0, 0);
    this.halo.position.copy(this.moon.position);
  }
}
