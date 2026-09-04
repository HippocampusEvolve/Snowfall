import { KIND } from './journal.js';
import { ITEM_INDEX } from './data/items.js';

const q = (n) => Math.round(n * 50);
const keyOf = (r) => `${r.id}|${q(r.x)}|${q(r.y)}|${q(r.z)}`;

export function quantizePlacement(position) {
  return { x: q(position.x) / 50, y: q(position.y) / 50, z: q(position.z) / 50 };
}

/** Свернуть PLACE по id и квантованной позиции в живые предметы мира. */
export function placedItemsFrom(records, item = null) {
  const wanted = typeof item === 'string' ? ITEM_INDEX[item] : item;
  const live = new Map();
  for (const record of records) {
    if (record.kind !== KIND.PLACE) continue;
    if (wanted !== null && wanted !== undefined && record.id !== wanted) continue;
    const key = keyOf(record);
    if (record.take) live.delete(key);
    else live.set(key, { ...record });
  }
  return [...live.values()];
}
