import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

const EYE = 1.7;
const WALK_SPEED = 3.0;
const RUN_SPEED = 5.9;
const BOUNDS = 72;

const GRAV = 24; // гравитация, м/с²
const STEP_UP = 0.55; // высота шага вверх (ступеньки/склон)
const STEP_DOWN = 0.45; // прилипание к полу при спуске (иначе прыжки на бугорках)
const FALL_PROBE = 4.0; // как глубоко ищем пол под ногами (дно ямы)

// Игрок от первого лица: WASD + Shift-бег, head bob, шаги по дистанции.
// Вертикаль — не привязка к heightmap, а гравитация + опора на воксельный SDF:
// можно провалиться в вырытую яму и зайти в пещеру (через Digger.surfaceBelow).
export class Player {
  constructor(camera, domElement, terrain, onStep, obstacles = [], digger = null) {
    this.camera = camera;
    this.terrain = terrain;
    this.onStep = onStep;
    this.obstacles = obstacles;
    this.digger = digger;
    this.controls = new PointerLockControls(camera, domElement);

    this.keys = new Set();
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

    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._wish = new THREE.Vector3();
    this._dir = new THREE.Vector3(0, 0, -1);

    // debug-режим (?debug): без pointer lock, поворот стрелками
    this.debug = new URLSearchParams(location.search).has('debug');

    // вертикальное состояние: Y ступней, скорость падения, на земле ли
    this.footY = terrain.getHeight(0, 0);
    this.vy = 0;
    this.grounded = true;
    camera.position.set(0, this.footY + EYE, 0);

    addEventListener('keydown', (e) => this.keys.add(e.code));
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  get locked() {
    return this.controls.isLocked || this.debug;
  }

  update(dt) {
    const cam = this.camera;

    if (this.debug) {
      const yaw = ((this.keys.has('ArrowLeft') ? 1 : 0) - (this.keys.has('ArrowRight') ? 1 : 0)) * 2.2 * dt;
      if (yaw) cam.rotateOnWorldAxis(new THREE.Vector3(0, 1, 0), yaw);
    }

    // направление взгляда в плоскости XZ
    this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    this._fwd.y = 0;
    if (this._fwd.lengthSq() < 1e-6) this._fwd.set(0, 0, -1);
    this._fwd.normalize();
    this._right.crossVectors(this._fwd, cam.up).normalize();

    const f = (this.keys.has('KeyW') ? 1 : 0) - (this.keys.has('KeyS') ? 1 : 0);
    const r = (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0);
    const wantRun = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
    const running = wantRun && f > 0 && !this.exhausted && this.stamina > 0.02;

    this._wish.set(0, 0, 0);
    if (this.locked && (f || r)) {
      this._wish
        .addScaledVector(this._fwd, f)
        .addScaledVector(this._right, r)
        .normalize()
        .multiplyScalar(running ? RUN_SPEED : WALK_SPEED);
    }

    // инерция (снег вязкий — разгон и торможение плавные)
    const damp = 1 - Math.exp(-7.5 * dt);
    this.vel.lerp(this._wish, damp);

    cam.position.x = THREE.MathUtils.clamp(cam.position.x + this.vel.x * dt, -BOUNDS, BOUNDS);
    cam.position.z = THREE.MathUtils.clamp(cam.position.z + this.vel.z * dt, -BOUNDS, BOUNDS);

    // коллизии со стволами елей — выталкивание из окружности
    for (const o of this.obstacles) {
      const dx = cam.position.x - o.x;
      const dz = cam.position.z - o.z;
      const R = o.r + 0.35;
      const d2 = dx * dx + dz * dz;
      if (d2 < R * R && d2 > 1e-8) {
        const d = Math.sqrt(d2);
        const push = (R - d) / d;
        cam.position.x += dx * push;
        cam.position.z += dz * push;
      }
    }

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
    const dig = this.digger;

    // выталкивание корпуса из стен: сэмплим плотность на нескольких высотах над
    // ступнёй; если внутри грунта — ньютоновский шаг наружу по горизонт. градиенту
    if (dig && dig.edits.size > 0) {
      const e = 0.15;
      for (let s = 0; s < 3; s++) {
        const by = this.footY + 0.5 + s * 0.6; // грудь/плечи/голова: 0.5, 1.1, 1.7
        for (let it = 0; it < 2; it++) {
          const f = dig.densityAt(cam.position.x, by, cam.position.z);
          if (f <= 0) break; // снаружи грунта — стены нет
          const dfx =
            (dig.densityAt(cam.position.x + e, by, cam.position.z) -
              dig.densityAt(cam.position.x - e, by, cam.position.z)) / (2 * e);
          const dfz =
            (dig.densityAt(cam.position.x, by, cam.position.z + e) -
              dig.densityAt(cam.position.x, by, cam.position.z - e)) / (2 * e);
          const g2 = dfx * dfx + dfz * dfz;
          if (g2 < 1e-6) break;
          let d = f / g2; // ньютон: |смещение| = f/|∇f|
          const len = Math.abs(d) * Math.sqrt(g2);
          if (len > 0.4) d *= 0.4 / len; // ограничиваем скачок за кадр
          cam.position.x = THREE.MathUtils.clamp(cam.position.x - dfx * d, -BOUNDS, BOUNDS);
          cam.position.z = THREE.MathUtils.clamp(cam.position.z - dfz * d, -BOUNDS, BOUNDS);
        }
      }
    }

    // опора под ногами: ближайший грунт в окне [footY-FALL_PROBE, footY+STEP_UP]
    const ground = dig
      ? dig.surfaceBelow(cam.position.x, cam.position.z, this.footY + STEP_UP, this.footY - FALL_PROBE)
      : this.terrain.getHeight(cam.position.x, cam.position.z);

    const wasGrounded = this.grounded;
    this.vy -= GRAV * dt;
    let nextY = this.footY + this.vy * dt;
    this.grounded = false;
    if (ground !== null) {
      if (nextY <= ground + 0.02) {
        nextY = ground; this.vy = 0; this.grounded = true; // приземлились / стоим
      } else if (wasGrounded && ground >= nextY - STEP_DOWN) {
        nextY = ground; this.vy = 0; this.grounded = true; // прилипаем при спуске
      }
    }
    this.footY = nextY;

    cam.position.y = this.footY + EYE + bobY;
    // лёгкое покачивание вбок
    cam.position.addScaledVector(this._right, bobX * 0.4);

    // FOV-раскачка при беге
    const targetFov = running && moving ? 81 : 75;
    if (Math.abs(cam.fov - targetFov) > 0.05) {
      cam.fov += (targetFov - cam.fov) * Math.min(1, 5 * dt);
      cam.updateProjectionMatrix();
    }

    // шаги по пройденной дистанции
    if (moving) {
      this.stride += speed * dt;
      const strideLen = running ? 1.5 : 0.92;
      if (this.stride >= strideLen) {
        this.stride = 0;
        this.side *= -1;
        this._dir.copy(this.vel).normalize();
        const fx =
          cam.position.x + this._dir.x * 0.3 + this._right.x * this.side * 0.17;
        const fz =
          cam.position.z + this._dir.z * 0.3 + this._right.z * this.side * 0.17;
        this.onStep(fx, fz, this._dir, this.side, running);
      }
    } else {
      this.stride = Math.min(this.stride, 0.4);
    }
  }
}
