// Тач-управление: телефон/планшет. Никаких видимых джойстиков — палец на
// ЛЕВОЙ половине экрана ведёт тело (аналоговый вектор от точки касания,
// дальше повёл — бег), палец на ПРАВОЙ — поворачивает взгляд (через
// look.rotateBy — сглаживание и крены общие с мышью). Кнопки — редкие и
// тонкие белые штрихи без подложек: прыжок всегда, «рука» (аналог F) —
// только когда есть что сделать, кнопки инструмента — когда он в руках.
//
// Интеграция минимальна: пишем аналоговые оси в player.touch (player.js
// подмешивает их к клавишам), «рука» и инструменты — колбэки в main.js.

const R = 52; // px полного хода пальца от точки касания до максимума скорости
const RUN_AT = 1.45; // во сколько R надо увести палец, чтобы перейти на бег
const DEAD = 7; // px мёртвой зоны — дрожь пальца не шевелит тело
const SENS = 0.0042; // рад/px взгляда (палец грубее мыши — чувствительность выше)

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Иконки: только штрих, без заливок и подложек — белые и тихие.
const ICONS = {
  // прыжок: стрелка отрывается от черты-земли
  jump: '<line x1="5" y1="20" x2="19" y2="20"/><polyline points="7.5 10.5 12 6 16.5 10.5"/><line x1="12" y1="6" x2="12" y2="16"/>',
  // рука-действие: точка в кольце — «взять/тронуть то, что перед тобой»
  act: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="0.8"/>',
  // лопата: черенок с перекладиной и совок
  shovel: '<path d="M9.5 3h5"/><line x1="12" y1="3" x2="12" y2="12.5"/><path d="M8.5 12.5h7v3.2a3.5 3.5 0 0 1-7 0z"/>',
  // намыть: горка снега
  build: '<path d="M5 18a7 7 0 0 1 14 0"/><line x1="3.5" y1="18" x2="20.5" y2="18"/>',
  // топор: топорище и клин лезвия
  axe: '<line x1="6" y1="20.5" x2="14.2" y2="7.2"/><path d="M13 4.5 18.5 9c-1.7 1.1-3.3 1.4-5.2 1L11.6 7.6c.4-1.1 .8-2.1 1.4-3.1z"/>',
};

export class TouchControls {
  // ?touch — включить тач-интерфейс на десктопе (посмотреть раскладку кнопок
  // и подсказки без телефона; мышью взгляд не водится — pointer lock не нужен)
  static supported() {
    return (
      new URLSearchParams(location.search).has('touch') ||
      matchMedia('(pointer: coarse)').matches ||
      'ontouchstart' in window
    );
  }

  constructor(player, look) {
    this.player = player;
    this.look = look;
    this.active = false;
    this.onAction = null; // () => {} — аналог нажатия F
    this.onTool = null; // (slot 1|2, down) => {} — держать = бить/копать

    this._moveId = null; // id пальца движения (левая половина)
    this._lookId = null; // id пальца взгляда (правая половина)
    this._ox = 0;
    this._oy = 0;
    this._lx = 0;
    this._ly = 0;

    // --- DOM: контейнер кнопок ---
    const ui = document.createElement('div');
    ui.id = 'touchUI';
    document.body.appendChild(ui);
    this.ui = ui;

    const mk = (id, icon) => {
      const b = document.createElement('button');
      b.id = id;
      b.className = 'tbtn hide';
      b.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[icon]}</svg>`;
      ui.appendChild(b);
      return b;
    };
    this.bJump = mk('tbJump', 'jump');
    this.bAct = mk('tbAct', 'act');
    this.bTool1 = mk('tbTool1', 'shovel');
    this.bTool2 = mk('tbTool2', 'build');
    this._tool = null;

    // прыжок: держим факт нажатия — фронт ловит player (_jumpHeld)
    this._press(this.bJump, (down) => (player.touch.jump = down));
    this._press(this.bAct, (down) => down && this.onAction && this.onAction());
    this._press(this.bTool1, (down) => this.onTool && this.onTool(1, down));
    this._press(this.bTool2, (down) => this.onTool && this.onTool(2, down));

    // --- пальцы на экране: движение и взгляд ---
    const opts = { passive: false };
    addEventListener('touchstart', (e) => this._start(e), opts);
    addEventListener('touchmove', (e) => this._move(e), opts);
    addEventListener('touchend', (e) => this._end(e), opts);
    addEventListener('touchcancel', (e) => this._end(e), opts);
  }

  // кнопка: touchstart/touchend без прохода до канваса и без синтетики мыши
  _press(btn, fn) {
    btn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn(true);
    }, { passive: false });
    const up = (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn(false);
    };
    btn.addEventListener('touchend', up, { passive: false });
    btn.addEventListener('touchcancel', up, { passive: false });
  }

  // войти в игру (кнопка меню): pointer lock на таче нет — просто включаемся
  activate() {
    if (this.active) return;
    this.active = true;
    this.player.touch.active = true;
    this.ui.classList.add('on');
    this.bJump.classList.remove('hide');
    document.body.classList.add('touch-mode');
    // меню и HUD прячет общий обработчик 'lock' в main.js
    this.look.dispatchEvent({ type: 'lock' });
  }

  // видимость контекстных кнопок — из тика main.js
  setButtons({ action = false, tool = null } = {}) {
    this.bAct.classList.toggle('hide', !action);
    if (tool !== this._tool) {
      this._tool = tool;
      this.bTool1.classList.toggle('hide', !tool);
      this.bTool2.classList.toggle('hide', tool !== 'shovel');
      if (tool)
        this.bTool1.querySelector('svg').innerHTML = ICONS[tool === 'axe' ? 'axe' : 'shovel'];
    }
  }

  // касание DOM-кнопок (экран смерти, меню) не глушим — иначе не будет click
  _skip(e) {
    return !this.active || (e.target.closest && e.target.closest('button, #menu, #death'));
  }

  _start(e) {
    if (this._skip(e)) return; // в меню/на кнопках экран живёт как обычная страница
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.clientX < innerWidth * 0.5) {
        if (this._moveId !== null) continue;
        this._moveId = t.identifier;
        this._ox = t.clientX;
        this._oy = t.clientY;
      } else {
        if (this._lookId !== null) continue;
        this._lookId = t.identifier;
        this._lx = t.clientX;
        this._ly = t.clientY;
      }
    }
  }

  _move(e) {
    if (this._skip(e)) return;
    e.preventDefault();
    const p = this.player.touch;
    for (const t of e.changedTouches) {
      if (t.identifier === this._moveId) {
        let dx = t.clientX - this._ox;
        let dy = t.clientY - this._oy;
        const len = Math.hypot(dx, dy);
        if (len < DEAD) {
          p.f = p.r = 0;
          p.run = false;
          continue;
        }
        p.r = clamp(dx / R, -1, 1);
        p.f = clamp(-dy / R, -1, 1);
        p.run = len > R * RUN_AT && p.f > 0.5; // бег — только уверенно вперёд
      } else if (t.identifier === this._lookId) {
        this.look.rotateBy(
          -(t.clientX - this._lx) * SENS,
          -(t.clientY - this._ly) * SENS
        );
        this._lx = t.clientX;
        this._ly = t.clientY;
      }
    }
  }

  _end(e) {
    if (this._skip(e)) return;
    e.preventDefault();
    const p = this.player.touch;
    for (const t of e.changedTouches) {
      if (t.identifier === this._moveId) {
        this._moveId = null;
        p.f = p.r = 0;
        p.run = false;
      } else if (t.identifier === this._lookId) {
        this._lookId = null;
      }
    }
  }
}
