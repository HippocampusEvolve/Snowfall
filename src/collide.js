import * as THREE from 'three';

// Единый решатель горизонтальных коллизий для кинематических тел.
// Тело — вертикальная капсула: круг радиуса radius на отрезке высот
// [pos.y, pos.y + height]. Использует игрок; враги/животные/стройка позже
// решаются этой же функцией против того же реестра коллайдеров.
//
// Формат коллайдера (обычный объект в общем массиве colliders):
//   { x, z, r }              — столб: ствол, столб навеса, мебель
//   { x1, z1, x2, z2, r }    — стена-отрезок: стены, кромки, полотно двери
//   y0, y1 (опционально)     — вертикальный диапазон препятствия: коллизия
//     только если [pos.y, pos.y+height] пересекает [y0, y1]. Пример: кромка
//     крыльца с y1 = пол-0.3 толкает только стоящего на земле, а идущий по
//     настилу проходит свободно. Нет полей — препятствие бесконечно по высоте.
//
// Выталкивание — НЕСКОЛЬКО проходов по всем коллайдерам до сходимости.
// Однопроходное решение в углу или узком проходе осциллирует: толчок из
// одного вдавливает в соседний, и по кадрам позиция прыгает туда-сюда
// (дёргания у крыльца). Итерации в пределах кадра сходятся к устойчивой
// точке, одинаковой от кадра к кадру.
export function resolveColliders(pos, height, radius, colliders, iters = 4) {
  const y = pos.y;
  for (let k = 0; k < iters; k++) {
    let worst = 0;
    for (const o of colliders) {
      if (o.y1 !== undefined && y > o.y1) continue;
      if (o.y0 !== undefined && y + height < o.y0) continue;
      let ox = o.x, oz = o.z;
      if (o.x2 !== undefined) {
        // отрезок: толкаемся от ближайшей его точки
        const abx = o.x2 - o.x1, abz = o.z2 - o.z1;
        const t = THREE.MathUtils.clamp(
          ((pos.x - o.x1) * abx + (pos.z - o.z1) * abz) / (abx * abx + abz * abz || 1),
          0, 1
        );
        ox = o.x1 + abx * t;
        oz = o.z1 + abz * t;
      }
      const dx = pos.x - ox;
      const dz = pos.z - oz;
      const R = o.r + radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= R * R || d2 < 1e-10) continue;
      const d = Math.sqrt(d2);
      const push = R - d;
      pos.x += (dx / d) * push;
      pos.z += (dz / d) * push;
      if (push > worst) worst = push;
    }
    if (worst < 1e-4) break; // всё разрешено — позиция устойчива
  }
}
