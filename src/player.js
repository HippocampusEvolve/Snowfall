import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

const EYE = 1.7;
const WALK_SPEED = 3.0;
const RUN_SPEED = 5.9;
const BOUNDS = 72;

// Игрок от первого лица: WASD + Shift-бег, head bob, шаги по дистанции.
export class Player {
  constructor(camera, domElement, terrain, onStep, obstacles = []) {
    this.camera = camera;
    this.terrain = terrain;
    this.onStep = onStep;
    this.obstacles = obstacles;
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

    camera.position.set(0, terrain.getHeight(0, 0) + EYE, 0);

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

    const groundH = this.terrain.getHeight(cam.position.x, cam.position.z);
    cam.position.y = groundH + EYE + bobY;
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
