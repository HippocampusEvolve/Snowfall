import { edgeTable, triTable } from './mctables.js';
import { createCaves, compose, MATERIAL } from './caves.js';

// Мешинг чанка: marching cubes по полю «рельеф - пещера - правка».
//
// Модуль двулик по замыслу. В воркере он слушает сообщения и отдаёт буферы
// через transfer; на главном потоке и в тестах из него берут одну чистую
// функцию meshChunk - ту же самую, что крутится в воркере. Поэтому здесь нет
// ни three, ни DOM: только таблицы MC и поле пещер.
//
// Сшивка вершин идёт по ГЛОБАЛЬНОМУ НОМЕРУ РЕБРА решётки (узел плюс ось), а не
// по хэшу координат: вершина marching cubes на общем ребре двух соседних кубов
// - это буквально одно и то же число, и совпадать оно обязано точно, а не
// в пределах эпсилона. Заодно это даёт индексированную геометрию даром.

export const VN = 16; // вокселей на ребро чанка
export const VS = 0.25; // ребро вокселя, м
export const S = VN + 1; // узлов на ребро (перекрытие с соседом)
export const SW = VN + 3; // узлов с кольцом в один сэмпл: -1 .. VN+1

// раскладка Marching Cubes (Paul Bourke): 8 углов + 12 рёбер
const CORNER = [
  [0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1],
  [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1],
];
const EDGE = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];
// для каждого ребра: смещение младшего узла и ось (0=x, 1=y, 2=z)
const EDGE_NODE = EDGE.map(([a, b]) => {
  const ca = CORNER[a], cb = CORNER[b];
  const axis = ca[0] !== cb[0] ? 0 : ca[1] !== cb[1] ? 1 : 2;
  const lo = ca[axis] < cb[axis] ? ca : cb;
  return { lo, axis, aIsLo: ca[axis] < cb[axis] };
});

// Общие буферы: размеры фиксированы, заполняются целиком - выделять по 200 КБ
// на каждый чанк незачем (в воркере чанков тысячи за заход в мир).
const FIELD = new Float32Array(SW * SW * SW);
const GRAD = new Float32Array(SW * SW * SW * 3);
const MAT = new Uint8Array(SW * SW * SW);
const EDIT_MAT = new Int8Array(SW * SW * SW);
const VERT = new Int32Array(S * S * S * 3); // ребро решётки -> номер вершины

const fi = (i, j, k) => ((k + 1) * SW + (j + 1)) * SW + (i + 1); // узел -1..VN+1
const ei = (i, j, k, a) => ((k * S + j) * S + i) * 3 + a; // ребро решётки 0..VN

/**
 * Меш одного чанка.
 *
 * @param {object} job
 * @param {number} job.cx индексы чанка
 * @param {number} job.cy
 * @param {number} job.cz
 * @param {Float32Array} job.colH baseHeight в SW² узлах колонки (с кольцом),
 *   порядок (k+1)*SW + (i+1)
 * @param {number} [job.capDepth] глубина «шапки» (м): колонка не режет террейн,
 *   и всё, что выше этой глубины под поверхностью, считается сплошным грунтом -
 *   поверхность снега там рисует сам террейн, а MC отдаёт только свод пещеры
 * @param {Array<[number, number]>|null} job.edits правки: [индекс в SW³, дельта]
 * @param {Array<[number, number]>|null} job.editMaterials материалы положенной массы
 * @param {object} caves поле пещер (createCaves)
 * @returns {{position: Float32Array, normal: Float32Array, material: Uint8Array, index: Uint32Array}|null}
 */
export function meshChunk(job, caves) {
  const { cx, cy, cz, colH } = job;
  // Шапка: в неразрезанной колонке верхние capDepth метров грунта сплошные.
  // Иначе MC построил бы В НЕЙ вторую снежную поверхность поверх террейна (её
  // не видно, но она есть) - а без неё чанк, задевающий поверхность, вовсе не
  // мешился, и свод пещеры на глубине 1.5-4 м оставался без геометрии.
  const cap = job.capDepth > 0 ? job.capDepth : 0;
  const ox = cx * VN, oy = cy * VN, oz = cz * VN;

  // 1. поле в SW³ узлах: рельеф, пещера, правка - одной формулой compose
  FIELD.fill(0);
  const ed = job.edits;
  if (ed) for (let n = 0; n < ed.length; n++) FIELD[ed[n][0]] = ed[n][1];
  EDIT_MAT.fill(-1);
  const editMat = job.editMaterials;
  if (editMat) for (let n = 0; n < editMat.length; n++) EDIT_MAT[editMat[n][0]] = editMat[n][1];
  for (let k = -1; k <= VN + 1; k++) {
    const z = (oz + k) * VS;
    for (let i = -1; i <= VN + 1; i++) {
      const x = (ox + i) * VS;
      const base = colH[(k + 1) * SW + (i + 1)];
      for (let j = -1; j <= VN + 1; j++) {
        const y = (oy + j) * VS;
        const p = fi(i, j, k);
        const g = base - y;
        const cave = caves.sdf(x, y, z, g);
        // база с шапкой: слагаемое рельефа не опускается ниже cap, поэтому
        // изоповерхность снега в шапку не попадает, а свод (cave) - как был
        FIELD[p] = compose(cap && g < cap ? y + cap : base, y, cave, FIELD[p]);
        MAT[p] = EDIT_MAT[p] >= 0
          ? EDIT_MAT[p]
          : caves.materialAt
            ? caves.materialAt(x, y, z, base, cave)
            : base - y <= 1.2
              ? MATERIAL.SNOW
              : base - y <= 4
                ? MATERIAL.SOIL
                : MATERIAL.STONE;
      }
    }
  }

  // 2. градиент поля в узлах 0..VN центральной разностью. Разность берётся по
  // ГЛОБАЛЬНОЙ решётке (кольцо для того и приехало), поэтому у общего узла двух
  // чанков она одна и та же - нормали продолжаются через границу без шва.
  const inv = 1 / (2 * VS);
  for (let k = 0; k <= VN; k++) {
    for (let j = 0; j <= VN; j++) {
      for (let i = 0; i <= VN; i++) {
        const p = fi(i, j, k), q = p * 3;
        GRAD[q] = (FIELD[p + 1] - FIELD[p - 1]) * inv; // +1 по i: x - младшая ось
        GRAD[q + 1] = (FIELD[p + SW] - FIELD[p - SW]) * inv;
        GRAD[q + 2] = (FIELD[p + SW * SW] - FIELD[p - SW * SW]) * inv;
      }
    }
  }

  // 3. marching cubes со сшивкой по номеру ребра
  VERT.fill(-1);
  const pos = [];
  const nrm = [];
  const mat = [];
  const idx = [];
  const ev = new Int32Array(12);

  const vertexOn = (ni, nj, nk, axis, vLo, vHi) => {
    const e = ei(ni, nj, nk, axis);
    const had = VERT[e];
    if (had >= 0) return had;
    const t = vLo / (vLo - vHi);
    const px = (ox + ni + (axis === 0 ? t : 0)) * VS;
    const py = (oy + nj + (axis === 1 ? t : 0)) * VS;
    const pz = (oz + nk + (axis === 2 ? t : 0)) * VS;
    // нормаль - линейная интерполяция узловых градиентов вдоль того же ребра
    const a = fi(ni, nj, nk) * 3;
    const b = fi(ni + (axis === 0 ? 1 : 0), nj + (axis === 1 ? 1 : 0), nk + (axis === 2 ? 1 : 0)) * 3;
    let gx = GRAD[a] + (GRAD[b] - GRAD[a]) * t;
    let gy = GRAD[a + 1] + (GRAD[b + 1] - GRAD[a + 1]) * t;
    let gz = GRAD[a + 2] + (GRAD[b + 2] - GRAD[a + 2]) * t;
    const l = Math.hypot(gx, gy, gz);
    // поле >0 в грунте, <0 в воздухе: наружу смотрит АНТИградиент
    if (l > 1e-9) { gx = -gx / l; gy = -gy / l; gz = -gz / l; } else { gx = 0; gy = 1; gz = 0; }
    const n = pos.length / 3;
    pos.push(px, py, pz);
    nrm.push(gx, gy, gz);
    // На границе слоёв ребро может видеть два кода. Больший код означает
    // более твёрдую сторону, её и закрепляем за общей вершиной.
    const pa = fi(ni, nj, nk);
    const pb = fi(
      ni + (axis === 0 ? 1 : 0),
      nj + (axis === 1 ? 1 : 0),
      nk + (axis === 2 ? 1 : 0)
    );
    const ma = MAT[pa], mb = MAT[pb];
    const ea = EDIT_MAT[pa], eb = EDIT_MAT[pb];
    // Материал положенной массы важнее природного слоя по другую сторону
    // ребра. Это особенно заметно у снега, чей код меньше камня и грунта.
    mat.push(ea >= 0 ? ea : eb >= 0 ? eb : ma > mb ? ma : mb);
    VERT[e] = n;
    return n;
  };

  const val = new Float64Array(8);
  for (let k = 0; k < VN; k++) {
    for (let j = 0; j < VN; j++) {
      for (let i = 0; i < VN; i++) {
        let ci = 0;
        for (let c = 0; c < 8; c++) {
          const o = CORNER[c];
          const v = FIELD[fi(i + o[0], j + o[1], k + o[2])];
          val[c] = v;
          if (v < 0) ci |= 1 << c;
        }
        const edges = edgeTable[ci];
        if (edges === 0) continue;
        for (let e = 0; e < 12; e++) {
          if (!(edges & (1 << e))) continue;
          const { lo, axis, aIsLo } = EDGE_NODE[e];
          const a = EDGE[e][0], b = EDGE[e][1];
          const vLo = aIsLo ? val[a] : val[b];
          const vHi = aIsLo ? val[b] : val[a];
          ev[e] = vertexOn(i + lo[0], j + lo[1], k + lo[2], axis, vLo, vHi);
        }
        const row = ci * 16;
        for (let n = 0; triTable[row + n] !== -1; n += 3) {
          // порядок A, C, B: при нашей конвенции знака (<0 - воздух) таблицы
          // дают обход внутрь грунта, переворачиваем наружу
          idx.push(ev[triTable[row + n]], ev[triTable[row + n + 2]], ev[triTable[row + n + 1]]);
        }
      }
    }
  }

  if (idx.length === 0) return null;
  return {
    position: new Float32Array(pos),
    normal: new Float32Array(nrm),
    material: new Uint8Array(mat),
    index: new Uint32Array(idx),
  };
}

// ---- воркерная половина ----
// Проверка именно на WorkerGlobalScope, а не на `typeof self`: на главном
// потоке браузера self - это window, и модуль подписался бы на сообщения окна.
const inWorker =
  typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;

if (inWorker) {
  let caves = null;
  self.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.kind === 'init') {
      caves = createCaves({ seed: msg.seed, avoid: msg.avoid });
      self.postMessage({ kind: 'ready', exits: caves.exits });
      return;
    }
    const out = meshChunk(msg, caves);
    if (!out) {
      self.postMessage({ kind: 'chunk', cx: msg.cx, cy: msg.cy, cz: msg.cz, ver: msg.ver, empty: true });
      return;
    }
    self.postMessage(
      { kind: 'chunk', cx: msg.cx, cy: msg.cy, cz: msg.cz, ver: msg.ver, ...out },
      [out.position.buffer, out.normal.buffer, out.material.buffer, out.index.buffer]
    );
  };
}
