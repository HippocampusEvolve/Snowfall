import * as THREE from 'three';
import { fbm, ss } from 'world-core/materials';

// Огонь: скрещенные полотна с покадровой текстурой пламени.
//
// Раньше это жило внутри Campfire и было заточено под костёр — приземистый и
// разлапистый. Камину нужен тот же огонь, но вытянутый и узкий, поэтому форма
// вынесена в параметры, а не переписана вторым экземпляром.
//
// Пламя рисуется не шейдером, а покадрово в маленький canvas: так язычок можно
// вести по высоте — сузить кверху, качнуть, разорвать турбулентностью. Шум
// берётся из world-core: там он периодический и проверен счётом, а здесь нам
// нужна только его непериодическая часть — время.
//
// Кадр считается ЧИСТОЙ функцией drawFlame() в переданный буфер, без канвы и
// без three. Это не красота ради красоты: так форму пламени можно посчитать на
// Node и сверить числами (tools/flame-check.mjs), а не смотреть глазами в
// браузере — тот же порядок, что у материалов ядра.

/**
 * Форма пламени. Все числа — те, что стояли в костре: FLAME_DEFAULT это его
 * огонь буква в букву, и менять их здесь нельзя, не пересняв эталон проверки.
 */
export const FLAME_DEFAULT = {
  burnFade: [0.12, 0.45], // на углях язычки истаивают в ноль
  taperPow: 0.62, // кверху язычок тоньше; меньше степень — выше язык
  swayAmp: [0.1, 0.045], // качание вбок: медленное и быстрое
  swayFreq: [2.1, 3.7],
  swayPhase: [3.6, 6],
  turbScale: [3.2, 3.4], // масштаб турбулентности по полотну
  turbPeriod: [8, 64],
  turbOct: 4,
  turbSeed: 1451,
  turbSpeed: 1.35,
  turbGain: [0.45, 1.05], // кверху рвёт сильнее
  width: 0.6, // полуширина языка у основания
  fade: 0.42, // насколько язык гаснет к верхушке
  alpha: [0.26, 0.58], // порог тела пламени
  top: [0.56, 0.95], // где верхушка тает
  foot: 0.045, // у самого низа уходит в угли, а не режется краем
  core: [0.55, 0.92], // выбеленное ядро
  coreFade: [0.2, 0.72],
  coreK: 0.95,
  mid: [0.3, 0.7], // переход тёмного оранжевого в светлый
  colDim: [186, 30, 4],
  colLit: [255, 146, 26],
  colCore: [255, 240, 196],
};

/**
 * Огонь камина: тот же язык, но вытянутый и узкий. Топка ограничивает пламя с
 * боков, тяга ведёт его вверх — поэтому язык уже (width), сужается медленнее
 * (taperPow) и рвётся слабее (turbGain): в топке нет ветра, который треплет
 * костёр на открытом снегу.
 */
export const FLAME_HEARTH = {
  ...FLAME_DEFAULT,
  taperPow: 0.5,
  swayAmp: [0.07, 0.03],
  turbScale: [2.6, 3.8],
  turbSpeed: 1.15,
  turbGain: [0.34, 0.86],
  width: 0.5,
  fade: 0.36,
  // ядро мягче костровского: в тёмной комнате выбеленная сердцевина с bloom
  // съедает сами язычки, и огонь читается свечкой, а не поленом в жару
  coreK: 0.78,
  // в топке огонь смотрится горячее: угольная база краснее, ядро желтее
  colDim: [176, 24, 3],
  colLit: [255, 138, 22],
  colCore: [255, 236, 186],
};

/**
 * Кадр пламени в буфер RGBA (W*H*4). Снизу широкое, кверху сужается и рвётся
 * турбулентностью, ядро выбелено; всё полотно медленно качает вбок.
 *
 * `b` — сила горения: на углях язычки истаивают в ноль.
 */
export function drawFlame(data, W, H, t, b, o = FLAME_DEFAULT) {
  const k = ss(o.burnFade[0], o.burnFade[1], b);
  let i = 0;
  for (let y = 0; y < H; y++) {
    const v = 1 - y / H; // 0 у углей, 1 на верхушке
    const taper = Math.pow(1 - v, o.taperPow);
    const sway =
      Math.sin(t * o.swayFreq[0] + v * o.swayPhase[0]) * o.swayAmp[0] * v +
      Math.sin(t * o.swayFreq[1] + v * o.swayPhase[1]) * o.swayAmp[1] * v;
    for (let x = 0; x < W; x++, i++) {
      const u = x / W - 0.5;
      const turb =
        fbm(
          (x / W) * o.turbScale[0],
          (y / H) * o.turbScale[1] + t * o.turbSpeed,
          o.turbPeriod[0],
          o.turbPeriod[1],
          o.turbOct,
          o.turbSeed
        ) - 0.5;
      const dist = Math.abs(u - sway) / (taper * o.width + 0.02);
      const val = 1 - dist + turb * (o.turbGain[0] + v * o.turbGain[1]) - v * o.fade;
      const a =
        ss(o.alpha[0], o.alpha[1], val) * (1 - ss(o.top[0], o.top[1], v)) * ss(0, o.foot, v);
      const core = ss(o.core[0], o.core[1], val) * (1 - ss(o.coreFade[0], o.coreFade[1], v)) * o.coreK;
      const m = ss(o.mid[0], o.mid[1], val);
      const r = o.colDim[0] + (o.colLit[0] - o.colDim[0]) * m;
      const g = o.colDim[1] + (o.colLit[1] - o.colDim[1]) * m;
      const bl = o.colDim[2] + (o.colLit[2] - o.colDim[2]) * m;
      const off = i * 4;
      data[off] = r + (o.colCore[0] - r) * core;
      data[off + 1] = g + (o.colCore[1] - g) * core;
      data[off + 2] = bl + (o.colCore[2] - bl) * core;
      data[off + 3] = a * 255 * k;
    }
  }
}

/**
 * Полотна пламени в сцене: канва, текстура, материал и меши.
 *
 * Полотен три, под 60 градусов: с любой стороны огонь читается объёмным, а
 * ребро полотна не поймать (на двух крестом оно ловилось и огонь схлопывался в
 * плоскую картинку).
 *
 * Масштабы полотен класс НЕ трогает: как огонь оседает по мере выгорания,
 * решает хозяин — у костра и камина это разные истории. Класс отвечает только
 * за саму картинку и за то, чтобы она пересчитывалась не чаще, чем нужно.
 */
export class FlameSheets {
  /**
   * @param {object} p
   * @param {number} p.w ширина полотна, м
   * @param {number} p.h высота полотна, м
   * @param {number} [p.texW] ширина полотна текстуры, пикселей
   * @param {number} [p.texH] высота полотна текстуры
   * @param {number} [p.fps] сколько раз в секунду пересчитывать картинку
   * @param {number} [p.sheets] сколько полотен
   * @param {object} [p.shape] форма пламени (FLAME_DEFAULT / FLAME_HEARTH)
   * @param {THREE.Color} [p.color] множитель яркости материала
   */
  constructor({
    w,
    h,
    texW = 72,
    texH = 108,
    fps = 30,
    sheets = 3,
    shape = FLAME_DEFAULT,
    color = new THREE.Color(1.15, 1.08, 1),
    renderOrder = 3,
  }) {
    this.w = w;
    this.h = h;
    this.texW = texW;
    this.texH = texH;
    this.fps = fps;
    this.shape = shape;
    this._acc = 0;

    const canvas = document.createElement('canvas');
    canvas.width = texW;
    canvas.height = texH;
    this.ctx = canvas.getContext('2d');
    this.img = this.ctx.createImageData(texW, texH);
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;

    // чуть выше единицы: ядро перешагивает порог bloom и обрастает ореолом, а
    // тонмаппинг его не съедает (toneMapped: false)
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      color,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });

    const geo = new THREE.PlaneGeometry(w, h);
    this.sheets = [];
    for (let i = 0; i < sheets; i++) {
      const f = new THREE.Mesh(geo, this.material);
      f.rotation.y = (i * Math.PI) / sheets;
      f.renderOrder = renderOrder;
      this.sheets.push(f);
    }
    this.frame(0, 0, 1, true); // первый кадр — чтобы прогрев сцены увидел пламя, а не пустоту
  }

  /** Добавить полотна в группу. */
  addTo(group) {
    for (const f of this.sheets) group.add(f);
    return this;
  }

  /**
   * Пересчитать картинку, но не чаще fps: покадрово на телефоне это заметный
   * кусок кадра, а разницы на глаз нет.
   */
  frame(dt, t, b, force = false) {
    this._acc += dt;
    if (!force && this._acc < 1 / this.fps) return false;
    this._acc = 0;
    drawFlame(this.img.data, this.texW, this.texH, t, b, this.shape);
    this.ctx.putImageData(this.img, 0, 0);
    this.texture.needsUpdate = true;
    return true;
  }

  dispose() {
    this.texture.dispose();
    this.material.dispose();
    this.sheets[0]?.geometry.dispose();
  }
}
