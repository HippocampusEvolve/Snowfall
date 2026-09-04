// Сосна кодом: ствол, мутовки веток, хвоя кистями. Без пака моделей.
//
// Зачем так. Пак LOLIPOP весил 1.41 МБ сырой геометрии плюс шесть текстур, и
// поляна стояла пустой, пока лес не приезжал волной. Форма сосны - это ствол
// с сужением, мутовки веток по высоте и хвоя; всё это считается от семени за
// доли миллисекунды и вариаций даёт сколько попросишь.
//
// Тяжёлая часть - `buildPine` - чистая: ни three, ни канвы, ни браузера. На
// выходе типизированные массивы (позиции, нормали, uv, индексы), обёртка в
// `BufferGeometry` живёт отдельно (`pineGeometry`), а альфа-маска хвои - в
// `pineFoliageTexture`, и то и другое зовётся только из `trees.js`. Поэтому
// геометрию можно считать и мерить в тестах на Node.
//
// Разбивка на два меша повторяет пак: кора (материал `bark` ядра) и хвоя
// (кисти-плоскости с alphaTest по общей текстуре). LOD2 - крест из двух
// плоскостей с силуэтом из той же текстуры.

import { mulberry32 } from './seed.js';

// Рост и радиус ствола (доля от роста) по типу сосны - числа те же, что были
// у пака: от них зависит рост уже посаженных сосен в мирах игроков.
export const KINDS = [
  { name: 'big', h: [10.5, 13.5], trunk: 0.045, whorls: 11, per: 6, bare: 0.26, width: 0.25 },
  { name: 'large', h: [12, 15.5], trunk: 0.05, whorls: 12, per: 6, bare: 0.3, width: 0.24 },
  { name: 'medium', h: [7.5, 10.5], trunk: 0.042, whorls: 10, per: 5, bare: 0.2, width: 0.28 },
  { name: 'small', h: [5, 7.5], trunk: 0.04, whorls: 9, per: 5, bare: 0.18, width: 0.3 },
  { name: 'sapling', h: [1.7, 3.2], trunk: 0, whorls: 9, per: 6, bare: 0.2, width: 0.34 },
];

// Порядок вариантов ровно тот, в котором их отдавал пак: сосна ставится по
// номеру места (`vi = i % variants.length`), и перестановка списка переселила
// бы весь лес в уже сохранённых мирах.
export const VARIANTS = [
  'big_1', 'big_2', 'big_3',
  'large_1', 'large_2', 'large_3',
  'medium_1', 'medium_2', 'medium_3',
  'sapling_1', 'sapling_2', 'sapling_3',
  'small_1', 'small_2', 'small_3',
];

export const LOD_TRI_BUDGET = [3000, 900, 200];

/** Тип сосны по имени варианта (`big_2` -> запись KINDS). */
export function kindOf(variant) {
  const base = String(variant).replace(/_\d+$/, '');
  return KINDS.find((k) => k.name === base) || KINDS[2];
}

// ---- сборщик буферов ----------------------------------------------------
// Копим в обычных массивах и режем в типизированные один раз: заранее считать
// точное число вершин для дерева с ветками дороже, чем сложить их в конце.
function builder() {
  return { pos: [], nor: [], uv: [], idx: [] };
}

function vert(b, x, y, z, nx, ny, nz, u, v) {
  const i = b.pos.length / 3;
  b.pos.push(x, y, z);
  b.nor.push(nx, ny, nz);
  b.uv.push(u, v);
  return i;
}

function quad(b, a, c, d, e) {
  b.idx.push(a, c, d, a, d, e);
}

function finish(b) {
  if (!b.idx.length) return null;
  const Index = b.pos.length / 3 > 65535 ? Uint32Array : Uint16Array;
  return {
    position: new Float32Array(b.pos),
    normal: new Float32Array(b.nor),
    uv: new Float32Array(b.uv),
    index: new Index(b.idx),
  };
}

function norm3(x, y, z) {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

// ---- ствол ---------------------------------------------------------------

/** Изгиб ствола: плавный увод верхушки в сторону, тем сильнее, чем выше. */
// В нуле изгиб равен нулю ровно: комель стоит на оси инстанса, и столб
// коллайдера с осью падения сходятся с ним, а не отъезжают на сантиметры.
function bendAt(t, ax, az, ph) {
  const s = t * t * (3 - 2 * t); // сглаженный рост от нуля у комля
  return [
    ax * s + ax * 0.35 * (Math.sin(t * 4.2 + ph) - Math.sin(ph)),
    az * s + az * 0.35 * (Math.cos(t * 3.7 + ph) - Math.cos(ph)),
  ];
}

// Ствол: у комля 6-8 % роста в поперечнике, к макушке сходит в ноль.
// Тонкая жердь читалась издали белым столбом, а не деревом.
function trunkRadius(t, r0) {
  return r0 * Math.pow(1 - t * 0.985, 1.35) + 0.0012;
}

function buildTrunk(b, p) {
  const { radial, rings, r0, ax, az, ph } = p;
  const rows = [];
  for (let k = 0; k <= rings; k++) {
    const t = k / rings;
    const [cx, cz] = bendAt(t, ax, az, ph);
    const r = trunkRadius(t, r0);
    const row = [];
    for (let i = 0; i <= radial; i++) {
      const a = (i / radial) * Math.PI * 2;
      const nx = Math.cos(a);
      const nz = Math.sin(a);
      row.push(vert(b, cx + nx * r, t, cz + nz * r, nx, 0.18, nz, i / radial, t * 6));
    }
    rows.push(row);
  }
  for (let k = 0; k < rings; k++) {
    for (let i = 0; i < radial; i++) {
      quad(b, rows[k][i], rows[k][i + 1], rows[k + 1][i + 1], rows[k + 1][i]);
    }
  }
}

// ---- ветка ---------------------------------------------------------------

/** Ортонормированная тройка вокруг направления ветки. */
function frame(d) {
  const up = Math.abs(d[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = norm3(d[1] * up[2] - d[2] * up[1], d[2] * up[0] - d[0] * up[2], d[0] * up[1] - d[1] * up[0]);
  const v = norm3(d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]);
  return [u, v];
}

/** Точка на оси ветки: прямая плюс провис вниз, растущий к концу. */
function branchPoint(base, d, len, droop, s) {
  return [
    base[0] + d[0] * len * s,
    base[1] + d[1] * len * s + droop * len * s * s,
    base[2] + d[2] * len * s,
  ];
}

function buildBranch(b, base, d, len, droop, r0, segs) {
  const [u, v] = frame(d);
  const rings = [];
  for (let k = 0; k <= segs; k++) {
    const s = k / segs;
    const c = branchPoint(base, d, len, droop, s);
    const r = r0 * (1 - s) + 0.0006;
    const row = [];
    for (let i = 0; i <= 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const ox = u[0] * Math.cos(a) + v[0] * Math.sin(a);
      const oy = u[1] * Math.cos(a) + v[1] * Math.sin(a);
      const oz = u[2] * Math.cos(a) + v[2] * Math.sin(a);
      row.push(vert(b, c[0] + ox * r, c[1] + oy * r, c[2] + oz * r, ox, oy, oz, i / 3, s * 2));
    }
    rings.push(row);
  }
  for (let k = 0; k < segs; k++) {
    for (let i = 0; i < 3; i++) {
      quad(b, rings[k][i], rings[k][i + 1], rings[k + 1][i + 1], rings[k + 1][i]);
    }
  }
}

// Кисть хвои - плоскость с альфа-маской, но ОДНА плоскость на ветку читается
// плоским крестом: с ребра её не видно, и крона рассыпается на палки с редкими
// карточками (кадр в браузере, 04.09.2026). Поэтому кисти ставятся СТАНЦИЯМИ:
// в каждой точке вдоль ветки две плоскости, скрещенные под 75 градусами, и
// станций три-четыре плюс шапка на конце. С любого ракурса ветка тогда несёт
// массу, а не силуэт.
//
// Нормаль подмешана вверх, но умеренно (0.45): с полным подмесом снег
// (`snowTint`) ложился одинаково на всю крону, а он должен садиться на
// верхние кисти и обходить нижние.
// Атлас поделён ПО ГОРИЗОНТАЛИ, а не по вертикали: у кисти ось u идёт вдоль
// ветки, и тайл ей нужен широкий, а не узкий столбик.
//   v 0.5..1 - кисть хвои (вся ширина)
//   v 0..0.5 - силуэт сосны для LOD2-креста
const BRUSH_UV = [0, 1, 0.5, 1];
const CROWN_UV = [0, 1, 0, 0.5];

function brush(b, c, along, side, w, h) {
  const nx = along[1] * side[2] - along[2] * side[1];
  const ny = along[2] * side[0] - along[0] * side[2];
  const nz = along[0] * side[1] - along[1] * side[0];
  const [mx, my, mz] = norm3(nx * 0.8, ny * 0.8 + 0.32, nz * 0.8);
  const [u0, u1, v0, v1] = BRUSH_UV;
  const corner = (sa, sb, u, v) =>
    vert(
      b,
      c[0] + along[0] * w * sa + side[0] * h * sb,
      c[1] + along[1] * w * sa + side[1] * h * sb,
      c[2] + along[2] * w * sa + side[2] * h * sb,
      mx,
      my,
      mz,
      u,
      v
    );
  const a = corner(-1, -1, u0, v0);
  const c2 = corner(1, -1, u1, v0);
  const d = corner(1, 1, u1, v1);
  const e = corner(-1, 1, u0, v1);
  quad(b, a, c2, d, e);
}

const CROSS = (75 * Math.PI) / 180; // угол между плоскостями станции

function needleSpray(b, base, d, len, droop, stations, roll0, scale, crossed = true) {
  const [u, v] = frame(d);
  const sideAt = (a) => [
    u[0] * Math.cos(a) + v[0] * Math.sin(a),
    u[1] * Math.cos(a) + v[1] * Math.sin(a),
    u[2] * Math.cos(a) + v[2] * Math.sin(a),
  ];
  for (let k = 0; k < stations; k++) {
    const s = 0.2 + (0.8 * (k + 0.6)) / stations;
    const c = branchPoint(base, d, len, droop, s);
    const a = roll0 + (k * 1.1);
    // ближе к концу ветки кисть мельче - крона сходит на нет, а не обрубается
    const f = scale * len * (1.15 - 0.4 * s);
    brush(b, c, d, sideAt(a), f * 0.55, f * 0.52);
    if (crossed) brush(b, c, d, sideAt(a + CROSS), f * 0.5, f * 0.48);
  }
  // шапка на конце: поперёк ветки, закрывает голый кончик
  const tip = branchPoint(base, d, len, droop, 1);
  const f = scale * len * 0.62;
  brush(b, tip, sideAt(roll0), sideAt(roll0 + Math.PI / 2), f * 0.55, f * 0.55);
}

// ---- сама сосна ----------------------------------------------------------

/**
 * Геометрия сосны от семени. Чистая функция: одинаковое семя - одинаковые
 * байты, three не нужен.
 *
 * @param {number} seed  целое семя варианта
 * @param {number} lod   0 - вблизи, 1 - среднее кольцо, 2 - крест-билборд
 * @param {string} variant  имя варианта (`big_2`), задаёт тип сосны
 * @returns {{bark: object|null, needles: object, height: number, crown: number,
 *            branches: number, triangles: number, widths: number[]}}
 *   Основание в нуле, высота ровно 1: масштаб сосны задаётся снаружи.
 */
export function buildPine(seed, lod = 0, variant = 'medium_1') {
  const rand = mulberry32((seed | 0) * 2654435761 + 12345);
  const kind = kindOf(variant);

  // все случайные числа тянем сразу и в одном порядке: LOD-ы одной сосны
  // должны получиться одной и той же формы, только разной подробности
  const jWhorl = Math.round(rand() * 2) - 1;
  const jPer = Math.round(rand() * 2) - 1;
  const wJit = 0.9 + rand() * 0.2;
  const bareJit = 0.9 + rand() * 0.2;
  const ph = rand() * Math.PI * 2;
  const bendA = rand() * Math.PI * 2;
  const bendR = 0.008 + rand() * 0.022;
  const droopJit = 0.85 + rand() * 0.3;
  const r0 = 0.030 + rand() * 0.012; // радиус комля: поперечник 0.060-0.084 роста
  const whorlJit = Array.from({ length: 12 }, () => rand());

  const bark = builder();
  const needles = builder();

  if (lod === 2) {
    // Крест из двух плоскостей: силуэт лежит в правой половине того же атласа.
    const w = kind.width * wJit * 1.6;
    const put = (dx, dz) => {
      const nx = -dz;
      const nz = dx;
      const [cu0, cu1, cv0, cv1] = CROWN_UV;
      const c = (sa, sb, u, v) =>
        vert(needles, dx * w * sa, sb, dz * w * sa, nx, 0.35, nz, u, v);
      quad(needles, c(-1, 0, cu0, cv0), c(1, 0, cu1, cv0), c(1, 1, cu1, cv1), c(-1, 1, cu0, cv1));
    };
    put(1, 0);
    put(0, 1);
    const n = finish(needles);
    return {
      bark: null,
      needles: n,
      height: 1,
      crown: w,
      trunkR: 0,
      crownBase: 0,
      branches: 0,
      triangles: n.index.length / 3,
      widths: [w, w, w],
    };
  }

  const near = lod === 0;
  const whorls = Math.max(3, Math.round((kind.whorls + jWhorl) * (near ? 1 : 0.8)));
  const per = Math.max(3, kind.per + jPer);
  const bare = Math.min(0.5, kind.bare * bareJit);
  const width = kind.width * wJit;
  const segs = near ? 2 : 1;
  const stations = near ? 3 : 1;

  buildTrunk(bark, {
    radial: near ? 7 : 5,
    rings: near ? 11 : 6,
    r0,
    ax: Math.cos(bendA) * bendR,
    az: Math.sin(bendA) * bendR,
    ph,
  });

  let branches = 0;
  const topT = 0.92; // выше макушку держит лидер: иначе между ним и верхней мутовкой дыра
  for (let k = 0; k < whorls; k++) {
    const u = whorls > 1 ? k / (whorls - 1) : 0;
    const t = bare + (topT - bare) * u;
    const [cx, cz] = bendAt(t, Math.cos(bendA) * bendR, Math.sin(bendA) * bendR, ph);
    const rTr = trunkRadius(t, r0);
    // Длина мутовки падает к макушке почти линейно: силуэт кроны - конус.
    // Прежний профиль поджимал нижние ярусы (0.62 у комля), и снизу крона
    // была уже, чем посередине - конус получался с талией.
    const len = width * (1.0 - 0.78 * Math.pow(u, 1.05));
    // Нижние ветки провисают вниз, верхние подняты. Провис умеренный: у
    // сосны лапа свисает, но не ложится в снег - нижняя точка сборки не
    // должна уходить глубже 7 см на рост в единицу.
    const pitch = -0.12 + 0.8 * u;
    const droop = -(0.15 - 0.12 * u) * droopJit;
    const a0 = ph + k * 2.39996; // золотой угол: мутовки не встают в столбик
    for (let i = 0; i < per; i++) {
      const a = a0 + (i / per) * Math.PI * 2 + (whorlJit[(k * 7 + i) % 12] - 0.5) * 0.4;
      const cp = Math.cos(pitch);
      const d = norm3(Math.cos(a) * cp, Math.sin(pitch), Math.sin(a) * cp);
      const L = len * (0.82 + whorlJit[(k * 5 + i * 3) % 12] * 0.36);
      const base = [cx + Math.cos(a) * rTr * 0.9, t, cz + Math.sin(a) * rTr * 0.9];
      buildBranch(bark, base, d, L, droop, rTr * 0.42, segs);
      // Нижние мутовки несут кисти помельче: полноразмерная кисть на первом
      // ярусе уходила под комель на десятую долю роста - лапа лежала в снегу.
      const low = 0.62 + 0.38 * Math.min(1, u * 3.5);
      needleSpray(needles, base, d, L, droop, stations, a * 1.7, (near ? 0.9 : 1.15) * low, near);
      branches++;
    }
  }

  // Макушка: короткий лидер со своими кистями, иначе сосна кончается палкой.
  {
    const [cx, cz] = bendAt(topT, Math.cos(bendA) * bendR, Math.sin(bendA) * bendR, ph);
    const base = [cx, topT - 0.05, cz];
    const d = [0, 1, 0];
    needleSpray(needles, base, d, width * 0.62, 0, near ? 3 : 2, ph, 0.85, near);
  }

  // Приводим к росту ровно 1. Отсчёт идёт от КОМЛЯ, а не от нижней точки
  // сборки: нижние лапы свисают ниже основания ствола, и если подгонять по
  // ним, комель повисает над снегом - сосна стоит на воздухе. Комель остаётся
  // в нуле, а лапы уходят немного под снег, как им и положено.
  const boxes = [bark, needles];
  let maxY = -Infinity;
  for (const b of boxes) {
    for (let i = 1; i < b.pos.length; i += 3) {
      if (b.pos[i] > maxY) maxY = b.pos[i];
    }
  }
  const minY = 0;
  const s = 1 / Math.max(maxY - minY, 1e-6);
  let rMax = 0;
  const widths = [0, 0, 0];
  for (const b of boxes) {
    for (let i = 0; i < b.pos.length; i += 3) {
      b.pos[i] *= s;
      b.pos[i + 1] = (b.pos[i + 1] - minY) * s;
      b.pos[i + 2] *= s;
      const r = Math.hypot(b.pos[i], b.pos[i + 2]);
      if (r > rMax) rMax = r;
      const y = b.pos[i + 1];
      for (let w = 0; w < 3; w++) {
        const at = 0.35 + w * 0.25;
        if (Math.abs(y - at) < 0.06 && r > widths[w]) widths[w] = r;
      }
    }
  }

  const bk = finish(bark);
  const nd = finish(needles);
  return {
    bark: bk,
    needles: nd,
    height: 1,
    crown: rMax,
    trunkR: trunkRadius(0, r0) * s,
    crownBase: bare * s,
    branches,
    triangles: (bk ? bk.index.length / 3 : 0) + (nd ? nd.index.length / 3 : 0),
    widths: widths.map((w) => w * 2),
  };
}

// ---- обёртки для сцены (three и браузер) ---------------------------------

/** Обернуть буферы `buildPine` в BufferGeometry. */
export function pineGeometry(THREE, part) {
  if (!part) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(part.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(part.normal, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(part.uv, 2));
  g.setIndex(new THREE.BufferAttribute(part.index, 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * Альфа-маска хвои: одна карта 256x256 на весь лес, файлов нет.
 * Левая половина - кисть иголок (веер от черешка), правая - силуэт сосны
 * для LOD2-креста.
 *
 * ЧИСТАЯ функция: ни канвы, ни браузера, на выходе байты альфы. Так плотность
 * заполнения маски меряется тестом, а не глазами - редкие одиночные штрихи и
 * дали ту «решётку» вместо хвои, которую было видно в кадре.
 */
export const MASK = 256;
const HALF = MASK / 2;

/** Отрезок с круглыми концами, кладётся по максимуму (штрихи не гасят друг друга). */
function maskStroke(a, x0, y0, x1, y1, w, val) {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - w - 1));
  const maxX = Math.min(MASK - 1, Math.ceil(Math.max(x0, x1) + w + 1));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - w - 1));
  const maxY = Math.min(MASK - 1, Math.ceil(Math.max(y0, y1) + w + 1));
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let t = ((x - x0) * dx + (y - y0) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = x0 + dx * t - x;
      const py = y0 + dy * t - y;
      const d = Math.hypot(px, py);
      if (d > w) continue;
      // мягкий край: последний пиксель гаснет, а не обрубается
      const v = val * Math.min(1, (w - d) / 1.3 + 0.3);
      const at = y * MASK + x;
      if (v > a[at]) a[at] = v;
    }
  }
}

/**
 * Альфа-карта хвои: Uint8Array 256x256, 0 - дыра, 255 - хвоя.
 * Верхняя половина (строки 0..127, v 0.5..1) - кисть: черешок ЛЕЖИТ вдоль
 * ветки, иголки веером вверх и вниз. Нижняя (строки 128..255, v 0..0.5) -
 * конус лапника для LOD2.
 */
export function pineMask() {
  const a = new Uint8Array(MASK * MASK);
  const rand = mulberry32(20260904);

  // ---- кисть: строки 0..127, черешок по горизонтали ----
  // Кончик ветки - слева (u=0 у sa=-1), основание - справа. Иголки отходят
  // назад, к основанию, как у настоящей лапы.
  const axis = 64;
  maskStroke(a, 4, axis, 250, axis, 3.0, 255);
  for (let i = 0; i < 150; i++) {
    const t = i / 149;
    const x = 246 - t * 240; // от основания к кончику
    // размах: широко у основания, сходит на нет у кончика
    const grow = Math.sin(Math.PI * Math.min(1, 0.06 + t * 0.94)) ** 0.55;
    for (const dir of [-1, 1]) {
      const spread = 56 * grow * (0.7 + rand() * 0.55);
      const back = spread * (0.5 + rand() * 0.45);
      maskStroke(a, x, axis, x + back, axis + dir * spread, 1.5 + rand() * 0.9, 255);
    }
  }
  // короткий подшёрсток у самого черешка - он держит массу, а длинные иглы
  // дают рваный, «хвойный» край
  for (let i = 0; i < 64; i++) {
    const t = i / 63;
    const x = 244 - t * 236;
    const grow = Math.sin(Math.PI * Math.min(1, 0.06 + t * 0.94)) ** 0.55;
    for (const dir of [-1, 1]) {
      const spread = 30 * grow * (0.7 + rand() * 0.5);
      maskStroke(a, x, axis, x + spread * 0.55, axis + dir * spread, 1.9 + rand() * 1.0, 255);
    }
  }

  // ---- силуэт: строки 128..255, конус макушкой вверх ----
  const apex = 132;
  const foot = 252;
  maskStroke(a, HALF, foot, HALF, apex + 6, 4.5, 255);
  for (let k = 0; k < 170; k++) {
    const t = k / 169;
    const y = apex + 4 + t * (foot - apex - 6);
    const w = 8 + 104 * Math.pow(t, 0.92);
    const tier = 0.74 + 0.26 * Math.abs(Math.sin(t * 12.5)); // ярусы лап
    for (const dir of [-1, 1]) {
      const spread = w * tier * (0.86 + rand() * 0.26);
      maskStroke(a, HALF, y, HALF + dir * spread, y + spread * 0.3, 4.5 + rand() * 3, 255);
    }
  }
  return a;
}

/** Доля закрытого альфа-тестом в тайле: 0 - кисть (верх), 1 - силуэт (низ). */
export function maskFill(a, tile = 0, threshold = 116) {
  const y0 = tile * HALF;
  let hit = 0;
  for (let y = 0; y < HALF; y++) {
    for (let x = 0; x < MASK; x++) if (a[(y0 + y) * MASK + x] >= threshold) hit++;
  }
  return hit / (MASK * HALF);
}

/** Обернуть маску в канву: цвет хвои плюс альфа из карты. */
export function pineFoliageCanvas() {
  const a = pineMask();
  const c = document.createElement('canvas');
  c.width = MASK;
  c.height = MASK;
  const g = c.getContext('2d');
  const img = g.createImageData(MASK, MASK);
  const rand = mulberry32(4242);
  for (let i = 0; i < a.length; i++) {
    // ночная хвоя: тёмная и холодная, с лёгким крапом от иголки к иголке
    const n = rand();
    img.data[i * 4] = 30 + n * 16;
    img.data[i * 4 + 1] = 58 + n * 22;
    img.data[i * 4 + 2] = 46 + n * 16;
    img.data[i * 4 + 3] = a[i];
  }
  g.putImageData(img, 0, 0);
  return c;
}

export function pineFoliageTexture(THREE) {
  const tex = new THREE.CanvasTexture(pineFoliageCanvas());
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
