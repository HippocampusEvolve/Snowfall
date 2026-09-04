import { material } from 'world-core/materials';
import { buildParts } from './build.js';
import { firepitParts } from './firepit-geometry.js';
import { fireplaceParts } from './fireplace-geometry.js';
import { shovelParts } from './shovel-geometry.js';
import { potParts } from './pot-geometry.js';
import { booksParts } from './books-geometry.js';

// Предметы Snowfall, собранные кодом: кострище, каркас камина, лопата,
// котелок, стопка книг. Геометрия - в *-geometry.js, поверхность - наборы
// ядра, ни одного файла модели и ни одной картинки в сборке.
//
// Каждая сборка берёт готовые наборы (`matsets(...)`) и отдаёт группу, в
// которой по одному мешу на роль. Меш назван ролью - мир достаёт его через
// `group.getObjectByName('rubble')`, когда хочет добавить своего: снежный
// налёт на камни у костра, например.

export { firepitParts, CLEARANCE as FIREPIT_CLEARANCE } from './firepit-geometry.js';
export { fireplaceParts, FIREPLACE_SIZE } from './fireplace-geometry.js';
export { shovelParts } from './shovel-geometry.js';
export { potParts } from './pot-geometry.js';
export { booksParts } from './books-geometry.js';

/** Кольцо камней с золой внутри. Набор: rubble. */
export function buildFirepit(sets) {
  return buildParts(firepitParts(), {
    rubble: material(sets.rubble, { normalScale: 1.1 }),
    // Отдельного набора «зола» в ядре нет, и заводить его ради одного диска
    // не за что: тот же щебень, задавленный почти в чёрное и уплотнённый
    // вчетверо, читается как перегоревший пепел.
    ash: material(sets.rubble, { color: 0x241d18, normalScale: 0.6, repeat: [4, 4] }),
  });
}

/** Каркас камина. Наборы: ashlar, beam. Нутро топки - firebox.js. */
export function buildFireplace(sets) {
  return buildParts(
    fireplaceParts(),
    {
      stone: material(sets.ashlar, { normalScale: 1.15 }),
      // Брус полки подкрашен: `beam` в ядре самый светлый из деревянных
      // наборов, и в упор к огню полка вылетала в пересвет.
      timber: material(sets.beam, { repeat: [0.5, 0.5], normalScale: 0.6, color: 0x8a6f52 }),
    },
    // камин стоит в лунной тени крыши, как и прочая мебель избы
    { castShadow: false, receiveShadow: true }
  );
}

/** Лопата. Наборы: iron, split. */
export function buildShovel(sets) {
  return buildParts(shovelParts(), {
    // чистому металлу в этом мире нечего отражать - сталь приглушена
    steel: material(sets.iron, { metalness: 0.75, roughness: 1, repeat: [3, 3] }),
    wood: material(sets.split, { normalScale: 0.7, repeat: [2, 2], color: 0xb08a5e }),
  });
}

/** Чугунок. Набор: iron. */
export function buildPot(sets) {
  return buildParts(
    potParts(),
    // Чугун не зеркалит, но и в чёрное пятно проваливаться не должен: у огня
    // на пузе и на дужке обязан лежать блик, иначе форма пропадает. Отсюда
    // приглушённая шероховатость вместо единицы и светлее взятый тон.
    { iron: material(sets.iron, { color: 0x8b8b92, metalness: 0.45, roughness: 0.62, repeat: [2, 2] }) },
    { castShadow: false, receiveShadow: true }
  );
}

/** Стопка книг. Наборы: leather, paper. */
export function buildBooks(sets) {
  return buildParts(
    booksParts(),
    {
      cover: material(sets.leather, { normalScale: 0.8, repeat: [4, 4] }),
      pages: material(sets.paper, { normalScale: 0.8, repeat: [4, 4] }),
    },
    { castShadow: false, receiveShadow: true }
  );
}

/**
 * Отложить сборку предмета до первого нарисованного кадра.
 *
 * Наборы ядра печёт очередь из четырёх воркеров, и первым в ней стоит материал
 * ПЕРВОГО КАДРА (main.js: bark, logend, split). Заказ на щебень кострища или
 * железо лопаты, отданный при вычислении модуля, встаёт в ту же очередь раньше
 * и отодвигает всё, что за ним, - на тёплом заходе это те самые две десятых
 * секунды, за которые мир должен успеть собраться.
 *
 * Раньше эти предметы приезжали файлами и ждать их было некому: сеть шла мимо
 * главного потока. Теперь ждать некому по той же причине - они приходят
 * ВОЛНОЙ ОТДЕЛКИ, после того как мир уже показан.
 *
 * Два кадра, а не один: в первом мир ещё компилирует шейдеры. Таймер сзади -
 * на случай спрятанной вкладки, где rAF не приходит вовсе.
 */
export function afterFirstFrames(fn) {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    fn();
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(once));
  }
  setTimeout(once, 3000);
}
