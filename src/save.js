// Память мира (VISION.md: «мир копится»): журнал записей в IndexedDB.
//
// Мир = семя + журнал. Рельеф, лес и камни пересобираются по семени одинаково
// каждый запуск, поэтому хранить их незачем; хранится только то, что игрок
// изменил своими руками, и время каждого изменения (journal.js). Из времени
// записей и времени последнего сохранения считается, что случилось с миром,
// пока игрока не было: лес отрос, костёр прогорел, тропы замело, ямы затянуло
// (growth.js).
//
// Раскладка хранилища (база `snowfall`):
//   world    - заголовок, одна запись: версия, эпоха, время сохранения,
//              голова журнала, позиция, инструменты, поленья, поленница,
//              топливо и старые счётчики добытого для одноразового переноса.
//              То, чего мало и что меняется
//              редко, живёт последним состоянием - записи под него не нужны.
//   journal  - сам журнал порциями по 4096 записей (ключ - номер порции):
//              автосейв дописывает последнюю, а не переписывает всё.
//   cache    - снимок вокселей и следов. Журнал - истина, снимок - КЭШ: если
//              cache.seq совпал с головой журнала, правки берутся готовыми,
//              иначе воспроизводятся все копки с нуля, и кэш переписывается.
//   save     - старая запись v2, только для миграции; после переноса удаляется.
//
// Почему IndexedDB, а не localStorage (v0.15.1): запись асинхронная и не
// держит кадр (setItem мегабайтной строки давал иголку 30–85 мс каждые
// 30 секунд), правки хранятся типизированными массивами без JSON/base64,
// и квота — сотни МБ против ~5 МБ. Смерть мир НЕ стирает. Сброс: кнопка в
// меню (reset()) или открыть с ?reset.
import { Journal, KIND } from './journal.js';
import { Inventory } from './inventory.js';
import { itemByMaterial, ITEM_INDEX } from './data/items.js';
import { RECIPES } from './data/recipes.js';
import { placedItemsFrom } from './placements.js';
import { MATERIAL } from './caves.js';
import { HAMMER_BLOCK } from './hammer-block.js';
import { createHearthState } from './hearth-state.js';
import {
  regrowStage, healedHits, fuelAfter, trailFade, pitFill, PIT_DEPTH,
} from './growth.js';

const DB_NAME = 'snowfall';
const DB_VER = 2; // v1 - один store `save` (v2 записи); v2 - журнал, заголовок, кэш
const OLD_STORE = 'save'; // старая запись, источник миграции
const OLD_KEY = 'world';
const HEAD_STORE = 'world';
const HEAD_KEY = 'header';
const JOURNAL_STORE = 'journal';
const CACHE_STORE = 'cache';
const CACHE_KEY = 'voxels';
const LS_KEY = 'snowfall.save.v1'; // самый старый формат — источник миграции
const LS_KEY3 = 'snowfall.save.v3'; // фолбэк без IndexedDB: заголовок, кэш и журнал
const INTERVAL = 30_000; // автосейв, мс
// Версия раскладки seeded-леса: записи журнала ссылаются на сосны по id, и
// после пересева (другой scatter/count) старые id указывают на другие деревья.
// При несовпадении версий рубка пропускается, остальной мир восстанавливается.
const FOREST_V = 2;
// Границы, в которых позиция игрока считается осмысленной. Террейн 400 м,
// то есть ±200 по горизонтали; по высоте берём с запасом на пещеры и гребни.
// Проверка не от недоверия к себе: NaN, однажды попавший в позицию (провал
// сквозь мир, деление на ноль в физике), закреплялся автосейвом навсегда, и
// каждый следующий запуск начинался падением.
const POS_LIMIT = 210;
const POS_LOW = -60;
const POS_HIGH = 200;

// Позиция из сейва, которой можно верить. Всё прочее (NaN, дыра под миром,
// координата за краем террейна) молча отбрасывается: остальной мир при этом
// восстанавливается, а игрок просто встаёт на место первой ночи.
function sanePos(x, y, z) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
  if (Math.abs(x) > POS_LIMIT || Math.abs(z) > POS_LIMIT) return false;
  return y > POS_LOW && y < POS_HIGH;
}

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

const nowSec = () => Math.round(Date.now() / 1000);
// Старые сохранения ещё не имеют revision: сравниваем их заголовок целиком.
const revisionOf = (head) => head?.revision ?? JSON.stringify(head ?? null);
const newRevision = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;

/**
 * Свернуть записи рубки в состояние леса на «сейчас».
 *
 * Отдельной чистой функцией, потому что это единственное место, где журнал
 * превращается обратно в мир, и проверять его хочется счётом, без сцены.
 * Возвращает то, что понимает lumber.restore, плюс список отросших сосен.
 */
export function forestFrom(records, worldNow) {
  const st = new Map();
  for (const r of records) {
    if (r.kind !== KIND.CHOP && r.kind !== KIND.FELL && r.kind !== KIND.SPLIT) continue;
    let s = st.get(r.id);
    if (!s) st.set(r.id, (s = { hits: 0, hitAt: 0, downed: 0, yaw: 0, wood: null, goneAt: null }));
    if (r.kind === KIND.CHOP) {
      s.hits = r.hits;
      s.hitAt = r.t;
    } else if (r.kind === KIND.FELL) {
      s.downed = 1;
      s.yaw = r.yaw;
      s.hits = 0;
      s.wood = null; // запас считает сама сосна при падении (lumber._woodFor)
      s.goneAt = null;
    } else {
      s.wood = r.left;
      s.goneAt = r.left <= 0 ? r.t : null;
    }
  }

  const fells = [];
  const regrow = [];
  for (const [id, s] of st) {
    if (s.goneAt !== null) {
      // ствол вышел весь: на месте пня считается отрастание
      fells.push([id, 1, 0, s.yaw]);
      const stage = regrowStage(worldNow - s.goneAt);
      if (stage !== 'stump') regrow.push([id, stage]);
    } else if (s.downed) {
      fells.push([id, 1, s.wood, s.yaw]); // лежит как лежит: ствол не отрастает
    } else if (s.hits > 0) {
      const hits = healedHits(s.hits, worldNow - s.hitAt);
      if (hits > 0) fells.push([id, 0, hits]);
    }
  }
  return { fells, regrow };
}

export class SaveGame {
  constructor({
    digger, footprints, campfire, player,
    shovel = null, logs = null, axe = null, pickaxe = null, hammer = null,
    torch = null, woodpile = null, lumber = null, yard = null, homestead = null,
  }) {
    this.digger = digger;
    this.footprints = footprints;
    this.campfire = campfire;
    this.player = player;
    this.shovel = shovel;
    this.logs = logs;
    this.axe = axe;
    this.pickaxe = pickaxe;
    this.hammer = hammer;
    this.torch = torch;
    this.woodpile = woodpile;
    this.lumber = lumber;
    this.yard = yard;
    this.homestead = homestead;
    this.hearth = null;
    this._pendingHearth = null;
    this.disabled = false; // взводит reset(): не дать автосейву записать мир обратно
    this.fpSize = 384 * 384 * 4; // размер снапшота следов (footprints.SNAP)
    // Журнал заводится сразу, до чтения хранилища: события мира могут начаться
    // раньше, чем приедет прочитанное, и попасть им некуда быть не должно.
    // Эпоху load() подменит на ту, что лежит в заголовке.
    this.journal = new Journal();
    this.inventory = new Inventory(this.journal);
    this._db = null; // кэш соединения; null после неудачи → фолбэк на localStorage
    this._dbPromise = null; // один общий open: параллельный вызов не получает ложный null
    this._fpCache = null; // последний RLE-снапшот следов — для sync-сейва действий/выхода
    this._saving = false;
    this._savingPromise = Promise.resolve();
    this._saveGeneration = 0; // более новый sync-сейв отменяет старый async snapshot
    this._revision = revisionOf(null);
    this.blocked = false; // конфликт или ошибка чтения: старый мир нельзя записывать поверх нового
    this.status = 'ok';
    this.onStatus = null;
    // Сдвиг времени сохранения назад: им живёт отладочный timeTravel, и только он.
    this._shift = 0;
    // Прочитанная, но ещё не применённая рубка: лес приезжает по сети позже,
    // чем читается сейв (см. forestReady).
    this._forest = null;
    this.mined = { soil: 0, stone: 0, ore: 0 }; // читается только при переносе старого заголовка
    this._wire();
  }

  _status(status) {
    if (this.status === status) return;
    this.status = status;
    this.onStatus?.(status);
  }

  _conflict() {
    this.blocked = true;
    this._status('conflict');
  }

  _readError() {
    this.blocked = true;
    this._status('read-error');
  }

  _saveError() {
    if (!this.blocked && !this.disabled) this._status('error');
    return false;
  }

  // Мир сам рассказывает журналу, что с ним делают: копок, удар инструментом,
  // полено в костре. Через колбэки, а не проверкой состояния по таймеру, -
  // иначе два копка между автосейвами слились бы в один.
  _wire() {
    this.digger.onStroke = (c, yaw, sign, strength, material = 0, tool = 'shovel') => {
      this.journal.dig(c.x, c.y, c.z, yaw, sign, strength, undefined, material, tool);
      if ((tool === 'pickaxe' || tool === 'hammer') && sign < 0 && strength > 0) {
        const item = itemByMaterial(material);
        if (item) {
          if (this.onMined) this.onMined(item.id, c);
          else this.inventory.add(item.id, 1);
        }
      }
    };
    if (this.lumber) {
      this.lumber.onEvent = (kind, p) => {
        if (kind === 'chop') this.journal.chop(p.id, p.hits);
        else if (kind === 'fell') this.journal.fell(p.id, p.fallYaw);
        else this.journal.split(p.id, p.wood);
      };
    }
    if (this.campfire) this.campfire.onFuel = () => this.journal.fuel();
  }

  /** Поленница изменилась (зовёт main.js: своего события у штабеля нет). */
  notePile(count) {
    this.journal.pile(count);
  }

  attachHearth(cabin) {
    this.hearth = cabin;
    if (this._pendingHearth) cabin.restore(this._pendingHearth.state, {elapsedSeconds:this._pendingHearth.away});
    this._pendingHearth = null;
  }

  _hearthSnapshot() {
    if (this.hearth) return this.hearth.snapshot();
    if (!this._pendingHearth) return null;
    // A pagehide can happen before the cabin finishes loading. Store its
    // already-aged fuel, not the pre-offline state with a fresh savedAt.
    const state = createHearthState();
    state.restore(this._pendingHearth.state, { elapsedSeconds: this._pendingHearth.away });
    return state.snapshot();
  }

  /** Предмет поставлен в мир или снят с прежней позиции. */
  notePlace(item, position, take = false) {
    const id = ITEM_INDEX[item];
    if (id === undefined) return 0;
    return this.journal.place(id, position.x, position.y, position.z, undefined, take);
  }

  /**
   * Лес приехал — применить придержанную рубку и отрастание.
   *
   * Зовётся волной отделки в main.js ДО того, как лес попадёт в кадр: пни,
   * лежащие стволы и подросший из пней молодняк оказываются на местах сразу,
   * ничего не «падает» и не «растёт на глазах».
   *
   * Держать запись обязательно: сейв читается раньше леса. С журналом это уже
   * не вопрос сохранности (записи никуда не денутся и без применения), но
   * порядок остаётся прежним - лес встаёт готовым, а не собирается при игроке.
   */
  forestReady() {
    if (!this._forest || !this.lumber) return;
    try {
      this.lumber.restore(this._forest.fells, this.player.pos);
      for (const [id, stage] of this._forest.regrow) {
        const p = this.lumber.pines[id];
        if (p && !p.culled) this.lumber.regrow(p, stage);
      }
    } catch (e) {
      console.warn('рубка не восстановлена:', e);
    }
    this._forest = null;
  }

  _open() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = (async () => {
      try {
        const rq = indexedDB.open(DB_NAME, DB_VER);
        rq.onupgradeneeded = () => {
          const db = rq.result;
          // старый store не трогаем: из него ещё предстоит перенести мир
          for (const name of [OLD_STORE, HEAD_STORE, JOURNAL_STORE, CACHE_STORE]) {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
          }
        };
        this._db = await idbReq(rq);
      } catch (e) {
        this._db = null; // приватный режим/старый браузер — живём на localStorage
      }
      return this._db;
    })();
    return this._dbPromise;
  }

  // читает сохранение и восстанавливает мир; вернуть false — мир новый
  async load() {
    const debug = new URLSearchParams(location.search).has('debug');
    if (new URLSearchParams(location.search).has('reset')) {
      await this._wipe();
      return false;
    }
    const db = await this._open();
    if (!db) return this._loadLS();

    // Чтение и применение разведены НАМЕРЕННО. Стереть мир игрока можно
    // только тогда, когда сама запись нечитаема: раньше под ту же гребёнку
    // попадал сбой на полпути применения и любая случайная осечка хранилища,
    // и ночь, прожитая человеком, исчезала из-за одной неудачной попытки.
    let head;
    let chunks = null;
    let cache = null;
    try {
      const tx = db.transaction([HEAD_STORE, JOURNAL_STORE, CACHE_STORE]);
      head = await idbReq(tx.objectStore(HEAD_STORE).get(HEAD_KEY));
      if (head) {
        chunks = await idbReq(tx.objectStore(JOURNAL_STORE).getAll());
        cache = await idbReq(tx.objectStore(CACHE_STORE).get(CACHE_KEY));
      }
    } catch (e) {
      console.warn('сейв не прочитан, мир оставлен как есть:', e);
      this._readError();
      return false;
    }
    if (!head) {
      const migrated = await this._migrate(db);
      if (!migrated) return false;
      head = migrated.head;
      chunks = migrated.chunks;
      cache = migrated.cache;
    }

    this._revision = revisionOf(head);

    const t0 = typeof performance === 'undefined' ? Date.now() : performance.now();
    try {
      this.journal.epoch = head.epoch;
      if (chunks) chunks.forEach((bytes, i) => this.journal.adopt(i, bytes));
      const moved = this._apply(head, cache, debug);
      if (moved) await this._persistMinedMigration(db, head, cache);
    } catch (e) {
      // мир восстановлен наполовину: это плохо, но не повод забыть его
      console.warn('сейв применён не целиком:', e);
      this._readError();
    }
    this.journal.loadMs = Math.round(
      ((typeof performance === 'undefined' ? Date.now() : performance.now()) - t0) * 10
    ) / 10;
    if (debug) {
      console.info(
        `[журнал] ${this.journal.count} записей (${this.journal.bytes} Б), ` +
        `воксели: ${this.journal.mode}, загрузка ${this.journal.loadMs} мс`
      );
    }
    return true;
  }

  // Восстановление мира из заголовка и кэша. Всё, что успело случиться без
  // игрока, считается ровно здесь и ровно один раз (growth.js).
  _apply(head, cache, debug = false) {
    const away = Math.max(0, nowSec() - (head.savedAt || nowSec()));
    const worldNow = this.journal.now();
    const oldSeq = head.seqHead;
    const cacheWasCurrent = !!cache && cache.seq === oldSeq;
    if (this.yard && head.resources !== undefined && (!Array.isArray(head.resources) ||
        head.resources.some((record) => !record || record.kind === 'log' ||
          !Object.hasOwn(ITEM_INDEX, record.kind) || !sanePos(record.x, record.y, record.z) ||
          !Number.isFinite(record.yaw)))) {
      throw new Error('Не удалось восстановить предметы на земле');
    }
    this.inventory.restore(this.journal.records());
    const mined = head.mined || {};
    let moved = 0;
    for (const id of ['soil', 'stone', 'ore']) {
      moved += this.inventory.add(id, Math.max(0, Math.floor(Number(mined[id]) || 0)));
    }
    const p = head.player || {};
    // Старые заголовки знали полено в руках, но ещё не писали его как ITEM.
    const carryKind = p.carry ? (p.carryKind || 'log') : null;
    if (p.carry && carryKind === 'log' && this.inventory.count('log') === 0) moved += this.inventory.add('log', 1);
    this.player.carryKind = carryKind && carryKind !== 'torch' && this.inventory.count(carryKind) > 0 ? carryKind : null;
    this._pendingHearth = { state: head.hearth || createHearthState().snapshot(), away: head.hearth ? away : 0 };
    if (this.hearth) this.attachHearth(this.hearth);
    this.mined = { soil: 0, stone: 0, ore: 0 };
    head.mined = { ...this.mined };
    if (moved) {
      head.seqHead = this.journal.seqHead;
      if (cacheWasCurrent) cache.seq = head.seqHead;
    }

    // ---- воксели: кэш, если он совпал с головой журнала, иначе воспроизведение
    const fill = pitFill(away);
    if (cache && cache.seq === head.seqHead && cache.editsK) {
      const entries = new Array(cache.editsK.length);
      for (let i = 0; i < cache.editsK.length; i++) entries[i] = [cache.editsK[i], cache.editsV[i]];
      const materials = new Array(cache.editMatK?.length || 0);
      for (let i = 0; i < materials.length; i++) materials[i] = [cache.editMatK[i], cache.editMatV[i]];
      this.digger.load(entries, { fill, materials });
      this.journal.mode = 'cache';
    } else {
      this._replayDigs(fill);
      this.journal.mode = 'replay';
    }
    // Foundations must see the restored excavation, not the untouched terrain.
    // A malformed or unsupported structure must not be silently replaced by
    // an empty one and then overwritten by autosave.
    if (this.homestead && this.homestead.restore(head.homestead || { version: 1, pieces: [] }) === false) {
      throw new Error('Не удалось восстановить постройку');
    }
    this.yard?.restore(head.resources || []);
    // Кэш переписывается ближайшим автосейвом: seq заголовка уже наш, а правки
    // после осадки ям отличаются от лежащих в хранилище.
    this._fpCache = null;

    // ---- следы: тропы заметает метелью, пока никто не ходит
    const fp = cache && cache.fp ? cache.fp : null;
    if (fp) {
      const bytes = unrle(fp, this.fpSize);
      const k = trailFade(away);
      if (k < 1) for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(bytes[i] * k);
      this.footprints.restore(bytes);
      if (debug) console.info(`[журнал] тропы x${k.toFixed(3)}, ямы x${fill.toFixed(3)}`);
    }

    // ---- костёр прогорел на углях, пока игрока не было
    if (typeof head.fuel === 'number') this.campfire.fuel = fuelAfter(head.fuel, away);

    if (sanePos(p.x, p.y, p.z)) {
      this.player.pos.set(p.x, p.y + 0.05, p.z); // чуть выше — не провалиться
    }
    const tools = head.tools || {};
    // лопата стоит там, где её оставили (или снова в руках)
    if (this.shovel && tools.shovel) {
      this.shovel.place(tools.shovel.x, tools.shovel.y, tools.shovel.z, tools.shovel.yaw || 0);
      if (tools.shovel.held && !this.player.carryKind) this.shovel.take();
    }
    // топор стоит там, где его оставили (или снова в руках)
    if (this.axe && tools.axe) {
      this.axe.place(tools.axe.x, tools.axe.y, tools.axe.z, tools.axe.yaw || 0);
      if (tools.axe.held && !this.player.carryKind && !this.shovel?.held) this.axe.take();
    }
    // кирка сохраняет и место в мире, и состояние в руке
    if (this.pickaxe && tools.pickaxe) {
      this.pickaxe.place(tools.pickaxe.x, tools.pickaxe.y, tools.pickaxe.z, tools.pickaxe.yaw || 0);
      if (tools.pickaxe.held && !this.player.carryKind && ![this.shovel, this.axe].some(tool => tool?.held)) this.pickaxe.take();
    }
    if (this.hammer && tools.hammer) {
      this.hammer.place(tools.hammer.x, tools.hammer.y, tools.hammer.z, tools.hammer.yaw || 0);
      if (tools.hammer.held && !this.player.carryKind && ![this.shovel, this.axe, this.pickaxe].some(tool => tool?.held)) this.hammer.take();
    }
    if (this.torch) {
      this.torch.restore(placedItemsFrom(this.journal.records(), 'torch'));
      const restored = this.torch.restoreState?.(head.torchState, {
        elapsedSeconds: away, legacyHeld: !!tools.torch?.held,
      });
      if (head.torchState && restored === false) throw new Error('Не удалось восстановить состояние факелов');
      if (tools.torch?.held && this.inventory.count('torch') > 0 && !this.player.carryKind &&
        ![this.shovel, this.axe, this.pickaxe, this.hammer].some((tool) => tool?.held)) {
        if (!this.torch.held) this.torch.take();
      }
    }
    // штабель поленницы — сколько было, столько и лежит
    if (this.woodpile && typeof head.pile === 'number') {
      this.woodpile.count = Math.min(head.pile, this.woodpile.capacity);
      this.woodpile._refresh();
    }
    // Рубка и отрастание применяются не здесь, а в forestReady: лес приезжает
    // по сети позже, чем читается сейв.
    if (head.forestV === FOREST_V) this._forest = forestFrom(this.journal.records(), worldNow);
    // брошенные поленья лежат, где их бросили; недонесённое — снова в руках
    if (this.logs && Array.isArray(head.logs)) this.logs.restore(head.logs);
    this.player.carrying = !!this.player.carryKind;
    return moved;
  }

  // Перенос счётчиков и их обнуление ложатся одной транзакцией, поэтому
  // повторная загрузка не сможет начислить старую добычу второй раз.
  async _persistMinedMigration(db, head, cache) {
    try {
      await this._write({ head, cache, chunks: this.journal.pending(), count: this.journal.count }, this._saveGeneration);
    } catch (e) {
      console.warn('старая добыча перенесена только в памяти:', e);
      this._saveError();
    }
  }

  // Воспроизведение копок из журнала: тот же метод копателя, что зовёт лопата,
  // с теми же параметрами. Чанки перестраиваются один раз в конце - тысяча
  // взмахов иначе перестроила бы одни и те же чанки тысячу раз.
  _replayDigs(fill) {
    const c = { x: 0, y: 0, z: 0 };
    this.digger.replayBegin();
    try {
      for (const r of this.journal.records()) {
        if (r.kind === KIND.PLACE && r.id === ITEM_INDEX.block && !r.take) {
          this.digger.blockStroke(
            { x: r.x, y: r.y + HAMMER_BLOCK.half.y, z: r.z },
            MATERIAL.STONE
          );
          continue;
        }
        if (r.kind === KIND.DIG) {
          c.x = r.x;
          c.y = r.y;
          c.z = r.z;
          if (r.tool === 'pickaxe') this.digger.pickaxeStroke(c, r.strength, r.material);
          else if (r.tool === 'hand') {
            const recipe = RECIPES.find((entry) =>
              entry.verb === 'build' && entry.give.material === r.material
            );
            this.digger.buildStroke(c, recipe?.give.radius || 0.5, r.strength, r.material);
          } else this.digger.shovelStroke(c, r.yaw, r.sign, r.strength, r.material);
        }
      }
      if (fill < 1) this.digger.settle(fill, PIT_DEPTH);
    } finally {
      this.digger.replayEnd();
    }
  }

  /**
   * Перенос старой записи v2 в журнал. Делается один раз, после чего старая
   * запись удаляется.
   *
   * У правок вокселей истории нет — они и уезжают в кэш как есть, без записей
   * DIG; чтобы кэш при этом считался годным, голова журнала берётся равной
   * его seq. Рубка, наоборот, разворачивается в записи: время у всех одно —
   * момент переноса, потому что настоящего у них не сохранилось.
   */
  async _migrate(db) {
    let d;
    try {
      d = await idbReq(db.transaction(OLD_STORE).objectStore(OLD_STORE).get(OLD_KEY));
    } catch (e) {
      this._readError();
      return null;
    }
    if (!d) return null;

    let head;
    let cache;
    try {
      const t = this.journal.now();
      if (Array.isArray(d.fells) && d.forestV === FOREST_V) {
        for (const [id, downed, a, yaw] of d.fells) {
          if (!downed) this.journal.chop(id, a, t);
          else {
            this.journal.fell(id, yaw || 0, t);
            this.journal.split(id, a, t);
          }
        }
      }
      head = {
        v: 3,
        epoch: this.journal.epoch,
        savedAt: nowSec(),
        seqHead: this.journal.seqHead,
        forestV: FOREST_V,
        fuel: typeof d.fuel === 'number' ? d.fuel : 0.8,
        player: { x: d.px, y: d.py, z: d.pz, carry: d.carry ? 1 : 0 },
        tools: { shovel: d.shv || null, axe: d.axe || null, pickaxe: null, hammer: null },
        logs: d.logs || [],
        pile: d.pile || 0,
      };
      cache = { seq: head.seqHead, editsK: d.editsK, editsV: d.editsV, fp: d.fp || null };
    } catch (e) {
      console.warn('старый сейв разобран не был:', e);
      this._readError();
      return null;
    }

    try {
      const saved = await this._write({
        head, cache, chunks: this.journal.pending(), count: this.journal.count, migrate: true,
      }, this._saveGeneration);
      if (!saved) return null;
    } catch (e) {
      console.warn('перенос старой записи не удался:', e);
      this._readError();
      return null;
    }
    // Записи уже лежат в журнале в памяти - перечитывать их из хранилища
    // незачем, потому и chunks здесь null.
    return { head, chunks: null, cache };
  }

  // Фолбэк-среда без IndexedDB: заголовок, кэш и журнал в localStorage.
  _loadLS() {
    let raw;
    try { raw = localStorage.getItem(LS_KEY3) || localStorage.getItem(LS_KEY); }
    catch (e) { this._readError(); return false; }
    if (!raw) return false;
    try {
      const d = JSON.parse(raw);
      this._revision = revisionOf(d.v === 3 ? d.head : null);
      const head = d.v === 3 ? d.head : {
        v: 3,
        epoch: this.journal.epoch,
        savedAt: nowSec(),
        seqHead: 0,
        forestV: d.forestV,
        fuel: d.fuel,
        player: { x: d.px, y: d.py, z: d.pz, carry: d.carry },
        tools: { shovel: d.shv || null, axe: d.axe || null, pickaxe: null, hammer: null },
        logs: d.logs || [],
        pile: d.pile || 0,
      };
      const editsK = [];
      const editsV = [];
      for (const [k, v] of d.edits || []) {
        editsK.push(k);
        editsV.push(v);
      }
      const editMatK = [];
      const editMatV = [];
      for (const [k, v] of d.editMaterials || []) {
        editMatK.push(k);
        editMatV.push(v);
      }
      if (d.journal) this.journal.adopt(0, unb64(d.journal));
      this.journal.epoch = head.epoch;
      this._apply(head, {
        seq: head.seqHead, editsK, editsV, editMatK, editMatV,
        fp: d.fp ? unb64(d.fp) : null,
      });
      // Миграцию запишет ближайший сейв с проверкой версии, как и обычные изменения.
      // рубка старого формата: у неё нет журнала, применяем как лежала
      if (d.v !== 3 && Array.isArray(d.fells) && d.forestV === FOREST_V) {
        this._forest = { fells: d.fells, regrow: [] };
      }
      return true;
    } catch (e) {
      this._readError();
      return false;
    }
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
    const em = this.digger.editMaterials || new Map();
    const editMatK = new Int32Array(em.size);
    const editMatV = new Uint8Array(em.size);
    i = 0;
    for (const [k, v] of em) {
      editMatK[i] = k;
      editMatV[i] = v;
      i++;
    }
    const p = this.player.pos;
    const head = {
      v: 3,
      epoch: this.journal.epoch,
      savedAt: nowSec() - this._shift,
      seqHead: this.journal.seqHead,
      forestV: FOREST_V,
      fuel: this.campfire.fuel,
      player: { x: p.x, y: p.y, z: p.z, carry: this.player.carrying ? 1 : 0,
        carryKind: this.player.carrying ? (this.player.carryKind || 'log') : null },
      tools: { shovel: null, axe: null, pickaxe: null, hammer: null, torch: { held: this.torch?.held ? 1 : 0 } },
      logs: this.logs ? this.logs.serialize() : [],
      pile: this.woodpile ? this.woodpile.count : 0,
      mined: { ...this.mined },
      resources: this.yard?.serialize() || [],
      homestead: this.homestead?.serialize() || {version:1,pieces:[]},
      hearth: this._hearthSnapshot(),
      torchState: this.torch?.snapshot?.() || null,
    };
    if (this.axe) {
      const a = this.axe.pos;
      head.tools.axe = { x: a.x, y: a.y, z: a.z, yaw: this.axe.yaw, held: this.axe.held ? 1 : 0 };
    }
    if (this.shovel) {
      const s = this.shovel.pos;
      head.tools.shovel = { x: s.x, y: s.y, z: s.z, yaw: this.shovel.yaw, held: this.shovel.held ? 1 : 0 };
    }
    if (this.pickaxe) {
      const p = this.pickaxe.pos;
      head.tools.pickaxe = { x: p.x, y: p.y, z: p.z, yaw: this.pickaxe.yaw, held: this.pickaxe.held ? 1 : 0 };
    }
    if (this.hammer) {
      const h = this.hammer.pos;
      head.tools.hammer = { x: h.x, y: h.y, z: h.z, yaw: this.hammer.yaw, held: this.hammer.held ? 1 : 0 };
    }
    // Кэш вокселей: он ровно того возраста, что и голова журнала, — по этому
    // совпадению загрузка и решает, верить ему или воспроизводить копки.
    const cache = { seq: head.seqHead, editsK, editsV, editMatK, editMatV, fp: this._fpCache };
    return { head, cache, chunks: this.journal.pending(), count: this.journal.count,
      journalBytes: this._db ? null : this.journal.snapshot() };
  }

  _write(data, generation) {
    const current = () => generation === this._saveGeneration && !this.disabled && !this.blocked;
    if (!current()) return Promise.resolve(false);
    // The fallback may wait for another tab's lock. Freeze ITEM/PLACE at the
    // same moment as physical resources, never read the live journal later.
    if (!this._db && !data.journalBytes) data.journalBytes = this.journal.snapshot();
    data.head.revision = newRevision();

    const write = (db) => {
      if (!current()) return Promise.resolve(false);
      if (!db) {
        // localStorage не имеет транзакций: проверка и запись выполняются
        // под общим замком всех вкладок. Без замка безопаснее сообщить об ошибке.
        const locks = globalThis.navigator?.locks;
        if (!locks) return Promise.reject(new Error('Хранилище не поддерживает безопасную запись'));
        return locks.request('snowfall-save', () => {
          if (!current()) return false;
          const raw = localStorage.getItem(LS_KEY3);
          const head = raw ? JSON.parse(raw).head : null;
          if (revisionOf(head) !== this._revision) { this._conflict(); return false; }
          this._saveLS(data); // ошибка записи должна дойти до save(), а не стать успехом
          this._revision = revisionOf(data.head);
          this._status('ok');
          return true;
        });
      }
      // При открытом соединении транзакция создаётся синхронно, но puts
      // зависят от read.onsuccess. Поэтому pagehide — лишь best effort:
      // закрытие страницы может оборвать выполнение до постановки записи.
      const stores = [HEAD_STORE, JOURNAL_STORE, CACHE_STORE];
      if (data.migrate) stores.push(OLD_STORE);
      const tx = db.transaction(stores, 'readwrite');
      const header = tx.objectStore(HEAD_STORE);
      const read = header.get(HEAD_KEY);
      return new Promise((resolve, reject) => {
        let cancelled = false;
        read.onsuccess = () => {
          if (!current()) { cancelled = true; tx.abort(); return; }
          if (revisionOf(read.result) !== this._revision) {
            cancelled = true;
            tx.abort();
            this._conflict();
            return;
          }
          try {
            header.put(data.head, HEAD_KEY);
            if (data.cache) tx.objectStore(CACHE_STORE).put(data.cache, CACHE_KEY);
            const j = tx.objectStore(JOURNAL_STORE);
            for (const [index, bytes] of data.chunks) j.put(bytes, index);
            if (data.migrate) tx.objectStore(OLD_STORE).delete(OLD_KEY);
          } catch (e) { tx.abort(); reject(e); }
        };
        tx.oncomplete = () => {
          // хвост журнала лёг в хранилище — следующий автосейв начнёт с него
          if (data.count > this.journal.flushed) this.journal.flushed = data.count;
          this._revision = revisionOf(data.head);
          if (!this.blocked) this._status('ok');
          resolve(true);
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => cancelled ? resolve(false) : reject(tx.error);
      });
    };

    return this._db ? write(this._db) : this._open().then(write);
  }

  // sync: завершённые действия и попытка сохранения при скрытии/выходе.
  // Состояние снимается с кэшем следов без предварительного await, однако
  // долговечность записи подтверждает только завершение её Promise.
  // Номер поколения не даёт старому
  // async snapshot перезаписать более свежую запись после возвращения GPU.
  save({ sync = false } = {}) {
    if (this.disabled || this.blocked) return Promise.resolve(false);
    // Обычный таймер не должен инвалидировать уже запущенную запись: он
    // просто дожидается её. Синхронный снимок действия/выхода получает
    // новое поколение и не даёт старому async-снапшоту записаться поверх.
    if (!sync && this._saving) return this._savingPromise;

    const generation = ++this._saveGeneration;

    if (sync) {
      try {
        if (!this._fpCache) this._fpCache = rle(this.footprints.snapshot());
        return this._write(this._collect(), generation).catch(() => this._saveError());
      } catch (e) { return Promise.resolve(this._saveError()); }
    }
    this._saving = true;
    this._savingPromise = this._saveAsync(generation);
    return this._savingPromise;
  }

  async _saveAsync(generation) {
    try {
      try {
        this._fpCache = rle(await this.footprints.snapshotAsync());
      } catch (e) {
        this._fpCache = rle(this.footprints.snapshot()); // нет PBO — раз в 30с терпимо
      }
      if (generation !== this._saveGeneration || this.disabled) return false;
      const data = this._collect();
      return await this._write(data, generation);
    } catch (e) {
      return this._saveError();
    } finally {
      this._saving = false;
    }
  }

  // Фолбэк-среда без IndexedDB: журнал идёт base64 рядом с JSON заголовка.
  _saveLS(d) {
    const edits = new Array(d.cache.editsK.length);
    for (let i = 0; i < d.cache.editsK.length; i++) {
      edits[i] = [d.cache.editsK[i], Math.round(d.cache.editsV[i] * 100) / 100];
    }
    const editMaterials = new Array(d.cache.editMatK.length);
    for (let i = 0; i < d.cache.editMatK.length; i++) {
      editMaterials[i] = [d.cache.editMatK[i], d.cache.editMatV[i]];
    }
    localStorage.setItem(LS_KEY3, JSON.stringify({
        v: 3,
        head: d.head,
        edits,
        editMaterials,
        journal: b64(d.journalBytes),
        fp: d.cache.fp ? b64(d.cache.fp) : undefined,
    }));
  }

  /**
   * Сдвинуть мир в прошлое на hours часов и перезагрузить страницу (?debug).
   *
   * Так живой мир проверяется без ожидания суток. Порядок ручной проверки:
   * срубить сосну до конца (чтобы ствол вышел весь), подбросить полено в
   * костёр, походить по снегу, выкопать яму, `__snow.saver.save()`,
   * `__snow.timeTravel(30)` — и после перезагрузки смотреть: на месте пня
   * стоит подросшая сосна, костёр на углях, тропы бледные, яма затянулась.
   */
  async timeTravel(hours) {
    const seconds = Math.round(hours * 3600);
    // Двигается эпоха журнала, а не времена записей: t — беззнаковое смещение
    // от неё, и запись первой минуты ушла бы в минус (см. Journal.shift).
    this.journal.shift(seconds);
    this._shift += seconds;
    await this.save();
    location.reload();
  }

  async _wipe() {
    try { localStorage.removeItem(LS_KEY); } catch (e) { /* приватный режим */ }
    try { localStorage.removeItem(LS_KEY3); } catch (e) { /* приватный режим */ }
    const db = await this._open();
    if (db) {
      try {
        const tx = db.transaction([HEAD_STORE, JOURNAL_STORE, CACHE_STORE, OLD_STORE], 'readwrite');
        for (const name of [HEAD_STORE, JOURNAL_STORE, CACHE_STORE, OLD_STORE]) {
          tx.objectStore(name).clear();
        }
        await new Promise((resolve) => { tx.oncomplete = tx.onerror = tx.onabort = resolve; });
      } catch (e) { /* ignore */ }
    }
    this.journal = new Journal();
    this.inventory = new Inventory(this.journal);
    this.mined = { soil: 0, stone: 0, ore: 0 };
    this._wire();
  }

  // стереть память мира и начать ночь заново (кнопка в меню). Автосейв
  // глушится: иначе pagehide перед перезагрузкой записал бы мир обратно.
  async reset() {
    if (this.blocked) return false;
    this.disabled = true;
    this._saveGeneration++;
    try { await this._savingPromise; } catch (e) { /* старый сейв уже не важен */ }
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
