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

// Ключ вокселя/чанка — SMI-число (упаковка умножением), не строка: editAt зовёт
// Map.get до 8 раз на сэмпл, а физика игрока сэмплит SDF сотнями раз за кадр —
// строковые ключи аллоцировали ~700 временных строк/кадр (GC-иголки) и дорого
// хешировались. Домен: ix,iz ∈ [-1024, 1024), iy ∈ [-256, 256) — ±256 м по
// горизонтали и ±64 м по вертикали при вокселе 0.25 м (мир 400 м → ±800, запас).
// x — младшая ось: сосед по x = ключ+KX, по z = +KZ, по y = +KY, поэтому 8 углов
// трилинейной ячейки — одна упаковка и семь сложений. Упаковывать ТОЛЬКО
// умножением: сдвиг << переполнил бы int32 (максимум ключа = 2^31-1, ровно
// потолок SMI); распаковка сдвигами безопасна — ключ неотрицателен.
const KX = 1;
const KZ = 2048; // = размер домена по x
const KY = 2048 * 2048; // = размер домена по x·z
const key = (ix, iy, iz) => ix + 1024 + (iz + 1024) * KZ + (iy + 256) * KY;
const unX = (k) => (k & 2047) - 1024;
const unZ = (k) => ((k >>> 11) & 2047) - 1024;
const unY = (k) => (k >>> 22) - 256;
// колонка (cx,cz) без вертикали: нижние биты ключа чанка (см. маску COLM)
const COLM = KY - 1;
const colKey = (cx, cz) => cx + 1024 + (cz + 1024) * KZ;

// общий буфер сэмплов _remesh: размер фиксирован, заполняется целиком — незачем
// выделять 20 КБ на каждый перестраиваемый чанк
const FIELD = new Float32Array(S * S * S);

export class Digger {
  constructor(scene, terrain, snowPatch, footprints) {
    this.terrain = terrain;
    this.terrainMesh = terrain.mesh;
    this.footprints = footprints; // правка у поверхности стирает следы на ней

    this.edits = new Map(); // key(ix,iy,iz) -> накопленная дельта плотности
    this.chunks = new Map(); // key(cx,cy,cz) -> THREE.Mesh (только непустые)
    // colKey(cx,cz) -> {h, hMin, hMax} — кэш baseHeight по узлам колонки чанков.
    // Рельеф статичен (копание живёт в edits, heightmap не меняется) → кэш вечный;
    // повторные копки в тех же колонках не пересчитывают террейн вовсе (~1.2 КБ
    // на колонку — раскоп в десятки колонок стоит копейки)
    this._heightCache = new Map();
    this.onChanged = null; // зовётся после перестройки мешей (main: перерисовать тени)

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
    this.skirt.visible = false; // включается в _rebuildSkirt; bbox считается там же
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

  // Высоты колонки чанков (cx,cz): baseHeight в S×S узлах + min/max, из кэша
  // (см. _heightCache). h[z*S + x] — порядок обхода как в сэмплах _remesh.
  _columnHeights(cx, cz) {
    const ck = colKey(cx, cz);
    let c = this._heightCache.get(ck);
    if (c) return c;
    const h = new Float32Array(S * S);
    let hMin = Infinity, hMax = -Infinity;
    let q = 0;
    for (let z = 0; z <= VN; z++) {
      for (let x = 0; x <= VN; x++) {
        const v = this.baseHeight((cx * VN + x) * VS, (cz * VN + z) * VS);
        h[q++] = v;
        if (v < hMin) hMin = v;
        if (v > hMax) hMax = v;
      }
    }
    c = { h, hMin, hMax };
    this._heightCache.set(ck, c);
    return c;
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

  // трилинейная интерполяция накопленных правок в произвольной точке.
  // Горячий путь физики: ключ пакуется один раз, остальные 7 углов ячейки —
  // сложением констант осей (x — младшая, см. key)
  editAt(x, y, z) {
    const E = this.edits;
    if (E.size === 0) return 0;
    const gx = x / VS, gy = y / VS, gz = z / VS;
    const ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz);
    const fx = gx - ix, fy = gy - iy, fz = gz - iz;
    const k = key(ix, iy, iz);
    let e = 0;
    let v;
    if ((v = E.get(k))) e += v * (1 - fx) * (1 - fy) * (1 - fz);
    if ((v = E.get(k + KX))) e += v * fx * (1 - fy) * (1 - fz);
    if ((v = E.get(k + KY))) e += v * (1 - fx) * fy * (1 - fz);
    if ((v = E.get(k + KX + KY))) e += v * fx * fy * (1 - fz);
    if ((v = E.get(k + KZ))) e += v * (1 - fx) * (1 - fy) * fz;
    if ((v = E.get(k + KX + KZ))) e += v * fx * (1 - fy) * fz;
    if ((v = E.get(k + KY + KZ))) e += v * (1 - fx) * fy * fz;
    if ((v = E.get(k + KX + KY + KZ))) e += v * fx * fy * fz;
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
        let k = key(imin, iy, iz); // вдоль x ключ растёт на KX=1
        for (let ix = imin; ix <= imax; ix++, k++) {
          const x = ix * VS;
          const d = Math.hypot(x - center.x, y - center.y, z - center.z);
          if (d >= radius) continue;
          const t = THREE.MathUtils.clamp((radius - d) / span, 0, 1);
          const w = strength * (t * t * (3 - 2 * t)); // сглаженный профиль
          if (w <= 0) continue;
          const v = THREE.MathUtils.clamp((this.edits.get(k) || 0) + sign * w, -CLAMP, CLAMP);
          this.edits.set(k, v);
        }
      }
    }

    this._remeshRange(imin, imax, jmin, jmax, kmin, kmax);
  }

  // Копок лопатой: ориентированный по yaw бокс с РЕЗКИМ профилем спада —
  // плоское дно, ровные стенки (marching cubes воспроизводит плоскость точно;
  // «мыльность» старых ям давала сферическая кисть с плавным спадом, не сетка).
  // half = {x, y, z} — полуразмеры бокса в его локальных осях; falloff — узкая
  // кромка осыпания (м). Стыки соседних копков оставляют лёгкие гребни —
  // это и есть следы штыка.
  editBox(center, yaw, half, sign, strength = 2.4, falloff = 0.1) {
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const ex = Math.abs(cos) * half.x + Math.abs(sin) * half.z + falloff;
    const ey = half.y + falloff;
    const ez = Math.abs(sin) * half.x + Math.abs(cos) * half.z + falloff;
    const imin = Math.floor((center.x - ex) / VS);
    const imax = Math.ceil((center.x + ex) / VS);
    const jmin = Math.floor((center.y - ey) / VS);
    const jmax = Math.ceil((center.y + ey) / VS);
    const kmin = Math.floor((center.z - ez) / VS);
    const kmax = Math.ceil((center.z + ez) / VS);

    for (let iz = kmin; iz <= kmax; iz++) {
      for (let iy = jmin; iy <= jmax; iy++) {
        const dy = iy * VS - center.y;
        let k = key(imin, iy, iz); // вдоль x ключ растёт на KX=1
        for (let ix = imin; ix <= imax; ix++, k++) {
          const dx = ix * VS - center.x;
          const dz = iz * VS - center.z;
          // локальные координаты бокса (поворот на -yaw)
          const lx = cos * dx + sin * dz;
          const lz = -sin * dx + cos * dz;
          // расстояние Чебышёва до граней бокса: ≤0 внутри
          const d = Math.max(
            Math.abs(lx) - half.x,
            Math.abs(dy) - half.y,
            Math.abs(lz) - half.z
          );
          const w = strength * THREE.MathUtils.clamp(1 - d / falloff, 0, 1);
          if (w <= 0) continue;
          const v = THREE.MathUtils.clamp((this.edits.get(k) || 0) + sign * w, -CLAMP, CLAMP);
          this.edits.set(k, v);
        }
      }
    }
    this._remeshRange(imin, imax, jmin, jmax, kmin, kmax);
  }

  // перестроить чанки, затронутые правкой в диапазоне воксельных индексов
  _remeshRange(imin, imax, jmin, jmax, kmin, kmax) {
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
        const { hMin, hMax } = this._columnHeights(cx, cz);
        const jlo = Math.min(jmin, Math.floor(hMin / VS) - 1);
        const jhi = Math.max(jmax, Math.ceil(hMax / VS) + 1);
        for (let cy = cmin(jlo); cy <= Math.floor(jhi / VN); cy++) dirty.push([cx, cy, cz]);
      }
    }

    let columnsChanged = false;
    for (const [cx, cy, cz] of dirty) columnsChanged = this._remesh(cx, cy, cz) || columnsChanged;
    if (columnsChanged) this._updateCoverage();
    if (this.onChanged) this.onChanged();
  }

  // Marching Cubes одного чанка. Возвращает true, если набор колонок изменился.
  _remesh(cx, cy, cz) {
    const k = key(cx, cy, cz);
    const had = this.chunks.has(k);

    // Сэмплы плотности S³ (с перекрытием границ соседей). Развёрнутый density():
    // базовая высота зависит только от колонки — берём из вечного кэша, а не
    // пересчитываем на каждом из S³ узлов; ключ правки вдоль x — инкремент
    const field = FIELD;
    const ox = cx * VN, oy = cy * VN, oz = cz * VN;
    const colH = this._columnHeights(cx, cz).h;
    const E = this.edits;
    let p = 0;
    for (let z = 0; z < S; z++) {
      const zRow = z * S;
      for (let y = 0; y < S; y++) {
        const yw = (oy + y) * VS;
        let k = key(ox, oy + y, oz + z);
        for (let x = 0; x < S; x++, k++) {
          const e = E.get(k);
          field[p++] = colH[zRow + x] - yw + (e || 0);
        }
      }
    }
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
    // позиции в мировых координатах, матрица меша единичная — сфера честная;
    // считаем её здесь, чтобы чанк проходил frustum culling (камеры И теней),
    // а не рисовался всегда, как раньше с frustumCulled=false
    geo.computeBoundingSphere();

    if (old) {
      old.geometry.dispose();
      old.geometry = geo;
    } else {
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.castShadow = mesh.receiveShadow = true;
      this.chunks.set(k, mesh);
      this.group.add(mesh);
    }
    return !had; // новый непустой чанк → колонки могли расшириться
  }

  // перерисовываем coverage-маску по колонкам (cx,cz), где есть непустые чанки
  _updateCoverage() {
    const cols = new Set();
    for (const k of this.chunks.keys()) cols.add(k & COLM); // нижние биты = colKey
    const RES = this.covCanvas.width; // 1 тексель = 1 колонка чанков
    const ctx = this.covCtx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, RES, RES);
    ctx.fillStyle = '#fff';
    for (const c of cols) {
      ctx.fillRect(unX(c) + RES / 2, unZ(c) + RES / 2, 1, 1);
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
      const cx = unX(c), cz = unZ(c);
      for (const [dcx, dcz, ox, oz, ax, az, nx, nz] of EDGES) {
        if (cols.has(c + dcx + dcz * KZ)) continue; // ребро внутреннее (сосед-colKey)
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
    if (pos.length) geo.computeBoundingSphere(); // мировые координаты — culling честный
    this.skirt.geometry.dispose();
    this.skirt.geometry = geo;
    this.skirt.visible = pos.length > 0; // у пустой геометрии сфера NaN — прячем меш
  }

  // луч по взгляду до снега (воксельным попаданиям — приоритет: иначе при
  // углублении ямы луч упирался бы в уже вырезанный невидимый террейн)
  _aim(camera, reach) {
    camera.getWorldDirection(this._dir);
    this._ray.set(camera.position, this._dir);
    this._ray.far = reach;
    const vHit = this._ray.intersectObjects(this.colliders, false)[0];
    const tHit = this._ray.intersectObject(this.terrainMesh, false)[0];
    return vHit || tHit || null;
  }

  // копание из камеры сферой — debug-инструмент (E/Q и мышь в ?debug)
  editFromCamera(camera, sign, reach = 4.8, radius = 1.1, strength = 3.0) {
    const hit = this._aim(camera, reach);
    if (!hit) return false;
    this.edit(hit.point, radius, sign, strength);
    return true;
  }

  // Копок лопатой из камеры: штык входит по взгляду в точку прицела.
  // sign=-1 — снять штык снега, sign=+1 — уложить/намыть. Бокс ориентирован
  // по азимуту взгляда, оси вертикальны: вертикальные стенки, плоское дно.
  // Возвращает точку врезания (для брызг/звука) или null (промах).
  shovelEdit(camera, sign, reach = 3.4) {
    const hit = this._aim(camera, reach);
    if (!hit) return null;
    const c = hit.point.clone().addScaledVector(this._dir, 0.12);
    c.y += sign > 0 ? 0.1 : -0.08; // укладка растёт над точкой, копок — вглубь
    const yaw = Math.atan2(this._dir.x, this._dir.z);
    this.editBox(c, yaw, { x: 0.34, y: 0.24, z: 0.34 }, sign, 2.4, 0.1);
    // правка у поверхности снимает/засыпает и следы на ней: свежий срез чист,
    // а под глубоким тоннелем поверхностные следы не трогаем
    if (
      this.footprints &&
      Math.abs(hit.point.y - this.baseHeight(hit.point.x, hit.point.z)) < 1.2
    ) {
      this.footprints.eraseCircle(hit.point.x, hit.point.z, 0.55);
    }
    return hit.point;
  }

  get colliders() {
    return [...this.chunks.values()];
  }

  // Восстановление правок из сохранения (см. save.js): заполняем edits разом
  // и перестраиваем все затронутые чанки — та же логика «грязных» колонок,
  // что в edit(): колонка в coverage-маске вырезает террейн целиком, поэтому
  // замащиваем весь диапазон высот её поверхности, не только слой правок.
  load(entries) {
    // сейвы старого формата хранили ключ строкой "ix|iy|iz" — конвертируем на
    // месте; узлы вне домена упаковки отбрасываем, чтобы битый сейв не породил
    // фантомный чанк из-за переполнившегося ключа
    if (entries.length && typeof entries[0][0] === 'string') {
      const conv = [];
      for (const [k, v] of entries) {
        const [ix, iy, iz] = k.split('|').map(Number);
        if (ix >= -1024 && ix < 1024 && iy >= -256 && iy < 256 && iz >= -1024 && iz < 1024)
          conv.push([key(ix, iy, iz), v]);
      }
      entries = conv;
    }
    this.edits = new Map(entries);
    if (this.edits.size === 0) return;

    // диапазон iy правок по колонкам (cx,cz); сэмпл на границе чанка
    // принадлежит и нижнему соседу (как cmin() в edit())
    const span = (i) => {
      const c = Math.floor(i / VN);
      return ((i % VN) + VN) % VN === 0 ? [c - 1, c] : [c];
    };
    const cols = new Map();
    for (const k of this.edits.keys()) {
      const ix = unX(k), iy = unY(k), iz = unZ(k);
      for (const cx of span(ix)) {
        for (const cz of span(iz)) {
          const ck = colKey(cx, cz);
          const c = cols.get(ck);
          if (!c) cols.set(ck, { cx, cz, jmin: iy, jmax: iy });
          else {
            c.jmin = Math.min(c.jmin, iy);
            c.jmax = Math.max(c.jmax, iy);
          }
        }
      }
    }

    let changed = false;
    for (const { cx, cz, jmin, jmax } of cols.values()) {
      const { hMin, hMax } = this._columnHeights(cx, cz);
      const jlo = Math.min(jmin, Math.floor(hMin / VS) - 1);
      const jhi = Math.max(jmax, Math.ceil(hMax / VS) + 1);
      const cyLo = Math.floor(jlo / VN) - (((jlo % VN) + VN) % VN === 0 ? 1 : 0);
      for (let cy = cyLo; cy <= Math.floor(jhi / VN); cy++) {
        changed = this._remesh(cx, cy, cz) || changed;
      }
    }
    if (changed) this._updateCoverage();
    if (this.onChanged) this.onChanged();
  }
}
