import { box } from './parts.js';

// Стопка книг на столе: семь томов разного размера.
//
// Книга собрана не коробкой, а как настоящая: блок страниц, две крышки и
// корешок. Оттого обрез виден с трёх сторон, а переплёт выступает над блоком
// кантиком - именно этот кантик глаз и читает как «книга», а не «кирпич».
// Заодно роли не спорят внутри одной коробки: страницы отдельным мешем,
// переплёты отдельным, два draw call на всю стопку.
//
// Цвет переплёта идёт вершинным цветом поверх одной и той же карты кожи:
// семь разных томов и ни одного лишнего материала.
//
// Начало координат - левый ближний угол стопки, на поверхности стола.

const COLORS = [0x6b3434, 0x35502f, 0x2f3f5c, 0x77582a, 0x4c3355, 0x5c4630, 0x40332c];

// [ширина, длина, толщина блока, x, z, поворот вокруг Y]
const FLAT = [
  { w: 0.205, d: 0.148, t: 0.035, x: 0.106, z: 0.022, ry: 0.03 },
  { w: 0.196, d: 0.140, t: 0.030, x: 0.100, z: 0.026, ry: -0.06 },
  { w: 0.184, d: 0.134, t: 0.026, x: 0.098, z: 0.020, ry: 0.09 },
  { w: 0.172, d: 0.128, t: 0.032, x: 0.104, z: 0.024, ry: -0.02 },
  // рядом лежат ещё два тома поменьше
  { w: 0.150, d: 0.120, t: 0.028, x: 0.372, z: 0.028, ry: 0.14 },
  { w: 0.142, d: 0.114, t: 0.024, x: 0.376, z: 0.024, ry: -0.10 },
];

// Седьмой том стоит на попа, привалившись к соседней стопке.
// y0 - подъём: наклонённая книга нижним углом ушла бы под столешницу.
const UPRIGHT = { w: 0.062, h: 0.226, d: 0.152, x: 0.497, z: 0.020, rz: -0.115, y0: 0.0056 };

const COVER = 0.004; // толщина крышки переплёта
const OVER = 0.006; // кантик: насколько крышка выступает за блок

/** Одна книга плашмя: блок, две крышки, корешок. Возвращает верх стопки. */
function flatBook(parts, b, y, tint) {
  const opt = { rot: [0, b.ry, 0] };
  const cy = y + b.t / 2;
  parts.push(box('pages', b.w, b.t, b.d, b.x, cy, b.z, opt));
  for (const s of [-1, 1]) {
    parts.push(box('cover', b.w + OVER * 2, COVER, b.d + OVER * 2, b.x, cy + s * (b.t / 2 + COVER / 2), b.z, { ...opt, tint }));
  }
  // корешок - слева, вдоль длинной стороны
  parts.push(box('cover', COVER, b.t + COVER * 2, b.d + OVER * 2, b.x - b.w / 2 - COVER / 2, cy, b.z, { ...opt, tint }));
  return y + b.t + COVER * 2;
}

export function booksParts() {
  const parts = [];
  let stackA = COVER; // нижняя крышка лежит на столе, а не под ним
  let stackB = COVER;
  FLAT.forEach((b, i) => {
    const tint = COLORS[i];
    if (i < 4) stackA = flatBook(parts, { ...b }, stackA, tint);
    else stackB = flatBook(parts, { ...b }, stackB, tint);
  });

  // стоячий том: блок, крышки по бокам, корешок сверху не нужен - он снизу,
  // на столе; наклон уводит верх к стопке, низ остаётся на столешнице
  const u = UPRIGHT;
  const opt = { rot: [0, 0, u.rz] };
  const cy = u.y0 + u.h / 2;
  const tint = COLORS[6];
  parts.push(box('pages', u.w, u.h, u.d, u.x, cy, u.z, opt));
  for (const s of [-1, 1]) {
    parts.push(box('cover', COVER, u.h + OVER * 2, u.d + OVER * 2, u.x + s * (u.w / 2 + COVER / 2), cy, u.z, { ...opt, tint }));
  }
  parts.push(box('cover', u.w + COVER * 2, COVER, u.d + OVER * 2, u.x, u.y0 + COVER / 2, u.z, { ...opt, tint }));

  return parts;
}
