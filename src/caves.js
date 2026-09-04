import { mulberry32 } from './seed.js';

// Поле пещер: чистая функция от семени, без three и без DOM. Один и тот же
// модуль исполняется на главном потоке (физика, укрытие), в воркере мешинга и
// в тестах на Node - поэтому здесь нет ни одного импорта тяжелее seed.js.
//
// Форма сети - классический «червь» на пересечении двух шумов: ход идёт там,
// где ОБА поля близки к нулю, то есть вдоль линии их пересечения. Это связная
// сеть коридоров, а не облако пузырей (пузыри дал бы один порог по одному
// шуму). Третье, низкочастотное поле локально расширяет коридор в зал.

export const DEPTH_MIN = 1.5; // тоньше потолок не бывает: под этим слоем свод
export const Y_FLOOR = -36; // ниже пещер нет (домен ключей вокселей ±64 м по y)
const BIG = 1e3; // «очень далеко от пещеры»: быстрый выход без вызова шума

// Ход: частота шума и полуширина полосы нуля. Ширина хода в метрах =
// 2 * W0 / |grad m|, где |grad m| ~ 2.2 * F_WORM для нашего градиентного шума.
// При F_WORM = 1/30 и W0 = 0.14 это около 3.8 м в поперечнике - ход, по
// которому идёшь не пригибаясь. Доля объёма при этом ~ (2.2 * W0)^2 ≈ 9 %.
//
// В замысле стояла частота порядка 1/12 м. С ней те же 3 м ширины требуют
// W0 ≈ 0.3, а это уже 40 % объёма: всё под миром превращается в губку. Ширина
// хода и доля объёма связаны через частоту жёстко, и из двух чисел замысла
// выбрано то, которое видно игроку: ширина хода и доля пустоты. См. отчёт.
const F_WORM = 1 / 30;
const W0 = 0.14;
const K = 1 / (2.2 * F_WORM); // перевод безразмерного запаса поля в метры

// Залы: низкочастотное поле раздувает полосу до HALL_GAIN раз - узлы сети
// шириной 6-9 м.
const F_HALL = 1 / 45;
const HALL_LO = 0.12;
const HALL_HI = 0.42;
const HALL_GAIN = 1.75;

// Шахта выхода: наклонный ствол от поверхности вниз до полосы ходов.
const EXIT_MIN = 3;
const EXIT_MAX = 5;
const EXIT_R0 = 25; // ближе к началу координат выходов нет
const EXIT_R1 = 60;
export const SHAFT_R = 1.7; // радиус ствола, м -> проход 3.4 м
const SHAFT_SLOPE = 35; // уклон ствола, градусов
const SHAFT_D0 = 10.5; // глубина подножия ствола, м
const SHAFT_D1 = 14.0;
const FOOT_R = 9; // радиус раздутия полосы у подножия: гарантированный зал
const FOOT_GAIN = 2.6;

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// Градиентный (перлиновский) шум с СОБСТВЕННОЙ таблицей перестановок от семени.
// ImprovedNoise из three брать нельзя: у него таблица зашита в модуль, все
// экземпляры дают одно и то же поле, и семя мира ни на что не влияло бы.
const GRAD = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

function makeNoise(rand) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (t, a, b) => a + t * (b - a);
  const g = (h, a, b, c) => {
    const G = GRAD[perm[h] % 12];
    return G[0] * a + G[1] * b + G[2] * c;
  };

  // Возвращает примерно [-1, 1] (перлин даёт ±0.7, домножаем до привычного).
  return function noise(x, y, z) {
    const px = Math.floor(x), py = Math.floor(y), pz = Math.floor(z);
    const X = px & 255, Y = py & 255, Z = pz & 255;
    const fx = x - px, fy = y - py, fz = z - pz;
    const u = fade(fx), v = fade(fy), w = fade(fz);
    const A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z;
    const B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z;
    const r = lerp(w,
      lerp(v,
        lerp(u, g(AA, fx, fy, fz), g(BA, fx - 1, fy, fz)),
        lerp(u, g(AB, fx, fy - 1, fz), g(BB, fx - 1, fy - 1, fz))),
      lerp(v,
        lerp(u, g(AA + 1, fx, fy, fz - 1), g(BA + 1, fx - 1, fy, fz - 1)),
        lerp(u, g(AB + 1, fx, fy - 1, fz - 1), g(BB + 1, fx - 1, fy - 1, fz - 1))));
    return r * 1.42;
  };
}

/**
 * Поле пещер мира.
 *
 * @param {object} o
 * @param {number} o.seed семя мира
 * @param {Array<{x:number,z:number,r:number}>} [o.avoid] цилиндры целого грунта
 */
export function createCaves({ seed = 1, avoid = [] } = {}) {
  const rand = mulberry32(seed >>> 0);
  const n1 = makeNoise(rand);
  const n2 = makeNoise(rand);
  const n3 = makeNoise(rand);

  // Выходы наверх. Направление ствола - наружу от начала координат: изба,
  // костёр и стартовая площадка лежат в центре, и подножие ствола заведомо
  // уходит от них, а не под них.
  const count = EXIT_MIN + Math.floor(rand() * (EXIT_MAX - EXIT_MIN + 1));
  const exits = [];
  let guard = 0;
  while (exits.length < count && guard++ < 400) {
    const a = rand() * Math.PI * 2;
    const r = EXIT_R0 + rand() * (EXIT_R1 - EXIT_R0);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    let ok = true;
    for (const c of avoid) if (Math.hypot(x - c.x, z - c.z) < c.r + 10) ok = false;
    for (const e of exits) if (Math.hypot(x - e.x, z - e.z) < 22) ok = false;
    if (!ok) continue;
    const depth = SHAFT_D0 + rand() * (SHAFT_D1 - SHAFT_D0);
    const run = depth / Math.tan((SHAFT_SLOPE * Math.PI) / 180); // горизонтальный снос
    exits.push({
      x, z, depth,
      fx: x + Math.cos(a) * run, // подножие: тем же лучом наружу
      fz: z + Math.sin(a) * run,
    });
  }

  // Расстояние от точки (x, depth, z) до ствола выхода. Вертикаль меряется
  // ГЛУБИНОЙ под поверхностью, а не мировым Y: так ствол сам следует за
  // рельефом и выходит на склоне ровно там, где посчитан.
  function shaftDist(x, z, depth) {
    let best = Infinity;
    for (let i = 0; i < exits.length; i++) {
      const e = exits[i];
      const ax = e.x, az = e.z, ay = -1.2; // устье чуть выше поверхности: открыто
      const dx = e.fx - ax, dy = e.depth - ay, dz = e.fz - az;
      const l2 = dx * dx + dy * dy + dz * dz;
      let t = ((x - ax) * dx + (depth - ay) * dy + (z - az) * dz) / l2;
      t = clamp01(t);
      const qx = x - (ax + dx * t), qy = depth - (ay + dy * t), qz = z - (az + dz * t);
      const d = Math.sqrt(qx * qx + qy * qy + qz * qz);
      if (d < best) best = d;
    }
    return best;
  }

  function sdf(x, y, z, depth) {
    if (y < Y_FLOOR) return BIG;
    const shaft = exits.length ? shaftDist(x, z, depth) - SHAFT_R : BIG;
    // Быстрый выход: у поверхности пещер нет вовсе, кроме устьев шахт. Физика
    // зовёт поле сотнями раз за кадр, и на поверхности оно не должно стоить
    // ни одного вызова шума.
    if (depth < DEPTH_MIN && shaft > 0) return DEPTH_MIN - depth + shaft;

    // полоса ходов, раздутая залами и подножием шахты
    let w = W0 * (1 + HALL_GAIN
      * smoothstep(HALL_LO, HALL_HI, n3(x * F_HALL, y * F_HALL, z * F_HALL)));
    for (let i = 0; i < exits.length; i++) {
      const e = exits[i];
      const d = Math.hypot(x - e.fx, z - e.fz, depth - e.depth);
      if (d < FOOT_R) w *= 1 + (FOOT_GAIN - 1) * smoothstep(FOOT_R, FOOT_R * 0.25, d);
    }
    const a1 = Math.abs(n1(x * F_WORM, y * F_WORM, z * F_WORM));
    const a2 = Math.abs(n2(x * F_WORM, y * F_WORM, z * F_WORM));
    let d = ((a1 > a2 ? a1 : a2) - w) * K;

    d = Math.max(d, DEPTH_MIN - depth); // свод сети не выходит на поверхность...
    d = Math.min(d, shaft); // ...а ствол выхода выходит, и сливается с сетью
    d = Math.max(d, Y_FLOOR - y); // дно

    for (let i = 0; i < avoid.length; i++) {
      const c = avoid[i];
      // внутри цилиндра грунт цел по построению; снаружи (c.r - dc < 0)
      // слагаемое ничего не меняет, поэтому без ветвления - иначе точка ровно
      // на образующей проскакивала бы мимо клампа
      const dc = Math.hypot(x - c.x, z - c.z);
      d = Math.max(d, c.r - dc);
    }
    return d;
  }

  // seed и avoid отдаём наружу: по ним воркер заводит у себя ТО ЖЕ поле
  return { sdf, exits, shaftDist, seed, avoid };
}

/**
 * Плотность мира одной формулой: рельеф, пещера и правка игрока.
 *
 * Пещера вырезается ПЕРЕСЕЧЕНИЕМ (min), а не вычитанием: на глубине 10 м
 * слагаемое рельефа равно +10, и сложением зал оттуда не выесть, не заведя
 * слагаемое меньше -10. min же отдаёт поле пещеры как есть.
 */
export function compose(base, y, cave, edit) {
  const g = base - y;
  return (g < cave ? g : cave) + edit;
}
