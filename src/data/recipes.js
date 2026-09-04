import { MATERIAL } from '../caves.js';

// Стройка описана данными: расход, результат в мире и действие руки.
const build = (id, name, item, material) => Object.freeze({
  id,
  name,
  take: Object.freeze({ [item]: 1 }),
  give: Object.freeze({ material, radius: 0.5, strength: 2.8 }),
  verb: 'build',
});

export const RECIPES = Object.freeze([
  build('place-stone', 'положить камень', 'stone', MATERIAL.STONE),
  build('pour-soil', 'насыпать грунт', 'soil', MATERIAL.SOIL),
  build('shape-snow', 'слепить снег', 'snow', MATERIAL.SNOW),
]);
