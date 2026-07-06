import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { edgeTable, triTable } from './mctables.js';
import { SNOW_CONST } from './snowmaterial.js';

// Воксельное копание в духе Digger Pro, адаптированное под heightmap-движок.
//
// Идея: базовый снежный террейн (быстрый heightmap) остаётся как есть. Там, где
// игрок копает, «материализуется» воксельное SDF-поле, разбитое на чанки, и
// перестраивается в меш алгоритмом Marching Cubes. Плоский террейн под чанком
// вырезается через coverage-маску, а воксельный меш заново воссоздаёт поверхность
// (его края точно совпадают с heightmap) + вырытый объём: ямы, тоннели, навесы.
//
// Ключ к бесшовности: правки хранятся в sparse-карте по АБСОЛЮТНЫМ индексам
// вокселей. Общая граница двух чанков — это одни и те же воксели, поэтому их
// значения всегда согласованы независимо от того, в каком порядке чанки созданы.

const CHUNK = 4.0; // ребро чанка, м
const VN = 16; // вокселей на ребро чанка
const VS = CHUNK / VN; // ребро вокселя = 0.25 м
const S = VN + 1; // сэмплов на ребро (перекрытие границ)

const CLAMP = 4.0; // предел накопленной правки на воксель (м)
const CORE = 0.6; // доля радиуса с полной силой, дальше — плавный спад

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

const key = (a, b, c) => `${a}|${b}|${c}`;

export class Digger {
  constructor(scene, terrain, snowPatch) {
    this.terrain = terrain;
    this.terrainMesh = terrain.mesh;

    this.edits = new Map(); // "ix|iy|iz" -> накопленная дельта плотности
    this.chunks = new Map(); // "cx|cy|cz" -> THREE.Mesh (только непустые)

    this.group = new THREE.Group();
    scene.add(this.group);

    this.material = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0.7, 0.76, 0.9), // вырытый снег/лёд — чуть темнее и синее поверхности
      roughness: 0.82,
      metalness: 0.0,
      side: THREE.DoubleSide, // видно и стенки изнутри пещеры
    });

    // coverage-маска в плоскости XZ: где воксельный меш заменяет плоский террейн
    this.area = SNOW_CONST.WORLD;
    const RES = 512;
    this.covCanvas = document.createElement('canvas');
    this.covCanvas.width = this.covCanvas.height = RES;
    this.covCtx = this.covCanvas.getContext('2d');
    this.covCtx.fillStyle = '#000';
    this.covCtx.fillRect(0, 0, RES, RES);
    this.covTex = new THREE.CanvasTexture(this.covCanvas);
    this.covTex.flipY = false;
    this.covTex.minFilter = this.covTex.magFilter = THREE.NearestFilter;
    this.covTex.needsUpdate = true;

    // подключаем маску к материалам снега (вырезание дырки под воксельным мешем)
    for (const u of [terrain.uniforms, snowPatch && snowPatch.uniforms].filter(Boolean)) {
      u.uCut.value = this.covTex;
      u.uCutArea.value = this.area;
      u.uCutOn.value = 1;
    }

    this._ray = new THREE.Raycaster();
    this._dir = new THREE.Vector3();
  }

  // плотность в воксельном узле: >0 — грунт, <0 — воздух. Нулевая изоповерхность
  // изначально совпадает с heightmap, поэтому воксельный меш стыкуется с террейном.
  density(ix, iy, iz) {
    const base = this.terrain.getHeight(ix * VS, iz * VS) - iy * VS;
    const e = this.edits.get(key(ix, iy, iz));
    return e ? base + e : base;
  }

  // Непрерывная плотность SDF в произвольной мировой точке (для физики игрока).
  // Базовый член H(x,z)-y — аналитический (точно совпадает с heightmap), правки
  // трилинейно интерполируются между узлами вокселей → поле гладкое и совпадает
  // с видимым мешем в узлах. Без правок (edits пуст) сводится ровно к heightmap.
  densityAt(x, y, z) {
    const base = this.terrain.getHeight(x, z) - y;
    const E = this.edits;
    if (E.size === 0) return base;
    const gx = x / VS, gy = y / VS, gz = z / VS;
    const ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz);
    const fx = gx - ix, fy = gy - iy, fz = gz - iz;
    let e = 0;
    let v;
    if ((v = E.get(key(ix, iy, iz)))) e += v * (1 - fx) * (1 - fy) * (1 - fz);
    if ((v = E.get(key(ix + 1, iy, iz)))) e += v * fx * (1 - fy) * (1 - fz);
    if ((v = E.get(key(ix, iy + 1, iz)))) e += v * (1 - fx) * fy * (1 - fz);
    if ((v = E.get(key(ix + 1, iy + 1, iz)))) e += v * fx * fy * (1 - fz);
    if ((v = E.get(key(ix, iy, iz + 1)))) e += v * (1 - fx) * (1 - fy) * fz;
    if ((v = E.get(key(ix + 1, iy, iz + 1)))) e += v * fx * (1 - fy) * fz;
    if ((v = E.get(key(ix, iy + 1, iz + 1)))) e += v * (1 - fx) * fy * fz;
    if ((v = E.get(key(ix + 1, iy + 1, iz + 1)))) e += v * fx * fy * fz;
    return base + e;
  }

  // Высота ближайшей опоры под ногами: марш вниз от yTop до yBottom, ищем переход
  // воздух(<0)→грунт(≥0). Возвращает Y поверхности (лин. интерполяция) или null.
  // Если старт оказался внутри грунта (шаг вверх на уступ) — чуть поднимаемся до
  // воздуха, но не больше ~0.6 м, чтобы не пробить потолок пещеры наверх.
  surfaceBelow(x, z, yTop, yBottom, ds = 0.1) {
    let py = yTop, pd = this.densityAt(x, py, z);
    let guard = 0;
    while (pd >= 0 && guard++ < 6) { py += ds; pd = this.densityAt(x, py, z); }
    for (let y = py - ds; y >= yBottom; y -= ds) {
      const d = this.densityAt(x, y, z);
      if (pd < 0 && d >= 0) {
        const t = pd / (pd - d); // доля пути [py→y], где плотность = 0
        return py + (y - py) * t;
      }
      pd = d;
      py = y;
    }
    return null;
  }

  // копание (sign=-1) или намыв (sign=+1) сферой в мировой точке center
  edit(center, radius, sign, strength = 3.0) {
    const imin = Math.floor((center.x - radius) / VS);
    const imax = Math.ceil((center.x + radius) / VS);
    const jmin = Math.floor((center.y - radius) / VS);
    const jmax = Math.ceil((center.y + radius) / VS);
    const kmin = Math.floor((center.z - radius) / VS);
    const kmax = Math.ceil((center.z + radius) / VS);
    const inner = radius * CORE;
    const span = Math.max(1e-4, radius - inner);

    for (let iz = kmin; iz <= kmax; iz++) {
      const z = iz * VS;
      for (let iy = jmin; iy <= jmax; iy++) {
        const y = iy * VS;
        for (let ix = imin; ix <= imax; ix++) {
          const x = ix * VS;
          const d = Math.hypot(x - center.x, y - center.y, z - center.z);
          if (d >= radius) continue;
          const t = THREE.MathUtils.clamp((radius - d) / span, 0, 1);
          const w = strength * (t * t * (3 - 2 * t)); // сглаженный профиль
          if (w <= 0) continue;
          const k = key(ix, iy, iz);
          const v = THREE.MathUtils.clamp((this.edits.get(k) || 0) + sign * w, -CLAMP, CLAMP);
          this.edits.set(k, v);
        }
      }
    }

    // грязные чанки: диапазон индексов + нижний сосед по общей границе
    const cmin = (i) => {
      let c = Math.floor(i / VN);
      if (((i % VN) + VN) % VN === 0) c -= 1; // сэмпл на границе принадлежит и нижнему чанку
      return c;
    };
    const dirty = [];
    for (let cz = cmin(kmin); cz <= Math.floor(kmax / VN); cz++)
      for (let cy = cmin(jmin); cy <= Math.floor(jmax / VN); cy++)
        for (let cx = cmin(imin); cx <= Math.floor(imax / VN); cx++)
          dirty.push([cx, cy, cz]);

    let columnsChanged = false;
    for (const [cx, cy, cz] of dirty) columnsChanged = this._remesh(cx, cy, cz) || columnsChanged;
    if (columnsChanged) this._updateCoverage();
  }

  // Marching Cubes одного чанка. Возвращает true, если набор колонок изменился.
  _remesh(cx, cy, cz) {
    const k = key(cx, cy, cz);
    const had = this.chunks.has(k);

    // сэмплы плотности S³ (с перекрытием границ соседей)
    const field = new Float32Array(S * S * S);
    const ox = cx * VN, oy = cy * VN, oz = cz * VN;
    let p = 0;
    for (let z = 0; z < S; z++)
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++)
          field[p++] = this.density(ox + x, oy + y, oz + z);
    const at = (x, y, z) => field[x + S * (y + S * z)];

    const pos = [];
    const ev = new Array(12); // интерполированные вершины рёбер
    for (let z = 0; z < VN; z++) {
      for (let y = 0; y < VN; y++) {
        for (let x = 0; x < VN; x++) {
          const val = [
            at(x, y, z), at(x + 1, y, z), at(x + 1, y, z + 1), at(x, y, z + 1),
            at(x, y + 1, z), at(x + 1, y + 1, z), at(x + 1, y + 1, z + 1), at(x, y + 1, z + 1),
          ];
          let ci = 0;
          for (let c = 0; c < 8; c++) if (val[c] < 0) ci |= 1 << c;
          const edges = edgeTable[ci];
          if (edges === 0) continue;

          for (let e = 0; e < 12; e++) {
            if (!(edges & (1 << e))) continue;
            const a = EDGE[e][0], b = EDGE[e][1];
            const va = val[a], vb = val[b];
            const t = va / (va - vb); // точка пересечения нуля вдоль ребра
            const ca = CORNER[a], cb = CORNER[b];
            ev[e] = [
              (ox + x + ca[0] + (cb[0] - ca[0]) * t) * VS,
              (oy + y + ca[1] + (cb[1] - ca[1]) * t) * VS,
              (oz + z + ca[2] + (cb[2] - ca[2]) * t) * VS,
            ];
          }

          const row = ci * 16;
          for (let n = 0; triTable[row + n] !== -1; n += 3) {
            const A = ev[triTable[row + n]];
            const B = ev[triTable[row + n + 1]];
            const C = ev[triTable[row + n + 2]];
            pos.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
          }
        }
      }
    }

    const old = this.chunks.get(k);
    if (pos.length === 0) {
      if (old) {
        this.group.remove(old);
        old.geometry.dispose();
        this.chunks.delete(k);
      }
      return had; // колонки меняются, только если чанк был и исчез
    }

    let geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo = mergeVertices(geo); // сшиваем совпадающие вершины → гладкие нормали внутри чанка
    geo.computeVertexNormals();

    if (old) {
      old.geometry.dispose();
      old.geometry = geo;
    } else {
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      this.chunks.set(k, mesh);
      this.group.add(mesh);
    }
    return !had; // новый непустой чанк → колонки могли расшириться
  }

  // перерисовываем coverage-маску по колонкам (cx,cz), где есть непустые чанки
  _updateCoverage() {
    const cols = new Set();
    for (const k of this.chunks.keys()) {
      const [cx, , cz] = k.split('|');
      cols.add(`${cx}|${cz}`);
    }
    const RES = this.covCanvas.width;
    const ctx = this.covCtx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, RES, RES);
    ctx.fillStyle = '#fff';
    const toPx = (w) => (w / this.area + 0.5) * RES;
    for (const c of cols) {
      const [cx, cz] = c.split('|').map(Number);
      const x0 = toPx(cx * CHUNK), x1 = toPx((cx + 1) * CHUNK);
      const z0 = toPx(cz * CHUNK), z1 = toPx((cz + 1) * CHUNK);
      ctx.fillRect(Math.floor(x0), Math.floor(z0), Math.ceil(x1 - x0), Math.ceil(z1 - z0));
    }
    this.covTex.needsUpdate = true;
  }

  // копание из камеры: луч по взгляду, правка в точке попадания.
  // Воксельным попаданиям — приоритет: иначе при углублении ямы луч упирался бы
  // в уже вырезанный (невидимый) плоский террейн, а не в дно пещеры.
  editFromCamera(camera, sign, reach = 4.8, radius = 1.1, strength = 3.0) {
    camera.getWorldDirection(this._dir);
    this._ray.set(camera.position, this._dir);
    this._ray.far = reach;
    const vHit = this._ray.intersectObjects(this.colliders, false)[0];
    const tHit = this._ray.intersectObject(this.terrainMesh, false)[0];
    const hit = vHit || tHit;
    if (!hit) return false;
    this.edit(hit.point, radius, sign, strength);
    return true;
  }

  get colliders() {
    return [...this.chunks.values()];
  }
}
