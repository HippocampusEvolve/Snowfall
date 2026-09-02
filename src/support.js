import * as THREE from 'three';
import { resolveColliders } from './collide.js';

// Опора мира для тела из ядра (world-core/core). Ядро не знает ни вокселей, ни
// избы, ни сосен: оно спрашивает три вещи - где пол, куда вытолкнуть, далеко ли
// до ближайшей поверхности от глаза, - а собирает ответы отсюда.
//
// Всё, что тут есть, раньше лежало прямо в player.js и было единственным, что
// привязывало контроллер к этому миру.

// зазор глаза от стен в пещере: держим корпус на этом расстоянии (м) от грунта,
// чтобы near-плоскость камеры не обрезала стену и не было видно сквозь неё
const WALL_MARGIN = 0.22;

// подошва: точки сэмплирования деревянного пола (центр + крест). Один луч в
// точку «проваливался» в щель между досками или цеплялся за нижнюю балку
// каркаса — опора мигала, прилипание к полу защёлкивало ноги вниз-вверх
// (йо-йо камеры)
const FOOT_SAMPLES = [
  [0, 0],
  [0.18, 0],
  [-0.18, 0],
  [0, 0.18],
  [0, -0.18],
];

/**
 * @param {object} o
 * @param {object} o.terrain рельеф: getHeight(x, z)
 * @param {object} o.digger воксельные правки: surfaceBelow, densityAt, edits
 * @param {Array} o.colliders реестр столбов и стен-отрезков (collide.js)
 * @param {(x: number, z: number) => number|null} o.getFloor деревянный пол избы
 */
export function createSupport({ terrain, digger, colliders, getFloor }) {
  const normal = new THREE.Vector3();
  const out = { dist: 0, normal };

  return {
    // Опора под ногами: ближайший грунт в окне высот, а деревянный пол избы
    // перекрывает его, если он выше и досягаем шагом.
    floorAt(x, z, yFrom, probe) {
      let y = digger
        ? digger.surfaceBelow(x, z, yFrom, yFrom - probe)
        : terrain.getHeight(x, z);
      let surface = 'snow';

      if (getFloor) {
        // берём ВЫСШУЮ досягаемую шагом точку подошвы: щель между досками или
        // балка под одной точкой не роняют опору, а перила и столешница над
        // головой отсекаются пер-сэмплом
        let best = null;
        for (const [dx, dz] of FOOT_SAMPLES) {
          const h = getFloor(x + dx, z + dz);
          if (h === null || h > yFrom) continue; // недосягаемо шагом — не опора
          if (best === null || h > best) best = h;
        }
        if (best !== null && (y === null || best >= y)) {
          y = best;
          surface = 'wood';
        }
      }

      return y === null ? null : { y, surface };
    },

    // Вытолкнуть тело из твёрдого: сперва стены пещер по SDF, потом стволы,
    // стены сруба, кромки, мебель и дверь. Скорость не трогаем - ядро само
    // отнимет ту её часть, что смотрит в поверхность, по суммарному смещению.
    resolve(pos, radius, height) {
      const dig = digger;
      if (dig && dig.edits.size > 0) {
        const e = 0.15;
        // сэмплим ТОЛЬКО выше высоты шага: то, на что можно зашагнуть (уступ,
        // кромка ямы), не считается стеной и не отпихивает — иначе не выбраться
        // из ямы и не залезть на уступ
        for (let s = 0; s < 3; s++) {
          const by = pos.y + 0.9 + s * 0.4; // грудь/плечи/голова: 0.9, 1.3, 1.7
          for (let it = 0; it < 2; it++) {
            const f = dig.densityAt(pos.x, by, pos.z);
            const dfx =
              (dig.densityAt(pos.x + e, by, pos.z) -
                dig.densityAt(pos.x - e, by, pos.z)) / (2 * e);
            const dfz =
              (dig.densityAt(pos.x, by, pos.z + e) -
                dig.densityAt(pos.x, by, pos.z - e)) / (2 * e);
            const g2 = dfx * dfx + dfz * dfz;
            if (g2 < 1e-6) break; // почти горизонтальный градиент (потолок/пол) — не стена
            // целевая изоповерхность −MARGIN·|∇f|: глаз стоит на WALL_MARGIN м снаружи
            const target = -WALL_MARGIN * Math.sqrt(g2);
            if (f <= target) break; // уже дальше запаса от стены
            let d = (f - target) / g2; // ньютон к целевой изоповерхности
            const len = d * Math.sqrt(g2);
            if (len > 0.4) d *= 0.4 / len; // ограничиваем скачок за кадр
            pos.x -= dfx * d;
            pos.z -= dfz * d;
          }
        }
      }

      // коллизии со структурами: итеративный решатель — в углах и узких
      // проходах не осциллирует
      resolveColliders(pos, height, radius, colliders);
    },

    // Знаковое расстояние от глаза до ближайшей поверхности и нормаль наружу.
    // Мир до первой копки — обычный heightmap без вырезов, прятать нечего:
    // возвращаем null, и ядро оставляет near как есть.
    clearance(eye) {
      const dig = digger;
      if (!dig || dig.edits.size === 0) return null;

      const e = 0.12;
      const f = dig.densityAt(eye.x, eye.y, eye.z);
      const dfx = (dig.densityAt(eye.x + e, eye.y, eye.z) - dig.densityAt(eye.x - e, eye.y, eye.z)) / (2 * e);
      const dfy = (dig.densityAt(eye.x, eye.y + e, eye.z) - dig.densityAt(eye.x, eye.y - e, eye.z)) / (2 * e);
      const dfz = (dig.densityAt(eye.x, eye.y, eye.z + e) - dig.densityAt(eye.x, eye.y, eye.z - e)) / (2 * e);
      const g2 = dfx * dfx + dfy * dfy + dfz * dfz;
      if (g2 < 1e-6) return null; // толкать некуда — градиента нет
      const gm = Math.sqrt(g2);

      // density < 0 в воздухе, ≥ 0 в грунте: расстояние = −f/|∇f|, наружу = −∇f
      out.dist = -f / gm;
      normal.set(-dfx / gm, -dfy / gm, -dfz / gm);
      return out;
    },
  };
}
