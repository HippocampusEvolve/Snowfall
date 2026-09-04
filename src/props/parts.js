// Описание предмета примитивами, отдельно от three.
//
// Мир собирает предмет из коробок, цилиндров, камней-икосаэдров, тел вращения
// и дуг. Здесь лежит только ОПИСАНИЕ этих деталей и арифметика по нему:
// сколько треугольников выйдет у three и какой габарит займёт готовая группа.
// Ни одной строчки three - оттого проверка идёт счётом на Node, без канвы и
// без браузера, и меряет ровно то, из чего собирается сцена.
//
// Формулы треугольников и вершин повторяют генераторы three дословно:
// BoxGeometry - 12 треугольников; CylinderGeometry - бок seg*2 (или seg, если
// один радиус нулевой) плюс по seg на каждую ненулевую крышку;
// IcosahedronGeometry(r, 0) - 20 треугольников и 12 вершин на сфере радиуса r;
// LatheGeometry - (точек-1)*seg*2; TorusGeometry - tubeSeg*arcSeg*2.
// Совпадение сверяется тестом на настоящей геометрии (test/props.test.js).

/** Золотое сечение: по нему стоят вершины икосаэдра в three. */
const PHI = (1 + Math.sqrt(5)) / 2;
const ICO_K = 1 / Math.hypot(1, PHI); // множитель нормировки вершины на сферу
const ICO_VERTS = [
  [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
  [0, -1, PHI], [0, 1, PHI], [0, -1, -PHI], [0, 1, -PHI],
  [PHI, 0, -1], [PHI, 0, 1], [-PHI, 0, -1], [-PHI, 0, 1],
].map(([x, y, z]) => [x * ICO_K, y * ICO_K, z * ICO_K]);

// ---- описание деталей ----

/**
 * Коробка w x h x d с центром в (x, y, z).
 *
 * `taper` сужает коробку вдоль оси: `{ axis: 'y', x: [1, 0.4], pivot: {...} }`
 * означает «по мере роста y множитель ширины идёт от 1 до 0.4», а `pivot` -
 * та точка местных координат, относительно которой сужение считается (для
 * стойки камина это её НАРУЖНАЯ грань: она обязана остаться на месте).
 */
export function box(role, w, h, d, x, y, z, o = {}) {
  return { kind: 'box', role, w, h, d, x, y, z, ...o };
}

/** Цилиндр по оси Y: радиусы верха и низа, высота, центр в (x, y, z). */
export function cyl(role, rTop, rBottom, h, seg, x, y, z, o = {}) {
  return { kind: 'cyl', role, rTop, rBottom, h, seg, x, y, z, ...o };
}

/** Камень: икосаэдр радиуса r, `scale` мнёт его в неправильный булыжник. */
export function ico(role, r, x, y, z, o = {}) {
  return { kind: 'ico', role, r, x, y, z, ...o };
}

/** Тело вращения: профиль [[r, y], ...] вокруг оси Y. */
export function lathe(role, profile, seg, x, y, z, o = {}) {
  return { kind: 'lathe', role, profile, seg, x, y, z, ...o };
}

/** Дуга круглого прутка: радиус кольца, радиус прутка, дуга в радианах. */
export function torus(role, r, tube, tubeSeg, arcSeg, arc, x, y, z, o = {}) {
  return { kind: 'torus', role, r, tube, tubeSeg, arcSeg, arc, x, y, z, ...o };
}

// ---- счёт ----

/** Треугольники одной детали - ровно столько, сколько построит three. */
export function partTriangles(p) {
  switch (p.kind) {
    case 'box':
      return 12;
    case 'cyl': {
      const side = p.open || (p.rTop > 0 && p.rBottom > 0) ? p.seg * 2 : p.seg;
      if (p.open) return side;
      return side + (p.rTop > 0 ? p.seg : 0) + (p.rBottom > 0 ? p.seg : 0);
    }
    case 'ico':
      return 20;
    case 'lathe':
      return (p.profile.length - 1) * p.seg * 2;
    case 'torus':
      return p.tubeSeg * p.arcSeg * 2;
    default:
      throw new Error(`неизвестная деталь: ${p.kind}`);
  }
}

/** Треугольники всего предмета. */
export function countTriangles(parts) {
  return parts.reduce((sum, p) => sum + partTriangles(p), 0);
}

/** Сколько выйдет мешей: по одному на роль - столько же и draw call'ов. */
export function countDrawCalls(parts) {
  return new Set(parts.map((p) => p.role)).size;
}

// ---- габариты ----

/** Вершины детали в её местных координатах, до поворота и посадки. */
function localVerts(p) {
  const v = [];
  switch (p.kind) {
    case 'box': {
      const hx = p.w / 2;
      const hy = p.h / 2;
      const hz = p.d / 2;
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        v.push([sx * hx, sy * hy, sz * hz]);
      }
      if (p.taper) {
        const t = p.taper;
        const piv = t.pivot || {};
        const px = piv.x ?? 0;
        const py = piv.y ?? 0;
        const pz = piv.z ?? 0;
        const span = t.axis === 'x' ? p.w : t.axis === 'z' ? p.d : p.h;
        const ai = t.axis === 'x' ? 0 : t.axis === 'z' ? 2 : 1;
        for (const q of v) {
          const u = q[ai] / span + 0.5; // 0 у дальнего конца оси, 1 у ближнего
          if (t.x) q[0] = (q[0] - px) * (t.x[0] + (t.x[1] - t.x[0]) * u) + px;
          if (t.y) q[1] = (q[1] - py) * (t.y[0] + (t.y[1] - t.y[0]) * u) + py;
          if (t.z) q[2] = (q[2] - pz) * (t.z[0] + (t.z[1] - t.z[0]) * u) + pz;
        }
      }
      break;
    }
    case 'cyl': {
      const hy = p.h / 2;
      for (let k = 0; k < p.seg; k++) {
        const a = (k / p.seg) * Math.PI * 2;
        const s = Math.sin(a);
        const c = Math.cos(a);
        v.push([p.rTop * s, hy, p.rTop * c], [p.rBottom * s, -hy, p.rBottom * c]);
      }
      break;
    }
    case 'ico': {
      const s = p.scale || [1, 1, 1];
      for (const [x, y, z] of ICO_VERTS) v.push([x * p.r * s[0], y * p.r * s[1], z * p.r * s[2]]);
      break;
    }
    case 'lathe': {
      for (let k = 0; k < p.seg; k++) {
        const a = (k / p.seg) * Math.PI * 2;
        const s = Math.sin(a);
        const c = Math.cos(a);
        for (const [r, y] of p.profile) v.push([r * s, y, r * c]);
      }
      break;
    }
    case 'torus': {
      for (let i = 0; i <= p.arcSeg; i++) {
        const u = (i / p.arcSeg) * p.arc;
        for (let j = 0; j <= p.tubeSeg; j++) {
          const w = (j / p.tubeSeg) * Math.PI * 2;
          const rr = p.r + p.tube * Math.cos(w);
          v.push([rr * Math.cos(u), rr * Math.sin(u), p.tube * Math.sin(w)]);
        }
      }
      break;
    }
    default:
      throw new Error(`неизвестная деталь: ${p.kind}`);
  }
  return v;
}

/**
 * Поворот в порядке three по умолчанию (Euler 'XYZ').
 *
 * 'XYZ' у three значит R = Rx * Ry * Rz, то есть к вектору сначала
 * применяется Z, затем Y, затем X. Порядок здесь тот же, иначе габарит
 * повёрнутой детали разойдётся со сценой.
 */
function rotate(q, rot) {
  const [rx = 0, ry = 0, rz = 0] = rot;
  let [x, y, z] = q;
  if (rz) { const c = Math.cos(rz), s = Math.sin(rz); [x, y] = [x * c - y * s, x * s + y * c]; }
  if (ry) { const c = Math.cos(ry), s = Math.sin(ry); [x, z] = [x * c + z * s, -x * s + z * c]; }
  if (rx) { const c = Math.cos(rx), s = Math.sin(rx); [y, z] = [y * c - z * s, y * s + z * c]; }
  return [x, y, z];
}

/** Габарит предмета: min, max и размер по каждой оси. */
export function boundsOf(parts) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    for (const q of localVerts(p)) {
      const w = rotate(q, p.rot || []);
      const world = [w[0] + p.x, w[1] + p.y, w[2] + p.z];
      for (let i = 0; i < 3; i++) {
        if (world[i] < min[i]) min[i] = world[i];
        if (world[i] > max[i]) max[i] = world[i];
      }
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/** Есть ли в описании NaN или бесконечность - в сцену такое пускать нельзя. */
export function finiteParts(parts) {
  const bad = [];
  const walk = (v, path) => {
    if (typeof v === 'number') { if (!Number.isFinite(v)) bad.push(path); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) walk(v[k], `${path}.${k}`); }
  };
  parts.forEach((p, i) => walk(p, `${p.role || '?'}#${i}`));
  return bad;
}

/**
 * Треугольники коробочных деталей - для проверок, которым нужна не рамка, а
 * сама поверхность (`tools/firebox-check.mjs` пускает по ней лучи).
 *
 * Только коробки: у камина других деталей нет, а честно повторять здесь
 * триангуляцию цилиндра и икосаэдра значило бы завести вторую копию three,
 * которая рано или поздно разойдётся с первой.
 */
export function boxTriangles(parts) {
  const pos = [];
  const idx = [];
  // Номер угла - три бита: старший x, средний y, младший z; 0 это минус.
  const FACES = [
    [0, 1, 2], [1, 3, 2], [4, 5, 6], [5, 7, 6],
    [0, 1, 4], [1, 5, 4], [2, 3, 6], [3, 7, 6],
    [0, 2, 4], [2, 6, 4], [1, 3, 5], [3, 7, 5],
  ];
  for (const p of parts) {
    if (p.kind !== 'box') throw new Error(`boxTriangles: деталь ${p.kind} не коробка`);
    const base = pos.length / 3;
    for (const q of localVerts(p)) {
      const w = rotate(q, p.rot || []);
      pos.push(w[0] + p.x, w[1] + p.y, w[2] + p.z);
    }
    for (const f of FACES) idx.push(base + f[0], base + f[1], base + f[2]);
  }
  return { pos: Float64Array.from(pos), idx: Float64Array.from(idx) };
}
