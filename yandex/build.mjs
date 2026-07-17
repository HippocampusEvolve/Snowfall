// Автономный сжатый билд для Яндекс.Игр / self-hosting.
// НИЧЕГО не меняет в основном проекте: читает src/public через `vite build`,
// всю обработку делает в yandex/build (staging). Основной пайплайн о нём не знает.
//
// Что делает:
//   1. vite build --base=./  (относительные пути ассетов — работает и в под-пути iframe)
//   2. релятивизация жёстких /models /textures в бандле (код грузит их абсолютно)
//   3. каждая .gltf-модель: текстуры → WebP, геометрия → quantize (KHR_mesh_quantization,
//      three понимает нативно; НЕ Draco — тот потребовал бы правку рантайма)
//   4. текстуры земли (снег, грузятся по жёстким .jpg) → пережатый .jpg, имя то же
//   5. zip + отчёт по размеру
//
// Безопасность для trees.js: используются ТОЛЬКО webp+quantize. optimize/join/flatten/weld
// переименовали бы меши и сломали матчинг Pine_*_LOD* / bark / clusters — их тут нет.
//
// Настройки через env: WEBP_Q=80 (1-100), NO_QUANTIZE=1, NO_ZIP=1.

import { execSync } from 'node:child_process';
import {
  existsSync, rmSync, mkdirSync, readdirSync,
  readFileSync, writeFileSync, statSync,
} from 'node:fs';
import { dirname, join, resolve, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const BUILD = join(HERE, 'build');
const WORK = join(HERE, '.work');
const GT = 'npx --yes @gltf-transform/cli';
const Q = process.env.WEBP_Q || '80';
const DO_QUANTIZE = process.env.NO_QUANTIZE !== '1';

const run = (cmd, cwd = ROOT) => execSync(cmd, { cwd, stdio: 'inherit' });
const mb = (b) => (b / 1048576).toFixed(1);
function dirSize(d) {
  let s = 0;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    s += e.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return s;
}
function findGltf(d, out = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) findGltf(p, out);
    else if (e.name.endsWith('.gltf')) out.push(p);
  }
  return out;
}
// Некоторые .gltf ссылаются на текстуры, которых нет на диске (билборды/checker
// у сосен — их узлы дропает trees.js в рантайме, файлы не поставлялись).
// gltf-transform читает ВЕСЬ images[] при загрузке и падает на ENOENT — поэтому
// подкладываем прозрачную 1×1-заглушку (в WebP весит ~0, узлы всё равно не рендерятся).
async function fillMissingTextures(gltfPath) {
  const gltf = JSON.parse(readFileSync(gltfPath, 'utf8'));
  const dir = dirname(gltfPath);
  for (const img of gltf.images || []) {
    if (!img.uri) continue;
    const p = join(dir, decodeURIComponent(img.uri));
    if (existsSync(p)) continue;
    mkdirSync(dirname(p), { recursive: true });
    const buf = await sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer();
    writeFileSync(p, buf);
    console.log(`   · заглушка для отсутствующей ${img.uri}`);
  }
}

// ── 1. vite build ────────────────────────────────────────────────────────────
console.log('▶ vite build → yandex/build (base=./)');
run('npx --yes vite build --base=./ --outDir yandex/build --emptyOutDir');

// ── 2. релятивизация абсолютных путей ассетов в бандле ─────────────────────────
console.log('▶ релятивизация /models /textures в бандле');
for (const f of readdirSync(join(BUILD, 'assets'))) {
  if (!f.endsWith('.js')) continue;
  const p = join(BUILD, 'assets', f);
  const c = readFileSync(p, 'utf8');
  // '/models/…' '/textures/…' в любых кавычках → относительный путь
  const patched = c.replace(/(["'`])\/(models|textures)\//g, '$1$2/');
  if (patched !== c) writeFileSync(p, patched);
}

// ── 3. модели: WebP + quantize ─────────────────────────────────────────────────
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const models = findGltf(join(BUILD, 'models'));
for (const g of models) {
  const dir = dirname(g);
  const base = basename(g);
  const glb = join(WORK, 'a.glb');
  console.log(`▶ ${relative(BUILD, g)}`);
  await fillMissingTextures(g);
  // webp читает исходную папку и пакует всё в self-contained glb
  run(`${GT} webp "${g}" "${glb}" --quality ${Q}`);
  // папку можно чистить: glb автономен
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (DO_QUANTIZE) {
    run(`${GT} quantize "${glb}" "${join(dir, base)}"`);
  } else {
    run(`${GT} copy "${glb}" "${join(dir, base)}"`);
  }
  rmSync(glb, { force: true });
}
rmSync(WORK, { recursive: true, force: true });

// ── 4. текстуры земли (снег): пережать jpg, имя сохранить ───────────────────────
console.log('▶ пережатие снега (jpg q80, имена сохранены)');
const texDir = join(BUILD, 'textures');
if (existsSync(texDir)) {
  for (const f of readdirSync(texDir)) {
    if (!/\.jpe?g$/i.test(f)) continue;
    const p = join(texDir, f);
    // читаем в буфер заранее — иначе sharp держит хэндл и запись в тот же путь
    // падает на Windows (файл занят)
    const input = readFileSync(p);
    const buf = await sharp(input).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
    writeFileSync(p, buf);
  }
}

// ── 5. отчёт + zip ─────────────────────────────────────────────────────────────
console.log('\n── размер билда ──');
for (const sub of ['assets', 'models', 'textures']) {
  const p = join(BUILD, sub);
  if (existsSync(p)) console.log(`  ${sub.padEnd(9)} ${mb(dirSize(p))} MB`);
}
console.log(`  ВСЕГО     ${mb(dirSize(BUILD))} MB`);

if (process.env.NO_ZIP !== '1' && process.platform === 'win32') {
  console.log('\n▶ zip → yandex/snowfall-yandex.zip');
  const ps =
    "Compress-Archive -Path 'build\\*' -DestinationPath 'snowfall-yandex.zip' " +
    '-Force -CompressionLevel Optimal';
  run(`powershell -NoProfile -Command "${ps}"`, HERE);
  const z = join(HERE, 'snowfall-yandex.zip');
  if (existsSync(z)) console.log(`  ZIP: ${mb(statSync(z).size)} MB  ← это уходит на Яндекс`);
} else if (process.env.NO_ZIP !== '1') {
  console.log('\n(не win32 — заархивируй yandex/build/* сам)');
}
console.log('\n✓ готово. Проверить локально: npx serve yandex/build');
