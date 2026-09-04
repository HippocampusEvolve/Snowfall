import * as THREE from 'three';
import { SNOW_CONST, createDiggerMaterial } from './snowmaterial.js';
import { PIT_DEPTH } from './growth.js';
import { compose, DEPTH_MIN, Y_FLOOR } from './caves.js';
import { meshChunk, VN, VS, SW } from './mesher.worker.js';
import {
  CAVE_LOAD_RADIUS,
  SURFACE_LOAD_RADIUS,
  chunkLoadRadius,
  chunkKeepRadius,
  mergeChunkParts,
} from './cavebudget.js';

// Воксельный объём мира: природные пещеры от семени плюс раскоп игрока.
//
// Идея: базовый снежный террейн (быстрый heightmap) остаётся как есть. Под ним
// живёт процедурное поле пещер (caves.js), а поверх - разреженная карта правок
// игрока. Плотность узла собирается ОДНОЙ формулой compose(base, y, cave, edit)
// - той же самой, что считает воркер, физика и тесты. Всё, где поле меняет знак,
// режется marching cubes на чанки 16³ по 0.25 м.
//
// Что здесь главное:
//
// 1. Мешинг уехал в воркер (mesher.worker.js). Главный поток только собирает
//    задание (высоты колонки и правки чанка), а обратно получает готовые
//    буферы. За кадр он ставит не больше двух чанков.
// 2. Чанки живут в радиусе R от игрока и выгружаются за R + гистерезис.
//    Правки при выгрузке никуда не деваются: они в edits, а не в мешах.
// 3. Вырез террейна (coverage) режет колонку НЕ по «есть непустой чанк», как
//    раньше, а по «в приповерхностной полосе колонки есть пещера или правка».
//    Иначе любой глубокий зал вырезал бы дырку в небо на поверхности.
//
// Ключ к бесшовности прежний: правки хранятся в sparse-карте по АБСОЛЮТНЫМ
// индексам вокселей. Общая граница двух чанков - это одни и те же воксели,
// поэтому их значения согласованы независимо от порядка создания чанков.

const CHUNK = SNOW_CONST.CUTCOL; // ребро чанка, м (= колонка coverage-выреза)
const S = VN + 1; // сэмплов на ребро (перекрытие границ)

const CLAMP = 4.0; // предел накопленной правки на воксель (м)
const CORE = 0.6; // доля радиуса с полной силой, дальше — плавный спад
const EDGE_BLEND = 0.6; // ширина сшивки с мешем террейна у границы чанка, м
const SKIRT = 0.35; // юбка по периметру выреза: лента вниз от кромки меша, м

// Подземные части дальше 24 м не видны сквозь грунт. Приповерхностные части и
// правки игрока остаются на прежних 40 м. У обоих радиусов есть одинаковый
// гистерезис выгрузки, чтобы прогулка по кромке не гоняла мешинг туда-сюда.
const R_LOAD = SURFACE_LOAD_RADIUS;
const INSTALL_PER_FRAME = 2; // готовых чанков в кадр (см. рамку 4 мс на чанк)
const PLAN_PER_FRAME = 4; // колонок, разбираемых на чанки за кадр

// Копок лопатой: половина бокса штыка, сила и кромка осыпания. Вынесены из
// shovelEdit, потому что теми же числами копок воспроизводит журнал (save.js),
// и разъехаться этим числам нельзя - иначе восстановленная яма не совпадёт
// с вырытой.
const SHOVEL_HALF = { x: 0.34, y: 0.24, z: 0.34 };
const SHOVEL_STRENGTH = 2.4;
const SHOVEL_FALLOFF = 0.1;

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

// нижняя и верхняя границы вертикали чанков: пещер ниже Y_FLOOR нет
const CY_FLOOR = Math.floor(Y_FLOOR / CHUNK);

export class Digger {
  constructor(scene, terrain, snowPatch, footprints, caves) {
    this.terrain = terrain;
    this.terrainMesh = terrain.mesh;
    this.footprints = footprints; // правка у поверхности стирает следы на ней
    this.caves = caves;

    this.edits = new Map(); // key(ix,iy,iz) -> накопленная дельта плотности
    // Один Mesh на колонку, а не на каждый вертикальный чанк. Части воркера
    // хранятся отдельно и при установке склеиваются чистой mergeChunkParts.
    // null означает, что чанк посчитан и оказался пустым: повторно его не мешим.
    this._parts = new Map(); // key(cx,cy,cz): буферы воркера | null
    this.chunks = new Map(); // colKey(cx,cz): THREE.Mesh
    // colKey(cx,cz) -> {h, hMin, hMax} — кэш baseHeight по узлам колонки чанков
    // (сетка SW² с кольцом в один сэмпл: кольцо уезжает в воркер под градиент).
    // Рельеф статичен → кэш вечный, но при выгрузке колонки он тоже уходит,
    // иначе на прогулке по миру карта разрослась бы на весь мир.
    this._heightCache = new Map();
    // colKey -> {jmin, jmax} диапазон правок по вертикали: по нему колонка
    // решает, режет ли она террейн, и какие чанки вообще стоит трогать
    this._editCols = new Map();
    this._cutCols = new Set(); // колонки, вырезающие террейн
    this._plan = new Map(); // colKey -> Set(cy), какие чанки колонке положены
    this.onChanged = null; // зовётся после установки чанков (main: перерисовать тени)
    this.onStroke = null; // зовётся на каждый копок лопатой (журнал в save.js)
    // Тихий режим воспроизведения: правки копятся, чанки не перестраиваются.
    this._quiet = false;

    this.group = new THREE.Group();
    scene.add(this.group);

    this.material = createDiggerMaterial({
      textures: terrain.textures,
      heightTex: terrain.heightTex,
      footprints,
    });

    // Юбка по периметру выреза (см. _rebuildSkirt).
    this.skirt = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.skirt.castShadow = this.skirt.receiveShadow = true;
    this.skirt.visible = false;
    this._primeKeep = null;
    this.group.add(this.skirt);

    // coverage-маска в плоскости XZ: где воксельный меш заменяет плоский террейн.
    // 1 тексель = 1 колонка чанков — при NearestFilter вырез в террейне совпадает
    // с границей чанка ТОЧНО.
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

    for (const u of [terrain.uniforms, snowPatch && snowPatch.uniforms].filter(Boolean)) {
      u.uCut.value = this.covTex;
      u.uCutArea.value = this.area;
      u.uCutOn.value = 1;
    }

    this._ray = new THREE.Raycaster();
    this._dir = new THREE.Vector3();

    // ---- очередь мешинга ----
    this._queue = []; // ключи грязных чанков, ближние впереди
    this._queued = new Set();
    this._ver = new Map(); // ключ чанка -> счётчик версии
    this._busy = []; // по воркеру: ключ чанка в работе или null
    this._ready = []; // готовые результаты, ждут установки
    this._colQueue = []; // колонки, которые ещё не разобраны на чанки
    this._colQueued = new Set();
    this._lastPlanAt = null;
    this._covDirty = false;

    this._workers = [];
    try {
      const n = Math.min(2, Math.max(1, (navigator.hardwareConcurrency || 2) >= 4 ? 2 : 1));
      for (let i = 0; i < n; i++) {
        const w = new Worker(new URL('./mesher.worker.js', import.meta.url), { type: 'module' });
        w.onmessage = (ev) => this._onWorkerMessage(i, ev.data);
        w.postMessage({ kind: 'init', seed: caves.seed, avoid: caves.avoid });
        this._workers.push(w);
        this._busy.push(null);
      }
    } catch (e) {
      // Воркеров нет (старый браузер, file://) — мешаем на главном потоке.
      // Мир от этого не разваливается, только подрагивает на входе.
      console.warn('[digger] воркер не завёлся, мешинг на главном потоке', e);
      this._workers = [];
    }
  }

  // ---------------- поле ----------------

  // Базовая высота снега для SDF. У границ чанков (там воксельный меш встречается
  // с окружающим снегом) — ТА ЖЕ поверхность, которую рисует деформируемый патч:
  // билинейная heightmap в точности текстуры (Terrain.getPatchHeight) — стык
  // с патчем вершина-в-вершину. В глубине чанка — гладкий аналитический шум;
  // между ними плавная сшивка. Вес зависит только от мировой позиции, поэтому
  // соседние чанки всегда согласованы.
  baseHeight(x, z) {
    const dx = Math.abs(x - Math.round(x / CHUNK) * CHUNK);
    const dz = Math.abs(z - Math.round(z / CHUNK) * CHUNK);
    const d = Math.min(dx, dz);
    if (d >= EDGE_BLEND) return this.terrain.getHeight(x, z) + SNOW_CONST.LIFT;
    const hm = this.terrain.getPatchHeight(x, z);
    const w = THREE.MathUtils.smoothstep(d, 0, EDGE_BLEND);
    return (w > 0 ? hm + (this.terrain.getHeight(x, z) - hm) * w : hm) + SNOW_CONST.LIFT;
  }

  // Высоты колонки чанков (cx,cz): baseHeight в SW² узлах (кольцо в один сэмпл
  // с каждой стороны — воркеру оно нужно под центральную разность градиента)
  // плюс min/max по внутренним узлам.
  _columnHeights(cx, cz) {
    const ck = colKey(cx, cz);
    let c = this._heightCache.get(ck);
    if (c) return c;
    const h = new Float32Array(SW * SW);
    let hMin = Infinity, hMax = -Infinity;
    for (let k = -1; k <= VN + 1; k++) {
      for (let i = -1; i <= VN + 1; i++) {
        const v = this.baseHeight((cx * VN + i) * VS, (cz * VN + k) * VS);
        h[(k + 1) * SW + (i + 1)] = v;
        if (i >= 0 && i <= VN && k >= 0 && k <= VN) {
          if (v < hMin) hMin = v;
          if (v > hMax) hMax = v;
        }
      }
    }
    c = { h, hMin, hMax };
    this._heightCache.set(ck, c);
    return c;
  }

  // плотность в воксельном узле: >0 — грунт, <0 — воздух
  density(ix, iy, iz) {
    const x = ix * VS, y = iy * VS, z = iz * VS;
    const base = this.baseHeight(x, z);
    const e = this.edits.get(key(ix, iy, iz)) || 0;
    return compose(base, y, this.caves.sdf(x, y, z, base - y), e);
  }

  // Непрерывная плотность SDF в произвольной мировой точке (для физики игрока).
  // Базовый член H(x,z)-y — аналитический (точно совпадает с heightmap), пещера
  // — поле caves, правки трилинейно интерполируются между узлами вокселей.
  densityAt(x, y, z) {
    const base = this.baseHeight(x, z);
    return compose(base, y, this.caves.sdf(x, y, z, base - y), this.editAt(x, y, z));
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
  surfaceBelow(x, z, yTop, yBottom, ds = 0.1) {
    // Марш идёт по вертикали, а (x, z) на нём не меняются — значит и высота
    // рельефа под колонкой одна на весь марш; пещера же меняется каждый шаг,
    // её приходится звать по-настоящему (у неё свой быстрый выход по глубине:
    // на поверхности она не стоит ни одного вызова шума).
    const base = this.baseHeight(x, z);
    const C = this.caves;
    const f = (y) => compose(base, y, C.sdf(x, y, z, base - y), this.editAt(x, y, z));

    let py = yTop, pd = f(py);
    let guard = 0;
    while (pd >= 0 && guard++ < 6) { py += ds; pd = f(py); }
    for (let y = py - ds; y >= yBottom; y -= ds) {
      const d = f(y);
      if (pd < 0 && d >= 0) {
        const t = pd / (pd - d); // доля пути [py→y], где плотность = 0
        return py + (y - py) * t;
      }
      pd = d;
      py = y;
    }
    return null;
  }

  // ---------------- правки игрока ----------------

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

    this._noteEdits(imin, imax, jmin, jmax, kmin, kmax);
    this._remeshRange(imin, imax, jmin, jmax, kmin, kmax);
  }

  // Копок лопатой: ориентированный по yaw бокс с РЕЗКИМ профилем спада —
  // плоское дно, ровные стенки (marching cubes воспроизводит плоскость точно).
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
    this._noteEdits(imin, imax, jmin, jmax, kmin, kmax);
    this._remeshRange(imin, imax, jmin, jmax, kmin, kmax);
  }

  // ---------------- учёт правок по колонкам ----------------

  // Сэмпл на границе чанка принадлежит и нижнему соседу.
  static _cmin(i) {
    let c = Math.floor(i / VN);
    if (((i % VN) + VN) % VN === 0) c -= 1;
    return c;
  }

  // Запомнить, что в этих колонках появились правки и на каких высотах: по
  // этому потом решается, режет ли колонка террейн и какие чанки ей положены.
  _noteEdits(imin, imax, jmin, jmax, kmin, kmax) {
    for (let cz = Digger._cmin(kmin); cz <= Math.floor(kmax / VN); cz++) {
      for (let cx = Digger._cmin(imin); cx <= Math.floor(imax / VN); cx++) {
        const ck = colKey(cx, cz);
        const c = this._editCols.get(ck);
        if (!c) this._editCols.set(ck, { jmin, jmax });
        else { c.jmin = Math.min(c.jmin, jmin); c.jmax = Math.max(c.jmax, jmax); }
        this._plan.delete(ck); // раскладка чанков колонки устарела
      }
    }
  }

  // ---------------- раскладка колонки ----------------

  // Подходит ли пещера к диапазону высот колонки ближе чем на margin.
  //
  // Сетка редкая (2 м по всем трём осям), но решение принимается не по знаку, а
  // по ЗАПАСУ: sdf пещеры мерян в метрах, поэтому «ближайшая пустота дальше
  // 2 м от каждого узла сетки 2 м» - честное доказательство, что чанк сплошной.
  // Полного marching cubes такая проверка не стоит.
  _caveNear(cx, cz, yLo, yHi, margin = 2.0) {
    const C = this.caves;
    const { h } = this._columnHeights(cx, cz);
    for (let i = 0; i <= VN; i += VN / 2) {
      const x = (cx * VN + i) * VS;
      for (let k = 0; k <= VN; k += VN / 2) {
        const z = (cz * VN + k) * VS;
        const base = h[(k + 1) * SW + (i + 1)];
        for (let y = yLo; y <= yHi + 1e-6; y += 2) {
          if (C.sdf(x, y, z, base - y) < margin) return true;
        }
        if (C.sdf(x, yHi, z, base - yHi) < margin) return true;
      }
    }
    return false;
  }

  // Какие чанки колонки положено мешить и режет ли она террейн.
  //
  // Правило выреза: колонка режет террейн, только если её ПРИПОВЕРХНОСТНАЯ
  // полоса содержит пещеру или правку. Тогда, как и раньше, воксельный меш
  // обязан замостить всю поверхность колонки — иначе в вырезе видно небо.
  // Если полоса чиста, террейн остаётся на месте, а мешатся лишь внутренние
  // чанки: чанк, пересекающий поверхность, в неразрезанной колонке не мешится
  // никогда — иначе в одном месте оказались бы две поверхности и мерцание.
  _columnPlan(cx, cz) {
    const ck = colKey(cx, cz);
    const had = this._plan.get(ck);
    if (had) return had;

    const { hMin, hMax } = this._columnHeights(cx, cz);
    const bandLo = hMin - 1, bandHi = hMax + 1;
    const ed = this._editCols.get(ck);
    const edLo = ed ? ed.jmin * VS : Infinity;
    const edHi = ed ? ed.jmax * VS : -Infinity;

    const cut =
      (ed && edHi >= bandLo && edLo <= bandHi) || this._caveNear(cx, cz, bandLo, bandHi);

    const set = new Set();
    const wide = new Set(); // приповерхностные и правленые чанки живут до 40 м
    const cyTop = Math.floor(bandHi / CHUNK);
    const cyBottom = Math.min(CY_FLOOR, ed ? Digger._cmin(ed.jmin) : CY_FLOOR);
    for (let cy = cyBottom; cy <= cyTop; cy++) {
      const lo = cy * CHUNK, hi = (cy + 1) * CHUNK;
      const nearSurface = hi > bandLo && lo < bandHi;
      if (nearSurface) {
        if (cut) {
          set.add(cy); // разрезанная колонка мостится целиком
          wide.add(cy);
        }
        continue;
      }
      if (lo > bandHi) continue; // выше рельефа мешить нечего
      const hasEdit = ed && edHi >= lo - VS && edLo <= hi + VS;
      if (hasEdit || this._caveNear(cx, cz, lo, hi)) {
        set.add(cy);
        if (hasEdit) wide.add(cy);
      }
    }

    // Раскладка могла смениться (правка открыла или закрыла чанк) - меши,
    // которым в ней больше нет места, надо снять со сцены: иначе колонка,
    // перестав резать террейн, оставила бы вторую поверхность поверх первой.
    let dropped = false;
    for (let cy = cyBottom - 1; cy <= cyTop + 1; cy++) {
      if (set.has(cy)) continue;
      const k = key(cx, cy, cz);
      if (this._parts.has(k)) dropped = true;
      this._retire(k);
    }

    const plan = { cut, set, wide };
    this._plan.set(ck, plan);
    if (dropped) this._rebuildColumn(ck);
    if (cut) {
      if (!this._cutCols.has(ck)) { this._cutCols.add(ck); this._covDirty = true; }
    } else if (this._cutCols.delete(ck)) this._covDirty = true;
    return plan;
  }

  // ---------------- очередь и воркеры ----------------

  _enqueue(k, front = false) {
    this._ver.set(k, (this._ver.get(k) || 0) + 1);
    if (this._queued.has(k)) {
      if (!front) return;
      const i = this._queue.indexOf(k);
      if (i > 0) this._queue.splice(i, 1); else return;
    }
    this._queued.add(k);
    if (front) this._queue.unshift(k); else this._queue.push(k);
  }

  // задание воркеру: высоты колонки (с кольцом) и правки чанка
  _job(k) {
    const cx = unX(k), cy = unY(k), cz = unZ(k);
    const { h } = this._columnHeights(cx, cz);
    let edits = null;
    if (this._editCols.has(colKey(cx, cz))) {
      const E = this.edits;
      const ox = cx * VN, oy = cy * VN, oz = cz * VN;
      const list = [];
      for (let kk = -1; kk <= VN + 1; kk++) {
        for (let j = -1; j <= VN + 1; j++) {
          let vk = key(ox - 1, oy + j, oz + kk);
          for (let i = -1; i <= VN + 1; i++, vk++) {
            const v = E.get(vk);
            if (v) list.push([((kk + 1) * SW + (j + 1)) * SW + (i + 1), v]);
          }
        }
      }
      if (list.length) edits = list;
    }
    return { cx, cy, cz, ver: this._ver.get(k), colH: h, edits };
  }

  // Снять рассчитанную часть и отменить ещё не начатое задание. Результат уже
  // идущего задания протухает по версии и будет отброшен при возвращении.
  _retire(k) {
    const changed = this._parts.delete(k);
    this._ver.set(k, (this._ver.get(k) || 0) + 1);
    if (this._queued.delete(k)) {
      const i = this._queue.indexOf(k);
      if (i >= 0) this._queue.splice(i, 1);
    }
    return changed;
  }

  // Собрать все готовые вертикальные части в одну геометрию колонки. Индексы
  // частей независимы, mergeChunkParts сдвигает их на число прежних вершин.
  _rebuildColumn(ck) {
    const old = this.chunks.get(ck);
    const plan = this._plan.get(ck);
    const parts = [];
    if (plan) {
      const cx = unX(ck), cz = unZ(ck);
      for (const cy of plan.set) {
        const k = key(cx, cy, cz);
        if (this._parts.has(k)) parts.push(this._parts.get(k));
      }
    }
    const out = mergeChunkParts(parts);
    if (!out) {
      if (old) {
        this.group.remove(old);
        old.geometry.dispose();
        this.chunks.delete(ck);
      }
      return;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(out.position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(out.normal, 3));
    geo.setIndex(new THREE.BufferAttribute(out.index, 1));
    // Все части уже в мировых координатах, матрица меша единичная.
    geo.computeBoundingSphere();
    if (old) {
      old.geometry.dispose();
      old.geometry = geo;
    } else {
      const mesh = new THREE.Mesh(geo, this.material);
      mesh.castShadow = mesh.receiveShadow = true;
      this.chunks.set(ck, mesh);
      this.group.add(mesh);
    }
  }

  _onWorkerMessage(i, msg) {
    if (msg.kind === 'ready') return;
    this._busy[i] = null;
    this._ready.push(msg);
  }

  _pump() {
    if (this._workers.length === 0) {
      // без воркеров мешаем прямо здесь, но не больше двух чанков за кадр
      for (let n = 0; n < INSTALL_PER_FRAME && this._queue.length; n++) {
        const k = this._queue.shift();
        this._queued.delete(k);
        const job = this._job(k);
        const out = meshChunk(job, this.caves);
        this._ready.push(out ? { ...job, ...out } : { ...job, empty: true });
      }
      return;
    }
    for (let i = 0; i < this._workers.length; i++) {
      while (this._busy[i] === null && this._queue.length) {
        const k = this._queue.shift();
        this._queued.delete(k);
        this._busy[i] = k;
        this._workers[i].postMessage(this._job(k));
      }
    }
  }

  // Поставить готовый чанк в сцену. Устаревший результат (правка обогнала
  // мешинг) выбрасывается по счётчику версии.
  _install(msg) {
    const k = key(msg.cx, msg.cy, msg.cz);
    if (msg.ver !== this._ver.get(k)) {
      // Чанк мог выйти за радиус, пока воркер его считал, а затем снова войти.
      // После отброса старого результата сразу восстанавливаем нужное задание.
      if (this._lastPlanAt) this._syncColumn(colKey(msg.cx, msg.cz), this._lastPlanAt);
      return;
    }
    this._parts.set(k, msg.empty ? null : {
      position: msg.position,
      normal: msg.normal,
      index: msg.index,
    });
    this._rebuildColumn(colKey(msg.cx, msg.cz));
  }

  /**
   * Кадр потоковой загрузки: колонки вокруг игрока разбираются на чанки,
   * очередь уезжает в воркеры, готовое ставится в сцену (не больше двух за
   * кадр), ушедшее за радиус выгружается.
   *
   * Зовётся из тика мира один раз за кадр. onChanged дёргается тоже один раз,
   * а не на каждый чанк: за ним стоит перерисовка карты теней.
   */
  update(pos) {
    if (this._quiet) return;
    const streamed = this._stream(pos);

    // разобрать несколько колонок из очереди
    for (let n = 0; n < PLAN_PER_FRAME && this._colQueue.length; n++) {
      const ck = this._colQueue.shift();
      this._colQueued.delete(ck);
      const cx = unX(ck), cz = unZ(ck);
      this._columnPlan(cx, cz);
      this._syncColumn(ck, pos);
    }

    this._pump();

    let installed = 0;
    while (installed < INSTALL_PER_FRAME && this._ready.length) {
      this._install(this._ready.shift());
      installed++;
    }
    if (this._covDirty) {
      this._covDirty = false;
      this._updateCoverage();
      installed++;
    }
    if ((installed || streamed) && this.onChanged) this.onChanged();
  }

  // Синхронизировать части колонки с двумя радиусами. В полосе гистерезиса
  // готовая часть остаётся, но новая ещё не загружается.
  _syncColumn(ck, pos) {
    const plan = this._plan.get(ck);
    if (!plan) return false;
    const cx = unX(ck), cz = unZ(ck);
    const d = Math.hypot((cx + 0.5) * CHUNK - pos.x, (cz + 0.5) * CHUNK - pos.z);
    let changed = false;
    for (const cy of plan.set) {
      const k = key(cx, cy, cz);
      const wide = plan.wide.has(cy);
      if (d <= chunkLoadRadius(wide)) {
        if (!this._parts.has(k) && !this._queued.has(k) && !this._busy.includes(k)) this._enqueue(k);
      } else if (d > chunkKeepRadius(wide)) {
        if (this._retire(k)) changed = true;
      }
    }
    if (changed) this._rebuildColumn(ck);
    return changed;
  }

  // Колонки ищутся в радиусе 40 м: только так находятся устья и вырезы.
  // Полностью подземные части внутри них загружаются лишь в радиусе 24 м.
  _stream(pos) {
    if (!pos) return false;
    if (this._lastPlanAt && Math.hypot(pos.x - this._lastPlanAt.x, pos.z - this._lastPlanAt.z) < 2)
      return false;
    this._lastPlanAt = { x: pos.x, z: pos.z };
    let changed = false;

    const c0x = Math.floor(pos.x / CHUNK), c0z = Math.floor(pos.z / CHUNK);
    const rad = Math.ceil(R_LOAD / CHUNK);
    for (let cz = c0z - rad; cz <= c0z + rad; cz++) {
      for (let cx = c0x - rad; cx <= c0x + rad; cx++) {
        const d = Math.hypot((cx + 0.5) * CHUNK - pos.x, (cz + 0.5) * CHUNK - pos.z);
        if (d > R_LOAD) continue;
        const ck = colKey(cx, cz);
        if (this._plan.has(ck) || this._colQueued.has(ck)) continue;
        this._colQueued.add(ck);
        this._colQueue.push(ck);
      }
    }
    // ближние колонки разбираются первыми
    this._colQueue.sort((a, b) => {
      const da = Math.hypot((unX(a) + 0.5) * CHUNK - pos.x, (unZ(a) + 0.5) * CHUNK - pos.z);
      const db = Math.hypot((unX(b) + 0.5) * CHUNK - pos.x, (unZ(b) + 0.5) * CHUNK - pos.z);
      return da - db;
    });

    // Правки остаются в edits. Глубокие части уходят за 32 м, приповерхностные
    // за 48 м. Если широких частей в плане нет, вместе с глубокими уходит кэш.
    for (const ck of [...this._plan.keys()]) {
      const d = Math.hypot((unX(ck) + 0.5) * CHUNK - pos.x, (unZ(ck) + 0.5) * CHUNK - pos.z);
      const plan = this._plan.get(ck);
      const keep = plan.wide.size ? chunkKeepRadius(true) : chunkKeepRadius(false);
      if (d > keep) {
        if (this._unloadColumn(ck)) changed = true;
      } else if (this._syncColumn(ck, pos)) changed = true;
    }
    return changed;
  }

  _unloadColumn(ck) {
    const plan = this._plan.get(ck);
    let changed = false;
    if (plan) {
      const cx = unX(ck), cz = unZ(ck);
      for (const cy of plan.set) {
        const k = key(cx, cy, cz);
        if (this._retire(k)) changed = true;
      }
    }
    const m = this.chunks.get(ck);
    if (m) {
      this.group.remove(m);
      m.geometry.dispose();
      this.chunks.delete(ck);
      changed = true;
    }
    this._plan.delete(ck);
    this._heightCache.delete(ck);
    if (this._cutCols.delete(ck)) this._covDirty = true;
    return changed;
  }

  // перестроить чанки, затронутые правкой в диапазоне воксельных индексов:
  // теперь это только постановка в очередь, в голову — копок игрока обязан
  // появиться в кадре через два-три кадра, а не через полный обход очереди
  _remeshRange(imin, imax, jmin, jmax, kmin, kmax) {
    if (this._quiet) return; // воспроизведение журнала поставит всё разом в конце
    for (let cz = Digger._cmin(kmin); cz <= Math.floor(kmax / VN); cz++) {
      for (let cx = Digger._cmin(imin); cx <= Math.floor(imax / VN); cx++) {
        const { set, wide } = this._columnPlan(cx, cz);
        // правка могла и открыть новые чанки, и попасть в уже размеченные
        const jlo = Digger._cmin(jmin), jhi = Math.floor(jmax / VN);
        for (let cy = jlo; cy <= jhi; cy++) {
          set.add(cy);
          wide.add(cy);
        }
        for (const cy of set) this._enqueue(key(cx, cy, cz), true);
      }
    }
  }

  // перерисовываем coverage-маску по колонкам, режущим террейн
  _updateCoverage() {
    const cols = this._cutCols;
    const RES = this.covCanvas.width; // 1 тексель = 1 колонка чанков
    const ctx = this.covCtx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, RES, RES);
    ctx.fillStyle = '#fff';
    for (const c of cols) ctx.fillRect(unX(c) + RES / 2, unZ(c) + RES / 2, 1, 1);
    this.covTex.needsUpdate = true;
    this._rebuildSkirt(cols);
  }

  // Юбка: по каждому наружному ребру покрытых колонок — вертикальная лента от
  // кромки меша вниз на SKIRT. Кромка MC-меша проходит точно через baseHeight
  // в узлах решётки 0.25 м — верх юбки совпадает с ней вершина в вершину.
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

  // ---- прогрев материала под заставкой ----
  // Программа снежного среза (digger-snow) в three собирается лениво: ровно
  // тогда, когда меш с этим материалом ВПЕРВЫЕ попадает в список отрисовки.
  // Лечение: на время прогревочного кадра подкладываем этим же материалом
  // вырожденный треугольник глубоко под миром.
  primeStart() {
    const geo = new THREE.BufferGeometry();
    const y = -80; // ниже любого рельефа: даже без куллинга ничего не видно
    geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, y, 0, 0.01, y, 0, 0, y, 0.01], 3)
    );
    geo.setAttribute('normal', new THREE.Float32BufferAttribute([0, 1, 0, 0, 1, 0, 0, 1, 0], 3));
    geo.computeBoundingSphere();
    this._primeKeep = { geometry: this.skirt.geometry, visible: this.skirt.visible };
    this.skirt.geometry = geo;
    this.skirt.visible = true;
  }

  // прогрев отработал — возвращаем юбку такой, какой она была до него
  primeEnd() {
    this.skirt.geometry.dispose(); // временный треугольник, больше не нужен
    const keep = this._primeKeep;
    this._primeKeep = null;
    this.skirt.geometry = keep ? keep.geometry : new THREE.BufferGeometry();
    this.skirt.visible = keep ? keep.visible : false;
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

  // Копок лопатой из камеры: штык входит по взгляду в точку прицела.
  shovelEdit(camera, sign, reach = 3.4) {
    const hit = this._aim(camera, reach);
    if (!hit) return null;
    const c = hit.point.clone().addScaledVector(this._dir, 0.12);
    c.y += sign > 0 ? 0.1 : -0.08; // укладка растёт над точкой, копок — вглубь
    const yaw = Math.atan2(this._dir.x, this._dir.z);
    this.shovelStroke(c, yaw, sign);
    if (
      this.footprints &&
      Math.abs(hit.point.y - this.baseHeight(hit.point.x, hit.point.z)) < 1.2
    ) {
      this.footprints.eraseCircle(hit.point.x, hit.point.z, 0.55);
    }
    return hit.point;
  }

  /**
   * Правка одного копка без камеры: центр бокса штыка, азимут, знак, сила.
   * Через неё копает лопата (shovelEdit) и через неё же журнал воспроизводит
   * записанные взмахи - формула правки одна на оба пути.
   */
  shovelStroke(center, yaw, sign, strength = SHOVEL_STRENGTH) {
    this.editBox(center, yaw, SHOVEL_HALF, sign, strength, SHOVEL_FALLOFF);
    if (this.onStroke && !this._quiet) this.onStroke(center, yaw, sign, strength);
  }

  /** Начать воспроизведение журнала: правки копятся, меши ждут. */
  replayBegin() {
    this._quiet = true;
  }

  /** Журнал воспроизведён - поставить всё затронутое в очередь. */
  replayEnd() {
    this._quiet = false;
    this._remeshEdits();
  }

  /**
   * Осадка правок у поверхности (growth.js): всё, что лежит не глубже depth
   * метров под базовой поверхностью снега, умножается на k.
   */
  settle(k, depth) {
    if (!(k < 1)) return;
    const surf = new Map(); // baseHeight по колонке (ix,iz): у ямы их немного
    for (const [kk, v] of this.edits) {
      const ix = unX(kk);
      const iz = unZ(kk);
      const ck = colKey(ix, iz);
      let h = surf.get(ck);
      if (h === undefined) {
        h = this.baseHeight(ix * VS, iz * VS);
        surf.set(ck, h);
      }
      if (unY(kk) * VS < h - depth) continue;
      const nv = v * k;
      if (Math.abs(nv) < 0.01) this.edits.delete(kk);
      else this.edits.set(kk, nv);
    }
  }

  get colliders() {
    return [...this.chunks.values()];
  }

  // Восстановление правок из кэша вокселей (см. save.js). fill < 1 - множитель
  // осадки ям за время отсутствия игрока (growth.js).
  load(entries, { fill = 1 } = {}) {
    // сейвы старого формата хранили ключ строкой "ix|iy|iz" — конвертируем на
    // месте; узлы вне домена упаковки отбрасываем
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
    if (fill < 1) this.settle(fill, PIT_DEPTH);
    this._remeshEdits();
  }

  // Разметка колонок по накопленным правкам: раскладка колонки устаревает,
  // а сами чанки поставит очередь потоковой загрузки.
  _remeshEdits() {
    if (this.edits.size === 0) return;
    const span = (i) => {
      const c = Math.floor(i / VN);
      return ((i % VN) + VN) % VN === 0 ? [c - 1, c] : [c];
    };
    for (const k of this.edits.keys()) {
      const ix = unX(k), iy = unY(k), iz = unZ(k);
      for (const cx of span(ix)) {
        for (const cz of span(iz)) {
          const ck = colKey(cx, cz);
          const c = this._editCols.get(ck);
          if (!c) this._editCols.set(ck, { jmin: iy, jmax: iy });
          else { c.jmin = Math.min(c.jmin, iy); c.jmax = Math.max(c.jmax, iy); }
          this._plan.delete(ck);
          if (!this._colQueued.has(ck)) { this._colQueued.add(ck); this._colQueue.push(ck); }
        }
      }
    }
  }
}
