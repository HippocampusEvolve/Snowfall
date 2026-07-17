import * as THREE from 'three';

// Слой viewmodel: то, что игрок держит в руках, живёт в СВОЕЙ сцене со своей
// камерой. Так устроен любой FPS, и ровно по двум причинам:
//   1) свой FOV (55° против мировых 75..81°) — лопата у края кадра не растянута
//      и не «дышит» вместе с раскачкой FOV на бегу;
//   2) свой depth-буфер (clearDepth перед проходом) — инструмент не протыкает
//      стену сруба и забой, к которому подошли вплотную.
// Плата: предмет в руках не отбрасывает тень в мир и не попадает в bloom.
//
// Поверх позы предмета риг накладывает четыре аддитивных слоя — именно они
// отличают «предмет прибит к лицу» от «предмет в руках»: отставание от взгляда
// (sway), собственная качка при ходьбе (bob), дыхание в покое и просадка при
// приземлении. Риг — общий: и лопата, и полено получают их даром.

const VIEW_FOV = 55;
const WORLD_FOV = 75; // базовый, без раскачки на бегу — от него считаем компенсацию

// Узкий FOV приближает предмет. Чтобы кадр остался прежним, камерное Z множим
// на это число: экранное положение и размер сохраняются в точности, а
// собственная перспектива предмета смягчается — ради этого всё и затевалось.
export const VIEW_Z =
  Math.tan(THREE.MathUtils.degToRad(WORLD_FOV / 2)) /
  Math.tan(THREE.MathUtils.degToRad(VIEW_FOV / 2));

const TAU = Math.PI * 2;
const clamp = THREE.MathUtils.clamp;

// sway: сколько радиан отставания даёт единица угловой скорости взгляда, и потолок
const SWAY_YAW = 0.020;
const SWAY_PITCH = 0.018;
const SWAY_MAX = 0.10;
const SWAY_SPRING = 9; // 1/с — с какой охотой риг догоняет взгляд

export class ViewModel {
  constructor(worldCamera, moonDir) {
    this.worldCamera = worldCamera;
    this.moonDir = moonDir;

    this.scene = new THREE.Scene(); // без тумана: руки в метре от глаза
    this.camera = new THREE.PerspectiveCamera(
      VIEW_FOV,
      window.innerWidth / window.innerHeight,
      0.01,
      12
    );
    this.rig = new THREE.Group();
    this.scene.add(this.rig);

    // Свет рига — тот же лунный ключ и отскок от снега, что и в мире, но
    // пересчитанные в камерное пространство перед каждым кадром: повернулся —
    // блик пополз по штыку, а не приклеен к нему намертво.
    this.key = new THREE.DirectionalLight(0xbfd2ff, 1.5);
    this.key.castShadow = false;
    this.scene.add(this.key, this.key.target);
    this.scene.add(new THREE.HemisphereLight(0x223560, 0x33517e, 0.9));

    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._yaw = 0;
    this._pitch = 0;
    this._seeded = false;

    this.swayYaw = 0;
    this.swayPitch = 0;
    this.breathT = 0;
    this.dip = 0; // просадка при приземлении
    this.dipV = 0;
  }

  add(obj) {
    this.rig.add(obj);
    obj.traverse((o) => {
      o.castShadow = false; // своя сцена — теней всё равно нет, не гоняем впустую
      o.receiveShadow = false;
    });
  }

  setSize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // приземление: короткий провал рига вниз (импульс в пружину просадки)
  land(impact) {
    this.dipV -= clamp(Math.abs(impact) * 0.05, 0.05, 0.40);
  }

  update(dt, player) {
    // --- sway: риг отстаёт от поворота взгляда и пружиной догоняет ---
    this._euler.setFromQuaternion(this.worldCamera.quaternion, 'YXZ');
    if (!this._seeded) {
      this._yaw = this._euler.y;
      this._pitch = this._euler.x;
      this._seeded = true;
    }
    let dy = this._euler.y - this._yaw;
    if (dy > Math.PI) dy -= TAU;
    else if (dy < -Math.PI) dy += TAU;
    const dp = this._euler.x - this._pitch;
    this._yaw = this._euler.y;
    this._pitch = this._euler.x;

    // цель — угловая скорость взгляда со знаком минус: предмет остаётся позади
    const inv = dt > 1e-4 ? 1 / dt : 0;
    const tYaw = clamp(-dy * inv * SWAY_YAW, -SWAY_MAX, SWAY_MAX);
    const tPitch = clamp(-dp * inv * SWAY_PITCH, -SWAY_MAX, SWAY_MAX);
    const k = 1 - Math.exp(-SWAY_SPRING * dt);
    this.swayYaw += (tYaw - this.swayYaw) * k;
    this.swayPitch += (tPitch - this.swayPitch) * k;

    // --- bob: своя качка при ходьбе. Риг вне камеры, головной bob он больше
    // не наследует, поэтому качку рисуем сами — с фазовым отставанием от шага
    const amt = player.bobAmt;
    const bt = player.bobT - 0.35;
    const bobX = Math.cos(bt) * amt * 0.85;
    const bobY = Math.sin(bt * 2) * amt * 0.6;
    const bobZ = Math.cos(bt * 2) * amt * 0.25;
    const bobRoll = Math.cos(bt) * amt * 0.3;

    // --- дыхание в покое: тем заметнее, чем сильнее запыхался; на ходу тонет в качке
    const idle = 1 - clamp(amt / 0.05, 0, 1);
    this.breathT += dt * TAU * (0.22 + 0.35 * player.exertion);
    const bAmp = (0.004 + 0.012 * player.exertion) * idle;
    const breathY = Math.sin(this.breathT) * bAmp;
    const breathZ = Math.sin(this.breathT * 0.5) * bAmp * 0.5;

    // --- просадка при приземлении: критически задемпфированная пружина (без отскока)
    const w = 16;
    this.dipV += (-w * w * this.dip - 2 * w * this.dipV) * dt;
    this.dip += this.dipV * dt;

    this.rig.position.set(
      bobX - this.swayYaw * 0.18,
      bobY + breathY + this.dip + this.swayPitch * 0.18,
      (bobZ + breathZ) * VIEW_Z
    );
    this.rig.rotation.set(
      this.swayPitch + breathY * 1.2,
      this.swayYaw,
      bobRoll - this.swayYaw * 0.35
    );
  }

  render(renderer) {
    // лунный вектор из мира — в камерное пространство рига
    this._q.copy(this.worldCamera.quaternion).invert();
    this._v.copy(this.moonDir).applyQuaternion(this._q).multiplyScalar(5);
    this.key.position.copy(this._v);

    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth(); // свой depth: инструмент не протыкает стены и забой
    renderer.render(this.scene, this.camera);
    renderer.autoClear = auto;
  }
}
