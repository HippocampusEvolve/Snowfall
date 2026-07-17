// Память мира (VISION.md: «мир копится»): сохранение в localStorage.
// Переживают перезагрузку: правки копания, карта следов/троп (уменьшенный
// снапшот), топливо костра, позиция игрока, лопата и брошенные поленья.
// Смерть мир НЕ стирает — следы той ночи остаются. Сброс: кнопка в меню
// (reset()) или открыть с ?reset.
const KEY = 'snowfall.save.v1';
const INTERVAL = 30_000; // автосейв, мс

// простое RLE поверх байтов снапшота следов: карта в основном нули,
// сжимается в десятки раз — легко влезает в квоту localStorage
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

export class SaveGame {
  constructor({ digger, footprints, campfire, player, shovel = null, logs = null }) {
    this.digger = digger;
    this.footprints = footprints;
    this.campfire = campfire;
    this.player = player;
    this.shovel = shovel;
    this.logs = logs;
    this.disabled = false; // взводит reset(): не дать автосейву записать мир обратно
    this.fpSize = 384 * 384 * 4; // размер снапшота следов (footprints.SNAP)
  }

  // читает сохранение и восстанавливает мир; вернуть false — мир новый
  load() {
    if (new URLSearchParams(location.search).has('reset')) {
      try { localStorage.removeItem(KEY); } catch (e) { /* приватный режим */ }
      return false;
    }
    let raw;
    try { raw = localStorage.getItem(KEY); } catch (e) { return false; }
    if (!raw) return false;
    try {
      const d = JSON.parse(raw);
      if (Array.isArray(d.edits) && d.edits.length) this.digger.load(d.edits);
      if (d.fp) this.footprints.restore(unrle(unb64(d.fp), this.fpSize));
      if (typeof d.fuel === 'number') this.campfire.fuel = d.fuel;
      if (typeof d.px === 'number') {
        this.player.pos.set(d.px, d.py + 0.05, d.pz); // чуть выше — не провалиться
      }
      // лопата стоит там, где её оставили (или снова в руках)
      if (this.shovel && d.shv) {
        this.shovel.place(d.shv.x, d.shv.y, d.shv.z, d.shv.yaw || 0);
        if (d.shv.held) this.shovel.take();
      }
      // брошенные поленья лежат, где их бросили; недонесённое — снова в руках
      if (this.logs && Array.isArray(d.logs)) this.logs.restore(d.logs);
      if (d.carry) this.player.carrying = true;
      return true;
    } catch (e) {
      // битое сохранение — начинаем чистую ночь, не ломая запуск
      try { localStorage.removeItem(KEY); } catch (e2) { /* ignore */ }
      return false;
    }
  }

  save() {
    if (this.disabled) return;
    const p = this.player.pos;
    const data = {
      edits: [...this.digger.edits].map(([k, v]) => [k, Math.round(v * 100) / 100]),
      fp: b64(rle(this.footprints.snapshot())),
      fuel: Math.round(this.campfire.fuel * 1000) / 1000,
      px: Math.round(p.x * 100) / 100,
      py: Math.round(p.y * 100) / 100,
      pz: Math.round(p.z * 100) / 100,
      carry: this.player.carrying ? 1 : 0,
    };
    if (this.logs) data.logs = this.logs.serialize();
    if (this.shovel) {
      const s = this.shovel.pos;
      data.shv = {
        x: Math.round(s.x * 100) / 100,
        y: Math.round(s.y * 100) / 100,
        z: Math.round(s.z * 100) / 100,
        yaw: Math.round(this.shovel.yaw * 100) / 100,
        held: this.shovel.held ? 1 : 0,
      };
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {
      // квота/приватный режим: игра живёт дальше без памяти
    }
  }

  // стереть память мира и начать ночь заново (кнопка в меню). Автосейв
  // глушится: иначе pagehide перед перезагрузкой записал бы мир обратно.
  reset() {
    this.disabled = true;
    try { localStorage.removeItem(KEY); } catch (e) { /* приватный режим */ }
    location.reload();
  }

  start() {
    setInterval(() => this.save(), INTERVAL);
    addEventListener('pagehide', () => this.save());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.save();
    });
  }
}
