// Валун кодом: икосфера, сдвинутая шумом по нормали. Пак Quaternius больше не
// нужен, а форма от семени даёт столько камней, сколько попросишь.
//
// Тяжёлая часть чистая, как у сосны (`pine.js`): ни three, ни браузера, только
// типизированные массивы. Грани плоские (нормаль на треугольник) - лоу-поли
// огранка читается под снегом лучше сглаженной, а вершин втрое меньше делить
// не приходится.

import { mulberry32 } from './seed.js';

export const ROCK_VARIANTS = 3;
export const ROCK_TRI_BUDGET = 300;

const T = (1 + Math.sqrt(5)) / 2;

// икосаэдр: 12 вершин, 20 граней
const ICO_V = [
  [-1, T, 0], [1, T, 0], [-1, -T, 0], [1, -T, 0],
  [0, -1, T], [0, 1, T], [0, -1, -T], [0, 1, -T],
  [T, 0, -1], [T, 0, 1], [-T, 0, -1], [-T, 0, 1],
];
const ICO_F = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

function unit(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function mid(a, b) {
  return unit([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
}

/** Псевдошум по направлению: сумма трёх волн со своими фазами. */
function lump(d, ph) {
  let s = 0;
  for (let k = 0; k < 3; k++) {
    const f = 1.7 + k * 1.9;
    s +=
      Math.sin(d[0] * f + ph[k * 3]) *
      Math.cos(d[1] * f * 1.13 + ph[k * 3 + 1]) *
      Math.sin(d[2] * f * 0.87 + ph[k * 3 + 2]) /
      (k + 1);
  }
  return s;
}

/**
 * Геометрия валуна от семени. Чистая функция.
 *
 * Нормирован как камни пака: низ на y=0, центр в нуле, наибольший габарит = 1.
 *
 * @param {number} seed
 * @returns {{position: Float32Array, normal: Float32Array, uv: Float32Array,
 *            index: Uint16Array, triangles: number}}
 */
export function buildRock(seed) {
  const rand = mulberry32((seed | 0) * 1103515245 + 7919);
  const ph = Array.from({ length: 9 }, () => rand() * Math.PI * 2);
  const amp = 0.16 + rand() * 0.12;
  // сплющиваем валун: лежачий камень, а не мяч
  const sq = [0.9 + rand() * 0.3, 0.62 + rand() * 0.26, 0.9 + rand() * 0.3];

  // одно деление: 80 граней - под рамкой в 300 и ровно тот лоу-поли, что нужен
  const faces = [];
  for (const f of ICO_F) {
    const a = unit(ICO_V[f[0]]);
    const b = unit(ICO_V[f[1]]);
    const c = unit(ICO_V[f[2]]);
    const ab = mid(a, b);
    const bc = mid(b, c);
    const ca = mid(c, a);
    faces.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
  }

  const push = (d) => {
    const r = 0.5 * (1 + amp * lump(d, ph));
    return [d[0] * r * sq[0], d[1] * r * sq[1], d[2] * r * sq[2]];
  };

  const pos = new Float32Array(faces.length * 9);
  const nor = new Float32Array(faces.length * 9);
  const uv = new Float32Array(faces.length * 6);
  const index = new Uint16Array(faces.length * 3);
  let minY = Infinity;
  let maxY = -Infinity;
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];

  faces.forEach((f, fi) => {
    const p = f.map(push);
    for (let i = 0; i < 3; i++) {
      const o = fi * 9 + i * 3;
      pos[o] = p[i][0];
      pos[o + 1] = p[i][1];
      pos[o + 2] = p[i][2];
      // трипланарная развёртка «на глаз»: у камня нет швов, важен только масштаб
      uv[fi * 6 + i * 2] = p[i][0] + p[i][2];
      uv[fi * 6 + i * 2 + 1] = p[i][1] + p[i][2] * 0.5;
      index[fi * 3 + i] = fi * 3 + i;
      for (let k = 0; k < 3; k++) {
        if (p[i][k] < box[k]) box[k] = p[i][k];
        if (p[i][k] > box[3 + k]) box[3 + k] = p[i][k];
      }
      if (p[i][1] < minY) minY = p[i][1];
      if (p[i][1] > maxY) maxY = p[i][1];
    }
    // нормаль на грань: плоская огранка
    const ux = p[1][0] - p[0][0];
    const uy = p[1][1] - p[0][1];
    const uz = p[1][2] - p[0][2];
    const vx = p[2][0] - p[0][0];
    const vy = p[2][1] - p[0][1];
    const vz = p[2][2] - p[0][2];
    const n = unit([uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]);
    for (let i = 0; i < 3; i++) {
      const o = fi * 9 + i * 3;
      nor[o] = n[0];
      nor[o + 1] = n[1];
      nor[o + 2] = n[2];
    }
  });

  // нормализация: наибольший габарит в 1, низ в нуле, центр XZ в нуле
  const s = 1 / Math.max(box[3] - box[0], box[4] - box[1], box[5] - box[2], 1e-6);
  const cx = (box[0] + box[3]) / 2;
  const cz = (box[2] + box[5]) / 2;
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] = (pos[i] - cx) * s;
    pos[i + 1] = (pos[i + 1] - minY) * s;
    pos[i + 2] = (pos[i + 2] - cz) * s;
  }

  return { position: pos, normal: nor, uv, index, triangles: faces.length };
}

/** Обернуть буферы валуна в BufferGeometry. */
export function rockGeometry(THREE, part) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(part.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(part.normal, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(part.uv, 2));
  g.setIndex(new THREE.BufferAttribute(part.index, 1));
  g.computeBoundingSphere();
  return g;
}
