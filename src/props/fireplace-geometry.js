import { box } from './parts.js';

// Каркас камина: подиум, две стойки с открытой топкой, перемычка, брус полки,
// дымосборник трапецией до кровли. Нутро топки - в firebox.js: футеровка,
// зола, угли, поленья, пламя. Здесь только кладка вокруг них.
//
// Начало координат - середина по ширине, на полу, у плоскости стены; тело
// растёт от стены в комнату (+Z). Габарит: x +-1.16, z 0..1.18, высота 4.25 -
// ровно тот, что был у модели, потому что по нему выставлены и коллайдер, и
// посадка камина у задней стены (cabin.js), и обмер полости (firebox.js).
//
// ЩЁКИ ТОПКИ НЕ ПАРАЛЛЕЛЬНЫ. Полость сужается к устью, как в настоящих
// камерных каминах, и футеровка firebox.js рассчитана именно на такую полость
// (CAVITY.slope). Стойка потому не коробка, а клин: наружная грань стоит на
// x = +-1.16 и не двигается, внутренняя идёт от 0.5185 у задней стенки до 0.47
// у устья. Если сделать стойку прямой, у устья между кирпичом футеровки и
// щекой откроется щель в 5 см, и в неё будет видно бревно стены.
//
// Детали кладки (квадры углов, наличники устья, пояски дымосборника) ВЫСТУПАЮТ
// из плоскости, а не лежат в ней: совпадающих плоскостей в мире быть не должно.

const HALF = 1.16; // полуширина камина
const DEPTH = 1.18; // вынос в комнату
const PODIUM = 0.16; // высота подиума, он же под топки
const BACK = 0.115; // задняя стенка полости
const MOUTH = 0.6; // устье: передняя плоскость стоек
const ROOF = 1.1; // свод полости
const LINTEL = 0.2; // перемычка над устьем
const SHELF = 0.12; // толщина бруса полки
const SIDE_BACK = 0.5185; // полуширина полости у задней стенки
const SIDE_MOUTH = 0.47; // полуширина полости у устья
const TOP = 4.25; // до кровли

const SHELF_Y = PODIUM + (ROOF - PODIUM) + LINTEL; // низ полки, 1.30
const HOOD_Y = SHELF_Y + SHELF; // низ дымосборника, 1.42

export const FIREPLACE_SIZE = Object.freeze({ width: HALF * 2, depth: DEPTH, height: TOP });

/** Квадры на наружных рёбрах стоек: [высота центра, вылет, высота блока]. */
const QUOINS = [0.30, 0.55, 0.80, 1.02];
/** Блоки на лицевой стороне стоек. */
const FACE_BLOCKS = [0.29, 0.53, 0.77, 1.00];
/** Пояски дымосборника: доля высоты от низа до верха. */
const HOOD_BANDS = [0.14, 0.44, 0.74];

export function fireplaceParts() {
  const parts = [];
  const stone = (w, h, d, x, y, z, o) => parts.push(box('stone', w, h, d, x, y, z, o));

  // подиум: он же под топки и приступок перед устьем
  stone(HALF * 2, PODIUM, DEPTH, 0, PODIUM / 2, DEPTH / 2);

  // задняя стенка полости - от подиума до свода
  stone(HALF * 2, ROOF - PODIUM, BACK, 0, (PODIUM + ROOF) / 2, BACK / 2);

  // стойки-клинья. Наружная грань неподвижна, внутренняя забирается к устью.
  const pierW = HALF - SIDE_MOUTH; // ширина у устья, 0.69
  const pierD = MOUTH - BACK + 0.015; // на 15 мм заходит в заднюю стенку
  const pierZ = (MOUTH + BACK - 0.015) / 2;
  const shrink = (HALF - SIDE_BACK) / pierW; // множитель ширины у задней стенки
  for (const s of [-1, 1]) {
    const cx = s * (HALF - pierW / 2);
    stone(pierW, ROOF - PODIUM, pierD, cx, (PODIUM + ROOF) / 2, pierZ, {
      // сужение вдоль z: у дальнего конца (задняя стенка) уже, у ближнего шире
      taper: { axis: 'z', x: [shrink, 1], pivot: { x: (s * pierW) / 2 } },
    });
  }

  // перемычка над устьем: перекрывает свод полости во всю ширину
  stone(HALF * 2, LINTEL, MOUTH, 0, ROOF + LINTEL / 2, MOUTH / 2);

  // брус полки - единственная деревянная деталь камина
  parts.push(box('timber', HALF * 2, SHELF, 0.74, 0, SHELF_Y + SHELF / 2, 0.35, { uv: 0.5, along: 'x' }));

  // дымосборник: трапеция от полки до кровли
  const hoodH = TOP - HOOD_Y;
  const hoodW = 1.9;
  const hoodD = 0.6;
  const hoodTopW = 0.75;
  const hoodTopD = 0.32;
  stone(hoodW, hoodH, hoodD, 0, HOOD_Y + hoodH / 2, hoodD / 2 - 0.02, {
    taper: { axis: 'y', x: [1, hoodTopW / hoodW], z: [1, hoodTopD / hoodD], pivot: { z: -hoodD / 2 } },
  });

  // ---- отделка кладки ----

  // квадры на наружных рёбрах стоек: выступают на 3 см вбок и вперёд
  for (const s of [-1, 1]) {
    for (const y of QUOINS) {
      stone(0.15, 0.17, 0.20, s * (HALF - 0.055), y, MOUTH - 0.14);
    }
  }

  // блоки на лицевой стороне стоек: выступают на 3 см из устья
  for (const s of [-1, 1]) {
    for (const y of FACE_BLOCKS) {
      stone(0.34, 0.16, 0.06, s * 0.82, y, MOUTH);
    }
  }

  // наличники устья: вертикальные бруски по кромке проёма
  for (const s of [-1, 1]) {
    stone(0.12, ROOF - PODIUM - 0.04, 0.07, s * (SIDE_MOUTH + 0.063), (PODIUM + ROOF) / 2, MOUTH + 0.005);
  }

  // плиты приступка перед устьем: три плоские плиты чуть выше подиума
  for (let i = 0; i < 3; i++) {
    stone(0.72, 0.04, 0.5, (i - 1) * 0.75, PODIUM + 0.005, MOUTH + 0.28);
  }

  // пояски дымосборника
  for (const k of HOOD_BANDS) {
    const y = HOOD_Y + hoodH * k;
    const kx = 1 + (hoodTopW / hoodW - 1) * k;
    const kz = 1 + (hoodTopD / hoodD - 1) * k;
    stone(hoodW * kx + 0.05, 0.09, hoodD * kz + 0.05, 0, y, hoodD / 2 - 0.02 - 0.025);
  }

  return parts;
}
