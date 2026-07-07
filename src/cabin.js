import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { snowTint } from './snowtint.js';

// Домик: Scandinavian Log Cabin (rivetech, CC-BY). Масштаб к реальным метрам,
// посадка в снег по рельефу, снег на крыше и кромках брёвен через snowTint.
// В домик можно войти: дверь (узел Cabin_Door_3) открывается по F, стены —
// коллизия-отрезки с проёмом, деревянный пол и ступенька на крыльцо.
// Внутри — процедурный уют: печка с углями, дрова, стол со свечой, кровать.

const LENGTH = 9.6; // длина домика по большей стороне, м (дверь ≈ 2.1 м)
const DOOR_OPEN = -2.2; // рад — распахнутая внутрь дверь
const DOOR_SPEED = 3.0; // скорость хода двери, 1/с

// План домика в координатах gltf.scene (горизонталь — x/z, они не задеты
// поворотами узлов Sketchfab; вертикаль пола НЕ берём из сырого accessor'а,
// а меряем raycast'ом по мешу Floor — иначе мебель висит). FLOOR_Y здесь —
// произвольный Y для l2w-вызовов, у которых важны только x/z (стены, углы).
const FLOOR_Y = 0.81;
const ROOM = { x0: -2.7, x1: 3.03, z0: -2.9, z1: 2.8 };
const PORCH_Z1 = 4.67;
// футпринт пола+крыльца+лестницы (локаль) — вне него не тратим raycast
const FOOT = { x0: -2.85, x1: 4.6, z0: -3.05, z1: 5.1 };

export async function createCabin(terrain, { x, z, rotY = 0 } = {}) {
  const gltf = await new GLTFLoader().loadAsync('/models/cabin/scene.gltf');
  const root = gltf.scene;

  // нормализация: большая сторона = LENGTH, центр XZ в нуле, пол на y=0
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const s = LENGTH / Math.max(size.x, size.z);
  root.scale.setScalar(s);
  root.position.set(
    -s * (box.min.x + box.max.x) / 2,
    -s * box.min.y,
    -s * (box.min.z + box.max.z) / 2
  );
  const half = new THREE.Vector2((size.x * s) / 2, (size.z * s) / 2);

  const group = new THREE.Group();
  group.add(root);

  // ---- материалы: тени, снег, прозрачные окна ----
  // Настоящее прозрачное стекло — БЕЗ дорогого transmission-прохода: обычный
  // Standard-материал с transparent+низкой opacity. Видно и внутрь дома
  // (горит очаг), и из дома наружу (ночь и снег). Тёплый emissive + bloom
  // оставляют окна «маяком» в лесу издалека, а свет самого интерьера
  // (подвесной фонарь + печь) читается сквозь стекло вблизи. depthWrite:false —
  // стекло не перекрывает интерьер по глубине; панели сортируются сзади-наперёд.
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x24313f,
    emissive: 0xffb262,
    emissiveIntensity: 0.75,
    roughness: 0.12,
    metalness: 0.0,
    transparent: true,
    opacity: 0.24,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const glassMeshes = [];
  const tinted = new Set();
  let floorMesh = null, supportMesh = null, roofMesh = null;
  root.traverse((c) => {
    if (!c.isMesh) return;
    c.castShadow = true;
    c.receiveShadow = true;
    const name = c.material?.name || '';
    if (name === 'Floor') floorMesh = c;
    else if (name === 'Wooden_Support_Struct') supportMesh = c; // рама + ступени крыльца
    else if (name === 'Roof') roofMesh = c;
    if (name === 'WindowGlass') {
      c.material = glassMat;
      glassMeshes.push(c);
      return;
    }
    if (tinted.has(c.material)) return;
    tinted.add(c.material);
    if (name === 'Roof') snowTint(c.material, '0.85, 0.89, 0.98', 1.0, 0.1, { geoNormal: true });
    else snowTint(c.material, '0.78, 0.83, 0.94', 0.5, 0.5);
  });

  // дверь — отдельный узел модели, вращается вокруг своей петли
  const doorNode = root.getObjectByName('Cabin_Door_3');

  // ---- посадка: по подножию родной лестницы крыльца ----
  // Сруб сажаем так, чтобы нижняя ступень его лестницы легла на снег —
  // она и есть вход. Пол при этом держим выше рельефа под футпринтом,
  // иначе снег прорастёт сквозь доски.
  const cos = Math.cos(rotY), sin = Math.sin(rotY);
  const lw = (lx, lz) => [x + (lx * cos + lz * sin) * s, z + (-lx * sin + lz * cos) * s];
  let ground = terrain.getHeight(x, z); // минимум под футпринтом — для света окон
  let maxUnder = -Infinity;
  for (let lx = ROOM.x0; lx <= ROOM.x1 + 0.01; lx += (ROOM.x1 - ROOM.x0) / 6) {
    for (let lz = ROOM.z0; lz <= PORCH_Z1 + 0.01; lz += (PORCH_Z1 - ROOM.z0) / 8) {
      const h = terrain.getHeight(...lw(lx, lz));
      ground = Math.min(ground, h);
      maxUnder = Math.max(maxUnder, h);
    }
  }
  const stairsGround = terrain.getHeight(...lw(4.6, 4.55)); // снег у подножия лестницы
  const groupY = Math.max(
    stairsGround - root.position.y + 0.3 * s, // нижняя ступень чуть выше снега
    maxUnder + 0.12 - root.position.y - FLOOR_Y * s // но пол — над рельефом
  );
  group.position.set(x, groupY, z);
  group.rotation.y = rotY;

  group.updateMatrixWorld(true);

  // преобразования локаль gltf.scene <-> мир
  const invRoot = root.matrixWorld.clone().invert();
  const _v = new THREE.Vector3();
  const l2w = (lx, ly, lz) => root.localToWorld(_v.set(lx, ly, lz));

  // ---- реальный пол из геометрии: raycast вниз по мешу Floor/лестницы ----
  // Никаких выдуманных плоскостей: высоту пола и ступеней берём с самих досок.
  const ray = new THREE.Raycaster();
  const _o = new THREE.Vector3();
  const _down = new THREE.Vector3(0, -1, 0);
  function castDown(wx, wz, fromY, meshes) {
    ray.set(_o.set(wx, fromY, wz), _down);
    ray.far = fromY + 40;
    const hits = ray.intersectObjects(meshes, false);
    return hits.length ? hits[0].point.y : null;
  }
  // калибровка: бьём вниз в центр bbox самого меша пола (точно над досками —
  // мой план-центр в пространстве gltf.scene смещён узлом Cabin_5 и мимо квадрата)
  floorMesh.geometry.computeBoundingBox();
  const fbb = floorMesh.geometry.boundingBox.clone().applyMatrix4(floorMesh.matrixWorld);
  const fcx = (fbb.min.x + fbb.max.x) / 2, fcz = (fbb.min.z + fbb.max.z) / 2;
  const worldFloorTop = castDown(fcx, fcz, fbb.max.y + 4, [floorMesh]) ?? fbb.max.y;
  const floorWorldY = worldFloorTop + 0.02;
  // локальный Y пола: поворот по Y не мешает y, поэтому это простая формула
  const localFloorY = (worldFloorTop - group.position.y - root.position.y) / s;

  // ---- интерьер: примитивы в локали gltf.scene, база — на реальном полу ----
  const interior = buildInterior(localFloorY);
  root.add(interior.group);
  group.updateMatrixWorld(true);

  // ---- коллизия: стены-отрезки с дверным проёмом + столбы крыльца ----
  const obstacles = [];
  const wall = (x0, z0, x1, z1, r = 0.14) => {
    const a = l2w(x0, FLOOR_Y, z0);
    const seg = { x1: a.x, z1: a.z, r };
    const b = l2w(x1, FLOOR_Y, z1);
    seg.x2 = b.x;
    seg.z2 = b.z;
    obstacles.push(seg);
    return seg;
  };
  wall(ROOM.x0, ROOM.z0 - 0.05, ROOM.x0, ROOM.z1 + 0.05); // левая
  wall(ROOM.x1, ROOM.z0 - 0.05, ROOM.x1, ROOM.z1 + 0.05); // правая
  wall(ROOM.x0, ROOM.z0, ROOM.x1, ROOM.z0); // задняя
  wall(ROOM.x0, ROOM.z1, -1.42, ROOM.z1); // фронт слева от проёма
  wall(0.02, ROOM.z1, ROOM.x1, ROOM.z1); // фронт справа от проёма
  {
    // столб навеса: только левый — правый стоит у верха лестницы, и его круг
    // с радиусом игрока перегораживал бы весь узкий лестничный коридор
    const p = l2w(-2.72, FLOOR_Y, 4.56);
    obstacles.push({ x: p.x, z: p.z, r: 0.14 });
  }
  // под настил не поднырнуть: кромки крыльца толкаются, только пока ноги
  // у земли (yMax между снегом и настилом); на настиле — свободно
  const underMax = floorWorldY - 0.3;
  for (const seg of [
    wall(ROOM.x0, ROOM.z1, ROOM.x0, PORCH_Z1, 0.12), // левый край крыльца
    wall(ROOM.x1, ROOM.z1, ROOM.x1, 3.85, 0.12), // правый край, не доходя до лестницы
    wall(ROOM.x0, PORCH_Z1, ROOM.x1, PORCH_Z1, 0.12), // фронтальная кромка
  ]) {
    seg.yMax = underMax;
  }
  // мебель: печка, стол, кровать (координаты — из buildInterior)
  for (const c of interior.colliders) {
    if (c.x2 !== undefined) {
      const seg = wall(c.x1, c.z1, c.x2, c.z2, c.r);
      seg.r = c.r;
    } else {
      const p = l2w(c.x, FLOOR_Y, c.z);
      obstacles.push({ x: p.x, z: p.z, r: c.r });
    }
  }
  // полотно двери — динамический отрезок, следует за углом открытия
  const doorSeg = { x1: 0, z1: 0, x2: 0, z2: 0, r: 0.1 };
  obstacles.push(doorSeg);

  // ---- пол/крыльцо/ступени: реальная поверхность из геометрии ----
  // В пределах футпринта пускаем луч вниз с уровня чуть выше пола (ниже
  // кровли и навеса) — попадаем в верх ближайших досок или ступени.
  const floorTargets = supportMesh ? [floorMesh, supportMesh] : [floorMesh];
  const _fv = new THREE.Vector3();
  const castY = worldFloorTop + 1.3;
  function floorHeightAt(wx, wz) {
    _fv.set(wx, 0, wz).applyMatrix4(invRoot);
    if (_fv.x < FOOT.x0 || _fv.x > FOOT.x1 || _fv.z < FOOT.z0 || _fv.z > FOOT.z1) return null;
    return castDown(wx, wz, castY, floorTargets);
  }
  function isInside(wx, wz) {
    _fv.set(wx, 0, wz).applyMatrix4(invRoot);
    return _fv.x >= ROOM.x0 && _fv.x <= ROOM.x1 && _fv.z >= ROOM.z0 && _fv.z <= ROOM.z1;
  }

  // ---- свет из окон: кластеризуем вершины стёкол на отдельные окна ----
  const lights = [];
  const centre = new THREE.Vector3();
  group.getWorldPosition(centre);
  const clusters = [];
  const v = new THREE.Vector3();
  for (const m of glassMeshes) {
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      let c = clusters.find((c) => c.p.distanceToSquared(v) < 1.3 * 1.3);
      if (!c) {
        c = { p: v.clone(), n: 1 };
        clusters.push(c);
      } else {
        c.p.lerp(v, 1 / ++c.n); // бегущее среднее
      }
    }
  }
  const out = new THREE.Vector3();
  for (const c of clusters) {
    // наружу — от вертикальной оси домика через центр окна
    out.copy(c.p).sub(centre).setY(0);
    if (out.lengthSq() < 1e-4) continue;
    out.normalize();
    const l = new THREE.PointLight(0xffa550, 4.5, 7.5, 2);
    l.position.copy(c.p).addScaledVector(out, 0.85);
    l.position.y = Math.max(c.p.y - 0.4, ground + 0.7);
    lights.push(l);
    group.attach(l);
  }

  // ---- маска снегопада: под крышей (по её реальным габаритам) снег не падает ----
  const roofC = l2w(0.17, 0, 0.75);
  let roofTopY = worldFloorTop + 3.5;
  if (roofMesh) {
    roofMesh.geometry.computeBoundingBox();
    roofTopY = roofMesh.geometry.boundingBox.clone().applyMatrix4(roofMesh.matrixWorld).max.y;
  }
  const snowMask = {
    x: roofC.x,
    z: roofC.z,
    cos, sin,
    hx: 3.65 * s,
    hz: 4.45 * s,
    topY: roofTopY,
  };

  // ---- дверь: состояние + мировые точки петли/кромки для коллизии ----
  let doorOpen = false;
  let doorT = 0; // 0 закрыта .. 1 открыта
  const hingeW = new THREE.Vector3();
  const edgeW = new THREE.Vector3();
  const doorCenter = new THREE.Vector3();
  function syncDoor() {
    doorNode.updateWorldMatrix(true, false);
    // отрезок коллизии — внешние 55% полотна: у петли его радиус
    // иначе перекрывал бы проём даже при распахнутой двери
    hingeW.set(-0.45, -0.7, 0);
    doorNode.localToWorld(hingeW);
    edgeW.set(-0.99, -0.7, 0);
    doorNode.localToWorld(edgeW);
    doorSeg.x1 = hingeW.x;
    doorSeg.z1 = hingeW.z;
    doorSeg.x2 = edgeW.x;
    doorSeg.z2 = edgeW.z;
    doorCenter.addVectors(hingeW, edgeW).multiplyScalar(0.5);
  }
  syncDoor();

  function toggleDoor() {
    doorOpen = !doorOpen;
    return doorOpen;
  }

  // тепло очага: мировая позиция печки (x/z из плана, Y — реальный пол)
  const stovePos = l2w(interior.stove.x, FLOOR_Y, interior.stove.z).clone();
  stovePos.y = worldFloorTop + 0.5;

  // мягкое «печное» дыхание света в окнах + дверь + огонь в печи и свеча
  function update(t, dt = 0) {
    const k = 0.9 + 0.06 * Math.sin(t * 1.7) + 0.04 * Math.sin(t * 3.9 + 1.2);
    glassMat.emissiveIntensity = 0.75 * k;
    for (const l of lights) l.intensity = 4.5 * k;

    // дверь плавно доходит до цели; коллизию двигаем вместе с полотном
    const target = doorOpen ? 1 : 0;
    if (Math.abs(target - doorT) > 1e-4) {
      doorT += (target - doorT) * Math.min(1, DOOR_SPEED * dt);
      if (Math.abs(target - doorT) < 1e-3) doorT = target;
      const e = doorT * doorT * (3 - 2 * doorT); // smoothstep
      doorNode.rotation.y = DOOR_OPEN * e;
      syncDoor();
    }

    interior.update(t);
  }

  return {
    group, obstacles, update, toggleDoor,
    get doorOpen() { return doorOpen; },
    doorCenter, floorHeightAt, isInside, snowMask, stovePos,
  };
}

// ---------------------------------------------------------------------------
// Интерьер: печка-буржуйка с трубой и углями, дрова, стол со свечой,
// табуретки, кровать с одеялом, коврик, полка с книгами. Всё — примитивы
// в локали gltf.scene (1 ед. ≈ 1 м). F — реальный Y пола, замеренный
// raycast'ом снаружи: база мебели ставится ровно на доски.
function buildInterior(F) {
  const g = new THREE.Group();

  // общая процедурная текстура доски (волокно + швы) — та же на всей мебели,
  // так что материалов по-прежнему два: draw call'ы не растут, а дерево уже
  // не плоская заливка, а с волокном и рельефом (виден вблизи внутри дома)
  const grain = makeWoodTexture();
  const wood = new THREE.MeshStandardMaterial({
    map: grain, bumpMap: grain, bumpScale: 0.006, color: 0xcaa06e, roughness: 0.72,
  });
  const woodDark = new THREE.MeshStandardMaterial({
    map: grain, bumpMap: grain, bumpScale: 0.006, color: 0x8a5f38, roughness: 0.82,
  });
  const iron = new THREE.MeshStandardMaterial({ color: 0x23252b, roughness: 0.55, metalness: 0.7 });

  const colliders = []; // {x,z,r} или {x1,z1,x2,z2,r} — в локали модели

  const mesh = (geo, mat, x, y, z, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    m.rotation.z = rz;
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };

  // ---- печка-буржуйка в дальнем левом углу ----
  const stove = { x: -1.95, z: -2.05 };
  mesh(new THREE.CylinderGeometry(0.34, 0.36, 0.72, 14), iron, stove.x, F + 0.48, stove.z);
  mesh(new THREE.CylinderGeometry(0.37, 0.37, 0.05, 14), iron, stove.x, F + 0.87, stove.z);
  for (const a of [0.5, 2.1, 3.7, 5.3]) {
    mesh(
      new THREE.CylinderGeometry(0.035, 0.045, 0.14, 6), iron,
      stove.x + Math.cos(a) * 0.27, F + 0.07, stove.z + Math.sin(a) * 0.27
    );
  }
  // дверца с щелью углей — светится и пульсирует
  const emberMat = new THREE.MeshStandardMaterial({
    color: 0x1a0d05,
    emissive: 0xff5f1e,
    emissiveIntensity: 1.8,
    roughness: 0.6,
  });
  mesh(new THREE.BoxGeometry(0.24, 0.28, 0.05), emberMat, stove.x, F + 0.44, stove.z + 0.34);
  // труба уходит сквозь кровлю (снаружи станет печной трубой)
  mesh(new THREE.CylinderGeometry(0.09, 0.09, 3.6, 10), iron, stove.x, F + 2.7, stove.z);
  // свет углей
  const ember = new THREE.PointLight(0xff8a40, 2.4, 6.5, 2);
  ember.position.set(stove.x, F + 0.75, stove.z + 0.45);
  g.add(ember);
  colliders.push({ x: stove.x, z: stove.z, r: 0.45 });

  // чугунный чайник на плите — маленькая тёплая деталь на верхней конфорке
  const ky = F + 0.9;
  const kettle = mesh(new THREE.SphereGeometry(0.135, 14, 10), iron, stove.x + 0.06, ky + 0.05, stove.z);
  kettle.scale.y = 0.82;
  mesh(new THREE.CylinderGeometry(0.145, 0.1, 0.025, 14), iron, stove.x + 0.06, ky, stove.z); // основание
  mesh(new THREE.CylinderGeometry(0.032, 0.05, 0.05, 8), iron, stove.x + 0.06, ky + 0.14, stove.z); // горлышко
  const spout = mesh(new THREE.CylinderGeometry(0.016, 0.032, 0.13, 6), iron, stove.x + 0.185, ky + 0.075, stove.z);
  spout.rotation.z = -0.95; // изогнутый носик
  // дужка-ручка: полукольцо, стоящее над чайником
  mesh(new THREE.TorusGeometry(0.11, 0.011, 6, 12, Math.PI), iron, stove.x + 0.06, ky + 0.1, stove.z);

  // ---- поленница у печки ----
  const logGeo = new THREE.CylinderGeometry(0.055, 0.06, 0.52, 7);
  const logMat = new THREE.MeshStandardMaterial({ color: 0x5c4126, roughness: 0.9 });
  const logs = [
    [-0.95, 0.06, -2.4], [-0.83, 0.06, -2.4], [-1.07, 0.06, -2.4],
    [-0.89, 0.165, -2.4], [-1.01, 0.165, -2.4], [-0.95, 0.27, -2.4],
  ];
  for (const [lx, ly, lz] of logs) mesh(logGeo, logMat, lx, F + ly, lz, 0, Math.PI / 2);

  // ---- стол у правого окна + свеча ----
  const table = { x: 1.75, z: 1.35 };
  mesh(new THREE.BoxGeometry(1.15, 0.07, 0.75), wood, table.x, F + 0.72, table.z);
  for (const [dx, dz] of [[-0.5, -0.3], [0.5, -0.3], [-0.5, 0.3], [0.5, 0.3]]) {
    mesh(new THREE.BoxGeometry(0.07, 0.72, 0.07), woodDark, table.x + dx, F + 0.36, table.z + dz);
  }
  colliders.push({ x: table.x, z: table.z, r: 0.6 });
  // блюдце, свеча, огонёк
  mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.02, 12), iron, table.x + 0.2, F + 0.765, table.z);
  mesh(
    new THREE.CylinderGeometry(0.033, 0.036, 0.15, 10),
    new THREE.MeshStandardMaterial({ color: 0xf3e3c3, roughness: 0.5 }),
    table.x + 0.2, F + 0.85, table.z
  );
  const flameMat = new THREE.MeshStandardMaterial({
    color: 0xffe0a0,
    emissive: 0xffc86e,
    emissiveIntensity: 3.2,
  });
  const flame = mesh(new THREE.ConeGeometry(0.02, 0.07, 8), flameMat, table.x + 0.2, F + 0.96, table.z);
  flame.castShadow = false;
  const candle = new THREE.PointLight(0xffc070, 1.15, 4, 2);
  candle.position.set(table.x + 0.2, F + 1.02, table.z);
  g.add(candle);

  // ---- табуретки ----
  for (const [sx, sz] of [[1.15, 0.7], [2.4, 0.85]]) {
    mesh(new THREE.CylinderGeometry(0.19, 0.21, 0.055, 10), wood, sx, F + 0.45, sz);
    for (const a of [0.4, 2.5, 4.6]) {
      mesh(
        new THREE.CylinderGeometry(0.024, 0.03, 0.45, 6), woodDark,
        sx + Math.cos(a) * 0.13, F + 0.22, sz + Math.sin(a) * 0.13
      );
    }
    colliders.push({ x: sx, z: sz, r: 0.24 });
  }

  // ---- кровать вдоль правой стены, ближе к дальнему углу ----
  const bed = { x: 2.12, z: -1.5 };
  mesh(new THREE.BoxGeometry(1.02, 0.26, 2.1), woodDark, bed.x, F + 0.2, bed.z);
  mesh(new THREE.BoxGeometry(1.02, 0.5, 0.07), woodDark, bed.x, F + 0.42, bed.z - 1.03); // изголовье
  mesh(
    new THREE.BoxGeometry(0.94, 0.13, 1.98),
    new THREE.MeshStandardMaterial({ color: 0xd9cfba, roughness: 0.95 }),
    bed.x, F + 0.39, bed.z
  );
  mesh(
    new THREE.BoxGeometry(0.97, 0.09, 1.25),
    new THREE.MeshStandardMaterial({ color: 0x7c3a2b, roughness: 0.95 }),
    bed.x, F + 0.46, bed.z + 0.35
  ); // одеяло
  mesh(
    new THREE.BoxGeometry(0.52, 0.11, 0.34),
    new THREE.MeshStandardMaterial({ color: 0xe9e1cf, roughness: 0.95 }),
    bed.x, F + 0.5, bed.z - 0.78
  ); // подушка
  colliders.push({ x1: bed.x, z1: bed.z - 0.85, x2: bed.x, z2: bed.z + 0.85, r: 0.5 });

  // ---- круглый плетёный коврик по центру ----
  const rug = mesh(
    new THREE.CylinderGeometry(0.85, 0.85, 0.014, 24),
    new THREE.MeshStandardMaterial({ color: 0x8a5030, roughness: 1 }),
    0.25, F + 0.007, 0
  );
  rug.castShadow = false;
  const rugIn = mesh(
    new THREE.CylinderGeometry(0.55, 0.55, 0.02, 24),
    new THREE.MeshStandardMaterial({ color: 0xa8703f, roughness: 1 }),
    0.25, F + 0.011, 0
  );
  rugIn.castShadow = false;

  // ---- полка на задней стене: книги и кружка ----
  mesh(new THREE.BoxGeometry(1.2, 0.05, 0.24), wood, 0.9, F + 1.5, -2.72);
  const bookCols = [0x6b3434, 0x35502f, 0x2f3f5c, 0x77582a, 0x4c3355];
  let bx = 0.45;
  for (let i = 0; i < 5; i++) {
    const h = 0.2 + (i % 3) * 0.03;
    const w = 0.045 + (i % 2) * 0.02;
    mesh(
      new THREE.BoxGeometry(w, h, 0.16),
      new THREE.MeshStandardMaterial({ color: bookCols[i], roughness: 0.9 }),
      bx, F + 1.525 + h / 2, -2.72, 0, i === 4 ? 0.22 : 0
    );
    bx += w + 0.012;
  }
  mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.09, 10),
    new THREE.MeshStandardMaterial({ color: 0x9c4a2f, roughness: 0.7 }),
    1.32, F + 1.57, -2.72);

  // ---- подвесной масляный фонарь по центру ----
  // Мягкий тёплый свет наполняет комнату и — главное — читается сквозь
  // прозрачные окна снаружи (это и есть «маяк» дома в ночном лесу). Мотивирует
  // заполняющий hearth-свет: у свечения есть видимый источник под потолком.
  const lampX = 0.35, lampZ = -0.2, lampY = F + 2.05, lampTop = F + 2.62;
  mesh(new THREE.CylinderGeometry(0.005, 0.005, lampTop - lampY - 0.05, 4), iron, lampX, (lampTop + lampY) / 2, lampZ); // подвес к потолку
  mesh(new THREE.ConeGeometry(0.075, 0.08, 8), iron, lampX, lampY + 0.18, lampZ); // колпак-крышка
  mesh(new THREE.CylinderGeometry(0.1, 0.115, 0.03, 8), iron, lampX, lampY + 0.12, lampZ); // верхний обод
  mesh(new THREE.CylinderGeometry(0.1, 0.09, 0.03, 8), iron, lampX, lampY - 0.12, lampZ); // дно
  const lampGlass = new THREE.MeshStandardMaterial({
    color: 0x2a1c0a, emissive: 0xffb666, emissiveIntensity: 2.4,
    transparent: true, opacity: 0.6, roughness: 0.3, depthWrite: false,
  });
  const lampBulb = mesh(new THREE.CylinderGeometry(0.075, 0.085, 0.2, 10), lampGlass, lampX, lampY, lampZ);
  lampBulb.castShadow = false;
  for (const a of [0.5, 2.6, 4.7]) { // вертикальные прутики каркаса
    mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.22, 4), iron, lampX + Math.cos(a) * 0.093, lampY, lampZ + Math.sin(a) * 0.093);
  }
  const hearth = new THREE.PointLight(0xffb060, 2.2, 8, 2);
  hearth.position.set(lampX, lampY, lampZ);
  g.add(hearth);

  // мерцание углей, свечи и тёплого фонаря
  function update(t) {
    const fk = 0.72 + 0.18 * Math.sin(t * 9.7) + 0.1 * Math.sin(t * 23.3 + 1.7);
    ember.intensity = 2.4 * fk;
    emberMat.emissiveIntensity = 1.8 * fk;
    const ck = 0.8 + 0.13 * Math.sin(t * 12.7 + 2.1) + 0.07 * Math.sin(t * 31.7);
    candle.intensity = 1.15 * ck;
    flameMat.emissiveIntensity = 3.2 * ck;
    flame.scale.y = 0.9 + 0.2 * ck;
    // фонарь дышит медленно — ровный заполняющий свет комнаты
    const lk = 0.9 + 0.06 * Math.sin(t * 3.1 + 0.5) + 0.04 * Math.sin(t * 6.7);
    hearth.intensity = 2.2 * lk;
    lampGlass.emissiveIntensity = 2.4 * lk;
  }

  return { group: g, colliders, stove, update };
}

// Процедурная текстура строганой доски: тёплая база, продольное волокно
// лёгкими безье-штрихами и тёмные швы между досками. Одна на всю мебель —
// служит и как map, и как bumpMap (рельеф волокна). Дёшево, без внешних файлов.
function makeWoodTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#b38551'; // тёплая база доски
  x.fillRect(0, 0, 256, 256);
  // продольное волокно
  for (let i = 0; i < 700; i++) {
    const y = Math.random() * 256;
    const dark = Math.random() < 0.78;
    x.strokeStyle = dark
      ? `rgba(70, 45, 22, ${0.05 + Math.random() * 0.13})`
      : `rgba(210, 176, 130, ${0.05 + Math.random() * 0.12})`;
    x.lineWidth = 0.4 + Math.random() * 1.6;
    x.beginPath();
    x.moveTo(0, y);
    x.bezierCurveTo(85, y + (Math.random() - 0.5) * 7, 170, y + (Math.random() - 0.5) * 7, 256, y + (Math.random() - 0.5) * 5);
    x.stroke();
  }
  // сучки — редкие тёмные завихрения
  for (let i = 0; i < 5; i++) {
    const kx = Math.random() * 256, ky = Math.random() * 256;
    for (let r = 1; r < 6; r++) {
      x.strokeStyle = `rgba(50, 30, 14, ${0.28 - r * 0.04})`;
      x.beginPath();
      x.ellipse(kx, ky, r * 1.8, r, Math.random(), 0, Math.PI * 2);
      x.stroke();
    }
  }
  // швы между досками
  x.strokeStyle = 'rgba(24, 13, 5, 0.6)';
  x.lineWidth = 2;
  for (let py = 40; py < 256; py += 42) {
    x.beginPath();
    x.moveTo(0, py + (Math.random() - 0.5) * 3);
    x.lineTo(256, py + (Math.random() - 0.5) * 3);
    x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
