import * as THREE from 'three';
import { material } from 'world-core/materials';
import { matsets, prepareMatsets } from './matsets.js';
import { snowTint } from './snowtint.js';
import { createSpread } from './spread.js';
import { createPlantScatter, cullThinCaveRoofs } from './planting.js';
import { KINDS, VARIANTS, buildPine, kindOf, pineFoliageTexture, pineGeometry } from './pine.js';
import { ROCK_VARIANTS, buildRock, rockGeometry } from './rock.js';

// Лес кодом: сосны считает `pine.js` (ствол, мутовки, хвоя кистями), валуны -
// `rock.js` (икосфера с шумом). Ни пака моделей, ни текстур с диска: 1.41 МБ
// геометрии и шесть картинок ушли из входа целиком, а форма теперь правится
// вместе с генератором, а не следующей закупкой ассетов.
//
// Инстансинг остался прежним: пара (вариант, кольцо LOD) -> InstancedMesh.
// Кольцо выбирается по удалению точки от центра мира - игрок заперт в
// |x|,|z| <= 72 и почти всё время у костра, так что статический LOD не
// «щёлкает» на ходу.
// Снег на хвое/коре/камнях - snowTint, тени хвои - alpha-test depth-материал.

const LOD_RINGS = [40, 85]; // ближе 40 м — LOD0, до 85 — LOD1, дальше — LOD2

export { KINDS };

// Семя вариантов: сдвиг в этом числе - это ПЕРЕСЕВ ФОРМЫ всех сосен мира.
// Рост и места не трогает (их считает planting.js), но менять без нужды не
// стоит: игрок узнаёт свою поляну в лицо.
const PINE_SHAPE_SEED = 20260904;

/** Три LOD одного варианта плюс радиус кроны, посчитанные от семени. */
function makeVariant(THREE_, name, i) {
  const seed = PINE_SHAPE_SEED + i * 977;
  const lods = [0, 1, 2].map((lod) => {
    const p = buildPine(seed, lod, name);
    return {
      bark: pineGeometry(THREE_, p.bark),
      clusters: pineGeometry(THREE_, p.needles),
      built: p,
    };
  });
  return { name, kind: kindOf(name), lods, crown: lods[0].built.crown };
}

export async function createTrees(terrain, count = 170, rockCount = 45, avoid = [], caves = null) {
  // Лес собирается за уже открытым меню, и одним куском его собирать нельзя:
  // пятнадцать вариантов по три кольца и две сотни инстансов держали поток
  // сотнями миллисекунд. Стыки ниже (`await breathe()`) - места, где сборку
  // можно отпустить, не разорвав ни одного этапа.
  const breathe = createSpread();
  const group = new THREE.Group();
  const obstacles = [];
  const pines = []; // рубимые сосны — записи для lumber.js
  const layout = createPlantScatter({ avoid });

  // кора и щебень печёт ядро в воркерах; кора к этому времени обычно уже готова
  const setsReady = prepareMatsets('bark', 'rubble');

  const variants = [];
  for (let i = 0; i < VARIANTS.length; i++) {
    await breathe();
    variants.push(makeVariant(THREE, VARIANTS[i], i));
  }
  await breathe();
  const rocks = [];
  for (let i = 0; i < ROCK_VARIANTS; i++) {
    rocks.push(rockGeometry(THREE, buildRock(PINE_SHAPE_SEED + 31 * (i + 1))));
  }

  // ---- материалы ----
  await setsReady;
  await breathe();
  const sets = matsets('bark', 'rubble');
  const barkMat = snowTint(
    material(sets.bark, { normalScale: 1.4, color: 0x8a7a63 }),
    '0.62, 0.68, 0.84',
    0.45,
    0.45
  );

  // Хвоя: одна канва 256x256 на весь лес (кисть иголок слева, силуэт для
  // LOD2-креста справа). Прозрачность через alphaTest, а не BLEND: с
  // инстансингом и сотней крон сортировка прозрачности безнадёжна, а маска
  // даёт чёткий контур и честный depth.
  const foliage = pineFoliageTexture(THREE);
  const clustersMat = snowTint(
    new THREE.MeshStandardMaterial({
      map: foliage,
      color: 0xbfd0b4,
      roughness: 0.9,
      metalness: 0,
      alphaTest: 0.45,
      side: THREE.DoubleSide,
    }),
    '0.72, 0.78, 0.92',
    0.8,
    0.08
  );

  // тени хвои: depth-материал с той же маской, иначе тень — сплошная карточка
  const clustersDepth = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    map: foliage,
    alphaTest: 0.45,
  });

  // камни почти целиком под снегом: шапка сверху, иней на боках — отрицательный
  // порог тянет налёт за горизонталь, голым остаётся только низ.
  const rockMat = snowTint(
    material(sets.rubble, { normalScale: 1.2, color: 0x6d7488, repeat: [1.6, 1.6] }),
    '0.58, 0.63, 0.76',
    0.95,
    -0.9
  );

  // ---- раскладка позиций ----
  await breathe();

  // Опора по МИНИМУМУ рельефа под пятном основания: на склоне высота в центре
  // выше, чем у нижней кромки, и посаженный по центру объект «висит» краем
  // в воздухе. Сажаем по нижней точке — низ всегда в снегу.
  const groundY = (x, z, rad) => {
    let m = terrain.getHeight(x, z);
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      m = Math.min(m, terrain.getHeight(x + Math.cos(a) * rad, z + Math.sin(a) * rad));
    }
    return m;
  };

  const dummy = new THREE.Object3D();
  // Геометрия сосны уже нормирована самим генератором (основание в нуле, рост
  // ровно 1), поэтому матрица нормализации - единичная. Поле оставлено: на нём
  // держится контракт записи с `lumber.js`.
  const PRE = new THREE.Matrix4();
  const inst = new THREE.Matrix4();

  // ---- сосны: группируем места по (вариант, LOD-кольцо) ----
  const buckets = new Map(); // `${vi}:${ring}` -> [{x,z}]
  const spots = layout.treeSpots(count);
  spots.forEach(([x, z], i) => {
    const vi = i % variants.length;
    const r = Math.hypot(x, z);
    const ring = r < LOD_RINGS[0] ? 0 : r < LOD_RINGS[1] ? 1 : 2;
    const key = `${vi}:${ring}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push([x, z]);
  });

  await breathe();

  for (const [key, list] of buckets) {
    // Стык на каждое ведро: одно ведро — это один вариант сосны в одном
    // LOD-кольце, десяток-другой инстансов, доли миллисекунды.
    await breathe();
    const [vi, ring] = key.split(':').map(Number);
    const v = variants[vi];
    const lod = v.lods[Math.min(ring, v.lods.length - 1)];
    const parts = [
      lod.bark && { geo: lod.bark, mat: barkMat, depth: null },
      lod.clusters && { geo: lod.clusters, mat: clustersMat, depth: clustersDepth },
    ].filter(Boolean);

    const meshes = parts.map((p) => {
      const m = new THREE.InstancedMesh(p.geo, p.mat, list.length);
      if (p.depth) m.customDepthMaterial = p.depth;
      // дальнее LOD-кольцо тень не отбрасывает: оно почти всегда вне окна карты
      // теней (±38 м от игрока), а хвоя с alphaTest — самая дорогая в depth-проходе
      m.castShadow = ring < 2;
      m.receiveShadow = true;
      return m;
    });

    list.forEach(([x, z], i) => {
      const [hMin, hMax] = v.kind.h;
      const pose = layout.treePose(hMin, hMax);
      const s = pose.height;
      const j = pose.width; // ширина кроны ±10%
      dummy.position.set(x, groundY(x, z, 0.9) - 0.06 * Math.min(s, 4), z);
      dummy.rotation.set(0, pose.yaw, 0);
      dummy.scale.set(s * j, s, s * j);
      dummy.updateMatrix();
      inst.multiplyMatrices(dummy.matrix, PRE);
      meshes.forEach((m) => m.setMatrixAt(i, inst));
      // столб коллайдера — только у взрослых сосен; сквозь подлесок ходим
      let ob = null;
      if (v.kind.trunk > 0) {
        ob = { x, z, r: Math.max(0.4, s * v.kind.trunk) };
        obstacles.push(ob);
      }
      // запись для рубки: меши инстансов + базовая матрица, чтобы lumber.js
      // мог крутить дерево (дрожь от удара, валка) поверх базовой позы.
      // Саженец (ob=null) тоже рубится — с одного удара, на одно полено.
      pines.push({
        id: pines.length,
        x,
        z,
        y: dummy.position.y,
        h: s,
        r: ob ? ob.r : 0.12,
        crown: v.crown * s * j, // радиус кроны в метрах - для cull
        ob,
        sapling: !ob,
        parts: meshes.map((m) => ({ mesh: m, i })),
        base: dummy.matrix.clone(),
        pre: PRE,
      });
    });
    meshes.forEach((m) => {
      m.instanceMatrix.needsUpdate = true;
      group.add(m);
    });
  }

  // ---- камни ----
  const boulders = []; // записи для cull, как pines у сосен
  const rockSpots = layout.rockSpots(rockCount);
  const perRock = rocks.map(() => []);
  rockSpots.forEach((sp, i) => perRock[i % rocks.length].push(sp));
  for (let ri = 0; ri < rocks.length; ri++) {
    await breathe();
    const list = perRock[ri];
    if (!list.length) continue;
    const mesh = new THREE.InstancedMesh(rocks[ri], rockMat, list.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const meshes = [mesh];
    list.forEach(([x, z], i) => {
      const pose = layout.rockPose();
      const s = pose.size;
      // сажаем по нижней точке рельефа под камнем и топим на четверть роста:
      // валун сидит в сугробе, а не лежит НА снегу (и тем более не висит)
      dummy.position.set(x, groundY(x, z, 0.45 * s) - 0.26 * s, z);
      dummy.rotation.set(0, pose.yaw, 0);
      dummy.scale.set(s * pose.scaleX, s, s * pose.scaleZ);
      dummy.updateMatrix();
      meshes.forEach((m) => m.setMatrixAt(i, dummy.matrix));
      let ob = null;
      if (s > 0.8) {
        ob = { x, z, r: s * 0.5 };
        obstacles.push(ob);
      }
      boulders.push({
        x, z,
        crown: s * 0.5, // валун нормирован в единичный куб: радиус = половина роста
        ob,
        parts: meshes.map((m) => ({ mesh: m, i })),
      });
    });
    meshes.forEach((m) => {
      m.instanceMatrix.needsUpdate = true;
      group.add(m);
    });
  }

  // ---- отбраковка того, что налезло на постройку ----
  // Зачем отдельным проходом, а не фильтром в scatter: раскладка леса - часть
  // геймплея, «мир копится». Сваленное дерево ищется в сейве по НОМЕРУ сосны,
  // а номер - это её место в общей очереди. Любой отказ внутри scatter сдвигает
  // очередь (цикл добирает кандидатов, пока не наберёт count) и заодно уводит
  // курсор ГПСЧ - после такой правки весь лес переезжает, а старый сейв
  // показывает пни не там. Поэтому позиции не трогаем вовсе: раскладка
  // считается ровно как раньше, а лишнее просто убирается из мира уже после -
  // нулевым масштабом инстанса и снятием коллайдера. Номера остаются на местах.
  //
  // zones - повёрнутые прямоугольники габаритов построек:
  //   { x, z, rotY, hx, hz, margin } (см. cabin.footprint).
  const _zero = new THREE.Vector3(0, 0, 0);
  const _hide = new THREE.Matrix4();
  // зазор от точки до прямоугольника, м (отрицательный - точка внутри)
  const gapToZone = (x, z, zn) => {
    const c = Math.cos(zn.rotY || 0);
    const sn = Math.sin(zn.rotY || 0);
    const dx = x - zn.x;
    const dz = z - zn.z;
    const rx = c * dx - sn * dz; // мир -> оси постройки
    const rz = sn * dx + c * dz;
    const ax = Math.abs(rx) - zn.hx;
    const az = Math.abs(rz) - zn.hz;
    if (ax <= 0 && az <= 0) return Math.max(ax, az);
    return Math.hypot(Math.max(ax, 0), Math.max(az, 0));
  };
  const hide = (item) => {
    _hide.makeTranslation(item.x, 0, item.z).scale(_zero);
    for (const part of item.parts) {
      part.mesh.setMatrixAt(part.i, _hide);
      part.mesh.instanceMatrix.needsUpdate = true;
    }
    if (item.ob) {
      const idx = obstacles.indexOf(item.ob);
      if (idx >= 0) obstacles.splice(idx, 1);
      item.ob = null;
    }
    item.culled = true;
  };
  const cull = (zones) => {
    let n = 0;
    for (const zn of zones) {
      const keep = zn.margin || 0; // запас, чтобы ветки не скребли по кровле
      for (const item of [...pines, ...boulders]) {
        if (item.culled) continue;
        if (gapToZone(item.x, item.z, zn) < item.crown + keep) {
          hide(item);
          n++;
        }
      }
    }
    return n;
  };

  // Сначала раскладка и все позы потребляют прежний поток ГПСЧ, затем лишние
  // объекты скрываются без добора. Так старые номера сосен не переезжают.
  cullThinCaveRoofs(
    [...pines, ...boulders],
    caves,
    (x, z) => terrain.getHeight(x, z),
    hide
  );

  return { group, obstacles, pines, cull };
}
