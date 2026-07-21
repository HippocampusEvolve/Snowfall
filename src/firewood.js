import * as THREE from 'three';
import { snowTint } from './snowtint.js';
import { snowCap } from './snowcap.js';

// Дрова без инвентаря: поленница у дома — это и есть «сколько у меня дров»
// (VISION.md: материя имеет вес и место, куча = счётчик). Полено берут по F,
// несут В РУКАХ (видно у камеры, идти медленнее, не побегать) и бросают
// в костёр — или приносят НОВОЕ (нарубленное в лесу) и кладут в штабель.
// Запас КОНЕЧЕН: сколько лежит — столько и есть, цифр поверх не будет.

// процедурная кора: тёмная база + продольные борозды (как у поленьев костра)
function makeBarkTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#1c110a';
  x.fillRect(0, 0, 128, 64);
  for (let i = 0; i < 80; i++) {
    const px = Math.random() * 128;
    const light = Math.random() < 0.22;
    x.strokeStyle = light
      ? `rgba(72, 50, 30, ${0.2 + Math.random() * 0.25})`
      : `rgba(7, 4, 2, ${0.3 + Math.random() * 0.35})`;
    x.lineWidth = 0.5 + Math.random() * 1.8;
    x.beginPath();
    x.moveTo(px, 0);
    x.bezierCurveTo(px + 3, 20, px - 3, 44, px + Math.random() * 4 - 2, 64);
    x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeEndTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 3, 32, 32, 32);
  g.addColorStop(0, '#8a6a42');
  g.addColorStop(0.75, '#5e422a');
  g.addColorStop(1, '#241610');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  x.strokeStyle = 'rgba(30, 16, 8, 0.5)';
  for (let r = 6; r < 30; r += 5 + Math.random() * 3) {
    x.beginPath();
    x.arc(32, 32, r, 0, Math.PI * 2);
    x.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function logMaterials() {
  const bark = makeBarkTexture();
  const side = new THREE.MeshStandardMaterial({
    map: bark,
    bumpMap: bark,
    bumpScale: 0.012,
    roughness: 0.95,
  });
  const end = new THREE.MeshStandardMaterial({ map: makeEndTexture(), roughness: 0.9 });
  return [side, end, end];
}

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

    const mats = logMaterials();
    // снег на верхних поленьях — та же метель, что на всём остальном
    snowTint(mats[0], '0.82, 0.86, 0.96', 0.55, 0.35);
    const geo = new THREE.CylinderGeometry(0.062, 0.066, 0.62, 8);

    // подкладки-лежни поперёк штабеля: дрова не лежат в снегу, и место
    // поленницы видно, даже когда сожгли всё до полена
    const bearerGeo = new THREE.CylinderGeometry(0.042, 0.042, 0.72, 7);
    for (const bx of [-0.18, 0.18]) {
      const b = new THREE.Mesh(bearerGeo, mats);
      b.rotation.x = Math.PI / 2; // вдоль Z — поперёк будущих поленьев
      b.position.set(bx, 0.03, 0);
      b.castShadow = true;
      b.receiveShadow = true;
      snowCap(b, 0.02);
      this.group.add(b);
    }

    // Слоты снизу вверх «в замок», ряды 5/4/5/4. Полено после rotation.z=π/2
    // лежит ВДОЛЬ локальной X — значит, ряд раскладываем ПОПЕРЁК, по Z
    // (раньше слоты шли по X, и поленья входили друг в друга торцами).
    // Соседние поленья строго через одно перевёрнуты комлем — как кладут
    // вручную; тогда сумма радиусов боковых соседей постоянна (0.128).
    // Просветы из худшего случая (комель к комлю, 0.132): STEP с боковым
    // зазором, LIFT = sqrt(0.132² − (STEP/2)²) + зазор. Разнобой — только
    // сдвиг торцов ВДОЛЬ оси бревна: он живой и не создаёт пересечений.
    this.slots = [];
    let n = 0;
    const ROWS = [5, 4, 5, 4]; // capacity = 18 (совместимо с сейвами)
    const STEP = 0.132;
    const LIFT = 0.116;
    const BASE = 0.138; // лежень (центр 0.03, r 0.042) + радиус комля 0.066
    for (let row = 0; row < ROWS.length; row++) {
      const count = ROWS[row];
      for (let i = 0; i < count; i++) {
        const m = new THREE.Mesh(geo, mats);
        m.rotation.z = Math.PI / 2;
        m.rotation.y = n % 2 ? Math.PI : 0; // переворот комля через одно
        m.position.set(
          Math.sin(n * 7.3) * 0.03, // торцы не подровнены — сложено руками
          BASE + row * LIFT,
          (i - (count - 1) / 2) * STEP
        );
        m.castShadow = true;
        m.receiveShadow = true;
        this.group.add(m);
        // верхние ряды открыты небу — несут снежную шапку по верхней дуге
        if (row > 0) snowCap(m, 0.024);
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
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.185, 0.44, 10), logMaterials());
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
    this.geo = new THREE.CylinderGeometry(0.055, 0.062, 0.55, 8);
    this.mats = logMaterials();
    // лежит под снегопадом — припорашивается, как и поленница
    snowTint(this.mats[0], '0.82, 0.86, 0.96', 0.5, 0.4);
  }

  drop(x, y, z, yaw) {
    const m = new THREE.Mesh(this.geo, this.mats);
    // лёгкий разнобой наклона: брошено, а не выложено
    m.rotation.set((Math.random() - 0.5) * 0.14, yaw, Math.PI / 2 + (Math.random() - 0.5) * 0.12);
    m.position.set(x, y + 0.055, z);
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
// только показывает/прячет). Своя пара материалов без snowTint — в руках
// полено «домашнее», не заснеженное.
export function createCarriedLog() {
  const holder = new THREE.Group();
  const log = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.062, 0.55, 8),
    logMaterials()
  );
  log.rotation.z = Math.PI / 2 - 0.18;
  log.rotation.y = 0.35;
  holder.add(log);
  holder.position.set(0.26, -0.32, -0.52); // нижний правый угол взгляда
  holder.visible = false;
  return holder;
}
