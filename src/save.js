// Память мира (VISION.md: «мир копится»): сохранение в IndexedDB.
// Переживают перезагрузку: правки копания, карта следов/троп (уменьшенный
// снапшот), топливо костра, позиция игрока, лопата, топор, поленья,
// поленница и сваленные деревья. Смерть мир НЕ стирает. Сброс: кнопка в
// меню (reset()) или открыть с ?reset.
//
// Почему IndexedDB, а не localStorage (v0.15.1): запись асинхронная и не
// держит кадр (setItem мегабайтной строки давал иголку 30–85 мс каждые
// 30 секунд), правки хранятся типизированными массивами без JSON/base64,
// и квота — сотни МБ против ~5 МБ (обжитый мир упирался в лимит, после
// чего setItem молча падал и мир переставал сохраняться). Старый
// localStorage-сейв мигрирует при первом запуске автоматически.
const DB_NAME = 'snowfall';
const DB_STORE = 'save';
const DB_KEY = 'world';
const LS_KEY = 'snowfall.save.v1'; // старый формат — источник миграции и фолбэк
const INTERVAL = 30_000; // автосейв, мс
// Версия раскладки seeded-леса: срубы хранятся по id сосен, и после пересева
// (другой scatter/count) старые id указывают на другие деревья. При
// несовпадении версий срубы пропускаются, остальной мир восстанавливается.
const FOREST_V = 2;

// простое RLE поверх байтов снапшота следов: карта в основном нули,
// сжимается в десятки раз
function rle(u8) {
  const out = [];
  let i = 0;
  while (i < u8.length) {
    const v = u8[i];
    let n = 1;
    while (n < 255 && i + n < u8.length && u8[i + n] === v) n++;
    out.push(n, v);
    i += n;
  }
  return Uint8Array.from(out);
}

function unrle(u8, size) {
  const out = new Uint8Array(size);
  let o = 0;
  for (let i = 0; i < u8.length; i += 2) {
    out.fill(u8[i + 1], o, o + u8[i]);
    o += u8[i];
  }
  return out;
}

// base64 — только для старого localStorage-формата (чтение при миграции
// и запись в фолбэке, если IndexedDB недоступна)
function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 8192) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
  }
  return btoa(s);
}

function unb64(str) {
  const s = atob(str);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

const idbReq = (rq) =>
  new Promise((resolve, reject) => {
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });

export class SaveGame {
  constructor({
    digger, footprints, campfire, player,
    shovel = null, logs = null, axe = null, woodpile = null, lumber = null,
  }) {
    this.digger = digger;
    this.footprints = footprints;
    this.campfire = campfire;
    this.player = player;
    this.shovel = shovel;
    this.logs = logs;
    this.axe = axe;
    this.woodpile = woodpile;
    this.lumber = lumber;
    this.disabled = false; // взводит reset(): не дать автосейву записать мир обратно
    this.fpSize = 384 * 384 * 4; // размер снапшота следов (footprints.SNAP)
    this._db = null; // кэш соединения; null после неудачи → фолбэк на localStorage
    this._dbTried = false;
    this._fpCache = null; // последний RLE-снапшот следов — для sync-сейва (pagehide)
    this._saving = false; // защёлка от наложения автосейвов (sync-сейв игнорирует)
  }

  async _open() {
    if (this._dbTried) return this._db;
    this._dbTried = true;
    try {
      const rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(DB_STORE);
      this._db = await idbReq(rq);
    } catch (e) {
      this._db = null; // приватный режим/старый браузер — живём на localStorage
    }
    return this._db;
  }

  // читает сохранение и восстанавливает мир; вернуть false — мир новый
  async load() {
    if (new URLSearchParams(location.search).has('reset')) {
      await this._wipe();
      return false;
    }
    const db = await this._open();
    // основной путь: запись в IndexedDB
    if (db) {
      try {
        const d = await idbReq(db.transaction(DB_STORE).objectStore(DB_STORE).get(DB_KEY));
        if (d) {
          const entries = new Array(d.editsK.length);
          for (let i = 0; i < d.editsK.length; i++) entries[i] = [d.editsK[i], d.editsV[i]];
          this._fpCache = d.fp || null;
          this._apply({ ...d, edits: entries, fpBytes: d.fp ? unrle(d.fp, this.fpSize) : null });
          return true;
        }
      } catch (e) {
        // битая запись — начинаем чистую ночь, не ломая запуск
        try { await this._wipe(); } catch (e2) { /* ignore */ }
        return false;
      }
    }
    // миграция: старый localStorage-сейв (или фолбэк-среда без IndexedDB)
    let raw;
    try { raw = localStorage.getItem(LS_KEY); } catch (e) { return false; }
    if (!raw) return false;
    try {
      const d = JSON.parse(raw);
      this._apply({
        ...d,
        edits: Array.isArray(d.edits) ? d.edits : [],
        fpBytes: d.fp ? unrle(unb64(d.fp), this.fpSize) : null,
      });
      if (db) {
        // перенос удался — пишем новый формат и убираем старый ключ
        await this.save();
        try { localStorage.removeItem(LS_KEY); } catch (e) { /* ignore */ }
      }
      return true;
    } catch (e) {
      try { localStorage.removeItem(LS_KEY); } catch (e2) { /* ignore */ }
      return false;
    }
  }

  // общая часть восстановления: принимает нормализованные данные
  _apply(d) {
    if (d.edits && d.edits.length) this.digger.load(d.edits);
    if (d.fpBytes) this.footprints.restore(d.fpBytes);
    if (typeof d.fuel === 'number') this.campfire.fuel = d.fuel;
    if (typeof d.px === 'number') {
      this.player.pos.set(d.px, d.py + 0.05, d.pz); // чуть выше — не провалиться
    }
    // лопата стоит там, где её оставили (или снова в руках)
    if (this.shovel && d.shv) {
      this.shovel.place(d.shv.x, d.shv.y, d.shv.z, d.shv.yaw || 0);
      if (d.shv.held) this.shovel.take();
    }
    // топор стоит там, где его оставили (или снова в руках)
    if (this.axe && d.axe) {
      this.axe.place(d.axe.x, d.axe.y, d.axe.z, d.axe.yaw || 0);
      if (d.axe.held) this.axe.take();
    }
    // штабель поленницы — сколько было, столько и лежит
    if (this.woodpile && typeof d.pile === 'number') {
      this.woodpile.count = Math.min(d.pile, this.woodpile.capacity);
      this.woodpile._refresh();
    }
    // сваленные деревья лежат, зарубки на стоящих — на месте
    if (this.lumber && Array.isArray(d.fells) && d.forestV === FOREST_V) {
      this.lumber.restore(d.fells, this.player.pos);
    }
    // брошенные поленья лежат, где их бросили; недонесённое — снова в руках
    if (this.logs && Array.isArray(d.logs)) this.logs.restore(d.logs);
    if (d.carry) this.player.carrying = true;
  }

  // сбор состояния мира — синхронный и дешёвый (правки уходят двумя
  // типизированными массивами, без JSON); снапшот следов берётся из _fpCache
  _collect() {
    const e = this.digger.edits;
    const editsK = new Int32Array(e.size);
    const editsV = new Float32Array(e.size);
    let i = 0;
    for (const [k, v] of e) {
      editsK[i] = k;
      editsV[i] = v;
      i++;
    }
    const p = this.player.pos;
    const data = {
      v: 2,
      editsK,
      editsV,
      fp: this._fpCache,
      fuel: this.campfire.fuel,
      px: p.x, py: p.y, pz: p.z,
      carry: this.player.carrying ? 1 : 0,
    };
    if (this.logs) data.logs = this.logs.serialize();
    if (this.woodpile) data.pile = this.woodpile.count;
    if (this.lumber) {
      data.fells = this.lumber.serialize();
      data.forestV = FOREST_V;
    }
    if (this.axe) {
      const a = this.axe.pos;
      data.axe = { x: a.x, y: a.y, z: a.z, yaw: this.axe.yaw, held: this.axe.held ? 1 : 0 };
    }
    if (this.shovel) {
      const s = this.shovel.pos;
      data.shv = { x: s.x, y: s.y, z: s.z, yaw: this.shovel.yaw, held: this.shovel.held ? 1 : 0 };
    }
    return data;
  }

  // sync: путь pagehide/скрытой вкладки — ничего не ждём перед записью
  // (снапшот следов берётся из кэша прошлого автосейва), транзакция
  // стартует до смерти страницы. Обычный автосейв обновляет снапшот
  // асинхронным readback'ом — без стойла GPU в кадре.
  async save({ sync = false } = {}) {
    if (this.disabled) return;
    if (this._saving && !sync) return; // прошлый ещё пишется — интервал догонит
    this._saving = true;
    try {
      if (!sync) {
        try {
          this._fpCache = rle(await this.footprints.snapshotAsync());
        } catch (e) {
          this._fpCache = rle(this.footprints.snapshot()); // нет PBO — раз в 30с терпимо
        }
      } else if (!this._fpCache) {
        this._fpCache = rle(this.footprints.snapshot()); // самый первый сейв — синхронно
      }
      const data = this._collect();
      const db = await this._open();
      if (db) {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(data, DB_KEY);
        await new Promise((resolve, reject) => {
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
      } else {
        this._saveLS(data);
      }
    } catch (e) {
      // квота/приватный режим: игра живёт дальше без памяти
    } finally {
      this._saving = false;
    }
  }

  // фолбэк-среда без IndexedDB: старый localStorage-формат, как в v0.15.0
  _saveLS(d) {
    const edits = new Array(d.editsK.length);
    for (let i = 0; i < d.editsK.length; i++) {
      edits[i] = [d.editsK[i], Math.round(d.editsV[i] * 100) / 100];
    }
    const out = {
      edits,
      fp: d.fp ? b64(d.fp) : undefined,
      fuel: d.fuel,
      px: d.px, py: d.py, pz: d.pz,
      carry: d.carry,
      logs: d.logs, pile: d.pile, fells: d.fells, forestV: d.forestV,
      axe: d.axe, shv: d.shv,
    };
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(out));
    } catch (e) { /* квота — живём без памяти */ }
  }

  async _wipe() {
    try { localStorage.removeItem(LS_KEY); } catch (e) { /* приватный режим */ }
    const db = await this._open();
    if (db) {
      try {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(DB_KEY);
        await new Promise((resolve) => { tx.oncomplete = tx.onerror = tx.onabort = resolve; });
      } catch (e) { /* ignore */ }
    }
  }

  // стереть память мира и начать ночь заново (кнопка в меню). Автосейв
  // глушится: иначе pagehide перед перезагрузкой записал бы мир обратно.
  async reset() {
    this.disabled = true;
    await this._wipe();
    location.reload();
  }

  start() {
    setInterval(() => this.save(), INTERVAL);
    addEventListener('pagehide', () => this.save({ sync: true }));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.save({ sync: true });
    });
  }
}
