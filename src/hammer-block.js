import { MATERIAL } from './caves.js';

export const HAMMER_BLOCK = Object.freeze({
  grid: 0.5,
  half: Object.freeze({ x: 0.5, y: 0.25, z: 0.5 }),
  strength: 4,
  falloff: 0.04,
});

const snap = (n) => Math.round(n / HAMMER_BLOCK.grid) * HAMMER_BLOCK.grid;
const snapY = (n) => snap(n - HAMMER_BLOCK.half.y) + HAMMER_BLOCK.half.y;

/** Центр блока на сетке, сдвинутый наружу от ближайшей грани поверхности. */
export function hammerBlockCenter(surface) {
  const point = surface.point || surface;
  const normal = surface.normal || { x: 0, y: 1, z: 0 };
  const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
  const center = { x: snap(point.x), y: snapY(point.y), z: snap(point.z) };
  if (ay >= ax && ay >= az) {
    const side = normal.y < 0 ? -1 : 1;
    center.y = snap(point.y) + side * HAMMER_BLOCK.half.y;
  } else if (ax >= az) {
    const side = normal.x < 0 ? -1 : 1;
    center.x = snap(point.x + side * HAMMER_BLOCK.half.x);
  } else {
    const side = normal.z < 0 ? -1 : 1;
    center.z = snap(point.z + side * HAMMER_BLOCK.half.z);
  }
  return center;
}

export function hammerBlockAvoided(center, avoid) {
  const radius = Math.hypot(HAMMER_BLOCK.half.x, HAMMER_BLOCK.half.z);
  return avoid.some((area) =>
    Math.hypot(center.x - area.x, center.z - area.z) < area.r + radius
  );
}

/** Поставить один каменный бокс и только после этого списать предмет. */
export function placeHammerBlock(inventory, digger, surface, avoid = [], onPlace = null) {
  if (inventory.count('block') < 1) return null;
  const center = hammerBlockCenter(surface);
  if (hammerBlockAvoided(center, avoid)) return null;
  digger.blockStroke(center, MATERIAL.STONE);
  inventory.take('block', 1);
  if (onPlace) onPlace(center);
  return center;
}
