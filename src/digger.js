import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { edgeTable, triTable } from './mctables.js';
import { SNOW_CONST, createDiggerMaterial } from './snowmaterial.js';

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

const CHUNK = SNOW_CONST.CUTCOL; // ребро чанка, м (= колонка coverage-выреза)
const VN = 16; // вокселей на ребро чанка
const VS = CHUNK / VN; // ребро вокселя = 0.25 м
const S = VN + 1; // сэмплов на ребро (перекрытие границ)

const CLAMP = 4.0; // предел накопленной правки на воксель (м)
const CORE = 0.6; // доля радиуса с полной силой, дальше — плавный спад
const EDGE_BLEND = 0.6; // ширина сшивки с мешем террейна у границы чанка, м
const SKIRT = 0.35; // юбка по периметру выреза: лента вниз от кромки меша, м

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
  constructor(scene, terrain, snowPatch, footprints) {
    this.terrain = terrain;
    this.terrainMesh = terrain.mesh;

    this.edits = new Map(); // "ix|iy|iz" -> накопленная дельта плотности
    this.chunks = new Map(); // "cx|cy|cz" -> THREE.Mesh (только непустые)

    this.group = new THREE.Group();
    scene.add(this.group);

    // единый со снегом материал: трипланарная текстура + переход в фирн вглубь
    this.material = createDiggerMaterial({
      textures: terrain.textures,
      heightTex: terrain.heightTex,
      footprints,
    });

    // Юбка по периметру выреза. Кромка воксельного меша пришита к поверхности
    // ПАТЧА (см. baseHeight), поэтому внутри его зоны стык точный; но вне её
    // сосед за линией выреза — голый террейн: он ниже на LIFT=0.03 и считает
    // высоту по треугольникам (±~2 см «твиста» к билинейной). Где сосед ниже
    // кромки, под скользящим углом видна щель — юбка закрывает её изнутри.
    // Геометрия — в _rebuildSkirt().
    this.skirt = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.skirt.castShadow = this.skirt.receiveShadow = true;
    this.skirt.frustumCulled = false;
    this.group.add(this.skirt);

    // coverage-маска в плоскости XZ: где воксельный меш заменяет плоский террейн.
    // 1 тексель = 1 колонка чанков — при NearestFilter вырез в террейне совпадает
    // с границей чанка ТОЧНО (маска произвольного разрешения резала с запасом
    // почти в тексель, и в щель между мешем и террейном было видно небо)
    this.area = SNOW_CONST.WORLD;
    const RES = Math.round(this.area / CHUNK);
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

  // Базовая высота снега для SDF. У границ чанков (там воксельный меш встречается
  // с окружающим снегом) — ТА ЖЕ поверхность, которую рисует деформируемый патч:
  // билинейная heightmap в точности текстуры (Terrain.getPatchHeight) — стык
  // с патчем вершина-в-вершину. В глубине чанка — гладкий аналитический шум;
  // между ними плавная сшивка. Вес зависит только от мировой позиции, поэтому
  // соседние чанки всегда согласованы. Плюс LIFT: патч приподнят над террейном
  // ровно на LIFT. Вне зоны патча сосед кромки — голый террейн (без LIFT,
  // треугольная интерполяция): та ступенька прячется юбкой (_rebuildSkirt).
  baseHeight(x, z) {
    const dx = Math.abs(x - Math.round(x / CHUNK) * CHUNK);
    const dz = Math.abs(z - Math.round(z / CHUNK) * CHUNK);
    const d = Math.min(dx, dz);
    if (d >= EDGE_BLEND) return this.terrain.getHeight(x, z) + SNOW_CONST.LIFT;
    const hm = this.terrain.getPatchHeight(x, z);
    const w = THREE.MathUtils.smoothstep(d, 0, EDGE_BLEND);
    return (w > 0 ? hm + (this.terrain.getHeight(x, z) - hm) * w : hm) + SNOW_CONST.LIFT;
  }

  // плотность в воксельном узле: >0 — грунт, <0 — воздух. Нулевая изоповерхность
  // изначально совпадает с heightmap, поэтому воксельный меш стыкуется с террейном.
  density(ix, iy, iz) {
    const base = this.baseHeight(ix * VS, iz * VS) - iy * VS;
    const e = this.edits.get(key(ix, iy, iz));
    return e ? base + e : base;
  }

  // Непрерывная плотность SDF в произвольной мировой точке (для физики игрока).
  // Базовый член H(x,z)-y — аналитический (точно совпадает с heightmap), правки
  // трилинейно интерполируются между узлами вокселей → поле гладкое и совпадает
  // с видимым мешем в узлах. Без правок (edits пуст) сводится ровно к heightmap.
  densityAt(x, y, z) {
    return this.baseHeight(x, z) - y + this.editAt(x, y, z);
  }

  // трилинейная интерполяция накопленных правок в произвольной точке
  editAt(x, y, z) {
    const E = this.edits;
    if (E.size === 0) return 0;
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
    return e;
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
    // По вертикали мало взять диапазон правки: колонка, попавшая в coverage-маску,
    // вырезает террейн ЦЕЛИКОМ, поэтому воксельный меш обязан замостить всю
    // поверхность колонки — включая чанки выше/ниже правки, куда уходит рельеф
    // на склоне (иначе в вырезе видно небо).
    const dirty = [];
    for (let cz = cmin(kmin); cz <= Math.floor(kmax / VN); cz++) {
      for (let cx = cmin(imin); cx <= Math.floor(imax / VN); cx++) {
        let hMin = Infinity, hMax = -Infinity;
        for (let z = 0; z <= VN; z++) {
          for (let x = 0; x <= VN; x++) {
            const h = this.baseHeight((cx * VN + x) * VS, (cz * VN + z) * VS);
            if (h < hMin) hMin = h;
            if (h > hMax) hMax = h;
          }
        }
        const jlo = Math.min(jmin, Math.floor(hMin / VS) - 1);
        const jhi = Math.max(jmax, Math.ceil(hMax / VS) + 1);
        for (let cy = cmin(jlo); cy <= Math.floor(jhi / VN); cy++) dirty.push([cx, cy, cz]);
      }
    }

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
            // порядок A,C,B: при нашей конвенции знака (<0 — воздух) таблицы дают
            // нормали внутрь грунта; переворачиваем, чтобы смотрели в воздух
            pos.push(A[0], A[1], A[2], C[0], C[1], C[2], B[0], B[1], B[2]);
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
    geo = mergeVertices(geo); // сшиваем совпадающие вершины

    // Нормали — из градиента SDF, а не из треугольников: поле глобальное, поэтому
    // нормали гладко продолжаются через границы чанков (computeVertexNormals на
    // открытом краю меша «заваливал» их — тёмный шов по контуру выреза). Базовый
    // член — та же blended-высота, что и у позиций (baseHeight): у кромки нормаль
    // сходится с нормалями патча (он тоже дифференцирует билинейную heightmap),
    // без тонального скачка на линии выреза; в глубине — гладкий аналитический
    // рельеф, как нормали террейна.
    const pAttr = geo.attributes.position;
    const nrm = new Float32Array(pAttr.count * 3);
    const eps = VS * 0.5;
    const df = (x, y, z) => this.baseHeight(x, z) - y + this.editAt(x, y, z);
    for (let i = 0; i < pAttr.count; i++) {
      const x = pAttr.getX(i), y = pAttr.getY(i), z = pAttr.getZ(i);
      const nx = df(x - eps, y, z) - df(x + eps, y, z);
      const ny = df(x, y - eps, z) - df(x, y + eps, z);
      const nz = df(x, y, z - eps) - df(x, y, z + eps);
      const l = Math.hypot(nx, ny, nz);
      if (l > 1e-6) {
        nrm[i * 3] = nx / l; nrm[i * 3 + 1] = ny / l; nrm[i * 3 + 2] = nz / l;
      } else {
        nrm[i * 3 + 1] = 1;
      }
    }
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));

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
    const RES = this.covCanvas.width; // 1 тексель = 1 колонка чанков
    const ctx = this.covCtx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, RES, RES);
    ctx.fillStyle = '#fff';
    for (const c of cols) {
      const [cx, cz] = c.split('|').map(Number);
      ctx.fillRect(cx + RES / 2, cz + RES / 2, 1, 1);
    }
    this.covTex.needsUpdate = true;
    this._rebuildSkirt(cols);
  }

  // Юбка: по каждому наружному ребру покрытых колонок — вертикальная лента от
  // кромки меша вниз на SKIRT. На плоскости выреза правки всегда нулевые (иначе
  // соседняя колонка тоже была бы покрыта), поэтому кромка MC-меша проходит
  // точно через baseHeight в узлах решётки 0.25 м — верх юбки совпадает с ней
  // вершина в вершину. Нормаль наружу и горизонтальна: шейдер красит юбку как
  // «стенку» среза (трипланар по нужной оси, холодный тинт) — видимая полоска
  // в щели читается как снежный уступ. Перестройка только при смене колонок.
  _rebuildSkirt(cols) {
    const pos = [];
    const nrm = [];
    // [dcx, dcz, ox, oz, ax, az, nx, nz]: сосед, угол начала ребра (в колонках),
    // ось вдоль ребра, наружная нормаль
    const EDGES = [
      [-1, 0, 0, 0, 0, 1, -1, 0], // запад
      [1, 0, 1, 0, 0, 1, 1, 0], // восток
      [0, -1, 0, 0, 1, 0, 0, -1], // север
      [0, 1, 0, 1, 1, 0, 0, 1], // юг
    ];
    for (const c of cols) {
      const [cx, cz] = c.split('|').map(Number);
      for (const [dcx, dcz, ox, oz, ax, az, nx, nz] of EDGES) {
        if (cols.has(`${cx + dcx}|${cz + dcz}`)) continue; // ребро внутреннее
        const bx = (cx + ox) * VN, bz = (cz + oz) * VN; // старт ребра, в вокселях
        let px = bx * VS, pz = bz * VS;
        let py = this.baseHeight(px, pz);
        for (let s = 1; s <= VN; s++) {
          const qx = (bx + ax * s) * VS, qz = (bz + az * s) * VS;
          const qy = this.baseHeight(qx, qz);
          pos.push(
            px, py, pz, qx, qy, qz, qx, qy - SKIRT, qz,
            px, py, pz, qx, qy - SKIRT, qz, px, py - SKIRT, pz
          );
          for (let i = 0; i < 6; i++) nrm.push(nx, 0, nz);
          px = qx; pz = qz; py = qy;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    this.skirt.geometry.dispose();
    this.skirt.geometry = geo;
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
