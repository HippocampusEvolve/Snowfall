// Выживание в духе TLD: тепло (утекает на морозе, быстрее в метель),
// индикация обморожения на экране, смерть от холода.
export class Stats {
  constructor() {
    this.warmth = 1;
    this.dead = false;
    this._acc = 0;

    this.els = {
      stats: document.getElementById('stats'),
      warmth: document.getElementById('warmthFill'),
      stamina: document.getElementById('staminaFill'),
      temp: document.getElementById('tempText'),
      frost: document.getElementById('frost'),
      death: document.getElementById('death'),
    };

    document.getElementById('retry').addEventListener('click', () => location.reload());
  }

  // heat: 0..1 — близость к источнику тепла (костёр)
  update(dt, blizzard, player, heat = 0) {
    if (this.dead) return;

    // тепло утекает только в игре (не в меню); движение греет, костёр отогревает
    if (player.locked) {
      const moveBonus = player.running ? 0.45 : player.moving ? 0.3 : 0;
      const drain = Math.max(0.1, 0.35 + blizzard * 1.5 - moveBonus) / 420;
      this.warmth = Math.max(0, this.warmth - drain * dt * (1 - heat * 0.95));
      this.warmth = Math.min(1, this.warmth + heat * dt / 40);
      if (this.warmth <= 0) this._die();
    }

    // DOM обновляем ~10 раз/с
    this._acc += dt;
    if (this._acc < 0.1) return;
    this._acc = 0;

    const e = this.els;
    e.warmth.style.width = `${this.warmth * 100}%`;
    e.warmth.classList.toggle('low', this.warmth < 0.3);
    e.stamina.style.width = `${player.stamina * 100}%`;
    e.stamina.classList.toggle('low', player.exhausted);

    const temp = Math.round(-10 - blizzard * 16 + (player.moving ? 1 : 0) + heat * 22);
    e.temp.textContent = `${temp}°`;
    e.temp.style.color = heat > 0.05 ? '#e8b070' : '#a9bde0';

    // изморозь по краям экрана
    const cold = Math.min(1, Math.max(0, (0.7 - this.warmth) / 0.7));
    e.frost.style.opacity = (cold * cold * 0.95).toFixed(3);
  }

  _die() {
    this.dead = true;
    this.els.death.classList.add('show');
    if (document.pointerLockElement) document.exitPointerLock();
  }
}
