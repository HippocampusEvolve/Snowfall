import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

// Лес из моделей Quaternius (CC0): 5 вариантов елей + 5 камней,
// инстансинг, снег на верхних гранях через шейдер, круги коллизий.

const PINES = ['PineTree_1', 'PineTree_2', 'PineTree_3', 'PineTree_4', 'PineTree_5'];
const ROCKS = ['Rock_1', 'Rock_2', 'Rock_3', 'Rock_4', 'Rock_5'];

function snowTint(mat, tint, amount, threshold = 0.45) {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_begin>',
      `#include <normal_fragment_begin>
      {
        vec3 wN = inverseTransformDirection(normal, viewMatrix);
        float snowAmt = smoothstep(${threshold.toFixed(2)}, 0.9, wN.y);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${tint}), snowAmt * ${amount.toFixed(2)});
      }`
    );
  };
  mat.customProgramCacheKey = () => `snowtint-${tint}-${amount}`;
  return mat;
}

// Собираем геометрии модели в root-пространстве + матрица нормализации
// (низ на y=0, центр в нуле, высота = 1).
function prepareVariant(fbx) {
  fbx.updateMatrixWorld(true);
  const parts = [];
  fbx.traverse((child) => {
    if (!child.isMesh) return;
    const geo = child.geometry.clone().applyMatrix4(child.matrixWorld);
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    parts.push({ geo, matNames: mats.map((m) => m?.name || '') });
  });
  const box = new THREE.Box3();
  for (const p of parts) {
    p.geo.computeBoundingBox();
    box.union(p.geo.boundingBox);
  }

  // Ось «вверх» определяем по стволу (группа Bark/Trunk): ствол всегда
  // вытянут вдоль вертикали, в отличие от кроны, которая бывает шире высоты.
  const probe = boxOfGroup(parts, /bark|trunk/i) || box;
  const ext = new THREE.Vector3();
  probe.getSize(ext);
  const upAxis = ext.z >= ext.x && ext.z >= ext.y ? 'z' : ext.x > ext.y ? 'x' : 'y';

  const R =
    upAxis === 'z'
      ? new THREE.Matrix4().makeRotationX(-Math.PI / 2)
      : upAxis === 'x'
        ? new THREE.Matrix4().makeRotationZ(Math.PI / 2)
        : new THREE.Matrix4();
  const rb = box.clone().applyMatrix4(R);
  const height = Math.max(rb.max.y - rb.min.y, 1e-3);
  const pre = new THREE.Matrix4()
    .makeScale(1 / height, 1 / height, 1 / height)
    .multiply(
      new THREE.Matrix4().makeTranslation(
        -(rb.min.x + rb.max.x) / 2,
        -rb.min.y,
        -(rb.min.z + rb.max.z) / 2
      )
    )
    .multiply(R);
  return { parts, pre };
}

// bbox вершин, принадлежащих группам с материалом, чьё имя матчит re
function boxOfGroup(parts, re) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  let found = false;
  for (const p of parts) {
    const groups = p.geo.groups?.length
      ? p.geo.groups
      : [{ start: 0, count: Infinity, materialIndex: 0 }];
    const idx = p.geo.index;
    const pos = p.geo.attributes.position;
    for (const g of groups) {
      if (!re.test(p.matNames[g.materialIndex] || '')) continue;
      const end = Math.min(g.start + g.count, idx ? idx.count : pos.count);
      for (let i = g.start; i < end; i++) {
        v.fromBufferAttribute(pos, idx ? idx.getX(i) : i);
        box.expandByPoint(v);
        found = true;
      }
    }
  }
  return found ? box : null;
}

const isFoliage = (name) => /leaf|leaves|needle|pine(?!.*bark)|green/i.test(name);

export async function createTrees(terrain, count = 170, rockCount = 45) {
  const group = new THREE.Group();
  const obstacles = [];
  const loader = new FBXLoader();

  const [pines, rocks] = await Promise.all([
    Promise.all(PINES.map((n) => loader.loadAsync(`/models/nature/${n}.fbx`).then(prepareVariant))),
    Promise.all(ROCKS.map((n) => loader.loadAsync(`/models/nature/${n}.fbx`).then(prepareVariant))),
  ]);

  const foliageMat = snowTint(
    new THREE.MeshStandardMaterial({ color: 0x1a3226, roughness: 0.95 }),
    '0.45, 0.51, 0.63',
    0.6
  );
  const barkMat = new THREE.MeshStandardMaterial({ color: 0x332414, roughness: 1.0 });
  const rockMat = snowTint(
    new THREE.MeshStandardMaterial({ color: 0x272e3c, roughness: 0.95 }),
    '0.55, 0.6, 0.72',
    0.8,
    0.3
  );

  // раскладываем позиции по вариантам
  const placed = [];
  const scatter = (n, rMin, rMax, minGap2) => {
    const out = [];
    let guard = 0;
    while (out.length < n && guard++ < n * 40) {
      const a = Math.random() * Math.PI * 2;
      const r = rMin + Math.pow(Math.random(), 0.7) * (rMax - rMin);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (placed.some((p) => (p[0] - x) ** 2 + (p[1] - z) ** 2 < minGap2)) continue;
      placed.push([x, z]);
      out.push([x, z]);
    }
    return out;
  };

  const dummy = new THREE.Object3D();
  const inst = new THREE.Matrix4();

  const buildInstances = (variants, spots, opts) => {
    // распределяем места по вариантам
    const perVariant = variants.map(() => []);
    spots.forEach((s, i) => perVariant[i % variants.length].push(s));

    variants.forEach((v, vi) => {
      const list = perVariant[vi];
      if (!list.length) return;
      // если имена материалов не различают хвою и ствол — хвоей считаем
      // самую «тяжёлую» часть (больше всего вершин)
      const anyFoliage = v.parts.some((p) => p.matNames.some(isFoliage));
      const heaviest = v.parts.reduce(
        (a, b) => (b.geo.attributes.position.count > a.geo.attributes.position.count ? b : a),
        v.parts[0]
      );
      const meshes = v.parts.map((p) => {
        const mats = p.matNames.map((n) =>
          opts.rock
            ? rockMat
            : (anyFoliage ? isFoliage(n) : p === heaviest)
              ? foliageMat
              : barkMat
        );
        const m = new THREE.InstancedMesh(p.geo, mats.length === 1 ? mats[0] : mats, list.length);
        m.castShadow = true;
        m.receiveShadow = true;
        return m;
      });
      list.forEach(([x, z], i) => {
        const h = opts.height();
        const s = h; // pre-матрица нормализует высоту к 1
        dummy.position.set(x, terrain.getHeight(x, z) + opts.sink * s, z);
        dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
        dummy.scale.set(s * (0.9 + Math.random() * 0.2), s, s * (0.9 + Math.random() * 0.2));
        dummy.updateMatrix();
        inst.multiplyMatrices(dummy.matrix, v.pre);
        meshes.forEach((m) => m.setMatrixAt(i, inst));
        if (opts.obstacleR) obstacles.push({ x, z, r: opts.obstacleR(s) });
      });
      meshes.forEach((m) => {
        m.instanceMatrix.needsUpdate = true;
        group.add(m);
      });
    });
  };

  buildInstances(pines, scatter(count, 13, 140, 16), {
    height: () => 7 + Math.random() * 5.5,
    sink: -0.02,
    obstacleR: (s) => Math.max(0.45, s * 0.055),
    rock: false,
  });
  buildInstances(rocks, scatter(rockCount, 10, 130, 6), {
    height: () => 0.5 + Math.random() * 1.5,
    sink: -0.12,
    obstacleR: (s) => (s > 0.8 ? s * 0.5 : 0),
    rock: true,
  });

  // нулевые радиусы не мешают
  return { group, obstacles: obstacles.filter((o) => o.r > 0) };
}
