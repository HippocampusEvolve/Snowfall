// Выживание в духе TLD: тепло (утекает на морозе, быстрее в метель),
// индикация обморожения на экране, смерть от холода.
//
// Полос и градусов на экране НЕТ, и это не упущение: холод игрок читает
// телом мира, а не цифрами — изморозью по краям кадра, дыханием, раскачкой
// бега, гулом ветра. Правило витрины: в кадре не должно быть чисел
// (docs/games.md, «Единая оболочка мира»). Само тепло живёт здесь и решает,
// когда ночь окажется длиннее игрока.
export class Stats {
  constructor() {
    this.warmth = 1;
    this.dead = false;
    this._acc = 0;

    this.els = {
      frost: document.getElementById('frost'),
      death: document.getElementById('death'),
    };

    document.getElementById('retry').addEventListener('click', () => location.reload());
  }

  // heat: 0..1 — близость к источнику тепла (костёр)
  update(dt, blizzard, player, heat = 0) {
    if (this.dead) return;

    // тепло утекает только в игре (не на паузе); движение греет, костёр отогревает
    if (player.locked) {
      const moveBonus = player.running ? 0.45 : player.moving ? 0.3 : 0;
      const drain = Math.max(0.1, 0.35 + blizzard * 1.5 - moveBonus) / 420;
      this.warmth = Math.max(0, this.warmth - drain * dt * (1 - heat * 0.95));
      this.warmth = Math.min(1, this.warmth + heat * dt / 40);
      if (this.warmth <= 0) this._die(player);
    }

    // изморозь обновляем ~10 раз/с: чаще нет смысла, переход и так плавный
    this._acc += dt;
    if (this._acc < 0.1) return;
    this._acc = 0;

    // изморозь по краям экрана — единственный экранный признак холода
    const cold = Math.min(1, Math.max(0, (0.7 - this.warmth) / 0.7));
    this.els.frost.style.opacity = (cold * cold * 0.95).toFixed(3);
  }

  _die(player) {
    this.dead = true;
    this.els.death.classList.add('show');
    // Тот же класс, что на паузе: игра встала, курсор свободен, и в углу
    // появляется выход на витрину (см. shell.js).
    document.body.classList.add('paused');
    if (document.pointerLockElement) document.exitPointerLock();
    // Курсор отпускает браузер, а пальцы держит только наш флаг: без этого
    // тело шло дальше за экраном смерти (см. player.halt).
    if (player) player.halt();
  }
}
