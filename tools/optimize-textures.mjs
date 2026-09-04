// Пережатие текстур: 2K-карты из паков весили 11 МБ и держали загрузку сайта
// в районе 20 секунд. Здесь они ужимаются по типу карты — цвет и нормали до
// 1K, roughness/specular до 512 (глазом на них разрешения не видно), а почти
// константные карты — до 64 пикселей.
//
// Результат кладётся в каталог `tex/` рядом с исходным `textures/`: имена
// URL'ов должны смениться, иначе посетители с `Cache-Control: immutable`
// увидят старые тяжёлые файлы ещё год. Исходники после прогона удаляются —
// они остаются в истории git (`git show <commit>:<путь>`).
//
// Разовый инструмент: в зависимостях проекта sharp не держим (33 МБ ради
// одного прогона в CI каждой сборки — расточительство).
//   npm i -D sharp && node tools/optimize-textures.mjs [--dry]
// Работает по исходным `textures/` — после первого прогона их уже нет,
// достать можно из истории: git show <коммит до v0.18.0>:<путь>.
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const DRY = process.argv.includes('--dry');

// Наборы: откуда → куда, и потолок разрешения по типу карты.
// mrMax разделён, потому что у сосен metallicRoughness служит ещё и
// occlusionTexture (AO в R-канале) — там детали видны, у домика в этой карте
// значим только G (roughness), остальное константа.
const SETS = [
  { from: 'public/textures', to: 'public/tex', mrMax: 512 },
  { from: 'public/models/pines/textures', to: 'public/models/pines/tex', mrMax: 1024 },
  {
    from: 'public/models/props/book_encyclopedia_set_01/textures',
    to: 'public/models/props/book_encyclopedia_set_01/tex',
    mrMax: 512,
  },
  {
    from: 'public/models/props/brass_pot_01/textures',
    to: 'public/models/props/brass_pot_01/tex',
    mrMax: 512,
  },
];

// Тип карты по имени файла → потолок стороны и качество webp.
// Нормалям качество выше: артефакты кодека читаются на них как рябь освещения.
function rule(name, set) {
  if (/_baseColor|_diff/i.test(name)) return { max: 1024, q: 80 };
  if (/_normal|_nor_gl/i.test(name)) return { max: 512, q: 82 };
  if (/_metallicRoughness|_arm/i.test(name)) return { max: set.mrMax, q: 74 };
  if (/_rough/i.test(name)) return { max: 512, q: 74 };
  if (/_specularf0|_specular/i.test(name)) return { max: 256, q: 74 };
  return { max: 1024, q: 80 };
}

// Имя с фактическим разрешением: snow_02_diff_2k.webp -> snow_02_diff_1k.webp.
// Суффикса нет — не трогаем.
function renameByRes(name, w, h) {
  const side = Math.max(w, h);
  const tag = side >= 2048 ? '2k' : side >= 1024 ? '1k' : `${side}`;
  return name.replace(/_(\d+k|\d{3,4})(?=\.webp$)/i, `_${tag}`);
}

let before = 0;
let after = 0;
const report = [];

// Ссылки внутри .gltf нужно перевести на новый каталог и новые имена —
// иначе модель приедет без текстур.
function rewriteGltf(dir, renames) {
  let touched = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.gltf')) continue;
    const p = path.join(dir, f);
    let json = fs.readFileSync(p, 'utf8');
    for (const [oldName, newName] of renames) {
      json = json.split(`textures/${oldName}`).join(`tex/${newName}`);
    }
    if (!DRY) fs.writeFileSync(p, json);
    touched.push(p);
  }
  return touched;
}

for (const set of SETS) {
  if (!fs.existsSync(set.from)) {
    console.log(`пропуск (нет каталога): ${set.from}`);
    continue;
  }
  if (!DRY) fs.mkdirSync(set.to, { recursive: true });
  const renames = [];

  for (const file of fs.readdirSync(set.from)) {
    const src = path.join(set.from, file);
    if (!/\.(webp|png|jpe?g)$/i.test(file)) {
      if (!DRY) fs.copyFileSync(src, path.join(set.to, file)); // license.txt и прочее
      continue;
    }

    // читаем в буфер, а не по пути: иначе sharp держит файл открытым и
    // Windows не даёт удалить исходный каталог в конце прогона
    const raw = fs.readFileSync(src);
    const img = sharp(raw);
    const meta = await img.metadata();
    const stats = await img.stats();
    const { max, q } = rule(file, set);

    // Карта без вариации (например, сплошь белый specular) не несёт данных —
    // хватит нескольких пикселей, чтобы материал остался прежним по смыслу.
    const flat = stats.channels.every((c) => c.stdev < 2);
    const target = flat ? 64 : max;

    const w = meta.width;
    const h = meta.height;
    const scale = Math.min(1, target / Math.max(w, h));
    const nw = Math.max(1, Math.round(w * scale));
    const nh = Math.max(1, Math.round(h * scale));

    let pipe = sharp(raw);
    if (scale < 1) pipe = pipe.resize(nw, nh, { kernel: 'lanczos3' });
    const buf = await pipe
      .webp({ quality: q, alphaQuality: 90, effort: 6, smartSubsample: true })
      .toBuffer();

    const srcSize = raw.length;
    before += srcSize;
    after += buf.length;

    const outName = renameByRes(file, nw, nh);
    if (!DRY) fs.writeFileSync(path.join(set.to, outName), buf);
    renames.push([file, outName]);

    report.push(
      `${(srcSize / 1024).toFixed(0).padStart(5)}K -> ${(buf.length / 1024)
        .toFixed(0)
        .padStart(4)}K  ${w}x${h} -> ${nw}x${nh}${flat ? ' (константа)' : ''}  ${set.to}/${outName}`
    );
  }

  for (const p of rewriteGltf(path.dirname(set.from), renames)) {
    report.push(`      правки ссылок: ${p}`);
  }
  // старый каталог с 2K-исходниками уходит из раздачи (остаётся в git-истории)
  if (!DRY) fs.rmSync(set.from, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(report.join('\n'));
console.log(
  `\nитого: ${(before / 1024 / 1024).toFixed(2)} МБ -> ${(after / 1024 / 1024).toFixed(2)} МБ ` +
    `(${(100 - (after / before) * 100).toFixed(0)}% долой)${DRY ? '  [--dry, ничего не записано]' : ''}`
);
