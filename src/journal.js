// Журнал мира: не снимок состояния, а список того, что игрок сделал, и когда.
//
// Мир = семя + журнал. По семени (см. trees.js, terrain.js) он пересобирается
// одинаковым, поэтому хранить его целиком незачем; хранится только то, что
// человек изменил своими руками, и время каждого изменения. Из времени и
// считается, что случилось с миром, пока игрока не было (growth.js).
//
// Запись - ровно 16 байт, little-endian:
//
//   0..3   seq   u32  номер записи, сквозной с первой ночи (1, 2, 3, ...)
//   4..7   t     u32  секунд от эпохи мира (epoch, Unix-секунды в заголовке)
//   8      tag   u8   биты 0..3 - вид записи (KIND);
//                     для DIG бит 4 - стройка рукой, бит 5 - кирка,
//                     биты 6..7 - материал 0..3; у других видов старшие биты 0
//   9..15       7 байт полезной нагрузки, своей у каждого вида
//
// Нагрузка по видам:
//
//   DIG    байт 8: бит 4 - стройка рукой, бит 5 - кирка,
//          биты 6..7 - материал удара;
//          9..10 i16 x, 11..12 i16 y, 13..14 i16 z - центр копка, шаг 2 см
//                (мир 400 м, i16 при 2 см держит +-655 м - с запасом);
//          15    u8  бит 7 - знак (0 копок, 1 намыв), биты 4..6 - сила
//                шагом 0.4, биты 0..3 - азимут штыка шагом 22.5 градуса.
//                Азимут записан не для красоты: копок - ориентированный
//                бокс (digger.editBox), без него воспроизведённая яма
//                легла бы гранями не туда. Бокс квадратный в плане, так
//                что шага в 22.5 градуса хватает - ошибка не больше
//                11 градусов и видна только по гребням от штыка.
//   CHOP   9..10 u16 id сосны, 11 u8 зарубок после удара
//   FELL   9..10 u16 id сосны, 11..12 i16 угол падения шагом 1e-4 рад
//   SPLIT  9..10 u16 id сосны, 11 u8 поленьев осталось (ноль - ствол вышел)
//   FUEL   нагрузки нет: полено в костре - само событие
//   PILE   9     u8  сколько поленьев стало в поленнице
//   ITEM   9     u8  id предмета (индекс в data/items.js),
//          10..11 i16 изменение количества
//   PLACE  байт 8: бит 4 - предмет снят, а не поставлен;
//          9     u8  id предмета (индекс в data/items.js),
//          10..11 i16 x, 12..13 i16 y, 14..15 i16 z, шаг 2 см
//
// Почему фиксированная длина: журнал дописывается порциями по CHUNK записей
// (ключ порции - её номер), и автосейв кладёт в IndexedDB только последнюю
// порцию, а не переписывает всё. Считать смещение записи умножением можно
// только при постоянном шаге.
//
// three здесь нет и быть не должно: модуль обязан ехать на голом Node.

export const REC = 16; // байт на запись
export const CHUNK = 4096; // записей в порции хранилища
export const KIND = {
  DIG: 1, CHOP: 2, FELL: 3, SPLIT: 4, FUEL: 5, PILE: 6, ITEM: 7, PLACE: 8,
};

const Q = 0.02; // шаг квантования центра копка, м
const YAW_STEPS = 16; // делений азимута в 4 битах
const STRENGTH_STEP = 0.4; // шаг силы в 3 битах (0 .. 2.8)
const KIND_MASK = 0x0f;
const BUILD_BIT = 0x10;
const PICKAXE_BIT = 0x20;
const TAKE_BIT = 0x10;

const clampI16 = (v) => Math.max(-32768, Math.min(32767, v));

/** Секунда мира по абсолютному времени: обе величины - Unix-секунды. */
export const secondsSince = (epoch, nowMs = Date.now()) =>
  Math.max(0, Math.round(nowMs / 1000) - epoch);

export class Journal {
  constructor(epoch = Math.floor(Date.now() / 1000)) {
    this.epoch = epoch; // Unix-секунды рождения мира; от неё считается t
    this.count = 0;
    this.seqHead = 0;
    // Сколько записей уже лежит в IndexedDB. Всё, что дальше, дописывается
    // ближайшим автосейвом - хвостом, не целиком.
    this.flushed = 0;
    this._buf = new Uint8Array(CHUNK * REC);
    this._view = new DataView(this._buf.buffer);
    // Как мир въехал в этот запуск. Живёт здесь, а не в save.js, потому что
    // спрашивают об этом журнал: `__snow.journal.stats()`.
    this.mode = 'new'; // 'new' | 'cache' | 'replay'
    this.loadMs = 0;
  }

  get bytes() {
    return this.count * REC;
  }

  /** Секунда мира прямо сейчас - время, с которым уходит новая запись. */
  now(nowMs = Date.now()) {
    return secondsSince(this.epoch, nowMs);
  }

  // Буфер растёт удвоением: журнал дописывается по одной записи на взмах, и
  // перевыделять его на каждую было бы ровно тем, чего мы избегаем.
  _room(n) {
    if (n * REC <= this._buf.length) return;
    let size = this._buf.length || CHUNK * REC;
    while (size < n * REC) size *= 2;
    const next = new Uint8Array(size);
    next.set(this._buf);
    this._buf = next;
    this._view = new DataView(next.buffer);
  }

  // общая шапка записи; возвращает смещение нагрузки
  _head(kind, t) {
    this._room(this.count + 1);
    const o = this.count * REC;
    this._view.setUint32(o, ++this.seqHead, true);
    this._view.setUint32(o + 4, t === undefined ? this.now() : t, true);
    this._view.setUint8(o + 8, kind);
    // хвост чистим: нагрузка короче семи байт не должна тащить чужое
    for (let i = 9; i < REC; i++) this._buf[o + i] = 0;
    this.count++;
    return o;
  }

  /** Правка инструментом: центр, азимут, знак, сила, материал и вид инструмента. */
  dig(x, y, z, yaw, sign, strength, t, material = 0, tool = 'shovel') {
    const m = Math.max(0, Math.min(3, material | 0));
    const tag = KIND.DIG
      | (tool === 'hand' ? BUILD_BIT : 0)
      | (tool === 'pickaxe' ? PICKAXE_BIT : 0)
      | (m << 6);
    const o = this._head(tag, t);
    this._view.setInt16(o + 9, clampI16(Math.round(x / Q)), true);
    this._view.setInt16(o + 11, clampI16(Math.round(y / Q)), true);
    this._view.setInt16(o + 13, clampI16(Math.round(z / Q)), true);
    const s = Math.max(0, Math.min(7, Math.round(strength / STRENGTH_STEP)));
    const a = ((Math.round((yaw / (Math.PI * 2)) * YAW_STEPS) % YAW_STEPS) + YAW_STEPS) % YAW_STEPS;
    this._buf[o + 15] = (sign > 0 ? 128 : 0) | (s << 4) | a;
    return this.seqHead;
  }

  /** Удар топором по стоящей сосне: сколько зарубок стало. */
  chop(id, hits, t) {
    const o = this._head(KIND.CHOP, t);
    this._view.setUint16(o + 9, id, true);
    this._buf[o + 11] = Math.min(255, hits);
    return this.seqHead;
  }

  /** Сосна повалена: куда легла крона. */
  fell(id, yaw, t) {
    const o = this._head(KIND.FELL, t);
    this._view.setUint16(o + 9, id, true);
    this._view.setInt16(o + 11, clampI16(Math.round(yaw * 10000)), true);
    return this.seqHead;
  }

  /** Разделка лежащего ствола: сколько поленьев в нём осталось. */
  split(id, left, t) {
    const o = this._head(KIND.SPLIT, t);
    this._view.setUint16(o + 9, id, true);
    this._buf[o + 11] = Math.max(0, Math.min(255, left));
    return this.seqHead;
  }

  /** Полено в костёр. */
  fuel(t) {
    this._head(KIND.FUEL, t);
    return this.seqHead;
  }

  /** Поленница: сколько поленьев в штабеле стало. */
  pile(count, t) {
    const o = this._head(KIND.PILE, t);
    this._buf[o + 9] = Math.max(0, Math.min(255, count));
    return this.seqHead;
  }

  /** Изменение одной стопки инвентаря. */
  item(id, delta, t) {
    const o = this._head(KIND.ITEM, t);
    this._buf[o + 9] = Math.max(0, Math.min(255, id | 0));
    this._view.setInt16(o + 10, clampI16(Math.round(delta)), true);
    return this.seqHead;
  }

  /** Поставить предмет в мир или снять его с той же квантованной позиции. */
  place(id, x, y, z, t, take = false) {
    const o = this._head(KIND.PLACE | (take ? TAKE_BIT : 0), t);
    this._buf[o + 9] = Math.max(0, Math.min(255, id | 0));
    this._view.setInt16(o + 10, clampI16(Math.round(x / Q)), true);
    this._view.setInt16(o + 12, clampI16(Math.round(y / Q)), true);
    this._view.setInt16(o + 14, clampI16(Math.round(z / Q)), true);
    return this.seqHead;
  }

  /** Запись по номеру (0-based) в виде объекта. */
  at(i) {
    const o = i * REC;
    const v = this._view;
    const tag = v.getUint8(o + 8);
    const r = { seq: v.getUint32(o, true), t: v.getUint32(o + 4, true), kind: tag & KIND_MASK };
    if (r.kind === KIND.DIG) {
      r.x = v.getInt16(o + 9, true) * Q;
      r.y = v.getInt16(o + 11, true) * Q;
      r.z = v.getInt16(o + 13, true) * Q;
      const b = this._buf[o + 15];
      r.sign = b & 128 ? 1 : -1;
      r.strength = ((b >> 4) & 7) * STRENGTH_STEP;
      r.yaw = (b & 15) * ((Math.PI * 2) / YAW_STEPS);
      r.material = tag >> 6;
      r.tool = tag & PICKAXE_BIT ? 'pickaxe' : tag & BUILD_BIT ? 'hand' : 'shovel';
    } else if (r.kind === KIND.CHOP) {
      r.id = v.getUint16(o + 9, true);
      r.hits = this._buf[o + 11];
    } else if (r.kind === KIND.FELL) {
      r.id = v.getUint16(o + 9, true);
      r.yaw = v.getInt16(o + 11, true) / 10000;
    } else if (r.kind === KIND.SPLIT) {
      r.id = v.getUint16(o + 9, true);
      r.left = this._buf[o + 11];
    } else if (r.kind === KIND.PILE) {
      r.count = this._buf[o + 9];
    } else if (r.kind === KIND.ITEM) {
      r.id = this._buf[o + 9];
      r.delta = v.getInt16(o + 10, true);
    } else if (r.kind === KIND.PLACE) {
      r.id = this._buf[o + 9];
      r.x = v.getInt16(o + 10, true) * Q;
      r.y = v.getInt16(o + 12, true) * Q;
      r.z = v.getInt16(o + 14, true) * Q;
      r.take = !!(tag & TAKE_BIT);
    }
    return r;
  }

  *records() {
    for (let i = 0; i < this.count; i++) yield this.at(i);
  }

  /**
   * Порции, которых ещё нет в хранилище (или которые в нём неполны).
   *
   * Возвращает [номер, байты] начиная с той порции, куда попала первая
   * несохранённая запись: её надо переписать целиком, потому что она в
   * хранилище лежит недописанной, а всё, что за ней, - новое.
   */
  pending() {
    const out = [];
    if (this.count === this.flushed) return out;
    const from = Math.floor(this.flushed / CHUNK);
    const to = Math.floor((this.count - 1) / CHUNK);
    for (let c = from; c <= to; c++) {
      const start = c * CHUNK * REC;
      const end = Math.min(this.count * REC, (c + 1) * CHUNK * REC);
      out.push([c, this._buf.slice(start, end)]);
    }
    return out;
  }

  /** Все занятые байты для фолбэка без IndexedDB. */
  snapshot() {
    return this._buf.slice(0, this.bytes);
  }

  /** Принять порцию из хранилища (порядок вызовов - по возрастанию номера). */
  adopt(index, bytes) {
    const n = Math.floor(bytes.length / REC);
    if (!n) return;
    const end = index * CHUNK + n;
    this._room(end);
    this._buf.set(bytes.subarray(0, n * REC), index * CHUNK * REC);
    this.count = Math.max(this.count, end);
    this.flushed = this.count;
    // номер последней записи и есть голова: seq растёт монотонно
    const last = this._view.getUint32((end - 1) * REC, true);
    if (last > this.seqHead) this.seqHead = last;
  }

  /**
   * Сдвинуть весь мир в прошлое на seconds (отладка: `__snow.timeTravel`).
   *
   * Двигается эпоха, а не времена записей: t - беззнаковое смещение от неё, и
   * запись первой минуты ушла бы в минус. Сдвиг эпохи назад делает то же
   * самое для всех записей разом и ровно на столько же.
   */
  shift(seconds) {
    this.epoch -= Math.round(seconds);
  }

  stats() {
    return {
      records: this.count,
      bytes: this.bytes,
      seqHead: this.seqHead,
      epoch: this.epoch,
      mode: this.mode,
      loadMs: this.loadMs,
    };
  }
}
