// Описание примитивов кирки отдельно от three. Тест считает те же сегменты,
// по которым pickaxe.js строит настоящую модель.
export const PICKAXE_PARTS = Object.freeze([
  { kind: 'cylinder', role: 'wood', top: 0.027, bottom: 0.034, height: 1.05, segments: 8, x: 0.36, y: 0.58, rz: 0 },
  { kind: 'cylinder', role: 'wood', top: 0.035, bottom: 0.029, height: 0.24, segments: 8, x: 0.36, y: 1.02, rz: 0 },
  { kind: 'cylinder', role: 'metal', top: 0.072, bottom: 0.072, height: 0.18, segments: 8, x: 0.36, y: 0, rz: Math.PI / 2 },
  { kind: 'cone', role: 'metal', top: 0, bottom: 0.075, height: 0.3, segments: 8, x: 0.15, y: 0, rz: Math.PI / 2 },
  { kind: 'cone', role: 'metal', top: 0, bottom: 0.095, height: 0.34, segments: 8, x: 0.61, y: 0, rz: -Math.PI / 2 },
]);

function partTriangles(part) {
  const sides = part.segments * (part.top > 0 && part.bottom > 0 ? 2 : 1);
  const caps = part.segments * ((part.top > 0 ? 1 : 0) + (part.bottom > 0 ? 1 : 0));
  return sides + caps;
}

export function countPickaxeTriangles() {
  return PICKAXE_PARTS.reduce((sum, part) => sum + partTriangles(part), 0);
}
