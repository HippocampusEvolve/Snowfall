import * as THREE from 'three';

// Чужая жизнь — пока только следами (VISION.md: присутствие вместо врагов).
// Изредка, пока игрок далеко или в доме, через поляну проходит зверь: заяц
// (характерные четвёрки-прыжки) или лиса (ровная строчка). Самого зверя нет —
// только цепочка на снегу, которую потом так же заметает. Редкость — валюта:
// событие раз в ~8–15 минут, первое — раньше, чтобы игрок успел его встретить.
const FIRST_DELAY = () => 240 + Math.random() * 180; // сек до первого зверя
const NEXT_DELAY = () => 480 + Math.random() * 420; // и между следующими
const SAFE_DIST = 16; // ближе к игроку зверь не подходит (следы не появляются на глазах)
const BOUNDS = 76; // край карты следов (160/2 с запасом)

export class Critters {
  constructor(footprints, camera) {
    this.footprints = footprints;
    this.camera = camera;
    this.timer = FIRST_DELAY();
    this.chain = null; // активная цепочка следов
  }

  // спланировать проход: линия мимо игрока (не через него), с лёгким виляньем
  _plan() {
    const p = this.camera.position;
    const type = Math.random() < 0.6 ? 'hare' : 'fox';
    const a = Math.random() * Math.PI * 2;
    const startDist = 24 + Math.random() * 12;
    const sx = p.x + Math.cos(a) * startDist;
    const sz = p.z + Math.sin(a) * startDist;
    // курс — на точку сбоку от игрока: путь пересекает окрестность, но не игрока
    const side = Math.random() < 0.5 ? -1 : 1;
    const tx = p.x + Math.cos(a + (side * Math.PI) / 2) * (8 + Math.random() * 8);
    const tz = p.z + Math.sin(a + (side * Math.PI) / 2) * (8 + Math.random() * 8);
    return {
      type,
      x: sx,
      z: sz,
      heading: Math.atan2(tz - sz, tx - sx),
      left: 30 + Math.random() * 25, // метров пути
      phase: Math.random() * 10, // фаза вилянья
    };
  }

  // одна «ступень» цепочки: прыжок зайца или пара шагов лисы.
  // Отпечатки — настоящие лапки (stampPaw): в детальной карте следов
  // они читаются формой, а не пятном
  _step(c) {
    const fp = this.footprints;
    const cos = Math.cos(c.heading);
    const sin = Math.sin(c.heading);
    // перпендикуляр к курсу — для парных отпечатков
    const px = -sin;
    const pz = cos;

    if (c.type === 'hare') {
      // четвёрка: задние лапы парой впереди, передние — строчкой позади
      fp.stampPaw(c.x + px * 0.1, c.z + pz * 0.1, c.heading, 'hareHind');
      fp.stampPaw(c.x - px * 0.1, c.z - pz * 0.1, c.heading, 'hareHind');
      fp.stampPaw(c.x - cos * 0.28 + px * 0.03, c.z - sin * 0.28 + pz * 0.03, c.heading, 'hareFront');
      fp.stampPaw(c.x - cos * 0.48 - px * 0.03, c.z - sin * 0.48 - pz * 0.03, c.heading, 'hareFront');
      const jump = 1.0 + Math.random() * 0.35;
      c.x += cos * jump;
      c.z += sin * jump;
      c.left -= jump;
    } else {
      // лиса: ровная строчка след-в-след
      fp.stampPaw(c.x, c.z, c.heading, 'fox');
      const step = 0.36;
      c.x += cos * step;
      c.z += sin * step;
      c.left -= step;
    }

    // лёгкое виляние курса — живая линия, не линейка
    c.phase += 0.35;
    c.heading += Math.sin(c.phase) * 0.045 + (Math.random() - 0.5) * 0.05;
  }

  update(dt) {
    const p = this.camera.position;

    if (!this.chain) {
      this.timer -= dt;
      if (this.timer > 0) return;
      this.chain = this._plan();
      this.timer = NEXT_DELAY();
      return;
    }

    // цепочка «идёт»: несколько ступеней за кадр — вся линия ложится за секунды
    const c = this.chain;
    const steps = c.type === 'hare' ? 2 : 4;
    for (let i = 0; i < steps; i++) {
      // зверь не подходит к игроку и не выходит за карту следов — обрываем путь
      if (
        c.left <= 0 ||
        Math.hypot(c.x - p.x, c.z - p.z) < SAFE_DIST ||
        Math.abs(c.x) > BOUNDS ||
        Math.abs(c.z) > BOUNDS
      ) {
        this.chain = null;
        return;
      }
      this._step(c);
    }
  }
}
