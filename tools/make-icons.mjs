// Генератор legacy-иконок Android (mipmap-*/ic_launcher.png и _round.png):
// та же снежинка, что в drawable/ic_launcher_foreground.xml, но растром — для
// Android < 8, где адаптивной иконки нет. Рисуем без зависимостей: расстояние
// до отрезка даёт сглаженный штрих, PNG собираем zlib'ом (он есть в Node).
//
//   node tools/make-icons.mjs
//
// Векторную иконку править отдельно — она независима (и именно её видит
// подавляющее большинство устройств).

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RES = join(dirname(fileURLToPath(import.meta.url)), '..', 'android', 'app', 'src', 'main', 'res');
const SIZES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

const BG_TOP = [0x0a, 0x13, 0x22]; // тот же градиент ночи, что у вектора
const BG_BOT = [0x04, 0x06, 0x0c];

// Снежинка: 6 лучей по 60°, у каждого стебель и две пары веток.
// Координаты — в долях половины иконки, центр (0,0), ось Y вверх.
function segments() {
  const L = 0.74; // длина луча в долях радиуса иконки
  const segs = [];
  const branch = (t, len) => {
    const a = (35 * Math.PI) / 180;
    const y = t * L;
    return [
      [0, y, Math.sin(a) * len, y + Math.cos(a) * len],
      [0, y, -Math.sin(a) * len, y + Math.cos(a) * len],
    ];
  };
  const arm = [[0, 0, 0, L], ...branch(0.45, 0.3 * L), ...branch(0.72, 0.22 * L)];
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3;
    const c = Math.cos(a);
    const s = Math.sin(a);
    for (const [x1, y1, x2, y2] of arm)
      segs.push([x1 * c - y1 * s, x1 * s + y1 * c, x2 * c - y2 * s, x2 * s + y2 * c]);
  }
  return segs;
}

const SEGS = segments();

// расстояние от точки до отрезка — по нему строится сглаженный штрих
function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function render(size, round) {
  const buf = Buffer.alloc(size * size * 4);
  const half = size / 2;
  // полуширина штриха: держим толщину ≈10% длины луча — те же пропорции,
  // что у вектора (strokeWidth 3 при луче 30); толще — снежинка плывёт в кляксу
  const stroke = Math.max(0.7, size * 0.017);
  const aa = 0.8; // ширина сглаживающей каймы, px
  for (let y = 0; y < size; y++) {
    // фон: вертикальный градиент ночи
    const g = y / (size - 1);
    const bg = [0, 1, 2].map((i) => Math.round(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * g));
    for (let x = 0; x < size; x++) {
      // нормализованные координаты: центр (0,0), край ±1, Y вверх
      const nx = (x + 0.5 - half) / half;
      const ny = -(y + 0.5 - half) / half;

      let d = Infinity;
      for (const s of SEGS) d = Math.min(d, distToSeg(nx, ny, s[0], s[1], s[2], s[3]));
      const dpx = d * half; // обратно в пиксели — сглаживание одинаково на всех размерах
      const flake = Math.max(0, Math.min(1, (stroke + aa - dpx) / aa));

      // круглый вариант: мягкая маска по кругу, за ней прозрачность
      let mask = 1;
      if (round) {
        const rpx = Math.hypot(nx, ny) * half;
        mask = Math.max(0, Math.min(1, (half - 0.5 - rpx) / aa));
      }

      const o = (y * size + x) * 4;
      for (let i = 0; i < 3; i++) buf[o + i] = Math.round(bg[i] + (255 - bg[i]) * flake);
      buf[o + 3] = Math.round(255 * mask);
    }
  }
  return buf;
}

// --- минимальный PNG-энкодер (RGBA8, без фильтров) ---
function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 6; // RGBA
  // строки со сканлайн-фильтром 0 (none)
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [dpi, size] of Object.entries(SIZES)) {
  const dir = join(RES, `mipmap-${dpi}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ic_launcher.png'), png(render(size, false), size));
  writeFileSync(join(dir, 'ic_launcher_round.png'), png(render(size, true), size));
  console.log(`mipmap-${dpi}: ${size}×${size}`);
}

// иконка для витрины RuStore/README — 512×512
mkdirSync(join(RES, '..', '..', '..', '..', '..', 'store'), { recursive: true });
writeFileSync(join(RES, '..', '..', '..', '..', '..', 'store', 'icon-512.png'), png(render(512, false), 512));
console.log('store/icon-512.png');
