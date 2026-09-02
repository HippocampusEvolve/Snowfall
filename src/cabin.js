import * as THREE from 'three';
import { createGLTFLoader } from './gltfload.js';
import { asset } from './asset.js';
import { snowTint } from './snowtint.js';
import { snowCap } from './snowcap.js';
import { buildFirebox } from './firebox.js';
import { material } from 'world-core/materials';
import { bed, table, stool, rug, shelfWithBooks, logStack } from 'world-core/props';
import { matset } from './matsets.js';

// Домик: Scandinavian Log Cabin (rivetech, CC-BY). Масштаб к реальным метрам,
// посадка в снег по рельефу, снег на крыше и кромках брёвен через snowTint.
// В домик можно войти: дверь (узел Cabin_Door_3) открывается по F, стены —
// коллизия-отрезки с проёмом, деревянный пол и ступенька на крыльцо.
// Внутри — процедурный уют: камин, дрова, стол со свечой, кровать, коврик,
// полка с книгами. Мебель — предметы каталога ядра (world-core/props):
// геометрия из примитивов, поверхность из наборов ядра, здесь только
// расстановка и коллайдеры.

const LENGTH = 9.6; // длина домика по большей стороне, м (дверь ≈ 2.1 м)
const DOOR_OPEN = 2.2; // рад — дверь распахивается НАРУЖУ, на крыльцо (по-северному)
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
  const gltf = await createGLTFLoader().loadAsync(asset('models/cabin/scene.gltf'));
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
  // Габарит сруба в его собственных осях (полуразмеры по x/z, вместе со свесом
  // кровли). Отдаём наружу как footprint: лес обмеряет по нему, что налезло
  // на дом, и убирает это из мира (см. cull в trees.js). Круг вокруг центра
  // тут не годится - дом вытянут и повёрнут, круг либо режет лишнее, либо
  // пропускает угол.
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
    // Floor — доски внутри дома и настил крыльца: всё под крышей, снега
    // на них не бывает (снег внутри дома выглядел как изморозь на полу)
    else if (name !== 'Floor') snowTint(c.material, '0.78, 0.83, 0.94', 0.5, 0.5);
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

  // снег лежит ШАПКОЙ на кровле: оболочка поверх меша крыши (snowcap.js);
  // толщину задаём в метрах через реальный мировой масштаб узла gltf
  if (roofMesh) snowCap(roofMesh, 0.09 / roofMesh.getWorldScale(new THREE.Vector3()).x);

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
  // Сколько коллайдеров у процедурной мебели: всё, что появится в этом списке
  // сверх этого числа, принесли поздние модели (см. `dressed` ниже).
  const ownColliders = interior.colliders.length;
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
  // у земли (y1 между снегом и настилом); на настиле — свободно
  const underMax = floorWorldY - 0.3;
  for (const seg of [
    wall(ROOM.x0, ROOM.z1, ROOM.x0, PORCH_Z1, 0.12), // левый край крыльца
    // правый край — до z=3.55: концевые круги этого сегмента и фронтальной
    // кромки с радиусом игрока перекрывались и пережимали устье лестницы
    wall(ROOM.x1, ROOM.z1, ROOM.x1, 3.55, 0.12),
    wall(ROOM.x0, PORCH_Z1, ROOM.x1, PORCH_Z1, 0.12), // фронтальная кромка
  ]) {
    seg.y1 = underMax;
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

  // ---- поздняя отделка: скачанные модели мебели ----
  // Чугунок и стопка книг стоят ВНУТРИ дома: снаружи их не видно вовсе, а
  // весят они четверть мегабайта. Держать на них вход в мир незачем — они
  // уезжают в последнюю волну отделки, уже за спиной у игрока (см. «волны
  // отделки» в main.js). Пока не приехали, на их местах стоят процедурные
  // двойники, ради которых интерьер и собран примитивами.
  //
  // Коллайдеры этих моделей отдаются наружу списком, а не дописываются в
  // `obstacles`: тот к моменту их приезда давно скопирован в общий реестр мира,
  // и добавленное в него уже никем не читается.
  const dressed = loadInteriorProps(interior.group, localFloorY, interior.colliders)
    .then(() => {
      group.updateMatrixWorld(true);
      return interior.colliders.slice(ownColliders).map((c) => {
        const p = l2w(c.x, FLOOR_Y, c.z);
        return { x: p.x, z: p.z, r: c.r };
      });
    })
    .catch(() => []); // нет файлов — процедурные двойники остаются на месте

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

  // тепло очага: мировая позиция устья (x/z из плана, Y — реальный пол)
  const stovePos = l2w(interior.hearth.x, FLOOR_Y, interior.hearth.z).clone();
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

    interior.update(t, dt);
  }

  return {
    group, obstacles, update, toggleDoor, dressed,
    get doorOpen() { return doorOpen; },
    doorCenter, floorHeightAt, isInside, snowMask, stovePos,
    // повёрнутый прямоугольник габарита в мировых координатах
    footprint: { x, z, rotY, hx: half.x, hz: half.y },
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
function buildInterior(F) {
  const g = new THREE.Group();

  const iron = new THREE.MeshStandardMaterial({ color: 0x23252b, roughness: 0.55, metalness: 0.7 });

  const colliders = []; // {x,z,r} или {x1,z1,x2,z2,r} — в локали модели

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

  // ---- стопка колотых дров сбоку от камина ----
  // Справа: камин занимает заднюю стену до x 0.16. Поленья лежат ТОРЦАМИ в
  // комнату: торец с кольцами — самая светлая и самая узнаваемая часть полена,
  // а сложенная вдоль стены стопка показывала комнате одну тёмную кору и
  // сливалась с брёвнами. Прежние шесть цилиндров «по x» вдобавок лежали друг
  // в друге по оси.
  adopt(logStack({ r: 0.055, len: 0.52, rows: [3, 2, 1] }), 0.62, -2.06, Math.PI / 2);

  // ---- стол у правого окна + свеча ----
  // Каркас стола — в группе 'table' (её прячет модельный стол WoodenTable_02).
  const tableAt = { x: 1.75, z: 1.35 };
  const TABLE_TOP = F + 0.755; // верх столешницы (свеча стоит на нём)
  groupNamed('table');
  adopt(table({ w: 1.15, d: 0.75, h: 0.755 }), tableAt.x, tableAt.z);
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

  // ---- табуретки (каждая в группе 'seatN' — её заменит модель стула) ----
  [[1.15, 0.7], [2.3, 0.9]].forEach(([sx, sz], i) => {
    groupNamed('seat' + i);
    adopt(stool({ r: 0.19, h: 0.45 }), sx, sz, i * 1.3);
    dest = g;
    colliders.push({ x: sx, z: sz, r: 0.24 });
  });

  // ---- кровать вдоль правой стены, ближе к дальнему углу ----
  // Изголовье стоит у самой стены: её брёвна выпирают внутрь до z ≈ −2.35
  // (см. BACK_WALL), и кровать, поставленная по ROOM, изголовьем сидела в
  // брёвнах. То же с правой стеной — кровать сдвинута к середине.
  const bedAt = { x: 2.0, z: -1.25 };
  adopt(bed({ w: 1.02, l: 2.1 }), bedAt.x, bedAt.z);
  colliders.push({ x1: bedAt.x, z1: bedAt.z - 0.85, x2: bedAt.x, z2: bedAt.z + 0.85, r: 0.5 });

  // ---- круглый плетёный коврик по центру ----
  adopt(rug({ r: 0.85 }), 0.25, 0);

  // ---- полка на задней стене: книги и кружка ----
  // Задняя кромка полки — на линии выпуклости брёвен (BACK_WALL); прежняя
  // полка стояла на z −2.72, то есть целиком в толще стены, и книг в комнате
  // видно не было.
  const shelf = shelfWithBooks({ width: 1.2, depth: 0.24, n: 5 });
  shelf.group.position.set(0.9, F + 1.5, BACK_WALL + 0.12);
  shelf.group.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = true;
  });
  g.add(shelf.group);

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
