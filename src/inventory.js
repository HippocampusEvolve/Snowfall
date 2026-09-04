import { KIND } from './journal.js';
import { ITEMS, ITEM_INDEX } from './data/items.js';

const amount = (n) => Math.max(0, Math.floor(Number(n) || 0));

// Инвентарь - свёртка записей ITEM. Собственного снимка состояния у него нет.
export class Inventory {
  constructor(journal) {
    this.journal = journal;
    this.counts = new Int32Array(ITEMS.length);
  }

  _index(id) {
    if (Number.isInteger(id)) return id >= 0 && id < ITEMS.length ? id : -1;
    return Object.hasOwn(ITEM_INDEX, id) ? ITEM_INDEX[id] : -1;
  }

  count(id) {
    const index = this._index(id);
    return index < 0 ? 0 : this.counts[index];
  }

  add(id, n) {
    const index = this._index(id);
    if (index < 0) return 0;
    const add = Math.min(amount(n), ITEMS[index].stack - this.counts[index]);
    if (add <= 0) return 0;
    this.counts[index] += add;
    this.journal.item(index, add);
    return add;
  }

  take(id, n) {
    const index = this._index(id);
    const take = amount(n);
    if (index < 0 || take <= 0 || this.counts[index] < take) return 0;
    this.counts[index] -= take;
    this.journal.item(index, -take);
    return take;
  }

  restore(records) {
    this.counts.fill(0);
    for (const record of records) {
      if (record.kind !== KIND.ITEM) continue;
      const index = this._index(record.id);
      if (index < 0) continue;
      this.counts[index] = Math.max(
        0,
        Math.min(ITEMS[index].stack, this.counts[index] + record.delta)
      );
    }
    return this;
  }

  total() {
    let total = 0;
    for (const n of this.counts) total += n;
    return total;
  }

  capacity() {
    return ITEMS.reduce((sum, item) => sum + item.stack, 0);
  }
}
