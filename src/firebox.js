import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { material, planeUV, cylinderUV, boxUV, quadGeometry } from 'world-core/materials';
import { matsets } from './matsets.js';
import { FlameSheets, FLAME_HEARTH } from './flame.js';

// Нутро топки камина: футеровка, под с золой, угли, поленья, пламя, свет.
//
// Сам камин — модель из Blender (fireplace.glb): кладка, подиум, стойки,
// дымосборник. Полость в ней есть и она честная — лучом из комнаты меряется
// задняя стенка, боковые, под и свод, — но полость эта ГЛАДКАЯ и серая, как и
// весь наружный бут: один запечённый атлас на всю модель. Раньше в ней стояла
// светящаяся плита 0.62 x 0.34 и три цилиндра, и глаз читал не горячую глубину,
// а яркий прямоугольник в нише.
//
// Здесь топка получает то, чего атлас дать не может: тёплый огнеупорный кирпич
// против холодного наружного камня, сажу кверху, под из плит, золу, угли,
// обугленные поленья и объёмное пламя. Материалы процедурные (world-core), ни
// одного лишнего файла в сборке.
//
// ВСЕ ЧИСЛА НИЖЕ — ОБМЕР, А НЕ ГЛАЗ. Полость промерена лучами по самой модели
// (tools/firebox-check.mjs повторяет обмер и сверяет с ним каждую деталь).
// Поэтому же они экспортируются: проверка обязана читать те же числа, что и
// сцена, иначе она проверяет свою копию.

/**
 * Полость топки в локали модели камина (начало — середина, у стены, на полу).
 *
 * Щёки НЕ параллельны: топка сужается к устью на 5.7 градуса — так сложены
 * настоящие камерные камины, и так она сложена в модели. Первая версия
 * футеровки этого не заметила (замер брался одним лучом из середины) и встала
 * прямоугольником: у задней стенки между кирпичом и щекой оставалось 4 см
 * пустоты, в которую смотрел серый наружный бут. Поймала проверка счётом.
 */
export const CAVITY = {
  back: 0.115, // задняя стенка
  floor: 0.16, // под
  roof: 1.1, // свод
  mouth: 0.6, // передняя плоскость стоек — устье
  sideBack: 0.5185, // полуширина у задней стенки
  slope: 0.1, // насколько щека забирается внутрь на метр глубины
};

/** Полуширина полости на глубине z. */
export const sideAt = (z) => CAVITY.sideBack - CAVITY.slope * (z - CAVITY.back);

/**
 * Зазор футеровки от стенок полости.
 *
 * Не «на глаз, чтобы не мерцало»: 12 мм это толщина облицовочного слоя, и
 * читается он именно так — кирпич выложен внутри каменного короба. Совпадающих
 * плоскостей в мирах быть не должно вообще, а не «почти не должно».
 */
export const LINER = 0.012;

/** Огонь стоит на золе, а не на поду: под ним слой пепла. */
export const ASH_Y = CAVITY.floor + LINER + 0.004;
/** Основание пламени — над золой, чтобы язык не резался её краем. */
export const FLAME_BASE = ASH_Y + 0.03;
/** Полотно пламени: уже и выше костра (см. flame.js). */
export const FLAME_W = 0.62;
export const FLAME_H = 0.78;

/**
 * Поленья. `along` — вдоль какой оси лежит полено: два поперёк топки и одно
 * торцом в комнату. Торец это единственное место, где видно, что полено —
 * дерево, а не тёмная колбаса: у коры силуэт, у торца годовые кольца. Пока все
 * три лежали поперёк, торцы смотрели в щёки и в кадр не попадали вовсе.
 */
export const LOGS = [
  { x: -0.03, y: ASH_Y + 0.05, z: 0.35, len: 0.6, r: 0.05, tilt: 0.05, along: 'x', charred: false },
  { x: 0.05, y: ASH_Y + 0.05, z: 0.25, len: 0.56, r: 0.047, tilt: -0.04, along: 'x', charred: true },
  { x: -0.13, y: ASH_Y + 0.125, z: 0.33, len: 0.34, r: 0.045, tilt: 0.06, along: 'z', charred: true },
];

/** Зола: эллиптическая насыпь на поду. */
export const ASH = { z: 0.36, rx: 0.32, rz: 0.19 };

/**
 * Щепа и обломок кирпича у края пода. Не мусор ради мусора: у топки, в которой
 * топят, край пода всегда засыпан — это то же самое, что след от чашки на
 * столе, признак пользования.
 */
export const CHIPS = [
  { x: -0.28, y: ASH_Y + 0.012, z: 0.5, w: 0.14, h: 0.022, d: 0.03, ry: 0.5 },
  { x: 0.29, y: ASH_Y + 0.01, z: 0.47, w: 0.1, h: 0.018, d: 0.026, ry: -0.9 },
  { x: 0.22, y: ASH_Y + 0.014, z: 0.53, w: 0.07, h: 0.028, d: 0.05, ry: 0.3 },
];

// Наборы карт считаются один раз на всю игру и раздаются материалам: клон
// текстуры ради своего числа повторов ничего не стоит (см. world-core). Кэш
// общий с камином снаружи — он же берёт кирпич и брус (см. `matsets.js`).
function loadSets() {
  return matsets(
    'brick', // огнеупорный кирпич, сажа кверху гуще
    'hearth', // плиты пода
    'bark',
    'logend',
    'beam',
  );
}

/** Мягкое круглое пятно: контактная тень под поленом и сияние над углями. */
function spotTexture(inner, outer, size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.45, outer);
  g.addColorStop(1, outer.replace(/[\d.]+\)$/, '0)'));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * Собрать нутро топки в группе `parent`, с началом координат камина в точке
 * (x, y, z) локали интерьера.
 *
 * Возвращает `{ update(dt, t), hearth }` — hearth это точка, от которой в игре
 * считается тепло (устье, а не середина печи).
 */
export function buildFirebox(parent, { x, y, z }) {
  const s = loadSets();
  const box = new THREE.Group();
  box.position.set(x, y, z);
  parent.add(box);

  // Углы футерованной полости. Отступ от щеки берётся ПО НОРМАЛИ, а не по x:
  // щека наклонная, и честный зазор в 12 мм требует чуть большего смещения.
  const HGT = CAVITY.roof - CAVITY.floor - LINER * 2;
  const zb = CAVITY.back + LINER; // задняя стенка футеровки
  const zm = CAVITY.mouth - LINER; // её передний край, у самого устья
  const yf = CAVITY.floor + LINER; // под
  const yr = CAVITY.roof - LINER; // свод
  const inset = LINER * Math.hypot(1, CAVITY.slope); // отступ от наклонной щеки
  const xb = sideAt(zb) - inset; // полуширина у задней стенки
  const xm = sideAt(zm) - inset; // и у устья

  // Тайл кирпича — ровно на высоту топки. Это не подгонка «чтобы красиво»:
  // сажа в генераторе густеет кверху монотонным градиентом, а монотонный
  // градиент не сходится сам с собой (проверено счётом в ядре). Один тайл по
  // вертикали — единственная раскладка, в которой шва нет по построению.
  const TILE = 1 / HGT; // тайлов на метр

  const brickMat = material(s.brick, { normalScale: 1.25 });
  // свод и верх стен закопчены сильнее: туда уходит весь дым
  const sootMat = material(s.brick, { normalScale: 1.1, color: 0x6b6158 });
  const hearthMat = material(s.hearth, { normalScale: 1.2, color: 0xb4a795 });

  const add = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = false; // комната в лунной тени крыши, как и вся мебель
    m.receiveShadow = true;
    box.add(m);
    return m;
  };

  /**
   * Четырёхугольник лицом в заданную сторону. Порядок вершин задаёт нормаль, и
   * перепутать его легко: у трапеции «по часовой» зависит от того, с какой
   * стороны смотреть. Поэтому сторона проверяется, а не выводится в уме —
   * изнанка в топке выглядела бы дырой в кладке.
   */
  const facing = (pts, dir, scale) => {
    const [a, b, c] = pts;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
    const n = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    const towards = n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2];
    const p = towards >= 0 ? pts : [...pts].reverse();
    return quadGeometry(p[0], p[1], p[2], p[3], scale);
  };

  // ---- футеровка: кирпич внутри каменного короба ----
  add(
    facing(
      [[-xb, yf, zb], [xb, yf, zb], [xb, yr, zb], [-xb, yr, zb]],
      [0, 0, 1],
      TILE
    ),
    brickMat
  );

  for (const sx of [-1, 1]) {
    add(
      facing(
        [
          [sx * xb, yf, zb],
          [sx * xm, yf, zm],
          [sx * xm, yr, zm],
          [sx * xb, yr, zb],
        ],
        [-sx, 0, 0],
        TILE
      ),
      brickMat
    );
  }

  add(
    facing(
      [[-xb, yr, zb], [xb, yr, zb], [xm, yr, zm], [-xm, yr, zm]],
      [0, -1, 0],
      TILE
    ),
    sootMat
  );

  // ---- под: плиты, поверх — зола ----
  add(
    facing(
      [[-xb, yf, zb], [xb, yf, zb], [xm, yf, zm], [-xm, yf, zm]],
      [0, 1, 0],
      1.6
    ),
    hearthMat
  );

  const ashGeo = new THREE.CircleGeometry(ASH.rx, 20)
    .rotateX(-Math.PI / 2)
    .scale(1, 1, ASH.rz / ASH.rx);
  planeUV(ashGeo, ASH.rx * 2, ASH.rz * 2, 3.4); // мелкий рисунок — крошка, а не плиты
  const ash = add(ashGeo, material(s.hearth, { normalScale: 0.55, color: 0x4a4038 }));
  ash.position.set(0, ASH_Y, ASH.z);

  // ---- контактные тени ----
  // Огонь тени не отбрасывает: единственный источник с тенями в мире — луна, а
  // комната стоит в тени крыши. Точечная тень от мерцающего огня стоила бы шести
  // граней кубической карты на каждый взвод, и всё это ради пятна под поленом.
  // Пятно и рисуем — оно и есть весь смысл той тени.
  const shadeTex = spotTexture('rgba(0,0,0,0.62)', 'rgba(0,0,0,0.32)');
  const shadeMat = new THREE.MeshBasicMaterial({
    map: shadeTex,
    transparent: true,
    depthWrite: false,
    opacity: 0.75,
    toneMapped: false,
  });
  for (const l of LOGS) {
    const long = l.len * 1.15;
    const across = l.r * 4.2;
    const sh = new THREE.Mesh(
      new THREE.PlaneGeometry(l.along === 'z' ? across : long, l.along === 'z' ? long : across),
      shadeMat
    );
    sh.rotation.x = -Math.PI / 2;
    sh.position.set(l.x, ASH_Y + 0.002 + (l.y - LOGS[0].y) * 0.02, l.z);
    sh.renderOrder = 1;
    box.add(sh);
  }

  // ---- поленья: кора по бокам, торцы отдельно, нижние обуглены ----
  const barkMat = material(s.bark, { normalScale: 1.6 });
  const charMat = material(s.bark, { normalScale: 1.4, color: 0x584f47 });
  const endMat = material(s.logend, { normalScale: 1.2 });
  for (const l of LOGS) {
    const geo = new THREE.CylinderGeometry(l.r, l.r * 1.08, l.len, 10);
    cylinderUV(geo, l.r, l.len, 2.6);
    const m = new THREE.Mesh(geo, [l.charred ? charMat : barkMat, endMat, endMat]);
    if (l.along === 'z') {
      m.rotation.x = Math.PI / 2 + l.tilt;
    } else {
      m.rotation.z = Math.PI / 2 + l.tilt;
    }
    m.position.set(l.x, l.y, l.z);
    m.receiveShadow = true;
    box.add(m);
  }

  // ---- щепа и обломок кирпича на поду ----
  const chips = [];
  for (const c of CHIPS) {
    const g = new THREE.BoxGeometry(c.w, c.h, c.d);
    boxUV(g, c.w, c.h, c.d, 3);
    g.rotateY(c.ry);
    g.translate(c.x, c.y, c.z);
    chips.push(g);
  }
  const chipMesh = new THREE.Mesh(mergeGeometries(chips), material(s.beam, { color: 0x6a5b4a }));
  chipMesh.receiveShadow = true;
  box.add(chipMesh);

  // ---- угли между поленьями ----
  const emberMat = new THREE.MeshStandardMaterial({
    color: 0x140a05,
    emissive: 0xff4a12,
    emissiveIntensity: 2.2,
    roughness: 1,
  });
  const emberGeos = [];
  for (let i = 0; i < 6; i++) {
    const a = i * 2.1 + 0.6;
    const g = new THREE.IcosahedronGeometry(0.022 + (i % 3) * 0.009, 1);
    g.translate(Math.cos(a) * 0.16, ASH_Y + 0.02, ASH.z + Math.sin(a) * 0.075);
    emberGeos.push(g);
  }
  box.add(new THREE.Mesh(mergeGeometries(emberGeos), emberMat));

  // ---- пламя ----
  const flame = new FlameSheets({
    w: FLAME_W,
    h: FLAME_H,
    texW: 56,
    texH: 120,
    fps: 30,
    shape: FLAME_HEARTH,
    color: new THREE.Color(1.12, 1.05, 0.98),
  });
  const flameGroup = new THREE.Group();
  flameGroup.position.set(0, FLAME_BASE, ASH.z);
  flame.addTo(flameGroup);
  box.add(flameGroup);

  // сияние над углями: горячий воздух в устье
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: spotTexture('rgba(255,170,78,0.5)', 'rgba(255,112,30,0.2)', 128),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      toneMapped: false,
      fog: false,
    })
  );
  glow.scale.set(0.85, 0.7, 1);
  glow.position.set(0, FLAME_BASE + 0.3, ASH.z);
  glow.renderOrder = 2;
  box.add(glow);

  // ---- искры: вверх, в дымосборник ----
  const SPARKS = 20;
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
  sparkGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
  const sparkPos = sparkGeo.attributes.position;
  const sparkCol = sparkGeo.attributes.color;
  const sparks = [];
  for (let i = 0; i < SPARKS; i++) {
    sparks.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: Math.random(), rate: 0.6 });
  }
  const sparkMesh = new THREE.Points(
    sparkGeo,
    new THREE.PointsMaterial({
      size: 0.022,
      map: spotTexture('rgba(255,220,150,1)', 'rgba(255,130,40,0.6)', 32),
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    })
  );
  sparkMesh.frustumCulled = false;
  sparkMesh.renderOrder = 3;
  box.add(sparkMesh);

  // ---- свет ----
  // Два источника, и это не расточительство. Один у самого устья светит в
  // комнату — он и был тут раньше. Второй стоит внизу, у золы, и светит
  // СКОЛЬЗЯЩЕ вдоль кирпича: ровно так проявляется рельеф, который в лобовом
  // свете пропадает. Без него футеровка читается плоской заливкой — той самой,
  // из-за которой камин и выглядел нарисованным.
  // Свет устья стоит ВЫШЕ середины проёма и чуть глубже его плоскости. Ниже и
  // ближе он бил прямо в подиум, и плита перед топкой светилась ярче всей
  // кладки — единственное белое пятно на тёмном камне.
  const mouthLight = new THREE.PointLight(0xff8a40, 2.6, 8.5, 2);
  mouthLight.position.set(0, CAVITY.floor + 0.56, CAVITY.mouth + 0.01);
  box.add(mouthLight);

  const innerLight = new THREE.PointLight(0xff6a24, 1.5, 1.9, 2);
  innerLight.position.set(0, ASH_Y + 0.045, ASH.z - 0.05);
  box.add(innerLight);

  const flameSheets = flame.sheets;

  function update(dt, t) {
    // Мерцание: медленное дыхание плюс быстрая дрожь, как у костра. Синусы
    // дают слышимый период, поэтому у медленной части шумовая основа.
    const fk = 0.72 + 0.18 * Math.sin(t * 9.7) + 0.1 * Math.sin(t * 23.3 + 1.7);
    const b = Math.min(1, 0.82 + fk * 0.2);

    mouthLight.intensity = 2.6 * fk;
    mouthLight.position.x = Math.sin(t * 6.9) * 0.03;
    innerLight.intensity = 1.5 * (0.75 + 0.35 * fk);
    emberMat.emissiveIntensity = (1.4 + fk * 1.1);

    glow.material.opacity = (0.34 + 0.22 * fk);
    glow.scale.set(0.8 + fk * 0.12, 0.66 + fk * 0.12, 1);

    for (let i = 0; i < flameSheets.length; i++) {
      const f = flameSheets[i];
      const k = 0.86 + fk * 0.2 + i * 0.03;
      f.scale.set(k, 0.82 + fk * 0.26, 1);
      f.position.y = (FLAME_H / 2) * f.scale.y;
    }
    flame.frame(dt, t, b);

    for (let i = 0; i < sparks.length; i++) {
      const e = sparks[i];
      e.life -= dt * e.rate;
      if (e.life <= 0) {
        e.life = 1;
        e.rate = 0.5 + Math.random() * 0.5;
        e.x = (Math.random() - 0.5) * 0.26;
        e.y = FLAME_BASE + 0.1;
        e.z = ASH.z + (Math.random() - 0.5) * 0.16;
        e.vx = (Math.random() - 0.5) * 0.09;
        e.vy = 0.5 + Math.random() * 0.55;
        e.vz = (Math.random() - 0.5) * 0.06 - 0.05; // тяга уносит вглубь, к дымоходу
      }
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.z += e.vz * dt;
      sparkPos.setXYZ(i, e.x, e.y, e.z);
      const a = e.life * Math.min(1, (1 - e.life) * 7);
      sparkCol.setXYZ(i, a, a * (0.5 + 0.5 * e.life), a * (0.2 + 0.4 * e.life));
    }
    sparkPos.needsUpdate = true;
    sparkCol.needsUpdate = true;
  }

  return {
    update,
    // тепло считают от устья, а не от середины печи
    hearth: { x, z: z + CAVITY.mouth },
  };
}
