import { MATERIAL } from '../caves.js';

// Предметы - только данные. Позиция в массиве является байтовым id в журнале.
export const ITEMS = Object.freeze([
  Object.freeze({ id: 'snow', name: 'снег', stack: 24, material: MATERIAL.SNOW }),
  Object.freeze({ id: 'soil', name: 'грунт', stack: 24, material: MATERIAL.SOIL }),
  Object.freeze({ id: 'stone', name: 'камень', stack: 24, material: MATERIAL.STONE }),
  Object.freeze({ id: 'ore', name: 'руда', stack: 12, material: MATERIAL.ORE }),
  Object.freeze({ id: 'log', name: 'полено', stack: 1, material: null }),
  Object.freeze({ id: 'torch', name: 'факел', stack: 8, material: null }),
  Object.freeze({ id: 'block', name: 'каменный блок', stack: 8, material: null }),
]);

export const ITEM_INDEX = Object.freeze(
  Object.fromEntries(ITEMS.map((item, index) => [item.id, index]))
);

export function itemByMaterial(material) {
  return ITEMS.find((item) => item.material === material) || null;
}
