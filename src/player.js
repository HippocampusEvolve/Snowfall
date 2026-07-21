import * as THREE from 'three';
import { resolveColliders } from './collide.js';

const EYE = 1.7;
const HEIGHT = 1.7; // высота капсулы тела — для вертикального диапазона коллайдеров
const RADIUS = 0.35; // радиус капсулы тела
// Темп вдвое ниже спринтерского прежнего: шаг по целине — неспешный (~1.5 м/с,
// человеческий прогулочный), бег — трусца. Мир маленький, спешить некуда.
const WALK_SPEED = 1.5;
const RUN_SPEED = 3.0;
const BOUNDS = 72;

const GRAV = 24; // гравитация, м/с²
const JUMP_SPEED = 6.3; // начальная скорость прыжка (≈0.8 м над землёй)
const STEP_UP = 0.55; // высота шага вверх (ступеньки/склон)
const STEP_DOWN = 0.45; // прилипание к полу при спуске (иначе прыжки на бугорках)
const FALL_PROBE = 4.0; // как глубоко ищем пол под ногами (дно ямы)
const COYOTE = 0.12; // грация после схода с опоры: прыжок ещё возможен, сек
// зазор глаза от стен в пещере: держим корпус на этом расстоянии (м) от грунта,
// чтобы near-плоскость камеры (0.1) не обрезала стену и не было видно сквозь неё
const WALL_MARGIN = 0.22;
const VIEW_SMOOTH = 14; // скорость догона вида за ступенькой (1/с): halflife ≈ 50 мс
// ЗАЩИТА ВИДА (анти-просвет за стену). Тело держим WALL_MARGIN от стены по
// ГОРИЗОНТАЛИ на трёх высотах, но near-плоскость камеры — не точка, а прямоугольник
// ~0.2 м перед глазом: её угол, качка головы и ВЕРХНЯЯ кромка стены/потолок
// выступают за грунт → «чуть-чуть видно за стеной». Поэтому саму КАМЕРУ трактуем
// как сферу (радиус = дальний угол near-плоскости) и толкаем из грунта по ПОЛНОМУ
// 3D-градиенту SDF. Плюс у стены сужаем near — сфера меньше, к забою подходим
// вплотную без просвета.
const NEAR_FAR = 0.1;     // near вдали от стен (как раньше)
const NEAR_HUG = 0.05;    // near вплотную к стене — узкая near-плоскость почти не выступает
const NEAR_ENGAGE = 0.75; // с какого расстояния до поверхности (м) начинаем сужать near
const VIEW_CLEAR_EPS = 0.02; // запас к радиусу защитной сферы, м
// подошва: точки сэмплирования деревянного пола (центр + крест). Один луч в
// точку «проваливался» в щель между досками или цеплялся за нижнюю балку
// каркаса — опора мигала, STEP_DOWN защёлкивал ноги вниз-вверх (йо-йо камеры)
const FOOT_SAMPLES = [
  [0, 0],
  [0.18, 0],
  [-0.18, 0],
  [0, 0.18],
  [0, -0.18],
];

// Игрок от первого лица: WASD + Shift-бег, head bob, шаги по дистанции.
// ТЕЛО и КАМЕРА разделены: физика двигает this.pos (ступни), камера каждый
// кадр выводится из pos (глаз + bob + сглаживание ступенек). Раньше физика
// гоняла camera.position напрямую, и боковой bob интегрировался в позицию —
// вид «плавал», а визуальные сдвиги протекали в коллизии.
// Вертикаль — не привязка к heightmap, а гравитация + опора на воксельный SDF:
// можно провалиться в вырытую яму и зайти в пещеру (через Digger.surfaceBelow).
export class Player {
  // look — SmoothLook (look.js): владеет ориентацией камеры, сглаживанием и
  // кренами; здесь остаётся только API lock()/isLocked (бывший PointerLockControls)
  constructor(camera, look, terrain, onStep, obstacles = [], digger = null, getFloor = null, onLand = null) {
    this.camera = camera;
    this.terrain = terrain;
    this.onStep = onStep;
    this.obstacles = obstacles;
    this.digger = digger;
    this.getFloor = getFloor; // (x,z) -> Y деревянного пола (домик/крыльцо) или null
    this.onLand = onLand; // (x,z,surface,impact) — приземление после прыжка/падения
    this.surface = 'snow'; // на чём стоим: 'snow' | 'wood' (липкое — в воздухе не мигает)
    this.controls = look;

    this.keys = new Set();
    // тач-оси (touch.js): f/r — аналоговые −1..1, подмешиваются к клавишам;
    // active включает locked без pointer lock (на таче его нет)
    this.touch = { f: 0, r: 0, run: false, jump: false, active: false };
    this.vel = new THREE.Vector3();
    this.bobT = 0;
    this.bobAmt = 0;
    this.stride = 0;
    this.side = 1;

    // выживание: выносливость и «запыхавшесть»
    this.stamina = 1;
    this.exhausted = false;
    this.exertion = 0;
    this.running = false;
    this.moving = false;
    this.carrying = false; // полено в руках: медленнее, бег недоступен

    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._wish = new THREE.Vector3();
    this._dir = new THREE.Vector3(0, 0, -1);

    // debug-режим (?debug): без pointer lock, поворот стрелками
    this.debug = new URLSearchParams(location.search).has('debug');

    // тело: pos — мировая позиция СТУПНЕЙ (pos.y — бывший footY)
    this.pos = new THREE.Vector3(0, terrain.getHeight(0, 0), 0);
    this.vy = 0;
    this.grounded = true;
    this.airT = 0; // сколько секунд без опоры (coyote-прыжок, устойчивость состояний)
    this._jumpHeld = false; // фронт нажатия пробела (один прыжок на нажатие)
    this.viewOffsetY = 0; // затухающий сдвиг вида для сглаживания ступенек (step smoothing)
    camera.position.set(this.pos.x, this.pos.y + EYE, this.pos.z);

    addEventListener('keydown', (e) => {
      if (e.code === 'Space') e.preventDefault(); // пробел не скроллит страницу
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  get locked() {
    return this.controls.isLocked || this.debug || this.touch.active;
  }

  // опора из деревянного пола: raycast в нескольких точках подошвы, берём
  // ВЫСШУЮ досягаемую шагом. Щель между досками или балка под одной точкой
  // не роняют опору; перила/столешница над головой отсекаются per-sample.
  sampleFloor(x, z) {
    let best = null;
    for (const [dx, dz] of FOOT_SAMPLES) {
      const h = this.getFloor(x + dx, z + dz);
      if (h === null || h > this.pos.y + STEP_UP) continue; // недосягаемо шагом — не опора
      if (best === null || h > best) best = h;
    }
    return best;
  }

  // Анти-просвет за стену. near-плоскость камеры — прямоугольник ~0.2 м перед
  // глазом; тело держит лишь ГОРИЗОНТАЛЬНЫЙ зазор, а near-угол, качка и верхние/
  // потолочные кромки выступают за грунт. Камеру трактуем как сферу радиуса R
  // (дальний угол near-плоскости) и держим в воздухе (density<0) по 3D-градиенту
  // SDF; у стены дополнительно сужаем near, чтобы сфера была меньше и к забою
  // можно было подойти вплотную без просвета. Работает поверх физики (камера
  // отделена от тела) — на движение не влияет.
  _shieldView(cam, dt) {
    const dig = this.digger;
    if (!dig || dig.edits.size === 0) { // мир = heightmap → near как обычно
      if (cam.near !== NEAR_FAR) { cam.near = NEAR_FAR; cam.updateProjectionMatrix(); }
      return;
    }
    const e = 0.12;
    let cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;

    // плотность и 3D-градиент SDF в точке глаза (в воздухе density<0, в грунте ≥0)
    let f = dig.densityAt(cx, cy, cz);
    let dfx = (dig.densityAt(cx + e, cy, cz) - dig.densityAt(cx - e, cy, cz)) / (2 * e);
    let dfy = (dig.densityAt(cx, cy + e, cz) - dig.densityAt(cx, cy - e, cz)) / (2 * e);
    let dfz = (dig.densityAt(cx, cy, cz + e) - dig.densityAt(cx, cy, cz - e)) / (2 * e);
    let g2 = dfx * dfx + dfy * dfy + dfz * dfz;
    let gm = Math.sqrt(Math.max(g2, 1e-6));

    // приближённое расстояние глаза до ближайшей поверхности (м); у стены жмём
    // near → near-плоскость (и сфера R) меньше, к забою подходим вплотную
    const distOut = Math.max(0, -f) / gm;
    const k = THREE.MathUtils.clamp(distOut / NEAR_ENGAGE, 0, 1);
    const targetNear = NEAR_HUG + (NEAR_FAR - NEAR_HUG) * k;
    const newNear = targetNear + (cam.near - targetNear) * Math.exp(-18 * dt);
    if (Math.abs(cam.near - newNear) > 1e-4) { cam.near = newNear; cam.updateProjectionMatrix(); }

    // радиус защитной сферы = дальний угол near-плоскости от глаза + запас
    const halfH = cam.near * Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
    const halfW = halfH * cam.aspect;
    const R = Math.hypot(cam.near, halfH, halfW) + VIEW_CLEAR_EPS;

    // толкаем камеру из грунта: цель f ≤ −R·|∇| (глаз на R метров в воздухе)
    for (let it = 0; it < 2; it++) {
      if (it > 0) { // пересэмплим в новой точке — точнее второй ньютоновский шаг
        f = dig.densityAt(cx, cy, cz);
        dfx = (dig.densityAt(cx + e, cy, cz) - dig.densityAt(cx - e, cy, cz)) / (2 * e);
        dfy = (dig.densityAt(cx, cy + e, cz) - dig.densityAt(cx, cy - e, cz)) / (2 * e);
        dfz = (dig.densityAt(cx, cy, cz + e) - dig.densityAt(cx, cy, cz - e)) / (2 * e);
        g2 = dfx * dfx + dfy * dfy + dfz * dfz;
        gm = Math.sqrt(Math.max(g2, 1e-6));
      }
      if (g2 < 1e-6) break; // почти нет градиента — толкать некуда
      const target = -R * gm;
      if (f <= target) break; // уже достаточно в воздухе
      let d = (f - target) / g2;
      const len = d * gm;
      if (len > 0.5) d *= 0.5 / len; // клэмп скачка за кадр
      cx -= dfx * d; cy -= dfy * d; cz -= dfz * d;
    }
    cam.position.set(cx, cy, cz);
  }

  update(dt) {
    const cam = this.camera;
    const pos = this.pos;

    if (this.debug) {
      const yaw = ((this.keys.has('ArrowLeft') ? 1 : 0) - (this.keys.has('ArrowRight') ? 1 : 0)) * 2.2 * dt;
      if (yaw) this.controls.rotateBy(yaw); // через цель взгляда — сглаживание общее с мышью
    }

    // направление взгляда в плоскости XZ
    this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    this._fwd.y = 0;
    if (this._fwd.lengthSq() < 1e-6) this._fwd.set(0, 0, -1);
    this._fwd.normalize();
    this._right.crossVectors(this._fwd, cam.up).normalize();

    const f = THREE.MathUtils.clamp(
      (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0) + this.touch.f, -1, 1);
    const r = THREE.MathUtils.clamp(
      (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0) + this.touch.r, -1, 1);
    const wantRun = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.touch.run;
    const running =
      wantRun && f > 0 && !this.exhausted && this.stamina > 0.02 && !this.carrying;

    this._wish.set(0, 0, 0);
    if (this.locked && (f || r)) {
      // аналоговая длина сохраняется (тач: лёгкий увод пальца = медленный шаг),
      // клавиши дают длину ≥1 и нормализуются как раньше
      this._wish.addScaledVector(this._fwd, f).addScaledVector(this._right, r);
      const wl = this._wish.length();
      this._wish.multiplyScalar(
        (Math.min(1, wl) / wl) * (running ? RUN_SPEED : WALK_SPEED) * (this.carrying ? 0.8 : 1)
      );
    }

    // инерция (снег вязкий — разгон и торможение плавные)
    const damp = 1 - Math.exp(-7.5 * dt);
    this.vel.lerp(this._wish, damp);

    pos.x = THREE.MathUtils.clamp(pos.x + this.vel.x * dt, -BOUNDS, BOUNDS);
    pos.z = THREE.MathUtils.clamp(pos.z + this.vel.z * dt, -BOUNDS, BOUNDS);

    // выталкивание корпуса из стен пещер: сэмплим плотность на нескольких
    // высотах над ступнёй; внутри грунта — ньютоновский шаг наружу по градиенту
    const dig = this.digger;
    if (dig && dig.edits.size > 0) {
      const e = 0.15;
      // сэмплим ТОЛЬКО выше STEP_UP: то, на что можно зашагнуть (уступ, кромка ямы),
      // не считается стеной и не отпихивает — иначе не выбраться из ямы/не залезть
      for (let s = 0; s < 3; s++) {
        const by = pos.y + 0.9 + s * 0.4; // грудь/плечи/голова: 0.9, 1.3, 1.7
        for (let it = 0; it < 2; it++) {
          const f = dig.densityAt(pos.x, by, pos.z);
          const dfx =
            (dig.densityAt(pos.x + e, by, pos.z) -
              dig.densityAt(pos.x - e, by, pos.z)) / (2 * e);
          const dfz =
            (dig.densityAt(pos.x, by, pos.z + e) -
              dig.densityAt(pos.x, by, pos.z - e)) / (2 * e);
          const g2 = dfx * dfx + dfz * dfz;
          if (g2 < 1e-6) break; // почти горизонтальный градиент (потолок/пол) — не стена
          // целевая изоповерхность −MARGIN·|∇f|: глаз стоит на WALL_MARGIN м снаружи
          const target = -WALL_MARGIN * Math.sqrt(g2);
          if (f <= target) break; // уже дальше запаса от стены
          let d = (f - target) / g2; // ньютон к целевой изоповерхности
          const len = d * Math.sqrt(g2);
          if (len > 0.4) d *= 0.4 / len; // ограничиваем скачок за кадр
          pos.x = THREE.MathUtils.clamp(pos.x - dfx * d, -BOUNDS, BOUNDS);
          pos.z = THREE.MathUtils.clamp(pos.z - dfz * d, -BOUNDS, BOUNDS);
        }
      }
    }

    // коллизии со структурами (стволы, стены, кромки, мебель, дверь):
    // итеративный решатель — в углах и узких проходах не осциллирует
    resolveColliders(pos, HEIGHT, RADIUS, this.obstacles);

    const speed = Math.hypot(this.vel.x, this.vel.z);
    const moving = speed > 0.35;
    this.moving = moving;
    this.running = running && moving;

    // выносливость: бег тратит, отдых восстанавливает
    if (this.running) this.stamina = Math.max(0, this.stamina - dt / 11);
    else this.stamina = Math.min(1, this.stamina + dt / (moving ? 20 : 9));
    if (this.stamina <= 0) this.exhausted = true;
    else if (this.exhausted && this.stamina > 0.3) this.exhausted = false;

    // «запыхавшесть» — растёт на бегу, спадает медленно (частота дыхания)
    if (this.running) this.exertion = Math.min(1, this.exertion + dt / 8);
    else this.exertion = Math.max(0, this.exertion - dt / 20);

    // head bob
    const targetBob = moving ? (running ? 0.075 : 0.045) : 0;
    this.bobAmt += (targetBob - this.bobAmt) * Math.min(1, 6 * dt);
    if (moving) this.bobT += dt * speed * 1.95;
    const bobY = Math.sin(this.bobT * 2.0) * this.bobAmt;
    const bobX = Math.cos(this.bobT) * this.bobAmt * 0.55;

    // --- вертикаль: гравитация + опора на воксельный SDF (ямы, пещеры) ---
    // опора под ногами: ближайший грунт в окне [pos.y-FALL_PROBE, pos.y+STEP_UP]
    let ground = dig
      ? dig.surfaceBelow(pos.x, pos.z, pos.y + STEP_UP, pos.y - FALL_PROBE)
      : this.terrain.getHeight(pos.x, pos.z);

    // деревянный пол домика/крыльца перекрывает грунт, если он выше
    let onWood = false;
    if (this.getFloor) {
      const fl = this.sampleFloor(pos.x, pos.z);
      if (fl !== null && (ground === null || fl >= ground)) {
        ground = fl;
        onWood = true;
      }
    }

    // прыжок: пробел, с опоры или в пределах coyote-грации (истощённый — нет)
    const wasAirborne = !this.grounded;
    const wantJump = this.keys.has('Space') || this.touch.jump;
    const canJump = this.grounded || (this.airT < COYOTE && this.vy <= 0);
    if (wantJump && !this._jumpHeld && canJump && this.locked && !this.exhausted) {
      // с поленом в руках толчок слабее (высота ~вдвое ниже) и дороже — прыжок
      // тяжёлый, а не бодрый: обе руки заняты
      this.vy = JUMP_SPEED * (this.carrying ? 0.7 : 1);
      this.grounded = false;
      this.airT = COYOTE; // прыжок съедает грацию — двойного прыжка нет
      this.stamina = Math.max(0, this.stamina - (this.carrying ? 0.1 : 0.06));
    }
    this._jumpHeld = wantJump;

    const wasGrounded = this.grounded;
    const prevFootY = pos.y; // для step smoothing: скачок опоры за кадр
    this.vy -= GRAV * dt;
    const impactVy = this.vy; // вертикальная скорость к моменту касания
    let nextY = pos.y + this.vy * dt;
    this.grounded = false;
    if (ground !== null) {
      if (nextY <= ground + 0.02) {
        nextY = ground; this.vy = 0; this.grounded = true; // приземлились / стоим
      } else if (wasGrounded && this.vy <= 0 && ground >= nextY - STEP_DOWN) {
        nextY = ground; this.vy = 0; this.grounded = true; // прилипаем при спуске
      }
    }
    pos.y = nextY;
    this.airT = this.grounded ? 0 : this.airT + dt;
    // на чём стоим — обновляем только с опоры: в полёте звук шагов/приземления
    // не мигает между 'wood' и 'snow'
    if (this.grounded) this.surface = onWood ? 'wood' : 'snow';

    // step smoothing: пока стоим на опоре, резкий скачок pos.y (порог, уступ, кромка
    // ямы, прилипание к склону) — это не свободное движение, а защёлкивание. Прячем
    // дельту в сдвиг вида и плавно догоняем — камера едет ровно, а не телепортом.
    // В воздухе (прыжок/падение) не трогаем: взлёт и приземление должны быть чёткими.
    if (this.grounded && wasGrounded) {
      this.viewOffsetY = THREE.MathUtils.clamp(
        this.viewOffsetY + (pos.y - prevFootY), -STEP_UP, STEP_UP
      );
    }
    this.viewOffsetY *= Math.exp(-VIEW_SMOOTH * dt); // экспоненциальное затухание к 0

    // приземление после прыжка/падения — глухой удар (и след на снегу)
    if (wasAirborne && this.grounded && impactVy < -3.2 && this.onLand) {
      this.onLand(pos.x, pos.z, this.surface, impactVy);
    }

    // камера — производная от тела: глаз + bob + сглаживание ступенек.
    // Bob больше НЕ копится в физической позиции (раньше боковая качка
    // каждый кадр добавлялась в camera.position и утекала в коллизии).
    cam.position.set(
      pos.x + this._right.x * bobX * 0.4,
      pos.y + EYE + bobY - this.viewOffsetY,
      pos.z + this._right.z * bobX * 0.4
    );

    // FOV-раскачка при беге
    const targetFov = running && moving ? 81 : 75;
    if (Math.abs(cam.fov - targetFov) > 0.05) {
      cam.fov += (targetFov - cam.fov) * Math.min(1, 5 * dt);
      cam.updateProjectionMatrix();
    }

    // анти-просвет: не даём near-плоскости камеры залезть за грунт (см. _shieldView)
    this._shieldView(cam, dt);

    // шаги по пройденной дистанции
    if (moving) {
      this.stride += speed * dt;
      const strideLen = running ? 1.5 : 0.92;
      if (this.stride >= strideLen) {
        this.stride = 0;
        this.side *= -1;
        this._dir.copy(this.vel).normalize();
        const fx = pos.x + this._dir.x * 0.3 + this._right.x * this.side * 0.17;
        const fz = pos.z + this._dir.z * 0.3 + this._right.z * this.side * 0.17;
        this.onStep(fx, fz, this._dir, this.side, running, this.surface);
      }
    } else {
      this.stride = Math.min(this.stride, 0.4);
    }
  }
}
