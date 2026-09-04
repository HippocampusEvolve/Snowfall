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
  { name: 'big', h: [10.5, 13.5], trunk: 0.045, whorls: 8, per: 5, bare: 0.3, width: 0.2 },
  { name: 'large', h: [12, 15.5], trunk: 0.05, whorls: 9, per: 5, bare: 0.34, width: 0.19 },
  { name: 'medium', h: [7.5, 10.5], trunk: 0.042, whorls: 7, per: 4, bare: 0.24, width: 0.23 },
  { name: 'small', h: [5, 7.5], trunk: 0.04, whorls: 6, per: 4, bare: 0.18, width: 0.26 },
  { name: 'sapling', h: [1.7, 3.2], trunk: 0, whorls: 5, per: 3, bare: 0.1, width: 0.3 },
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
function bendAt(t, ax, az, ph) {
  const s = t * t * (3 - 2 * t); // сглаженный рост от нуля у комля
  return [ax * s + ax * 0.35 * Math.sin(t * 4.2 + ph), az * s + az * 0.35 * Math.cos(t * 3.7 + ph)];
}

function trunkRadius(t, r0) {
  return r0 * Math.pow(1 - t * 0.97, 1.25) + 0.0014;
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

// Кисть хвои: одна плоскость с альфа-маской. Плоскость лежит ВДОЛЬ ветки
// (одна ось - сама ветка), а поворот вокруг ветки у соседних кистей разный:
// так спрей иголок читается объёмом с любой стороны, а не карточкой.
// Нормаль подмешана вверх - снег (`snowTint`) ложится на хвою сверху.
const BRUSH_U = [0, 0.5]; // левая половина атласа - кисть

function brush(b, c, along, side, w, h) {
  const nx = along[1] * side[2] - along[2] * side[1];
  const ny = along[2] * side[0] - along[0] * side[2];
  const nz = along[0] * side[1] - along[1] * side[0];
  const [mx, my, mz] = norm3(nx * 0.55, ny * 0.55 + 0.7, nz * 0.55);
  const [u0, u1] = BRUSH_U;
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
  const a = corner(-1, -1, u0, 0);
  const c2 = corner(1, -1, u1, 0);
  const d = corner(1, 1, u1, 1);
  const e = corner(-1, 1, u0, 1);
  quad(b, a, c2, d, e);
}

function needleSpray(b, base, d, len, droop, count, roll0, scale) {
  const [u, v] = frame(d);
  for (let k = 0; k < count; k++) {
    const s = 0.22 + (0.78 * (k + 0.5)) / count;
    const c = branchPoint(base, d, len, droop, s);
    const a = roll0 + (k * Math.PI) / count;
    const side = [
      u[0] * Math.cos(a) + v[0] * Math.sin(a),
      u[1] * Math.cos(a) + v[1] * Math.sin(a),
      u[2] * Math.cos(a) + v[2] * Math.sin(a),
    ];
    // ближе к концу ветки кисть мельче - крона сходит на нет, а не обрубается
    const f = scale * len * (1.05 - 0.45 * s);
    brush(b, c, d, side, f * 0.62, f * 0.5);
  }
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
  const r0 = 0.011 + rand() * 0.008;
  const whorlJit = Array.from({ length: 12 }, () => rand());

  const bark = builder();
  const needles = builder();

  if (lod === 2) {
    // Крест из двух плоскостей: силуэт лежит в правой половине того же атласа.
    const w = kind.width * wJit * 1.6;
    const put = (dx, dz) => {
      const nx = -dz;
      const nz = dx;
      const c = (sa, sb, u, v) =>
        vert(needles, dx * w * sa, sb, dz * w * sa, nx, 0.35, nz, u, v);
      quad(needles, c(-1, 0, 0.5, 0), c(1, 0, 1, 0), c(1, 1, 1, 1), c(-1, 1, 0.5, 1));
    };
    put(1, 0);
    put(0, 1);
    const n = finish(needles);
    return {
      bark: null,
      needles: n,
      height: 1,
      crown: w,
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
  const brushes = near ? 8 : 3;

  buildTrunk(bark, {
    radial: near ? 7 : 5,
    rings: near ? 11 : 6,
    r0,
    ax: Math.cos(bendA) * bendR,
    az: Math.sin(bendA) * bendR,
    ph,
  });

  let branches = 0;
  const topT = 0.965;
  for (let k = 0; k < whorls; k++) {
    const u = whorls > 1 ? k / (whorls - 1) : 0;
    const t = bare + (topT - bare) * u;
    const [cx, cz] = bendAt(t, Math.cos(bendA) * bendR, Math.sin(bendA) * bendR, ph);
    const rTr = trunkRadius(t, r0);
    // длина мутовки падает к макушке; самый широкий ярус - чуть выше нижнего
    const len = width * (1.0 - 0.82 * Math.pow(u, 0.85)) * (0.62 + 0.38 * Math.min(1, u * 6 + 0.35));
    // нижние ветки провисают вниз, верхние подняты
    const pitch = -0.34 + 0.9 * u;
    const droop = -(0.34 - 0.3 * u) * droopJit;
    const a0 = ph + k * 2.39996; // золотой угол: мутовки не встают в столбик
    for (let i = 0; i < per; i++) {
      const a = a0 + (i / per) * Math.PI * 2 + (whorlJit[(k * 7 + i) % 12] - 0.5) * 0.4;
      const cp = Math.cos(pitch);
      const d = norm3(Math.cos(a) * cp, Math.sin(pitch), Math.sin(a) * cp);
      const L = len * (0.82 + whorlJit[(k * 5 + i * 3) % 12] * 0.36);
      const base = [cx + Math.cos(a) * rTr * 0.9, t, cz + Math.sin(a) * rTr * 0.9];
      buildBranch(bark, base, d, L, droop, rTr * 0.42, segs);
      needleSpray(needles, base, d, L, droop, brushes, a * 1.7, near ? 0.72 : 0.95);
      branches++;
    }
  }

  // Макушка: короткий лидер со своими кистями, иначе сосна кончается палкой.
  {
    const [cx, cz] = bendAt(topT, Math.cos(bendA) * bendR, Math.sin(bendA) * bendR, ph);
    const base = [cx, topT - 0.04, cz];
    const d = [0, 1, 0];
    needleSpray(needles, base, d, width * 0.5, 0, near ? 3 : 2, ph, 0.8);
  }

  // Приводим к росту ровно 1 с основанием в нуле: макушка и кисти могут
  // выступить за верх, и лучше подогнать сборку целиком, чем резать кисти.
  const boxes = [bark, needles];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    for (let i = 1; i < b.pos.length; i += 3) {
      if (b.pos[i] < minY) minY = b.pos[i];
      if (b.pos[i] > maxY) maxY = b.pos[i];
    }
  }
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
 * Альфа-маска хвои: одна канва 256x256 на весь лес, файлов нет.
 * Левая половина - кисть иголок (пучок штрихов от черешка), правая - силуэт
 * сосны для LOD2-креста.
 */
export function pineFoliageCanvas(seed = 7) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 256);
  const rand = mulberry32(seed);

  // кисть: веточка снизу вверх, от неё иголки ёлочкой в обе стороны
  g.lineCap = 'round';
  g.strokeStyle = '#3f5a35';
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(64, 250);
  g.lineTo(64, 18);
  g.stroke();
  for (let i = 0; i < 96; i++) {
    const t = i / 95;
    const y = 250 - t * 232;
    const spread = 56 * Math.sin(Math.PI * Math.min(1, t * 1.15)) * (0.75 + rand() * 0.45);
    for (const dir of [-1, 1]) {
      const lift = 16 + rand() * 14;
      g.strokeStyle = `rgb(${44 + rand() * 30 | 0}, ${86 + rand() * 46 | 0}, ${40 + rand() * 26 | 0})`;
      g.lineWidth = 2.4 + rand() * 1.4;
      g.beginPath();
      g.moveTo(64, y);
      g.lineTo(64 + dir * spread, y - lift);
      g.stroke();
    }
  }

  // силуэт: конус лапника с рваным краем - LOD2 виден с 85 м и дальше
  g.fillStyle = '#3d5a34';
  const tiers = 7;
  for (let k = 0; k < tiers; k++) {
    const t = k / (tiers - 1);
    const yTop = 236 - t * 214;
    const yBot = yTop + 46;
    const w = 58 * (1 - t * 0.86) + 6;
    g.beginPath();
    g.moveTo(192, yTop - 14);
    for (let i = 0; i <= 8; i++) {
      const f = i / 8;
      g.lineTo(192 - w + 2 * w * f, yBot - Math.abs(f - 0.5) * 14 + (rand() - 0.5) * 8);
    }
    g.closePath();
    g.fill();
  }
  g.fillStyle = '#4a3a2c';
  g.fillRect(188, 200, 9, 52);
  return c;
}

export function pineFoliageTexture(THREE) {
  const tex = new THREE.CanvasTexture(pineFoliageCanvas());
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
