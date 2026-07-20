import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { createGLTFLoader } from './gltfload.js';
import { asset } from './asset.js';
import { snowTint } from './snowtint.js';

// Лес: реалистичные сосны LOLIPOP (CC-BY, 15 вариантов × LOD0-2) + камни
// Quaternius (CC0). Инстансинг по паре (вариант × LOD-кольцо): кольцо выбирается
// по удалению точки от центра мира — игрок заперт в |x|,|z| ≤ 72 и почти всё
// время у костра, так что статический LOD не «щёлкает» на ходу.
// Снег на хвое/коре/камнях — snowTint, тени хвои — alpha-test depth-материал.

const LOD_RINGS = [40, 85]; // ближе 40 м — LOD0, до 85 — LOD1, дальше — LOD2

// Лес детерминирован (mulberry32 от константы): одна и та же раскладка каждую
// ночь. Иначе «мир копится» ломается — сваленное дерево не найти после
// перезагрузки, если сосны пересеялись по новым местам.
const FOREST_SEED = 20260706; // день, когда началась эта ночь
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// рост и радиус ствола (доля от роста) по типу сосны
const KINDS = [
  { re: /^Pine_big_/, h: [10.5, 13.5], trunk: 0.045 },
  { re: /^Pine_large_/, h: [12, 15.5], trunk: 0.05 },
  { re: /^Pine_medium_/, h: [7.5, 10.5], trunk: 0.042 },
  { re: /^Pine_small_/, h: [5, 7.5], trunk: 0.04 },
  { re: /^Pine_sapling_/, h: [1.7, 3.2], trunk: 0 }, // подлесок, сквозь него можно пройти
];

const ROCKS = ['Rock_1', 'Rock_2', 'Rock_3', 'Rock_4', 'Rock_5'];

// Билборды (LOD3) и служебные узлы вычищены из самого ассета при оптимизации
// (см. CREDITS.md), но фильтр оставлен как страховка на случай замены пака.
async function loadPinesScene() {
  const json = await (await fetch(asset('models/pines/scene.gltf'))).json();
  const drop = new Set();
  json.nodes.forEach((n, i) => {
    if (/Billboard|^Back$|^Ref_plane$/i.test(n.name || '')) drop.add(i);
  });
  for (const n of json.nodes) {
    if (n.children) n.children = n.children.filter((c) => !drop.has(c));
  }
  for (const s of json.scenes) s.nodes = s.nodes.filter((c) => !drop.has(c));
  const gltf = await createGLTFLoader().parseAsync(JSON.stringify(json), asset('models/pines/'));
  return gltf.scene;
}

// Разбираем сцену пака на варианты: имя → геометрии LOD0-2 (кора + хвоя)
// в мировом пространстве пака + матрица нормализации (низ y=0, центр XZ в
// нуле, высота = 1). Матрица одна на вариант (по LOD0) — LOD-ы совмещены.
function collectPineVariants(root) {
  root.updateMatrixWorld(true);
  const byName = new Map();
  root.traverse((node) => {
    const m = node.name.match(/^(Pine_[a-z]+_\d+)_LOD(\d+)$/);
    if (!m) return;
    const [, vname, lodS] = m;
    let v = byName.get(vname);
    if (!v) {
      v = { name: vname, lods: [], kind: KINDS.find((k) => k.re.test(vname)) };
      byName.set(vname, v);
    }
    const lod = { bark: null, clusters: null };
    node.traverse((child) => {
      if (!child.isMesh) return;
      const geo = child.geometry.clone().applyMatrix4(child.matrixWorld);
      if (/bark/i.test(child.material.name)) lod.bark = geo;
      else lod.clusters = geo;
    });
    v.lods[+lodS] = lod;
  });

  const variants = [...byName.values()].filter((v) => v.lods[0] && v.kind);
  for (const v of variants) {
    const box = new THREE.Box3();
    for (const geo of [v.lods[0].bark, v.lods[0].clusters]) {
      if (!geo) continue;
      geo.computeBoundingBox();
      box.union(geo.boundingBox);
    }
    const height = Math.max(box.max.y - box.min.y, 1e-3);
    v.pre = new THREE.Matrix4()
      .makeScale(1 / height, 1 / height, 1 / height)
      .multiply(
        new THREE.Matrix4().makeTranslation(
          -(box.min.x + box.max.x) / 2,
          -box.min.y,
          -(box.min.z + box.max.z) / 2
        )
      );
  }
  return variants;
}

// Собираем геометрии FBX-модели в root-пространстве + матрица нормализации
// (низ на y=0, центр в нуле, максимальный размер = 1) — для камней.
function prepareRock(fbx) {
  fbx.updateMatrixWorld(true);
  const geos = [];
  fbx.traverse((child) => {
    if (!child.isMesh) return;
    geos.push(child.geometry.clone().applyMatrix4(child.matrixWorld));
  });
  const box = new THREE.Box3();
  for (const g of geos) {
    g.computeBoundingBox();
    box.union(g.boundingBox);
  }
  const size = new THREE.Vector3();
  box.getSize(size);
  const s = 1 / Math.max(size.x, size.y, size.z, 1e-3);
  const pre = new THREE.Matrix4()
    .makeScale(s, s, s)
    .multiply(
      new THREE.Matrix4().makeTranslation(
        -(box.min.x + box.max.x) / 2,
        -box.min.y,
        -(box.min.z + box.max.z) / 2
      )
    );
  return { geos, pre };
}

export async function createTrees(terrain, count = 170, rockCount = 45, avoid = []) {
  const group = new THREE.Group();
  const obstacles = [];
  const pines = []; // рубимые сосны — записи для lumber.js
  const rand = mulberry32(FOREST_SEED);

  const [pineScene, rockFbx] = await Promise.all([
    loadPinesScene(),
    Promise.all(ROCKS.map((n) => new FBXLoader().loadAsync(asset(`models/nature/${n}.fbx`)))),
  ]);

  const variants = collectPineVariants(pineScene);
  const rocks = rockFbx.map(prepareRock);

  // ---- материалы ----
  // Кора и хвоя — PBR-материалы из пака (общие на все варианты). Хвою переводим
  // из BLEND в alpha-test: с инстансингом и сотней крон сортировка прозрачности
  // безнадёжна, а маска даёт чёткий контур и честный depth.
  let barkMat = null;
  let clustersMat = null;
  pineScene.traverse((c) => {
    if (!c.isMesh) return;
    if (/bark/i.test(c.material.name)) barkMat ??= c.material;
    else if (/clusters/i.test(c.material.name)) clustersMat ??= c.material;
  });

  clustersMat.transparent = false;
  clustersMat.alphaTest = 0.45;
  clustersMat.depthWrite = true;
  snowTint(clustersMat, '0.72, 0.78, 0.92', 0.8, 0.08);
  snowTint(barkMat, '0.62, 0.68, 0.84', 0.45, 0.45);

  // тени хвои: depth-материал с той же маской, иначе тень — сплошная карточка
  const clustersDepth = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    map: clustersMat.map,
    alphaTest: 0.45,
  });

  // камни почти целиком под снегом: шапка сверху, иней на боках — отрицательный
  // порог тянет налёт за горизонталь, голым остаётся только низ. Лоу-поли стиль
  // Quaternius под таким слоем не читается.
  const rockMat = snowTint(
    new THREE.MeshStandardMaterial({ color: 0x2c3342, roughness: 0.95 }),
    '0.58, 0.63, 0.76',
    0.95,
    -0.9
  );

  // ---- раскладка позиций ----
  const placed = [];
  const scatter = (n, rMin, rMax, minGap2) => {
    const out = [];
    let guard = 0;
    while (out.length < n && guard++ < n * 40) {
      const a = rand() * Math.PI * 2;
      const r = rMin + Math.pow(rand(), 0.7) * (rMax - rMin);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (avoid.some((av) => (av.x - x) ** 2 + (av.z - z) ** 2 < av.r * av.r)) continue;
      if (placed.some((p) => (p[0] - x) ** 2 + (p[1] - z) ** 2 < minGap2)) continue;
      placed.push([x, z]);
      out.push([x, z]);
    }
    return out;
  };

  const dummy = new THREE.Object3D();
  const inst = new THREE.Matrix4();

  // ---- сосны: группируем места по (вариант, LOD-кольцо) ----
  const buckets = new Map(); // `${vi}:${ring}` -> [{x,z}]
  const spots = scatter(count, 13, 140, 16);
  spots.forEach(([x, z], i) => {
    const vi = i % variants.length;
    const r = Math.hypot(x, z);
    const ring = r < LOD_RINGS[0] ? 0 : r < LOD_RINGS[1] ? 1 : 2;
    const key = `${vi}:${ring}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push([x, z]);
  });

  for (const [key, list] of buckets) {
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
      const s = hMin + rand() * (hMax - hMin);
      const j = 0.9 + rand() * 0.2; // ширина кроны ±10%
      dummy.position.set(x, terrain.getHeight(x, z) - 0.06 * Math.min(s, 4), z);
      dummy.rotation.set(0, rand() * Math.PI * 2, 0);
      dummy.scale.set(s * j, s, s * j);
      dummy.updateMatrix();
      inst.multiplyMatrices(dummy.matrix, v.pre);
      meshes.forEach((m) => m.setMatrixAt(i, inst));
      if (v.kind.trunk > 0) {
        const ob = { x, z, r: Math.max(0.4, s * v.kind.trunk) };
        obstacles.push(ob);
        // запись для рубки: меши инстансов + базовая матрица, чтобы lumber.js
        // мог крутить дерево (дрожь от удара, валка) поверх базовой позы
        pines.push({
          id: pines.length,
          x,
          z,
          y: dummy.position.y,
          h: s,
          r: ob.r,
          ob,
          parts: meshes.map((m) => ({ mesh: m, i })),
          base: dummy.matrix.clone(),
          pre: v.pre,
        });
      }
    });
    meshes.forEach((m) => {
      m.instanceMatrix.needsUpdate = true;
      group.add(m);
    });
  }

  // ---- камни ----
  const rockSpots = scatter(rockCount, 10, 130, 6);
  const perRock = rocks.map(() => []);
  rockSpots.forEach((sp, i) => perRock[i % rocks.length].push(sp));
  rocks.forEach((rock, ri) => {
    const list = perRock[ri];
    if (!list.length) return;
    const meshes = rock.geos.map((geo) => {
      const m = new THREE.InstancedMesh(geo, rockMat, list.length);
      m.castShadow = true;
      m.receiveShadow = true;
      return m;
    });
    list.forEach(([x, z], i) => {
      const s = 0.5 + rand() * 1.5;
      dummy.position.set(x, terrain.getHeight(x, z) - 0.12 * s, z);
      dummy.rotation.set(0, rand() * Math.PI * 2, 0);
      dummy.scale.set(s * (0.9 + rand() * 0.2), s, s * (0.9 + rand() * 0.2));
      dummy.updateMatrix();
      inst.multiplyMatrices(dummy.matrix, rock.pre);
      meshes.forEach((m) => m.setMatrixAt(i, inst));
      if (s > 0.8) obstacles.push({ x, z, r: s * 0.5 });
    });
    meshes.forEach((m) => {
      m.instanceMatrix.needsUpdate = true;
      group.add(m);
    });
  });

  return { group, obstacles, pines };
}
