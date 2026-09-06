import { MATERIAL } from '../caves.js';

// Стройка описана данными: расход, результат в мире и действие руки.
const build = (id, name, item, material) => Object.freeze({
  id,
  name,
  take: Object.freeze({ [item]: 1 }),
  give: Object.freeze({ material, radius: 0.5, strength: 2.8 }),
  verb: 'build',
});

const craft = (id, name, take, give) => Object.freeze({
  id,
  name,
  take: Object.freeze(take),
  give: Object.freeze(give),
  verb: 'craft',
  station: 'workbench',
});

export const RECIPES = Object.freeze([
  build('place-stone', 'положить камень', 'stone', MATERIAL.STONE),
  build('pour-soil', 'насыпать грунт', 'soil', MATERIAL.SOIL),
  build('shape-snow', 'слепить снег', 'snow', MATERIAL.SNOW),
  craft('make-torch', 'расщепить смолистое полено на факелы', { log: 1 }, { torch: 2 }),
  craft('make-block', 'сделать каменный блок', { stone: 4 }, { block: 1 }),
  craft('dress-ore', 'обтесать железистый камень', { ore: 2 }, { block: 1 }),
]);
