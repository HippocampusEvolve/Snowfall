import * as THREE from 'three';
import { VIEW_Z } from './viewmodel.js';

// Лопата — инструмент копания (VISION.md: мир — это интерфейс, материя имеет
// вес и место). Живёт в мире воткнутой в снег; F — взять в руки, F — воткнуть
// там, где стоишь. В руках: ЛКМ — копнуть (срез-штык), ПКМ — уложить снег.
// Правка, звук и брызги происходят в момент ВРЕЗАНИЯ штыка, не по клику —
// замах короткой анимацией.
//
// Анимация собрана по канону FPS-viewmodel, и три вещи в ней неслучайны:
//   * ВРАЩЕНИЕ ИДЁТ ВОКРУГ КИСТЕЙ. Модель построена от острия штыка, поэтому
//     наивный поворот группы гоняет по дуге рукоять, а штык стоит на месте —
//     читается как «лопату двигают», а не «человек машет». Пивот вынесен на
//     черенок (PIVOT_Y), и штык описывает настоящую дугу рычага.
//   * КРИВЫЕ РАЗНЫЕ ПО ФАЗАМ. Замах — 'io' (зависает в верхней точке), бросок —
//     'in' (скорость МАКСИМАЛЬНА ровно в кадре контакта). Симметричный
//     smoothstep на броске гасит скорость там, где нужен удар, и он «ватный».
//   * КОНТАКТ — СОБЫТИЕ. За ним подряд: hitstop (поза заморожена), отдача
//     камеры (см. punch) и рычаг, которым ком отрывают от забоя.
// Копание — не рубка: ЛКМ гонит штык ТОЛЧКОМ вдоль оси (срез), дуга и сброс
// кистью принадлежат ПКМ (намыву). Оттого два разных набора кейфреймов.

const REST = new THREE.Euler(1.18, -0.12, -0.16); // покойный наклон в руках
const PIVOT_Y = 0.75; // где на черенке лежит нижняя кисть — центр вращения
// Остриё в покое, камерное пространство. Y подобран так, чтобы штык с тулейкой
// СТОЯЛИ В КАДРЕ у нижне-правого края: при y=-0.5 вся лопата в покое лежала
// ниже кромки 55°-frustum'а — «исчезала из рук» и появлялась только в замахе.
const TIP = new THREE.Vector3(0.3, -0.34, -0.55 * VIEW_Z);

const CANCEL = 0.82; // с какой доли цикла принимается следующий замах
const BLEND = 0.06; // с — сшивка поз на стыке цепочки
const PUNCH_W = 18; // 1/с — жёсткость пружины отдачи камеры (ζ=1, оседает ~180 мс)

const POSE = ['px', 'py', 'pz', 'rx', 'ry', 'rz'];

const ss = (k) => {
  const t = THREE.MathUtils.clamp(k, 0, 1);
  return t * t * (3 - 2 * t);
};

// Кривая ВХОДА в кейфрейм:
//   io   — приходим с нулевой скоростью (замах зависает в верхней точке)
//   in   — разгон: скорость максимальна ровно в кадре контакта
//   out  — торможение: передемпфированный возврат, без отскока
//   hold — заморозка (hitstop): скорость обнуляется ударом
const EASE = {
  io: ss,
  in: (k) => k * k * k,
  out: (k) => 1 - (1 - k) ** 3,
  hold: () => 0,
};

// кейфрейм: [u, значение, кривая входа]; u — доля цикла
function track(kf, u) {
  for (let i = 1; i < kf.length; i++) {
    const [t1, v1, e] = kf[i];
    if (u > t1) continue;
    const [t0, v0] = kf[i - 1];
    return v0 + (v1 - v0) * EASE[e]((u - t0) / (t1 - t0));
  }
  return kf[kf.length - 1][1];
}

// Раскладка тяжёлого инструмента: замах ~38% цикла, бросок ~8% (быстро!),
// hitstop ~60 мс, дальше рычаг и оседание. impact совпадает с концом броска —
// с точкой максимального выноса штыка и максимальной его скорости.
// px/py/pz — камерное смещение кистей; rx/ry/rz — поворот вокруг них.
// -rx гонит штык вниз-вперёд, +rx поднимает (см. REST).
const STROKES = {
  // срез-штык: отвели и подняли → толчок вниз-вперёд → рычаг, ком отрывается
  dig: {
    dur: 0.78,
    impact: 0.46,
    punch: { pitch: 1.7, roll: -0.55 },
    px: [[0, 0], [0.38, 0.04, 'io'], [0.46, -0.05, 'in'], [0.535, -0.05, 'hold'], [0.7, -0.02, 'out'], [1, 0, 'out']],
    py: [[0, 0], [0.38, 0.1, 'io'], [0.46, -0.2, 'in'], [0.535, -0.2, 'hold'], [0.7, 0.02, 'out'], [1, 0, 'out']],
    pz: [[0, 0], [0.38, 0.12, 'io'], [0.46, -0.26, 'in'], [0.535, -0.26, 'hold'], [0.7, -0.1, 'out'], [1, 0, 'out']],
    rx: [[0, 0], [0.38, 0.4, 'io'], [0.46, -0.34, 'in'], [0.535, -0.34, 'hold'], [0.7, 0.16, 'out'], [1, 0, 'out']],
    ry: [[0, 0], [0.38, 0.1, 'io'], [0.46, -0.08, 'in'], [0.535, -0.08, 'hold'], [0.7, -0.02, 'out'], [1, 0, 'out']],
    rz: [[0, 0], [0.38, 0.12, 'io'], [0.46, -0.06, 'in'], [0.535, -0.06, 'hold'], [0.7, 0.02, 'out'], [1, 0, 'out']],
  },
  // намыв: подобрали снизу → вынос вперёд-вверх → сброс кистью
  build: {
    dur: 0.68,
    impact: 0.48,
    punch: { pitch: 0.7, roll: 0.25 },
    px: [[0, 0], [0.4, 0.02, 'io'], [0.48, -0.03, 'in'], [0.545, -0.03, 'hold'], [0.72, -0.01, 'out'], [1, 0, 'out']],
    py: [[0, 0], [0.4, -0.08, 'io'], [0.48, 0.16, 'in'], [0.545, 0.16, 'hold'], [0.72, 0.05, 'out'], [1, 0, 'out']],
    pz: [[0, 0], [0.4, 0.06, 'io'], [0.48, -0.18, 'in'], [0.545, -0.18, 'hold'], [0.72, -0.05, 'out'], [1, 0, 'out']],
    rx: [[0, 0], [0.4, -0.1, 'io'], [0.48, 0.55, 'in'], [0.545, 0.55, 'hold'], [0.72, 0.2, 'out'], [1, 0, 'out']],
    ry: [[0, 0], [0.4, 0.04, 'io'], [0.48, -0.06, 'in'], [0.545, -0.06, 'hold'], [0.72, -0.02, 'out'], [1, 0, 'out']],
    rz: [[0, 0], [0.4, 0.05, 'io'], [0.48, -0.18, 'in'], [0.545, -0.18, 'hold'], [0.72, -0.05, 'out'], [1, 0, 'out']],
  },
};

function shovelMaterials() {
  return {
    metal: new THREE.MeshStandardMaterial({ color: 0x5f6a76, metalness: 0.75, roughness: 0.45 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x74512f, roughness: 0.85 }),
  };
}

// сборка лопаты: остриё штыка в НАЧАЛЕ КООРДИНАТ, черенок вверх по +Y
function buildShovel() {
  const g = new THREE.Group();
  const m = shovelMaterials();

  // штык — выгнутый совок: плоскость с поперечным прогибом и сужением к острию
  const bladeGeo = new THREE.PlaneGeometry(0.24, 0.32, 6, 5);
  const pos = bladeGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i); // -0.16 (остриё) .. 0.16 (плечи)
    const u = x / 0.12; // -1..1 поперёк
    const taper = 0.72 + 0.28 * ss((y + 0.16) / 0.32); // к острию у́же
    pos.setX(i, x * taper);
    pos.setZ(i, (1 - u * u) * 0.035); // прогиб совка
  }
  bladeGeo.computeVertexNormals();
  const blade = new THREE.Mesh(bladeGeo, m.metal);
  blade.material.side = THREE.DoubleSide;
  blade.position.y = 0.16;
  blade.castShadow = true;
  g.add(blade);

  // тулейка (стакан крепления черенка)
  const socket = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.026, 0.14, 8), m.metal);
  socket.position.set(0, 0.38, 0.028);
  socket.castShadow = true;
  g.add(socket);

  // черенок
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.021, 0.98, 8), m.wood);
  shaft.position.set(0, 0.93, 0.03);
  shaft.castShadow = true;
  g.add(shaft);

  // ручка-перекладина
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.15, 8), m.wood);
  grip.rotation.z = Math.PI / 2;
  grip.position.set(0, 1.43, 0.03);
  grip.castShadow = true;
  g.add(grip);

  return g;
}

// Снежные брызги врезания: короткий фонтан крошки из-под штыка
const BURST_MAX = 220;
class SnowBurst {
  constructor(scene) {
    this.live = []; // {x,y,z,vx,vy,vz,age,ttl}
    this.posArr = new Float32Array(BURST_MAX * 3);
    this.aArr = new Float32Array(BURST_MAX);
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
          gl_PointSize = uPR * 52.0 / max(0.5, -mv.z);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.16, d) * vA;
          gl_FragColor = vec4(vec3(0.84, 0.88, 0.97), a);
        }
      `,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  spawn(point, dir) {
    const n = 26;
    for (let i = 0; i < n; i++) {
      if (this.live.length >= BURST_MAX) break;
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
    const drag = Math.exp(-1.6 * dt);
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.age += dt;
      if (p.age >= p.ttl) {
        this.live[i] = this.live[this.live.length - 1];
        this.live.pop();
        continue;
      }
      p.vy -= 7.5 * dt; // снежная крошка лёгкая — падает мягче камня
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

export class Shovel {
  // scene — мир (воткнутая лопата и брызги), view — слой viewmodel (лопата в руках)
  constructor(scene, view) {
    // лопата в мире — воткнута в снег
    this.world = buildShovel();
    this.world.visible = false;
    scene.add(this.world);
    this.pos = new THREE.Vector3();
    this.yaw = 0;
    this.held = false;

    // Лопата в руках. holder — кисти, swing — поза замаха вокруг них,
    // carried — модель, сдвинутая так, чтобы точка (0,PIVOT_Y,0) черенка
    // легла ровно в центр вращения.
    this.holder = new THREE.Group();
    this.holder.visible = false;
    this.swing = new THREE.Group();
    this.holder.add(this.swing);

    const carried = buildShovel();
    carried.rotation.copy(REST);
    const grip = new THREE.Vector3(0, PIVOT_Y, 0).applyEuler(REST);
    carried.position.copy(grip).negate();
    this.swing.add(carried);
    this.holder.position.copy(TIP).add(grip); // остриё садится ровно в TIP
    view.add(this.holder);

    this.swingT = -1; // <0 — покой
    this.kind = null; // 'dig' | 'build'
    this.stroke = null;
    this.dur = 1;
    this.amp = 1; // разброс амплитуды: цепочка замахов не должна быть метрономом
    this.cross = 1; // разброс «диагонали» броска
    this._n = 0;
    this._impactFired = true;
    this._blendT = BLEND;
    this._pose = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 };
    this._from = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 };

    // Отдача камеры (viewpunch). Мир дёргается, viewmodel — нет: он привязан
    // к виду, своя отдача у него в кейфреймах. main.js накладывает punch на
    // камеру перед рендером и снимает сразу после — иначе viewmodel прочитал
    // бы его как угловую скорость взгляда (рывок sway).
    this.punch = { pitch: 0, roll: 0 };
    this._punchV = { pitch: 0, roll: 0 };

    this.bursts = new SnowBurst(scene);
  }

  get busy() {
    return this.swingT >= 0;
  }

  // поставить лопату в мире (воткнута остриём в снег, слегка наклонена)
  place(x, y, z, yaw) {
    this.pos.set(x, y, z);
    this.yaw = yaw;
    this.world.position.set(x, y - 0.12, z);
    this.world.rotation.set(0.2, yaw, 0.07, 'YXZ');
    this.world.visible = !this.held;
  }

  take() {
    this.held = true;
    this.world.visible = false;
    this.holder.visible = true;
  }

  plant(x, y, z, yaw) {
    this.held = false;
    this.holder.visible = false;
    this._rest();
    this.place(x, y, z, yaw);
  }

  // Цепочка замахов: следующий принимается уже на исходе оседания (CANCEL) —
  // иначе зажатая кнопка ощущается залипшей. Стык поз сшивается блендом.
  trySwing(kind) {
    if (!this.held) return false;
    if (this.swingT >= 0 && this.swingT / this.dur < CANCEL) return false;

    for (const c of POSE) this._from[c] = this._pose[c];
    this._blendT = 0;

    this.kind = kind;
    this.stroke = STROKES[kind];
    this.amp = 0.92 + Math.random() * 0.16;
    this.dur = this.stroke.dur / (0.94 + Math.random() * 0.12);
    this.cross = this._n++ % 2 ? 1 : 0.55; // диагональ броска гуляет от замаха к замаху
    this.swingT = 0;
    this._impactFired = false;
    return true;
  }

  spray(point, dir) {
    this.bursts.spawn(point, dir);
  }

  _rest() {
    this.swingT = -1;
    this._blendT = BLEND;
    for (const c of POSE) this._pose[c] = 0;
    this.swing.position.set(0, 0, 0);
    this.swing.rotation.set(0, 0, 0);
  }

  // отдача камеры: импульс в скорость (не в угол) — старт мягкий, спад упругий
  _kick({ pitch, roll }) {
    this._punchV.pitch += pitch;
    this._punchV.roll += roll * this.cross;
  }

  _punchStep(dt) {
    const w = PUNCH_W;
    for (const c of ['pitch', 'roll']) {
      this._punchV[c] += (-w * w * this.punch[c] - 2 * w * this._punchV[c]) * dt;
      this.punch[c] += this._punchV[c] * dt;
    }
  }

  // onImpact(kind) зовётся один раз в момент врезания штыка и возвращает,
  // укусил ли штык снег: промах не должен отдавать в камеру
  update(dt, onImpact) {
    this.bursts.update(dt);
    this._punchStep(dt);
    if (this.swingT < 0) return;

    this.swingT += dt;
    const u = this.swingT / this.dur;
    const s = this.stroke;

    if (!this._impactFired && u >= s.impact) {
      this._impactFired = true;
      if (onImpact(this.kind)) this._kick(s.punch);
    }

    const p = this._pose;
    const a = this.amp;
    p.px = track(s.px, u) * a * this.cross;
    p.py = track(s.py, u) * a;
    p.pz = track(s.pz, u) * a * VIEW_Z;
    p.rx = track(s.rx, u) * a;
    p.ry = track(s.ry, u) * a * this.cross;
    p.rz = track(s.rz, u) * a * this.cross;

    // сшивка со старой позой, если замах начат поверх недооседавшего
    if (this._blendT < BLEND) {
      this._blendT += dt;
      const k = ss(this._blendT / BLEND);
      for (const c of POSE) p[c] = this._from[c] + (p[c] - this._from[c]) * k;
    }

    this.swing.position.set(p.px, p.py, p.pz);
    this.swing.rotation.set(p.rx, p.ry, p.rz);

    if (u >= 1) this._rest();
  }
}
