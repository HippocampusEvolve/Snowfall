import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { snowTint } from './snowtint.js';
import { createGLTFLoader } from './gltfload.js';
import { asset } from './asset.js';

// Костёр: кольцо камней из Blender (firepit.glb), зола, поленья с процедурной
// корой, тлеющие угли; пламя покадровой текстурой, искры, дым, мерцающий
// тёплый свет. Источник тепла для Stats.
//
// Огонь ЕСТ ДРОВА: fuel 1..0 выгорает за FUEL_TIME — пламя оседает, свет
// тускнеет, дым редеет, треск затихает (audio), проталина сжимается (main).
// До нуля не умирает: остаются тлеющие угли (burn ≥ BURN_MIN) — их можно
// раздуть новым поленом (addFuel). Никакого индикатора: топливо видно по огню.
const FUEL_TIME = 480; // секунд от полного костра до углей
const BURN_MIN = 0.1; // «угли»: нижний предел горения

// Кольцо камней собрано в Blender (blender-web-agent-kit) и запечено в один
// материал: base + ORM, 584 треугольника, один draw call. Камни разной породы
// (плитняк, колотый, окатанный) лежат плоской стороной вниз, стык к стыку, а
// внутренние бока закопчены — копоть запечена в атлас по расстоянию до огня,
// поэтому чернота приходится ровно на ту сторону, что смотрит в пламя.
// Прежнее процедурное кольцо (одиннадцать мятых икосфер) — в истории файла.
const PIT_MODEL = 'models/props/firepit.glb';

let pitProto = null;
const pitWaiting = [];
let pitLoading = null;

/** Грузит кольцо камней один раз. Полосу загрузки ведёт DefaultLoadingManager. */
export function loadFirepitModel() {
  if (!pitLoading) {
    pitLoading = createGLTFLoader()
      .loadAsync(asset(PIT_MODEL))
      .then((gltf) => {
        pitProto = gltf.scene;
        pitProto.traverse((o) => {
          if (!o.isMesh) return;
          o.castShadow = true;
          o.receiveShadow = true;
          // шероховатость лежит в ORM, множитель её не трогает
          o.material.roughness = 1;
          o.material.metalness = 0;
          // у огня снег на камнях тает — лишь лёгкий иней с наружной стороны
          snowTint(o.material, '0.6, 0.65, 0.78', 0.18, 0.6);
        });
        while (pitWaiting.length) pitWaiting.pop().add(pitProto.clone(true));
        return pitProto;
      })
      // кольцо камней не доехало — костёр горит и без него; тихий фолбэк,
      // как у камина в cabin.js. Молчать нельзя только в консоли.
      .catch((e) => {
        console.warn('кольцо камней не загрузилось:', e);
        return null;
      });
  }
  return pitLoading;
}

loadFirepitModel();

// ---- шум для пламени ----
// Пламя рисуется не шейдером, а покадрово в маленький canvas: так язычок
// можно вести по высоте — сузить кверху, качнуть, разорвать турбулентностью.
// Хеш целочисленный (без sin), value-шум сглажен, fbm складывает октавы.
function hash2(x, y, s) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2d);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function wrapi(a, n) {
  a %= n;
  return a < 0 ? a + n : a;
}
// px/py — периоды решётки: шум замыкается сам на себя и не «расползается»
function vnoise(x, y, px, py, s) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const x0 = wrapi(xi, px);
  const x1 = wrapi(xi + 1, px);
  const y0 = wrapi(yi, py);
  const y1 = wrapi(yi + 1, py);
  const a = hash2(x0, y0, s);
  const b = hash2(x1, y0, s);
  const c = hash2(x0, y1, s);
  const d = hash2(x1, y1, s);
  const t = a + (b - a) * u;
  const q = c + (d - c) * u;
  return t + (q - t) * v;
}
function fbm(x, y, px, py, oct, s) {
  let amp = 1;
  let f = 1;
  let sum = 0;
  let nrm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x * f, y * f, px * f, py * f, s + i * 7919);
    nrm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / nrm;
}
const cl01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function ss(e0, e1, x) {
  const t = cl01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

// размер полотна пламени: мельче — видно ступеньки, крупнее — дорого на телефоне
const FLAME_W = 72;
const FLAME_H = 108;
const FLAME_FPS = 30; // текстура перерисовывается 30 раз в секунду, глазу хватает
// Полотно шире, чем высокое: костёр приземистый и разлапистый, в отличие от
// вытянутого огня в камине. Ширина подобрана по просвету кладки.
const FLAME_PW = 0.95;
const FLAME_PH = 0.9;

export class Campfire {
  constructor(scene, terrain, x, z) {
    this.position = new THREE.Vector3(x, terrain.getHeight(x, z), z);
    this.group = new THREE.Group();
    this.group.position.copy(this.position);
    scene.add(this.group);

    this.burnU = { value: 1 }; // сила горения наружу (звук треска)
    this.fuel = 0.8; // 0..1 — запас дров
    this.burn = 1; // 0..1 — сглаженная сила горения (BURN_MIN на углях)
    this._flare = 0; // вспышка при подброшенном полене

    // ---- костровище: кольцо камней из Blender ----
    // группа отдаётся сцене сразу, модель доедет в неё сама
    if (pitProto) this.group.add(pitProto.clone(true));
    else pitWaiting.push(this.group);

    // ---- зола под костром ----
    // радиус меряется по просвету кладки (0.372 у модели): диск шире просвета
    // прошёл бы сквозь камни на уровне земли и замерцал в стыках
    const ash = new THREE.Mesh(
      new THREE.CircleGeometry(0.36, 24).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x0d0a08, roughness: 1 })
    );
    ash.position.y = 0.02;
    ash.receiveShadow = true;
    this.group.add(ash);

    // ---- поленья с процедурной корой ----
    const barkCanvas = document.createElement('canvas');
    barkCanvas.width = 128;
    barkCanvas.height = 64;
    const bctx = barkCanvas.getContext('2d');
    bctx.fillStyle = '#180e08';
    bctx.fillRect(0, 0, 128, 64);
    for (let i = 0; i < 90; i++) {
      const px = Math.random() * 128;
      const light = Math.random() < 0.2;
      bctx.strokeStyle = light
        ? `rgba(66, 46, 28, ${0.2 + Math.random() * 0.25})`
        : `rgba(6, 3, 1, ${0.3 + Math.random() * 0.35})`;
      bctx.lineWidth = 0.5 + Math.random() * 1.8;
      bctx.beginPath();
      bctx.moveTo(px, 0);
      bctx.bezierCurveTo(px + 3, 20, px - 3, 44, px + Math.random() * 4 - 2, 64);
      bctx.stroke();
    }
    const barkTex = new THREE.CanvasTexture(barkCanvas);
    barkTex.wrapS = barkTex.wrapT = THREE.RepeatWrapping;
    barkTex.colorSpace = THREE.SRGBColorSpace;

    const endCanvas = document.createElement('canvas');
    endCanvas.width = endCanvas.height = 64;
    const ectx = endCanvas.getContext('2d');
    const eg = ectx.createRadialGradient(32, 32, 3, 32, 32, 32);
    eg.addColorStop(0, '#8a6a42');
    eg.addColorStop(0.75, '#5e422a');
    eg.addColorStop(1, '#241610');
    ectx.fillStyle = eg;
    ectx.fillRect(0, 0, 64, 64);
    ectx.strokeStyle = 'rgba(30, 16, 8, 0.5)';
    for (let r = 6; r < 30; r += 5 + Math.random() * 3) {
      ectx.beginPath();
      ectx.arc(32, 32, r, 0, Math.PI * 2);
      ectx.stroke();
    }
    const endTex = new THREE.CanvasTexture(endCanvas);
    endTex.colorSpace = THREE.SRGBColorSpace;

    const sideMat = new THREE.MeshStandardMaterial({
      map: barkTex,
      bumpMap: barkTex,
      bumpScale: 0.012,
      roughness: 0.95,
    });
    const charredMat = sideMat.clone();
    charredMat.color.setHex(0x4a423c); // обгоревшие — присыпаны пеплом
    const endMat = new THREE.MeshStandardMaterial({ map: endTex, roughness: 0.9 });
    const logGeo = new THREE.CylinderGeometry(0.048, 0.058, 0.68, 10);
    for (let i = 0; i < 4; i++) {
      const charred = i % 2 === 1;
      const log = new THREE.Mesh(logGeo, [charred ? charredMat : sideMat, endMat, endMat]);
      // шалашик
      const a = (i / 4) * Math.PI * 2 + 0.4;
      log.rotation.z = Math.PI / 2 - 0.35;
      log.rotation.y = a;
      log.position.y = 0.12;
      log.castShadow = true;
      log.receiveShadow = true;
      this.group.add(log);
    }

    // ---- тлеющие угли между поленьями ----
    this.emberMat = new THREE.MeshStandardMaterial({
      color: 0x140a05,
      emissive: 0xff4a12,
      emissiveIntensity: 2.2,
      roughness: 1,
    });
    const emberGeos = [];
    for (let i = 0; i < 4; i++) {
      const g = new THREE.IcosahedronGeometry(0.028 + (i % 2) * 0.012, 1);
      const a = i * 2.4 + 0.7;
      g.translate(Math.cos(a) * 0.11, 0.045, Math.sin(a) * 0.11);
      emberGeos.push(g);
    }
    this.group.add(new THREE.Mesh(mergeGeometries(emberGeos), this.emberMat));

    // ---- пламя: три скрещенных полотна с покадровой текстурой ----
    // Полотен три, под 60 градусов: с любой стороны огонь читается объёмным,
    // а ребро полотна не поймать (на двух крестом оно ловилось и огонь
    // схлопывался в плоскую картинку).
    const flameCanvas = document.createElement('canvas');
    flameCanvas.width = FLAME_W;
    flameCanvas.height = FLAME_H;
    this.fctx = flameCanvas.getContext('2d');
    this.fimg = this.fctx.createImageData(FLAME_W, FLAME_H);
    this.ftex = new THREE.CanvasTexture(flameCanvas);
    this.ftex.colorSpace = THREE.SRGBColorSpace;
    this._fAcc = 0; // накопитель кадров текстуры
    const flameMat = new THREE.MeshBasicMaterial({
      map: this.ftex,
      // чуть выше единицы: ядро перешагивает порог bloom (0.82) и обрастает
      // ореолом, а тонмаппинг его не съедает (toneMapped: false). Выше 1.2
      // язычки сливаются в белое пятно — проверено на снегу у избы
      color: new THREE.Color(1.15, 1.08, 1),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });
    const flameGeo = new THREE.PlaneGeometry(FLAME_PW, FLAME_PH);
    this.flames = [];
    for (let i = 0; i < 3; i++) {
      const f = new THREE.Mesh(flameGeo, flameMat);
      f.position.y = 0.095 + FLAME_PH / 2;
      f.rotation.y = (i * Math.PI) / 3;
      f.renderOrder = 3;
      this.flames.push(f);
      this.group.add(f);
    }
    this._drawFlame(0, 1); // первый кадр — чтобы прогрев сцены увидел пламя, а не пустоту

    // ---- угли-искры ----
    // Каждая искра живёт сама по себе: рождается над углями, всплывает,
    // виляет, сносится ветром и гаснет. Яркость идёт вершинным цветом —
    // на углях искры просто не вылетают.
    const EMBERS = 64;
    const eGeo = new THREE.BufferGeometry();
    eGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(EMBERS * 3), 3));
    eGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(EMBERS * 3), 3));
    this.sparkPos = eGeo.attributes.position;
    this.sparkCol = eGeo.attributes.color;
    this.sparks = [];
    for (let i = 0; i < EMBERS; i++) {
      const s = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: Math.random(), rate: 0.5, on: false };
      this.sparks.push(s);
    }
    const spCanvas = document.createElement('canvas');
    spCanvas.width = spCanvas.height = 32;
    const spctx = spCanvas.getContext('2d');
    const spg = spctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    spg.addColorStop(0, 'rgba(255,220,150,1)');
    spg.addColorStop(0.4, 'rgba(255,130,40,0.6)');
    spg.addColorStop(1, 'rgba(255,80,0,0)');
    spctx.fillStyle = spg;
    spctx.fillRect(0, 0, 32, 32);
    const spTex = new THREE.CanvasTexture(spCanvas);
    spTex.colorSpace = THREE.SRGBColorSpace;
    const embers = new THREE.Points(
      eGeo,
      new THREE.PointsMaterial({
        size: 0.04,
        map: spTex,
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
        fog: false,
      })
    );
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

    // мягкое сияние вокруг пламени: тёплое ядро, к краю сходит в ноль
    const glowCanvas = document.createElement('canvas');
    glowCanvas.width = glowCanvas.height = 128;
    const gctx = glowCanvas.getContext('2d');
    const gg = gctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    // ядро слабее эталонного (0.95): у нас вокруг белый снег и bloom, на такой
    // подложке яркое сияние съедает сами язычки
    gg.addColorStop(0, 'rgba(255,168,74,0.5)');
    gg.addColorStop(0.35, 'rgba(255,110,30,0.2)');
    gg.addColorStop(1, 'rgba(255,80,10,0)');
    gctx.fillStyle = gg;
    gctx.fillRect(0, 0, 128, 128);
    const glowTex = new THREE.CanvasTexture(glowCanvas);
    glowTex.colorSpace = THREE.SRGBColorSpace;
    this.glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: glowTex,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        toneMapped: false,
        fog: false,
      })
    );
    this.glow.scale.set(2.6, 2.2, 1);
    this.glow.position.y = 0.06 + 1.1; // остальное задаёт update
    this.glow.renderOrder = 2;
    this.group.add(this.glow);
  }

  // подбросить полено: топливо +, короткая вспышка занявшегося огня
  addFuel() {
    this.fuel = Math.min(1, this.fuel + 0.34);
    this._flare = 1;
  }

  // тепло для Stats/проталины: угли греют еле-еле, полный костёр — как раньше
  get heatK() {
    return 0.12 + 0.88 * this.burn;
  }

  // Кадр пламени: снизу широкое, кверху сужается и рвётся турбулентностью,
  // ядро выбелено. Всё полотно медленно качает вбок — огонь «дышит».
  // b — сила горения: на углях язычки истаивают в ноль.
  _drawFlame(t, b) {
    const d = this.fimg.data;
    const k = ss(0.12, 0.45, b);
    let i = 0;
    for (let y = 0; y < FLAME_H; y++) {
      const v = 1 - y / FLAME_H; // 0 у углей, 1 на верхушке
      const taper = Math.pow(1 - v, 0.62); // кверху язычок тоньше
      const sway = Math.sin(t * 2.1 + v * 3.6) * 0.1 * v + Math.sin(t * 3.7 + v * 6) * 0.045 * v;
      for (let x = 0; x < FLAME_W; x++, i++) {
        const u = x / FLAME_W - 0.5;
        const turb = fbm((x / FLAME_W) * 3.2, (y / FLAME_H) * 3.4 + t * 1.35, 8, 64, 4, 1451) - 0.5;
        const dist = Math.abs(u - sway) / (taper * 0.6 + 0.02);
        const val = 1 - dist + turb * (0.45 + v * 1.05) - v * 0.42;
        // сверху язычок тает, у самого низа — уходит в угли, а не режется краем
        const a = ss(0.26, 0.58, val) * (1 - ss(0.56, 0.95, v)) * ss(0, 0.045, v);
        const core = ss(0.55, 0.92, val) * (1 - ss(0.2, 0.72, v)) * 0.95;
        const m = ss(0.3, 0.7, val);
        const r = 186 + (255 - 186) * m;
        const g = 30 + (146 - 30) * m;
        const bl = 4 + (26 - 4) * m;
        const o = i * 4;
        d[o] = r + (255 - r) * core;
        d[o + 1] = g + (240 - g) * core;
        d[o + 2] = bl + (196 - bl) * core;
        d[o + 3] = a * 255 * k;
      }
    }
    this.fctx.putImageData(this.fimg, 0, 0);
    this.ftex.needsUpdate = true;
  }

  update(dt, t, windLevel) {
    // топливо выгорает; сила горения плавно догоняет запас (огонь оседает
    // не мгновенно), на нуле остаются тлеющие угли
    this.fuel = Math.max(0, this.fuel - dt / FUEL_TIME);
    const targetBurn = BURN_MIN + (1 - BURN_MIN) * Math.min(1, this.fuel * 2.4);
    this.burn += (targetBurn - this.burn) * Math.min(1, dt * 0.25);
    this._flare = Math.max(0, this._flare - dt * 0.55);
    const b = Math.min(1, this.burn + this._flare * 0.35); // вспышка от полена
    this.burnU.value = b;

    // Мерцание: медленное дыхание от fbm плюс быстрая дрожь. Синусы дают
    // слышимый период, шум — нет, поэтому огонь не «тикает».
    const fl = 0.72 + fbm(t * 1.6, 0.5, 64, 64, 3, 99) * 0.5 + Math.sin(t * 17.3) * 0.045;
    // 23 вместо прежних 50: на белом снегу да с ACES и bloom прежняя яркость
    // выжигала всё вокруг костра в чистый белый, и на полу проступали круги —
    // ступеньки проталины. С 23 остаётся тёплая лужа света, а огонь видно.
    this.light.intensity = 23 * fl * (0.08 + 0.92 * b);
    this.light.position.x = Math.sin(t * 7.7) * 0.04;
    this.light.position.z = Math.cos(t * 6.3) * 0.04;
    // угли дышат вместе с пламенем; гаснут последними (медленнее, чем свет)
    this.emberMat.emissiveIntensity = (1.35 + fl * 1.25) * (0.3 + 0.7 * b);

    // Сияние: спрайт стоит НА углях. Раньше он был вдвое шире и утоплен в
    // землю — террейн срезал его нижнюю половину, и на снегу проступал
    // светлый круг. Теперь нижняя кромка держится над снегом.
    const gs = 0.45 + 0.55 * b;
    this.glow.material.opacity = (0.4 + 0.3 * fl) * (0.12 + 0.88 * b);
    this.glow.scale.set((2.5 + fl * 0.4) * gs, (2.1 + fl * 0.35) * gs, 1);
    this.glow.position.y = 0.06 + this.glow.scale.y * 0.5;

    // пламя оседает: язычки ниже, база остаётся на углях; мерцание качает
    // ширину и высоту полотен, каждое следующее чуть шире соседа
    const fs = 0.25 + 0.75 * b;
    for (let i = 0; i < this.flames.length; i++) {
      const f = this.flames[i];
      f.scale.set((0.55 + 0.45 * fs) * (0.86 + fl * 0.22 + i * 0.03), fs * (0.8 + fl * 0.34), 1);
      f.position.y = 0.095 + (FLAME_PH / 2) * f.scale.y;
    }
    // текстуру пламени пересчитываем 30 раз в секунду: покадрово на телефоне
    // это заметный кусок кадра, а разницы на глаз нет
    this._fAcc += dt;
    if (this._fAcc >= 1 / FLAME_FPS) {
      this._fAcc = 0;
      this._drawFlame(t, b);
    }

    // искры
    const pos = this.sparkPos;
    const col = this.sparkCol;
    for (let k = 0; k < this.sparks.length; k++) {
      const e = this.sparks[k];
      e.life -= dt * e.rate;
      if (e.life <= 0) {
        e.life = 1;
        e.rate = 0.4 + Math.random() * 0.45;
        e.on = Math.random() < 0.12 + 0.88 * b; // на углях вылетают одиночки
        e.x = (Math.random() - 0.5) * 0.34;
        e.y = 0.14;
        e.z = (Math.random() - 0.5) * 0.34;
        e.vx = (Math.random() - 0.5) * 0.22;
        e.vy = 0.45 + Math.random() * 0.8;
        e.vz = (Math.random() - 0.5) * 0.22;
      }
      e.vx += (Math.sin(t * 3 + k) * 0.12 + windLevel * 0.7) * dt;
      e.vz += (Math.cos(t * 2.6 + k) * 0.1 + windLevel * 0.25) * dt;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.z += e.vz * dt;
      pos.setXYZ(k, e.x, e.y, e.z);
      // разгорается на вылете, гаснет к концу жизни и краснеет
      const a = e.on ? e.life * Math.min(1, (1 - e.life) * 8) : 0;
      col.setXYZ(k, a, a * (0.5 + 0.5 * e.life), a * (0.2 + 0.4 * e.life));
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;

    // дым поднимается и сносится ветром; у затухающего костра он жиже
    const smokeK = 0.3 + 0.7 * b;
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
      s.material.opacity = 0.085 * smokeK * Math.sin(Math.PI * Math.min(k * 1.15, 1));
    }
  }
}
