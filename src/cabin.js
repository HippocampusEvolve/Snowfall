import * as THREE from 'three';
import { createGLTFLoader } from './gltfload.js';
import { asset } from './asset.js';
import { snowTint } from './snowtint.js';
import { snowCap } from './snowcap.js';
import { buildFirebox } from './firebox.js';
import { material } from 'world-core/materials';
import { bed, table, stool, rug, shelfWithBooks, logStack } from 'world-core/props';
import { matset, prepareMatsets } from './matsets.js';
import { createSpread } from './spread.js';
import { buildCabin } from './cabin-geometry.js';

// Изба собирается из метрических буферов: сруб, крыша, дверь, окна и крыльцо.
// В домик можно войти: дверь открывается по F, стены имеют свободный проём,
// деревянный пол и ступенька на крыльцо отдают свои реальные высоты.
// Внутри - процедурный уют: камин, дрова, стол со свечой, кровать, коврик,
// полка с книгами. Мебель - предметы каталога ядра (world-core/props):
// геометрия из примитивов, поверхность из наборов ядра, здесь только
// расстановка и коллайдеры.

const DOOR_OPEN = 2.2; // рад - дверь распахивается наружу, на крыльцо
const DOOR_SPEED = 3.0; // скорость хода двери, 1/с
const FLOOR_Y = 0.81;
const INTERIOR_SCALE = 1.0545349463020333;
const INTERIOR_X = -0.20205235481262207 * INTERIOR_SCALE;
const INTERIOR_Z = -0.8637917041778564 * INTERIOR_SCALE;
const CABIN_SETS = [
  'log', 'bark', 'logend', 'split', 'brick', 'hearth', 'beam', 'ashlar',
  'floor', 'cloth', 'wool', 'braid', 'leather', 'paper',
];

export async function createCabin(terrain, { x, z, rotY = 0 } = {}, workGate = Promise.resolve()) {
  const breathe = createSpread();
  const built = buildCabin();
  await Promise.resolve(workGate).then(() => prepareMatsets(...CABIN_SETS));
  const group = new THREE.Group();
  group.name = 'ProceduralCabin';
  const geometry = (data) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(data.uv, 2));
    g.setIndex(new THREE.BufferAttribute(data.index, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  };
  const mesh = (data, mat) => {
    const m = new THREE.Mesh(geometry(data), mat);
    m.name = data.name;
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };

  const logMat = snowTint(
    material(matset('log'), { normalScale: 1.35, color: 0x8b6242 }),
    '0.78, 0.83, 0.94',
    0.5,
    0.5
  );
  const beamMat = snowTint(
    material(matset('beam'), { normalScale: 0.8, color: 0x7b573d }),
    '0.78, 0.83, 0.94',
    0.45,
    0.55
  );
  const boardMat = material(matset('floor'), { normalScale: 0.85, color: 0xb0875e });
  const roofMat = snowTint(
    material(matset('floor'), { normalScale: 1.0, color: 0x5a4030 }),
    '0.85, 0.89, 0.98',
    1.0,
    0.1,
    { geoNormal: true }
  );
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
  const logMesh = mesh(built.meshes.logs, logMat);
  const beamMesh = mesh(built.meshes.beam, beamMat);
  const roofMesh = mesh(built.meshes.roof, roofMat);
  const glassMesh = mesh(built.meshes.glass, glassMat);
  glassMesh.castShadow = false;

  const { layout } = built;
  // Статичные доски и подвижная дверь остаются одним проходом материала.
  // Малый хвост вершин двери поворачивается на ЦП только во время движения.
  const staticBoards = built.meshes.boards;
  const movingBoards = built.meshes.door;
  const staticVertices = staticBoards.position.length / 3;
  const boardPosition = new Float32Array(staticBoards.position.length + movingBoards.position.length);
  const boardNormal = new Float32Array(staticBoards.normal.length + movingBoards.normal.length);
  const boardUv = new Float32Array(staticBoards.uv.length + movingBoards.uv.length);
  const boardIndex = new Uint32Array(staticBoards.index.length + movingBoards.index.length);
  boardPosition.set(staticBoards.position);
  boardNormal.set(staticBoards.normal);
  boardUv.set(staticBoards.uv);
  boardUv.set(movingBoards.uv, staticBoards.uv.length);
  boardIndex.set(staticBoards.index);
  for (let i = 0; i < movingBoards.index.length; i++) {
    boardIndex[staticBoards.index.length + i] = movingBoards.index[i] + staticVertices;
  }
  const boardGeo = new THREE.BufferGeometry();
  boardGeo.setAttribute('position', new THREE.BufferAttribute(boardPosition, 3));
  boardGeo.setAttribute('normal', new THREE.BufferAttribute(boardNormal, 3));
  boardGeo.setAttribute('uv', new THREE.BufferAttribute(boardUv, 2));
  boardGeo.setIndex(new THREE.BufferAttribute(boardIndex, 1));
  function setDoorGeometry(angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    const p0 = staticBoards.position.length;
    for (let i = 0; i < movingBoards.position.length; i += 3) {
      const dx = movingBoards.position[i];
      const dy = movingBoards.position[i + 1];
      const dz = movingBoards.position[i + 2];
      boardPosition[p0 + i] = layout.door.hingeX + dx * c + dz * s;
      boardPosition[p0 + i + 1] = dy;
      boardPosition[p0 + i + 2] = layout.door.hingeZ - dx * s + dz * c;
      const nx = movingBoards.normal[i];
      const ny = movingBoards.normal[i + 1];
      const nz = movingBoards.normal[i + 2];
      boardNormal[p0 + i] = nx * c + nz * s;
      boardNormal[p0 + i + 1] = ny;
      boardNormal[p0 + i + 2] = -nx * s + nz * c;
    }
    boardGeo.attributes.position.needsUpdate = true;
    boardGeo.attributes.normal.needsUpdate = true;
  }
  setDoorGeometry(0);
  boardGeo.computeBoundingBox();
  boardGeo.computeBoundingSphere();
  const boardMesh = new THREE.Mesh(boardGeo, boardMat);
  boardMesh.name = 'boards';
  boardMesh.castShadow = true;
  boardMesh.receiveShadow = true;

  const doorNode = new THREE.Group();
  doorNode.name = 'Cabin_Door_3';
  doorNode.position.set(layout.door.hingeX, 0, layout.door.hingeZ);
  group.add(logMesh, beamMesh, boardMesh, roofMesh, glassMesh, doorNode);

  const cos = Math.cos(rotY), sin = Math.sin(rotY);
  const lw = (lx, lz) => [x + lx * cos + lz * sin, z - lx * sin + lz * cos];
  let maxUnder = -Infinity;
  for (let lx = layout.room.x0; lx <= layout.room.x1 + 0.01; lx += (layout.room.x1 - layout.room.x0) / 6) {
    for (let lz = layout.room.z0; lz <= layout.porch.z1 + 0.01; lz += (layout.porch.z1 - layout.room.z0) / 8) {
      const h = terrain.getHeight(...lw(lx, lz));
      maxUnder = Math.max(maxUnder, h);
    }
  }
  const stepZ = layout.porch.z1 + layout.porch.stepDepth / 2;
  const stairsGround = terrain.getHeight(...lw(layout.door.centerX, stepZ));
  const groupY = Math.max(
    stairsGround + 0.04 - layout.porch.stepTop,
    maxUnder + 0.12 - layout.room.floorY
  );
  group.position.set(x, groupY, z);
  group.rotation.y = rotY;
  group.updateMatrixWorld(true);

  snowCap(roofMesh, 0.09);

  const _v = new THREE.Vector3();
  const l2w = (lx, ly, lz) => group.localToWorld(_v.set(lx, ly, lz));
  const interiorPoint = (ix, iz) => ({
    x: INTERIOR_X + ix * INTERIOR_SCALE,
    z: INTERIOR_Z + iz * INTERIOR_SCALE,
  });

  const interior = await buildInterior(FLOOR_Y, breathe);
  const interiorHolder = new THREE.Group();
  interiorHolder.position.set(
    INTERIOR_X,
    layout.room.floorY - FLOOR_Y * INTERIOR_SCALE,
    INTERIOR_Z
  );
  interiorHolder.scale.setScalar(INTERIOR_SCALE);
  interiorHolder.add(interior.group);
  group.add(interiorHolder);
  const ownColliders = interior.colliders.length;
  group.updateMatrixWorld(true);

  const obstacles = [];
  const wall = (x0, z0, x1, z1, r = 0.14) => {
    const a = l2w(x0, layout.room.floorY, z0);
    const seg = { x1: a.x, z1: a.z, r };
    const b = l2w(x1, layout.room.floorY, z1);
    seg.x2 = b.x;
    seg.z2 = b.z;
    obstacles.push(seg);
    return seg;
  };
  for (const c of layout.wallColliders) wall(c.x1, c.z1, c.x2, c.z2, c.r);
  const underMax = groupY + layout.room.floorY - 0.3;
  for (const c of layout.porchColliders) {
    const seg = wall(c.x1, c.z1, c.x2, c.z2, c.r);
    seg.y1 = underMax;
  }
  const post = l2w(layout.room.x0 + 0.11, layout.room.floorY, layout.porch.z1 - 0.1);
  obstacles.push({ x: post.x, z: post.z, r: 0.14 });

  for (const c of interior.colliders) {
    const a = interiorPoint(c.x1 ?? c.x, c.z1 ?? c.z);
    if (c.x2 !== undefined) {
      const b = interiorPoint(c.x2, c.z2);
      wall(a.x, a.z, b.x, b.z, c.r * INTERIOR_SCALE);
    } else {
      const p = l2w(a.x, layout.room.floorY, a.z);
      obstacles.push({ x: p.x, z: p.z, r: c.r * INTERIOR_SCALE });
    }
  }
  const doorSeg = { x1: 0, z1: 0, x2: 0, z2: 0, r: 0.1 };
  obstacles.push(doorSeg);

  const dressed = loadInteriorProps(interior.group, FLOOR_Y, interior.colliders)
    .then(() => {
      group.updateMatrixWorld(true);
      return interior.colliders.slice(ownColliders).map((c) => {
        const local = interiorPoint(c.x, c.z);
        const p = l2w(local.x, layout.room.floorY, local.z);
        return { x: p.x, z: p.z, r: c.r * INTERIOR_SCALE };
      });
    })
    .catch(() => []);

  const _fv = new THREE.Vector3();
  function floorHeightAt(wx, wz) {
    group.worldToLocal(_fv.set(wx, groupY, wz));
    const inWidth = _fv.x >= layout.room.x0 && _fv.x <= layout.room.x1;
    if (inWidth && _fv.z >= layout.room.z0 && _fv.z <= layout.porch.z1) {
      return groupY + layout.room.floorY;
    }
    const stepHalf = layout.door.width / 2 + 0.23;
    if (
      _fv.x >= layout.door.centerX - stepHalf && _fv.x <= layout.door.centerX + stepHalf
      && _fv.z >= layout.porch.z1 && _fv.z <= layout.porch.z1 + layout.porch.stepDepth
    ) return groupY + layout.porch.stepTop;
    return null;
  }
  function isInside(wx, wz) {
    group.worldToLocal(_fv.set(wx, groupY, wz));
    return _fv.x >= layout.room.x0 && _fv.x <= layout.room.x1
      && _fv.z >= layout.room.z0 && _fv.z <= layout.room.z1;
  }

  const lights = [];
  for (const w of layout.windows) {
    let wx = w.lightCenter ?? w.center, wz = w.fixed ?? layout.room.z1;
    if (w.wall === 'back') wz = w.fixed ?? layout.room.z0;
    else if (w.wall === 'left' || w.wall === 'right') {
      wx = w.fixed ?? (w.wall === 'left' ? layout.room.x0 : layout.room.x1);
      wz = w.lightCenter ?? w.center;
    }
    const outLength = Math.hypot(wx, wz) || 1;
    const ox = wx / outLength, oz = wz / outLength;
    const l = new THREE.PointLight(0xffa550, 4.5, 7.5, 2);
    l.position.set(wx + ox * 0.85, w.centerY - 0.4, wz + oz * 0.85);
    lights.push(l);
    group.add(l);
  }
  const roofC = l2w(layout.roof.centerX, 0, layout.roof.centerZ);
  const snowMask = {
    x: roofC.x,
    z: roofC.z,
    cos, sin,
    hx: layout.roof.hx,
    hz: layout.roof.hz,
    topY: groupY + layout.roof.topY,
  };

  let doorOpen = false;
  let doorT = 0;
  const hingeW = new THREE.Vector3();
  const edgeW = new THREE.Vector3();
  const doorCenter = new THREE.Vector3();
  function syncDoor() {
    doorNode.updateMatrix();
    setDoorGeometry(doorNode.rotation.y);
    doorNode.updateWorldMatrix(true, false);
    hingeW.set(-layout.door.leafWidth * 0.45, layout.room.floorY + 1, 0);
    doorNode.localToWorld(hingeW);
    edgeW.set(-layout.door.leafWidth, layout.room.floorY + 1, 0);
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
  const stoveLocal = interiorPoint(interior.hearth.x, interior.hearth.z);
  const stovePos = l2w(stoveLocal.x, layout.room.floorY + 0.5, stoveLocal.z).clone();

  function update(t, dt = 0) {
    const k = 0.9 + 0.06 * Math.sin(t * 1.7) + 0.04 * Math.sin(t * 3.9 + 1.2);
    glassMat.emissiveIntensity = 0.75 * k;
    for (const l of lights) l.intensity = 4.5 * k;
    const target = doorOpen ? 1 : 0;
    if (Math.abs(target - doorT) > 1e-4) {
      doorT += (target - doorT) * Math.min(1, DOOR_SPEED * dt);
      if (Math.abs(target - doorT) < 1e-3) doorT = target;
      const e = doorT * doorT * (3 - 2 * doorT); // плавный ход у краёв
      doorNode.rotation.y = DOOR_OPEN * e;
      syncDoor();
    }
    interior.update(t, dt);
  }

  return {
    group, obstacles, update, toggleDoor, dressed,
    get doorOpen() { return doorOpen; },
    doorCenter, doorNode, floorHeightAt, isInside, snowMask, stovePos,
    footprint: { x, z, rotY, hx: layout.roof.hx, hz: layout.roof.hz },
  };
}

// ---------------------------------------------------------------------------
// Интерьер: камин с топкой, стопка дров, стол со свечой, табуретки, кровать с
// пледом, коврик, полка с книгами. Всё в локали gltf.scene (1 ед. ≈ 1 м).
// F — реальный Y пола, замеренный raycast'ом снаружи: база мебели ставится
// ровно на доски.
//
// Мебель — предметы каталога ядра (`world-core/props`). До этого она была
// коробками с одной канвовой текстурой доски на всё дерево и заливками вместо
// ткани и ковра; глаз цеплялся за неё как за заглушки. Предмет ядра знает свои
// материалы сам (кровать: брус, ткань, шерстяной плед), здесь остаются только
// место, коллайдер и свет.
async function buildInterior(F, breathe) {
  const g = new THREE.Group();

  const iron = new THREE.MeshStandardMaterial({ color: 0x23252b, roughness: 0.55, metalness: 0.7 });

  const colliders = []; // {x,z,r} или {x1,z1,x2,z2,r} — в локали модели
  const make = (name, options) => material(matset(name), options);
  const logMats = () => ({
    bark: make('bark', { normalScale: 1.6 }),
    end: make('logend', { normalScale: 1.2 }),
    split: make('split', { normalScale: 1.3 }),
  });
  const tableMats = () => ({
    top: make('floor', { normalScale: 0.8, color: 0xc9a473 }),
    seat: make('floor', { normalScale: 0.8, color: 0xc9a473 }),
    legs: make('beam', { normalScale: 0.7, color: 0x8a6a4a }),
  });

  // мебель складываем в `dest` (по умолчанию корень g). Для предметов, которые
  // заменяет реальная модель (стол, сиденья, свеча), временно переключаем dest
  // на именованную группу — потом её прячем, когда встанет скачанный ассет.
  let dest = g;
  const mesh = (geo, mat, x, y, z, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    m.rotation.z = rz;
    // комната целиком в лунной тени крыши — тень мебели от луны не видна
    // никогда, а десятки мелких мешей утяжеляли каждый depth-проход теней
    m.castShadow = false;
    m.receiveShadow = true;
    dest.add(m);
    return m;
  };
  const groupNamed = (name) => {
    const grp = new THREE.Group();
    grp.name = name;
    g.add(grp);
    dest = grp;
    return grp;
  };
  // предмет каталога: поставить базой на пол в (x, z), тени — как у mesh()
  const adopt = (prop, x, z, ry = 0) => {
    prop.group.position.set(x, F, z);
    prop.group.rotation.y = ry;
    prop.group.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false;
      o.receiveShadow = true;
    });
    dest.add(prop.group);
    return prop;
  };

  await breathe();

  // ---- камин у задней стены ----
  // Сложен в Blender (blender-web-agent-kit), 1920 треугольников. Подиум,
  // стойки с открытой топкой, брус полки поперёк, дымосборник трапецией до
  // кровли. Нутро топки кирпичное и тёплое против холодного наружного камня —
  // этот контраст читается как «горит» ещё до того, как в топке появится огонь.
  //
  // ПОВЕРХНОСТЬ СЧИТАЕТСЯ КОДОМ, файла текстур у камина нет.
  //
  // До этого вся модель лежала в одном запечённом атласе 1024x1024, и он был
  // не «низкого качества», а физически пуст: 56 пикселей карты на метр
  // поверхности (тексель в 1.8 см), причём UV-острова занимали 15% атласа, а
  // остальное было чёрной пустотой. Каждому каменному блоку доставалось пятно
  // примерно 20 на 20 пикселей — на нём не помещается ни скол, ни фаска.
  //
  // Теперь модель развёрнута в метрах (`tools/fireplace-retile.mjs`) и
  // разложена по ролям на три материала, а карты считает world-core: 512
  // пикселей на метр, вдевятеро плотнее, и плотность больше не зависит от того,
  // насколько велик предмет. Заодно .glb похудел с 630 до 176 КБ.
  //
  // Запечённую занятость при этом не жаль: three.js применяет aoMap ТОЛЬКО к
  // непрямому свету, а картинку в этой комнате лепит точечный огонь. Объём
  // даёт карта нормалей, и её генератор считает вместе с цветом.
  //
  // До него в этой комнате стояла каменка в углу, а до неё буржуйка — обе в
  // истории файла. Камин выбран за открытый огонь: он и источник света, и
  // картинка, а угловая печь ни того ни другого в полную силу не даёт.
  //
  // Модель встаёт СВОИМ началом координат: середина по ширине, на полу, у
  // плоскости стены. Тело растёт от стены в комнату.
  //     габарит модели: x ±1.16, z 0..1.18 (вперёд), высота 4.25
  // ROOM — коллизионный прямоугольник, а НЕ плоскость стены. Брёвна сруба
  // круглые и выпирают внутрь комнаты: у задней стены самая дальняя точка
  // геометрии лежит на z = -2.35, то есть на 55 см ближе к центру, чем
  // ROOM.z0 = -2.9. Камин, поставленный по ROOM, наполовину утонул в брёвнах,
  // и в топке вместо кирпича была видна рама окна.
  // Замерено перебором вершин сруба внутри объёма топки, а не на глаз.
  const BACK_WALL = -2.30;
  const stove = { x: -1.0, z: BACK_WALL };
  const stoveGroup = new THREE.Group();
  stoveGroup.name = 'fireplaceModel';
  stoveGroup.position.set(stove.x, F, stove.z);
  g.add(stoveGroup);
  // Материал по имени из .glb. Имена ставит `fireplace-retile.mjs`, разбирая
  // модель по ролям: наружная кладка и дымосборник — тёсаный камень, нутро
  // топки — тот же кирпич, что у футеровки, полка — брус.
  //
  // Материал ядра ОДНОСТОРОННИЙ, и это обязывает модель: каждая её грань
  // должна смотреть лицом в комнату. В исходной модели дымосборник был
  // вывернут целиком, и пока .glb нёс свой двусторонний материал, three
  // дорисовывал изнанку; с материалом ядра у камина пропала передняя стенка
  // дымосборника, а сквозь неё было видно изнанку боковых. За ориентацией
  // теперь следит сам `fireplace-retile.mjs` (шаг «ориентация»).
  const STOVE_MATS = { stone: 'ashlar', firebrick: 'brick', timber: 'beam' };
  // Развёртка у модели одна на все роли — один тайл на метр, — а размер рисунка
  // у материалов разный по их природе. Дереву метровый тайл мелок вдвое: у него
  // рисунок вдоль волокна, и на полке в 20 см глубиной он сходится в рябь,
  // которую глаз читает как мокрый металл. Ему тайл в два метра и рельеф
  // вполовину; камню и кирпичу метровый тайл ровно впору.
  //
  // Брус ещё и подкрашен, и это тоже кадр, а не вкус: `beam` в ядре самый
  // светлый из деревянных наборов (яркость 99 против 52 у бревна сруба), и в
  // упор к огню полка вылетала в пересвет — светло-бежевая доска посреди
  // тёмной кладки, будто мокрая. Множитель сажает её к тону сруба, сохраняя
  // рисунок; замена набора на бревно тон чинила, но вместе с ним уносила и
  // продольную фактуру, ради которой брус и выбран.
  const STOVE_LOOK = {
    ashlar: { normalScale: 1.15 },
    brick: { normalScale: 1 },
    beam: { repeat: [0.5, 0.5], normalScale: 0.6, color: 0x8a6f52 },
  };
  createGLTFLoader()
    .loadAsync(asset('models/props/fireplace.glb'))
    .then((gltf) => {
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        // камин в лунной тени крыши, как и прочая мебель (см. mesh())
        o.castShadow = false;
        o.receiveShadow = true;
        const set = STOVE_MATS[o.material?.name];
        // Неизвестное имя оставляем как есть, а не подставляем камень наугад:
        // молчаливая подмена спрятала бы разъезд модели и кода, а серый камень
        // на месте бруса выглядит достаточно правдоподобно, чтобы не заметить.
        if (!set) return;
        o.material = material(matset(set), STOVE_LOOK[set]);
      });
      stoveGroup.add(gltf.scene);
    })
    .catch(() => {}); // нет файла — огонь и свет всё равно на месте

  // Нутро топки — в firebox.js: футеровка кирпичом, под с золой, угли,
  // поленья, объёмное пламя и свет. Числа полости там же, они обмерены по самой
  // модели лучом, а не взяты на глаз.
  //
  // До этого в топке стояла светящаяся плита 0.62 x 0.34 и три голых цилиндра —
  // ровно то, что глаз читал как «яркий прямоугольник в нише», а не как огонь в
  // горячей глубине.
  const firebox = buildFirebox(g, { x: stove.x, y: F, z: stove.z });
  // Коллайдер — отрезок: камин это плита 2.32 на 1.18 у стены, и кругом её
  // не описать, не отобрав у комнаты угол.
  colliders.push({
    x1: stove.x - 0.62, z1: stove.z + 0.55, x2: stove.x + 0.62, z2: stove.z + 0.55, r: 0.62,
  });

  await breathe();

  // ---- стопка колотых дров сбоку от камина ----
  // Справа: камин занимает заднюю стену до x 0.16. Поленья лежат ТОРЦАМИ в
  // комнату: торец с кольцами — самая светлая и самая узнаваемая часть полена,
  // а сложенная вдоль стены стопка показывала комнате одну тёмную кору и
  // сливалась с брёвнами. Прежние шесть цилиндров «по x» вдобавок лежали друг
  // в друге по оси.
  adopt(logStack({ r: 0.055, len: 0.52, rows: [3, 2, 1], mats: logMats() }), 0.62, -2.06, Math.PI / 2);

  await breathe();

  // ---- стол у правого окна + свеча ----
  // Каркас стола — в группе 'table' (её прячет модельный стол WoodenTable_02).
  const tableAt = { x: 1.75, z: 1.35 };
  const TABLE_TOP = F + 0.755; // верх столешницы (свеча стоит на нём)
  groupNamed('table');
  adopt(table({ w: 1.15, d: 0.75, h: 0.755, mats: tableMats() }), tableAt.x, tableAt.z);
  dest = g;
  colliders.push({ x: tableAt.x, z: tableAt.z, r: 0.6 });
  // блюдце, свеча, огонёк — в группе candleSet (её переставим на верх модели стола)
  groupNamed('candleSet');
  mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.02, 12), iron, tableAt.x + 0.2, TABLE_TOP + 0.01, tableAt.z);
  mesh(
    new THREE.CylinderGeometry(0.033, 0.036, 0.15, 10),
    new THREE.MeshStandardMaterial({ color: 0xf3e3c3, roughness: 0.5 }),
    tableAt.x + 0.2, TABLE_TOP + 0.095, tableAt.z
  );
  const flameMat = new THREE.MeshStandardMaterial({
    color: 0xffe0a0,
    emissive: 0xffc86e,
    emissiveIntensity: 3.2,
  });
  const flame = mesh(new THREE.ConeGeometry(0.02, 0.07, 8), flameMat, tableAt.x + 0.2, TABLE_TOP + 0.205, tableAt.z);
  flame.castShadow = false;
  const candle = new THREE.PointLight(0xffc070, 1.15, 4, 2);
  candle.position.set(tableAt.x + 0.2, TABLE_TOP + 0.265, tableAt.z);
  dest.add(candle);
  dest = g;

  await breathe();

  // ---- табуретки (каждая в группе 'seatN' — её заменит модель стула) ----
  [[1.15, 0.7], [2.3, 0.9]].forEach(([sx, sz], i) => {
    groupNamed('seat' + i);
    adopt(stool({ r: 0.19, h: 0.45, mats: tableMats() }), sx, sz, i * 1.3);
    dest = g;
    colliders.push({ x: sx, z: sz, r: 0.24 });
  });

  await breathe();

  // ---- кровать вдоль правой стены, ближе к дальнему углу ----
  // Изголовье стоит у самой стены: её брёвна выпирают внутрь до z ≈ −2.35
  // (см. BACK_WALL), и кровать, поставленная по ROOM, изголовьем сидела в
  // брёвнах. То же с правой стеной — кровать сдвинута к середине.
  const bedAt = { x: 2.0, z: -1.25 };
  adopt(bed({
    w: 1.02,
    l: 2.1,
    mats: {
      frame: make('beam', { normalScale: 0.7, color: 0x8a6a4a }),
      sheet: make('cloth', { normalScale: 0.8, color: 0xe6dcc8 }),
      blanket: make('wool', { normalScale: 1.1 }),
      pillow: make('cloth', { normalScale: 0.9, color: 0xf2ebdc }),
    },
  }), bedAt.x, bedAt.z);
  colliders.push({ x1: bedAt.x, z1: bedAt.z - 0.85, x2: bedAt.x, z2: bedAt.z + 0.85, r: 0.5 });

  await breathe();

  // ---- круглый плетёный коврик по центру ----
  adopt(rug({ r: 0.85, mats: { braid: make('braid', { normalScale: 0.7 }) } }), 0.25, 0);

  await breathe();

  // ---- полка на задней стене: книги и кружка ----
  // Задняя кромка полки — на линии выпуклости брёвен (BACK_WALL); прежняя
  // полка стояла на z −2.72, то есть целиком в толще стены, и книг в комнате
  // видно не было.
  const coverColors = [0x6b3434, 0x35502f, 0x2f3f5c, 0x77582a, 0x4c3355];
  const shelfMats = {
    wood: make('beam', { normalScale: 0.7, color: 0xa88a66 }),
    pages: make('paper', { normalScale: 0.8, repeat: [2, 2] }),
  };
  coverColors.forEach((color, i) => {
    shelfMats[`cover${i}`] = make('leather', { color, normalScale: 0.8 });
  });
  const shelf = shelfWithBooks({ width: 1.2, depth: 0.24, n: 5, mats: shelfMats });
  shelf.group.position.set(0.9, F + 1.5, BACK_WALL + 0.12);
  shelf.group.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = true;
  });
  g.add(shelf.group);

  await breathe();

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

  // мерцание огня в топке, свечи и тёплого фонаря
  function update(t, dt = 0) {
    firebox.update(dt, t);
    const ck = 0.8 + 0.13 * Math.sin(t * 12.7 + 2.1) + 0.07 * Math.sin(t * 31.7);
    candle.intensity = 1.15 * ck;
    flameMat.emissiveIntensity = 3.2 * ck;
    flame.scale.y = 0.9 + 0.2 * ck;
    // фонарь дышит медленно — ровный заполняющий свет комнаты
    const lk = 0.9 + 0.06 * Math.sin(t * 3.1 + 0.5) + 0.04 * Math.sin(t * 6.7);
    hearth.intensity = 2.2 * lk;
    lampGlass.emissiveIntensity = 2.4 * lk;
  }

  // hearth — устье, а не середина печи: тепло считают от него. У буржуйки
  // разницы почти не было, у каменки середина приходится в толщу кладки.
  return { group: g, colliders, stove, hearth: firebox.hearth, update };
}

// Реальные ассеты мебели (Poly Haven, CC0, glTF 1k) поверх процедурного
// интерьера. Модель ставим базой на пол (по её bbox), прячем процедурный
// двойник (visible=false), добавляем коллайдер. Нет файла → тихо оставляем
// примитив. Всё в локали интерьера g — метрическая Y-up, как процедурная мебель.
async function loadInteriorProps(g, F, colliders) {
  // Оставлены только модели, что по стилю и размеру ложатся в рустик-сруб:
  // чугунок у печи и стопка книг на столе. Прочая мебель Poly Haven не подошла
  // (стул — резной трон 2.4 м, «стол» — кубик 0.44 м, «бочка» — современная
  // стальная бочка с наклейкой) — роль мебели держит процедурная (buildInterior).
  // Загрузчик умеет `hide` (спрятать процедурный двойник) — заготовка под
  // будущие рустик-модели, что пользователь скачает со Sketchfab.
  const PROPS = [
    // file — относительно /models/props/; x,z — якорь в локали; yaw — доворот;
    // on — 'floor'(деф)|'table'; col — радиус коллайдера; scale — доп. масштаб;
    // hide — имя процедурной группы-двойника ('table'|'seat0'|'seat1')
    // чугунок стоял у прежней печи; камин занял это место, и котелок
    // переехал к краю подиума, откуда его удобно снять с огня
    { file: 'brass_pot_01/brass_pot_01_1k.gltf', x: 0.32, z: -1.32, yaw: 1.0, col: 0.22 },
    { file: 'book_encyclopedia_set_01/book_encyclopedia_set_01_1k.gltf', x: 1.6, z: 1.5, yaw: 0.6, on: 'table' },
  ];
  const loader = createGLTFLoader();
  const box = new THREE.Box3();
  const TOP0 = F + 0.755; // верх процедурной столешницы (свеча стоит здесь)
  let tableTop = TOP0;
  for (const p of PROPS) {
    let gltf;
    try {
      gltf = await loader.loadAsync(asset('models/props/' + p.file));
    } catch (e) {
      continue; // файла нет — процедурный двойник остаётся на месте
    }
    const scene = gltf.scene;
    // castShadow=false: пропсы стоят в комнате, в лунной тени крыши (см. mesh())
    scene.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = true; } });
    if (p.scale) scene.scale.multiplyScalar(p.scale);
    scene.updateMatrixWorld(true);
    box.setFromObject(scene);
    const baseTo = p.on === 'table' ? tableTop : F;
    const holder = new THREE.Group();
    holder.position.set(p.x, baseTo - box.min.y, p.z); // база модели — на пол/стол
    holder.rotation.y = p.yaw || 0;
    holder.add(scene);
    g.add(holder);
    if (p.hide) {
      const twin = g.getObjectByName(p.hide);
      if (twin) twin.visible = false;
    }
    if (p.hide === 'table') {
      tableTop = (F - box.min.y) + box.max.y; // верх модельного стола — под предметы
      const cs = g.getObjectByName('candleSet');
      if (cs) cs.position.y += tableTop - TOP0; // свечу переставляем на стол
    }
    if (p.col) colliders.push({ x: p.x, z: p.z, r: p.col });
  }
}
