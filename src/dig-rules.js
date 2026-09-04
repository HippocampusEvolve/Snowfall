import { MATERIAL } from './caves.js';

// Числа правки вынесены из Digger, чтобы правила инструментов проверялись
// на Node без three и совпадали при живом ударе и воспроизведении журнала.
export const DIG_RULES = Object.freeze({
  SHOVEL_STRENGTH: 2.4,
  PICK_RADIUS: 0.32,
  PICK_STONE_STRENGTH: 2.4 / 3,
});

export function shovelAppliedStrength(material, sign, strength = DIG_RULES.SHOVEL_STRENGTH) {
  return sign < 0 && material > MATERIAL.SOIL ? 0 : strength;
}

export function pickaxeAppliedStrength(material) {
  return material >= MATERIAL.STONE
    ? DIG_RULES.PICK_STONE_STRENGTH
    : DIG_RULES.SHOVEL_STRENGTH;
}
