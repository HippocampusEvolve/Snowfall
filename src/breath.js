import * as THREE from 'three';

// Пар от дыхания на морозе: пул спрайтов, выдохи по таймеру,
// частота дыхания растёт с нагрузкой (бег).
const POOL = 24;

function makePuffTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(230,240,255,0.75)');
  g.addColorStop(0.5, 'rgba(215,228,250,0.32)');
  g.addColorStop(1, 'rgba(200,215,245,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export class Breath {
  constructor(scene, camera, onExhale) {
    this.camera = camera;
    this.onExhale = onExhale;
    this.timer = 1.5;

    const tex = makePuffTexture();
    this.pool = [];
    for (let i = 0; i < POOL; i++) {
      const s = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: tex,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          fog: true,
        })
      );
      s.visible = false;
      s.userData = { life: 0, ttl: 1, vel: new THREE.Vector3(), grow: 0.3 };
      scene.add(s);
      this.pool.push(s);
    }

    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
  }

  _spawn(exertion, windLevel) {
    const cam = this.camera;
    this._fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    this._right.set(1, 0, 0).applyQuaternion(cam.quaternion);

    const n = 2 + ((Math.random() * 2) | 0);
    for (let i = 0; i < n; i++) {
      const s = this.pool.find((p) => !p.visible);
      if (!s) return;
      const u = s.userData;
      s.position
        .copy(cam.position)
        .addScaledVector(this._fwd, 0.32 + Math.random() * 0.06)
        .addScaledVector(this._right, (Math.random() - 0.5) * 0.06);
      s.position.y -= 0.18;
      u.vel
        .copy(this._fwd)
        .multiplyScalar(0.35 + exertion * 0.45)
        .addScaledVector(this._right, (Math.random() - 0.5) * 0.12);
      u.vel.y += 0.05 + Math.random() * 0.05;
      // ветер сносит пар
      u.vel.x += windLevel * 0.5;
      u.vel.z += windLevel * 0.18;
      u.life = 0;
      u.ttl = 1.5 + Math.random() * 0.7;
      u.grow = 0.16 + exertion * 0.16;
      s.scale.setScalar(0.05);
      s.visible = true;
    }
  }

  update(dt, exertion, windLevel) {
    // частота дыхания: спокойно ~раз в 4 c, запыхавшись ~раз в 1.3 c
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = Math.max(1.3, 4.2 - exertion * 3.0) * (0.9 + Math.random() * 0.2);
      this._spawn(exertion, windLevel);
      if (this.onExhale) this.onExhale(exertion);
    }

    for (const s of this.pool) {
      if (!s.visible) continue;
      const u = s.userData;
      u.life += dt;
      const t = u.life / u.ttl;
      if (t >= 1) {
        s.visible = false;
        s.material.opacity = 0;
        continue;
      }
      s.position.addScaledVector(u.vel, dt);
      u.vel.multiplyScalar(1 - 1.4 * dt);
      s.scale.setScalar(0.05 + t * u.grow);
      s.material.opacity = 0.1 * Math.pow(Math.sin(Math.PI * t), 0.8);
    }
  }
}
