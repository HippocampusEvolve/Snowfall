import * as THREE from 'three';
import { cylinderUV, discUV, material } from 'world-core/materials';
import {
  splitLogGeometry,
  roundLogGeometry,
  logMaterials,
  splitLogMaterials,
  roundLogMaterials,
} from 'world-core/props';
import { snowTint } from './snowtint.js';
import { snowCap } from './snowcap.js';
import { matsets } from './matsets.js';

// Дрова без инвентаря: поленница у дома — это и есть «сколько у меня дров»
// (VISION.md: материя имеет вес и место, куча = счётчик). Полено берут по F,
// несут В РУКАХ (видно у камеры, идти медленнее, не побегать) и бросают
// в костёр — или приносят НОВОЕ (нарубленное в лесу) и кладут в штабель.
// Запас КОНЕЧЕН: сколько лежит — столько и есть, цифр поверх не будет.

// Полено — колотая половинка из ядра (world-core/props): кора по дуге, торец
// с кольцами, светлая плоскость раскола. Раньше это были цилиндры с канвовой
// корой по кругу, и поленница читалась как штабель труб: у настоящих дров
// половина поверхности — светлый раскол, он и делает дрова дровами.
// Материалы — наборы ядра, считаются один раз на игру.
//
// Снаружи кора несёт снежный налёт (snowTint) — та же метель, что на всём
// остальном; в руках полено «домашнее», без снега.
function outdoorLogMaterials() {
  const m = preparedLogMaterials();
  snowTint(m.bark, '0.82, 0.86, 0.96', 0.55, 0.35);
  return m;
}

function preparedLogMaterials() {
  const sets = matsets('bark', 'logend', 'split');
  return logMaterials({
    bark: material(sets.bark, { normalScale: 1.6 }),
    end: material(sets.logend, { normalScale: 1.2 }),
    split: material(sets.split, { normalScale: 1.3 }),
  });
}

/** Радиус и длина полена в штабеле и на земле. */
const LOG_R = 0.075;
const LOG_LEN = 0.62;

// Поленница: штабель колотых поленьев у стены, сверху присыпаны снегом.
// КОНЕЧНАЯ: слоты построены заранее, видимы первые `count` — взял полено,
// и штабель ПОХУДЕЛ; принёс из леса и сложил — подрос. Куча = счётчик.
export class Woodpile {
  constructor(terrain, x, z, rotY = 0, initial = 7) {
    this.group = new THREE.Group();
    const y = terrain.getHeight(x, z);
    this.group.position.set(x, y, z);
    this.group.rotation.y = rotY;
    this.position = new THREE.Vector3(x, y, z);
    this.obstacle = { x, z, r: 0.5 };

    const mats = outdoorLogMaterials();
    const geo = splitLogGeometry(LOG_R, LOG_LEN, Math.PI, 8);
    const halfMats = splitLogMaterials(mats);

    // подкладки-лежни поперёк штабеля: дрова не лежат в снегу, и место
    // поленницы видно, даже когда сожгли всё до полена
    const BEARER_R = 0.042;
    const bearerGeo = roundLogGeometry(BEARER_R, 0.72, 7);
    const bearerMats = roundLogMaterials(mats);
    for (const bx of [-0.18, 0.18]) {
      const b = new THREE.Mesh(bearerGeo, bearerMats);
      b.rotation.x = Math.PI / 2; // вдоль Z — поперёк будущих поленьев
      b.position.set(bx, 0.03, 0);
      b.castShadow = true;
      b.receiveShadow = true;
      snowCap(b, 0.02);
      this.group.add(b);
    }

    // Слоты снизу вверх, ряды 4/3/4/3/4: семь поленьев - это уже два ряда, а
    // не плот из пяти в один слой. Полено после rotation.z=π/2 лежит
    // ВДОЛЬ локальной X — значит, ряд раскладываем ПОПЕРЁК, по Z (раньше
    // слоты шли по X, и поленья входили друг в друга торцами).
    //
    // Половинки лежат кто расколом кверху, кто корой: штабель из одних
    // плоскостей раскола в первом же кадре читался плотом из досок. Высота
    // ряда честная: верх любого полена ряда — на радиус выше пола ряда, будь
    // то макушка коры или плоскость раскола, поэтому следующий ряд ложится на
    // оба одинаково, а ряд поднимается ровно на радиус. Ось полена лежит в
    // плоскости раскола: у лежащего расколом кверху она на радиус выше пола
    // ряда, у лежащего корой кверху — на самом полу ряда. Касание по линии
    // или по плоскости, тел друг в друге нет (та же укладка у стопки в
    // world-core, её считает world-check-kit). Разнобой — только сдвиг торцов
    // ВДОЛЬ оси бревна: он живой и не создаёт пересечений.
    this.slots = [];
    let n = 0;
    const ROWS = [4, 3, 4, 3, 4]; // capacity = 18 (совместимо с сейвами)
    const STEP = 2 * LOG_R + 0.012;
    const LIFT = LOG_R;
    const FLOOR0 = 0.03 + BEARER_R; // пол нижнего ряда: верх лежней
    const ROLLS = [Math.PI, 0, Math.PI, Math.PI, 0, Math.PI, 0]; // π — раскол кверху, 0 — кора
    for (let row = 0; row < ROWS.length; row++) {
      const count = ROWS[row];
      for (let i = 0; i < count; i++) {
        const m = new THREE.Mesh(geo, halfMats);
        const roll = ROLLS[n % ROLLS.length];
        // порядок ZYX: сперва поворот вокруг своей оси (Y), потом укладка вдоль X
        m.rotation.set(0, roll, Math.PI / 2, 'ZYX');
        m.position.set(
          Math.sin(n * 7.3) * 0.03, // торцы не подровнены — сложено руками
          FLOOR0 + row * LIFT + (roll === Math.PI ? LOG_R : 0),
          (i - (count - 1) / 2) * STEP
        );
        m.castShadow = true;
        m.receiveShadow = true;
        this.group.add(m);
        // шапка на каждом: какой ряд окажется верхним, решает счётчик дров
        snowCap(m, 0.024);
        this.slots.push(m);
        n++;
      }
    }
    this.count = Math.min(initial, this.slots.length);

    // превью «куда и откуда»: призрак полена в следующем свободном слоте
    // (сложить) и тёплая подсветка верхнего (взять) — рука видит цель заранее
    this.ghost = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: 0xcfe0ff,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      })
    );
    this.pick = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: 0xffd28a,
        transparent: true,
        opacity: 0.25,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    this.pick.scale.setScalar(1.12);
    this.ghost.visible = this.pick.visible = false;
    this.group.add(this.ghost, this.pick);
    this._refresh();
  }

  // показать намерение руки: 'add' — призрак в следующем слоте,
  // 'take' — подсветить полено, которое возьмётся; null — спрятать оба
  preview(mode) {
    const next = this.count < this.slots.length ? this.slots[this.count] : null;
    this.ghost.visible = mode === 'add' && !!next;
    if (this.ghost.visible) {
      this.ghost.position.copy(next.position);
      this.ghost.rotation.copy(next.rotation);
    }
    const top = this.count > 0 ? this.slots[this.count - 1] : null;
    this.pick.visible = mode === 'take' && !!top;
    if (this.pick.visible) {
      this.pick.position.copy(top.position);
      this.pick.rotation.copy(top.rotation);
    }
  }

  // мировая позиция верхнего полена — чтобы прицел руки тянулся к нему,
  // а не к абстрактному центру штабеля
  topWorld(target) {
    const top = this.slots[Math.max(0, this.count - 1)];
    return target.copy(top.position).applyMatrix4(this.group.matrixWorld);
  }

  get capacity() {
    return this.slots.length;
  }

  _refresh() {
    this.slots.forEach((m, i) => (m.visible = i < this.count));
  }

  // взять полено с верха штабеля; false — куча пуста, дрова кончились
  take() {
    if (this.count <= 0) return false;
    this.count--;
    this._refresh();
    return true;
  }

  // положить принесённое полено; false — штабель полон, класть некуда
  add() {
    if (this.count >= this.slots.length) return false;
    this.count++;
    this._refresh();
    return true;
  }
}

// Колода для колки у поленницы — толстый чурбак; в неё воткнут топор,
// пока он не в руках. Хозяйство стояло тут до игрока (VISION: «кто здесь жил?»)
export function createChoppingBlock(terrain, x, z) {
  const y = terrain.getHeight(x, z);
  const R = 0.1725; // средний из радиусов верха и низа
  const geo = new THREE.CylinderGeometry(0.16, 0.185, 0.44, 10);
  cylinderUV(geo, R, 0.44, 2.6);
  discUV(geo, R); // срез — вся карта колец на круг
  const m = new THREE.Mesh(geo, roundLogMaterials(outdoorLogMaterials()));
  m.position.set(x, y + 0.19, z);
  m.rotation.y = 0.7;
  m.castShadow = true;
  m.receiveShadow = true;
  snowCap(m, 0.025);
  return { mesh: m, x, z, topY: y + 0.41, obstacle: { x, z, r: 0.26 } };
}

// Брошенные поленья: полено можно бросить где угодно (F вне костра) — оно
// ляжет в снег и ОСТАНЕТСЯ лежать (VISION.md: мир копится, материя имеет
// место). F рядом — поднять обратно. Переживают перезагрузку (save.js).
export class GroundLogs {
  constructor(scene) {
    this.scene = scene;
    this.list = []; // {mesh, x, y, z, yaw}
    this.geo = splitLogGeometry(0.055, 0.55, Math.PI, 8);
    // лежит под снегопадом — припорашивается, как и поленница
    this.mats = splitLogMaterials(outdoorLogMaterials());
  }

  drop(x, y, z, yaw) {
    const m = new THREE.Mesh(this.geo, this.mats);
    // Половинка ложится расколом вниз, корой вверх — так она и падает; ось
    // полена лежит в плоскости раскола, то есть на самом снегу.
    // Лёгкий разнобой наклона: брошено, а не выложено
    m.rotation.set((Math.random() - 0.5) * 0.14, yaw, Math.PI / 2 + (Math.random() - 0.5) * 0.12);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    this.scene.add(m);
    this.list.push({ mesh: m, x, y, z, yaw });
  }

  take(entry) {
    const i = this.list.indexOf(entry);
    if (i < 0) return false;
    this.scene.remove(entry.mesh);
    this.list.splice(i, 1);
    return true;
  }

  serialize() {
    const r = (v) => Math.round(v * 100) / 100;
    return this.list.map((l) => [r(l.x), r(l.y), r(l.z), r(l.yaw)]);
  }

  restore(arr) {
    for (const [x, y, z, yaw] of arr) this.drop(x, y, z, yaw);
  }
}

// Полено в руках: крепится к камере, покачивается в такт ходьбе (main.js
// только показывает/прячет). Своя тройка материалов без snowTint — в руках
// полено «домашнее», не заснеженное.
export function createCarriedLog() {
  const holder = new THREE.Group();
  const log = new THREE.Mesh(
    splitLogGeometry(0.055, 0.55, Math.PI, 8),
    splitLogMaterials(preparedLogMaterials())
  );
  log.rotation.z = Math.PI / 2 - 0.18;
  log.rotation.y = 0.35;
  holder.add(log);
  holder.position.set(0.26, -0.32, -0.52); // нижний правый угол взгляда
  holder.visible = false;
  return holder;
}
