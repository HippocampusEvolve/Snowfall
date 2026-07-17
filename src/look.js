import * as THREE from 'three';

// Взгляд от первого лица с ТЕЛОМ — замена PointerLockControls (API совместим:
// lock()/unlock(), isLocked, события 'lock'/'unlock').
//
// Мышь двигает ЦЕЛЬ (tYaw/tPitch), камера догоняет её экспоненциальной
// пружиной — взгляд «тяжёлый», с мягким доездом после остановки руки
// (референс — RDR2 от первого лица, Kingdom Come; в соревновательных шутерах
// такое сглаживание ненавидят, в созерцательной игре это и есть характер).
// Поверх — аддитивные слои веса, все в долях градуса:
//   * крен в вираж по угловой скорости взгляда (Dishonored/Thief);
//   * крен на стрейфе — классика Quake cl_rollangle;
//   * клевок тангажа при приземлении (пружина, ζ=1 — без отскока);
//   * микронаклон при разгоне/торможении тела (Cyberpunk);
//   * дыхание в покое — в том же ритме, что руки (viewmodel) и звук.
// Ротация камеры собирается заново КАЖДЫЙ кадр из yaw/pitch/roll (YXZ):
// эффекты не копятся в кватернионе и не утекают в прицел — проблема, из-за
// которой отдачу лопаты снимали сразу после рендера, здесь исключена.
// ?rawlook — сырой 1:1 взгляд без сглаживания и эффектов (если укачивает).

const SENS = 0.002; // рад/пиксель — как у PointerLockControls
const PI_2 = Math.PI / 2;
const clamp = THREE.MathUtils.clamp;

export class SmoothLook extends THREE.EventDispatcher {
  constructor(camera, domElement) {
    super();
    this.camera = camera;
    this.domElement = domElement;
    this.isLocked = false;

    // все ручки крутятся на живую: __snow.look.cfg.smooth = 24 и т.п.
    this.cfg = {
      raw: new URLSearchParams(location.search).has('rawlook'),
      smooth: 14, // 1/с — жёсткость догона взгляда (полудогон ~50 мс)
      turnRoll: 0.005, // рад крена на 1 рад/с поворота взгляда
      turnRollMax: 0.021, // потолок крена в вираж, ~1.2°
      strafeRoll: 0.023, // крен на полном боковом шаге, ~1.3°
      rollRate: 8, // 1/с — пружина входа/выхода крена
      accelPitch: 0.0011, // рад наклона на 1 м/с² продольного разгона
      accelPitchMax: 0.008, // потолок наклона, ~0.45°
      breath: 1, // множитель дыхания камеры (0 — выключить)
    };

    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    this.yaw = this.tYaw = e.y;
    this.pitch = this.tPitch = e.x;

    this._roll = 0;
    this._kick = 0; // клевок приземления (рад) и его скорость
    this._kickV = 0;
    this._accSm = 0; // сглаженное продольное ускорение тела
    this._prevFwd = 0;
    this._breathT = 0;
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');

    const doc = domElement.ownerDocument;
    doc.addEventListener('mousemove', (ev) => {
      if (!this.isLocked) return;
      this.tYaw -= (ev.movementX || 0) * SENS;
      this.tPitch = clamp(this.tPitch - (ev.movementY || 0) * SENS, -PI_2, PI_2);
    });
    doc.addEventListener('pointerlockchange', () => {
      const locked = doc.pointerLockElement === domElement;
      if (locked === this.isLocked) return;
      this.isLocked = locked;
      this.dispatchEvent({ type: locked ? 'lock' : 'unlock' });
    });
  }

  lock() {
    this.domElement.requestPointerLock();
  }

  unlock() {
    this.domElement.ownerDocument.exitPointerLock();
  }

  // поворот целью (debug-стрелки): сглаживание и крены — как у мыши
  rotateBy(dYaw, dPitch = 0) {
    this.tYaw += dYaw;
    this.tPitch = clamp(this.tPitch + dPitch, -PI_2, PI_2);
  }

  // приземление: клевок взгляда вниз, сила — по скорости касания
  land(impact) {
    if (this.cfg.raw) return;
    this._kickV -= clamp(Math.abs(impact) * 0.12, 0.15, 0.9);
  }

  // звать РАНЬШЕ физики игрока: движение должно идти по свежему взгляду
  update(dt, player) {
    const c = this.cfg;
    const prevYaw = this.yaw;

    if (c.raw) {
      this.yaw = this.tYaw;
      this.pitch = this.tPitch;
      this._euler.set(this.pitch, this.yaw, 0, 'YXZ');
      this.camera.quaternion.setFromEuler(this._euler);
      return;
    }

    // догон цели: экспоненциальная пружина — доезд без перерегулирования
    const k = 1 - Math.exp(-c.smooth * dt);
    this.yaw += (this.tYaw - this.yaw) * k;
    this.pitch += (this.tPitch - this.pitch) * k;

    // скорость тела в осях взгляда (горизонталь): right=(cosY,0,-sinY), fwd=(-sinY,0,-cosY)
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    const lat = player.vel.x * cosY - player.vel.z * sinY; // вправо +
    const fwd = -player.vel.x * sinY - player.vel.z * cosY; // вперёд +

    // крен: в вираж (по угловой скорости уже сглаженного взгляда) + в сторону стрейфа
    const vYaw = dt > 1e-4 ? (this.yaw - prevYaw) / dt : 0;
    const rollT =
      clamp(vYaw * c.turnRoll, -c.turnRollMax, c.turnRollMax) -
      c.strafeRoll * clamp(lat / 1.5, -1, 1);
    this._roll += (rollT - this._roll) * (1 - Math.exp(-c.rollRate * dt));

    // клевок приземления: критически задемпфированная пружина
    const w = 14;
    this._kickV += (-w * w * this._kick - 2 * w * this._kickV) * dt;
    this._kick += this._kickV * dt;

    // микронаклон при разгоне/торможении
    const acc = dt > 1e-4 ? (fwd - this._prevFwd) / dt : 0;
    this._prevFwd = fwd;
    this._accSm += (acc - this._accSm) * (1 - Math.exp(-10 * dt));
    const accP = clamp(-this._accSm * c.accelPitch, -c.accelPitchMax, c.accelPitchMax);

    // дыхание в покое: ритм общий с руками и звуком (0.22 + 0.35·exertion Гц);
    // на ходу тонет в качке шага
    const idle = 1 - clamp(player.bobAmt / 0.05, 0, 1);
    this._breathT += dt * Math.PI * 2 * (0.22 + 0.35 * player.exertion);
    const breath = Math.sin(this._breathT) * (0.0012 + 0.0035 * player.exertion) * idle * c.breath;

    this._euler.set(this.pitch + this._kick + accP + breath, this.yaw, this._roll, 'YXZ');
    this.camera.quaternion.setFromEuler(this._euler);
  }
}
